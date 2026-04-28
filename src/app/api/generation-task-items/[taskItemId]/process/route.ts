import { after, NextResponse } from 'next/server';
import type {
  GenerationSlotSchemaItem,
  PdfPageInput,
  PdfVisionPageInput,
} from '@/src/lib/llm/fill-template-from-pdf';
import { fillTemplateSlotsFromPdf } from '@/src/lib/llm/fill-template-from-pdf';
import { buildErrorLogPayload, logEvent } from '@/src/lib/logging/log-event';
import { renderPdfPagesForVisionOnServer } from '@/src/lib/pdf/server-pdf';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 300;

function createUnauthorizedResponse() {
  return NextResponse.json(
    {
      code: 'UNAUTHORIZED',
      message: '请先登录后再继续。',
    },
    { status: 401 },
  );
}

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

type GenerationTaskItemRecord = {
  id: string;
  task_id: string;
  owner_id: string;
  template_id: string | null;
  source_pdf_name: string;
  source_pdf_path: string;
  status: string;
  elapsed_seconds: number;
  slot_total_count: number;
  slot_completed_count: number;
  processing_trace?: string;
  created_at: string;
  reviewed_at?: string | null;
  output_docx_path?: string | null;
  error_message?: string | null;
  llm_input?: {
    template_name?: string;
    template_prompt?: string;
    slot_schema?: GenerationSlotSchemaItem[];
    pages?: PdfPageInput[];
    vision_pages?: PdfVisionPageInput[];
    likely_scanned?: boolean;
    total_text_length?: number;
    force_ocr?: boolean;
    selected_original_page_numbers?: number[];
  } | null;
};

function buildFallbackReviewPayload(slotSchema: GenerationSlotSchemaItem[]) {
  return {
    document_summary: '',
    extracted_items: slotSchema.map((slot) => ({
      slot_key: slot.slot_key,
      field_category: slot.field_category,
      meaning_to_applicant: slot.meaning_to_applicant,
      original_value: '',
      evidence: '',
      evidence_page_numbers: [],
      notes: '',
      confidence: null,
    })),
  };
}

function formatProcessingTraceEntry(message: string) {
  return `[${new Date().toISOString()}] ${message}`;
}

function normalizePages(value: unknown): PdfPageInput[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (page): page is PdfPageInput =>
      !!page &&
      typeof page === 'object' &&
      typeof (page as PdfPageInput).page_number === 'number' &&
      typeof (page as PdfPageInput).text === 'string',
  );
}

function normalizeVisionPages(value: unknown): PdfVisionPageInput[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (page): page is PdfVisionPageInput =>
      !!page &&
      typeof page === 'object' &&
      typeof (page as PdfVisionPageInput).page_number === 'number' &&
      typeof (page as PdfVisionPageInput).image_data_url === 'string',
  );
}

function normalizeSelectedOriginalPageNumbers(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (pageNumber): pageNumber is number =>
      typeof pageNumber === 'number' && Number.isInteger(pageNumber) && pageNumber > 0,
  );
}

async function buildVisionPagesForTaskItem(params: {
  admin: AdminClient;
  item: GenerationTaskItemRecord;
}) {
  const originalPageNumbers = normalizeSelectedOriginalPageNumbers(
    params.item.llm_input?.selected_original_page_numbers,
  );

  if (originalPageNumbers.length === 0) {
    return [];
  }

  const { data: fileBlob, error } = await params.admin.storage
    .from('generation-pdfs')
    .download(params.item.source_pdf_path);

  if (error || !fileBlob) {
    throw error ?? new Error('Unable to download the original PDF for OCR.');
  }

  const arrayBuffer = await fileBlob.arrayBuffer();

  return renderPdfPagesForVisionOnServer({
    pdfBytes: new Uint8Array(arrayBuffer),
    originalPageNumbers,
  });
}

async function recalculateTaskSummary(admin: AdminClient, taskId: string) {
  const { data: items, error } = await admin
    .from('generation_task_items')
    .select('status')
    .eq('task_id', taskId);

  if (error) {
    throw error;
  }

  const totalItems = items?.length ?? 0;
  const succeededItems =
    items?.filter((item) => ['succeeded', 'review_pending', 'reviewed'].includes(item.status))
      .length ?? 0;
  const failedItems = items?.filter((item) => item.status === 'failed').length ?? 0;
  const hasRunningItems =
    items?.some((item) => ['running', 'uploaded', 'pending'].includes(item.status)) ?? false;

  const nextStatus = hasRunningItems
    ? 'running'
    : failedItems > 0 && succeededItems === 0
      ? 'failed'
      : 'completed';

  await admin
    .from('generation_tasks')
    .update({
      status: nextStatus,
      total_items: totalItems,
      succeeded_items: succeededItems,
      failed_items: failedItems,
      finished_at: hasRunningItems ? null : new Date().toISOString(),
    })
    .eq('id', taskId);
}

async function updateSlotProgress(
  admin: AdminClient,
  taskItemId: string,
  progress: { completedSlots: number; totalSlots: number },
) {
  await admin
    .from('generation_task_items')
    .update({
      slot_total_count: progress.totalSlots,
      slot_completed_count: progress.completedSlots,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskItemId);
}

async function appendProcessingTrace(
  admin: AdminClient,
  taskItemId: string,
  message: string,
) {
  try {
    const { error } = await admin.rpc('append_generation_task_item_processing_trace', {
      p_task_item_id: taskItemId,
      p_entry: formatProcessingTraceEntry(message),
    });

    if (error) {
      console.error('[Generation Task] Failed to append processing trace.', error);
    }
  } catch (error) {
    console.error('[Generation Task] Failed to append processing trace.', error);
  }
}

async function runGenerationTaskItemProcess(params: {
  item: GenerationTaskItemRecord;
  actorEmail: string | null;
}) {
  const admin = createSupabaseAdminClient();
  const startedAt = new Date();
  const slotSchema = Array.isArray(params.item.llm_input?.slot_schema)
    ? params.item.llm_input?.slot_schema
    : [];
  const pages = normalizePages(params.item.llm_input?.pages);
  const precomputedVisionPages = normalizeVisionPages(params.item.llm_input?.vision_pages);

  try {
    if (slotSchema.length === 0) {
      throw new Error('当前模板缺少槽位定义，请重新保存模板后再试。');
    }

    if (pages.length === 0 && precomputedVisionPages.length === 0) {
      throw new Error('当前任务缺少 PDF 预处理结果，请重新创建批量任务后再试。');
    }

    await admin
      .from('generation_task_items')
      .update({
        status: 'running',
        error_message: null,
        started_at: startedAt.toISOString(),
        finished_at: null,
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
        processing_trace: '',
      })
      .eq('id', params.item.id);

    await appendProcessingTrace(
      admin,
      params.item.id,
      `开始处理 ${params.item.source_pdf_name}，共 ${slotSchema.length} 个槽位。`,
    );

    await admin
      .from('generation_tasks')
      .update({
        status: 'running',
        started_at: startedAt.toISOString(),
      })
      .eq('id', params.item.task_id);

    await logEvent({
      ownerId: params.item.owner_id,
      actorEmail: params.actorEmail,
      level: 'info',
      eventType: 'generation_task_item_started',
      message: `Started generation task item for ${params.item.source_pdf_name}.`,
      route: '/api/generation-task-items/[taskItemId]/process',
      templateId: params.item.template_id,
      taskId: params.item.task_id,
      taskItemId: params.item.id,
      payload: {
        slotCount: slotSchema.length,
        pageCount: pages.length,
        visionPageCount: precomputedVisionPages.length,
        likelyScanned: params.item.llm_input?.likely_scanned === true,
        forceOcr: params.item.llm_input?.force_ocr === true,
      },
    });

    const visionPages =
      precomputedVisionPages.length > 0
        ? precomputedVisionPages
        : await buildVisionPagesForTaskItem({
            admin,
            item: params.item,
          });

    await appendProcessingTrace(
      admin,
      params.item.id,
      `已在后台准备 OCR 页图 ${visionPages.length} 页。`,
    );

    let lastLoggedCompletedSlots = -1;

    const llmOutput = await fillTemplateSlotsFromPdf({
      pdfFileName: params.item.source_pdf_name,
      templateName: params.item.llm_input?.template_name ?? '未命名模板',
      templatePrompt: params.item.llm_input?.template_prompt ?? '',
      slots: slotSchema,
      pages,
      visionPages,
      likelyScanned: params.item.llm_input?.likely_scanned === true,
      totalTextLength:
        typeof params.item.llm_input?.total_text_length === 'number'
          ? params.item.llm_input.total_text_length
          : 0,
      forceOcr: params.item.llm_input?.force_ocr === true,
      onTrace: async ({ message }) => {
        await appendProcessingTrace(admin, params.item.id, message);
      },
      onProgress: async ({ completedSlots, totalSlots }) => {
        await updateSlotProgress(admin, params.item.id, {
          completedSlots,
          totalSlots,
        });

        const shouldLogProgress =
          completedSlots === totalSlots ||
          completedSlots === 0 ||
          completedSlots !== lastLoggedCompletedSlots;

        if (shouldLogProgress) {
          lastLoggedCompletedSlots = completedSlots;

          await appendProcessingTrace(
            admin,
            params.item.id,
            `槽位回填进度：已完成 ${completedSlots}/${totalSlots}，待抽取 ${Math.max(0, totalSlots - completedSlots)}。`,
          );

          await logEvent({
            ownerId: params.item.owner_id,
            actorEmail: params.actorEmail,
            level: 'info',
            eventType: 'generation_task_item_progress',
            message: `Generation task item progressed to ${completedSlots}/${totalSlots} filled slots.`,
            route: '/api/generation-task-items/[taskItemId]/process',
            templateId: params.item.template_id,
            taskId: params.item.task_id,
            taskItemId: params.item.id,
            payload: {
              completedSlots,
              totalSlots,
              pendingSlots: Math.max(0, totalSlots - completedSlots),
            },
          });
        }
      },
    });

    const finishedAt = new Date();
    const elapsedSeconds = Math.max(
      1,
      Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
    );
    const completedSlots = llmOutput.extracted_items.filter((item) =>
      Boolean(item.original_value.trim()),
    ).length;

    const { error: updateError } = await admin
      .from('generation_task_items')
      .update({
        status: 'review_pending',
        elapsed_seconds: elapsedSeconds,
        llm_output: llmOutput,
        slot_total_count: slotSchema.length,
        slot_completed_count: completedSlots,
        finished_at: finishedAt.toISOString(),
      })
      .eq('id', params.item.id);

    if (updateError) {
      throw updateError;
    }

    await recalculateTaskSummary(admin, params.item.task_id);

    await appendProcessingTrace(
      admin,
      params.item.id,
      `槽位回填完成，用时 ${elapsedSeconds} 秒；已回填 ${completedSlots}/${slotSchema.length} 个槽位。`,
    );

    await logEvent({
      ownerId: params.item.owner_id,
      actorEmail: params.actorEmail,
      level: 'info',
      eventType: 'generation_task_item_processed',
      message: 'Generation task item processed successfully.',
      route: '/api/generation-task-items/[taskItemId]/process',
      templateId: params.item.template_id,
      taskId: params.item.task_id,
      taskItemId: params.item.id,
      payload: {
        sourcePdfName: params.item.source_pdf_name,
        elapsedSeconds,
        slotCount: slotSchema.length,
        completedSlots,
        pendingSlots: Math.max(0, slotSchema.length - completedSlots),
      },
    });
  } catch (error) {
    const fallbackReviewPayload = buildFallbackReviewPayload(slotSchema);
    await admin
      .from('generation_task_items')
      .update({
        status: 'review_pending',
        error_message: null,
        llm_output: fallbackReviewPayload,
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
        finished_at: new Date().toISOString(),
      })
      .eq('id', params.item.id);

    await appendProcessingTrace(
      admin,
      params.item.id,
      `模型自动回填失败，已转为人工核查：${error instanceof Error ? error.message : '未知错误'}`,
    );

    await recalculateTaskSummary(admin, params.item.task_id);

    await logEvent({
      ownerId: params.item.owner_id,
      actorEmail: params.actorEmail,
      level: 'error',
      eventType: 'generation_task_item_failed',
      message: error instanceof Error ? error.message : 'Failed to process generation task item.',
      route: '/api/generation-task-items/[taskItemId]/process',
      templateId: params.item.template_id,
      taskId: params.item.task_id,
      taskItemId: params.item.id,
      payload: buildErrorLogPayload(error, {
        sourcePdfName: params.item.source_pdf_name,
        slotCount: slotSchema.length,
        pageCount: pages.length,
        visionPageCount: precomputedVisionPages.length,
        likelyScanned: params.item.llm_input?.likely_scanned === true,
      }),
    });
  }
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ taskItemId: string }> },
) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  const admin = createSupabaseAdminClient();

  try {
    const { taskItemId } = await context.params;
    const { data: item, error: itemError } = await admin
      .from('generation_task_items')
      .select(
        'id, task_id, owner_id, template_id, source_pdf_name, source_pdf_path, status, elapsed_seconds, slot_total_count, slot_completed_count, processing_trace, created_at, reviewed_at, output_docx_path, error_message, llm_input',
      )
      .eq('id', taskItemId)
      .single<GenerationTaskItemRecord>();

    if (itemError || !item) {
      return NextResponse.json(
        {
          code: 'GENERATION_TASK_ITEM_NOT_FOUND',
          message: '未找到该任务项。',
        },
        { status: 404 },
      );
    }

    if (item.owner_id !== user.id) {
      return createUnauthorizedResponse();
    }

    if (['review_pending', 'reviewed', 'succeeded'].includes(item.status)) {
      return NextResponse.json({
        data: {
          item,
        },
      });
    }

    if (item.status === 'running') {
      return NextResponse.json({
        data: {
          item,
        },
      });
    }

    await admin
      .from('generation_task_items')
      .update({
        status: 'running',
        error_message: null,
        started_at: new Date().toISOString(),
        finished_at: null,
        slot_total_count:
          Array.isArray(item.llm_input?.slot_schema) ? item.llm_input.slot_schema.length : 0,
        slot_completed_count: 0,
        processing_trace: '',
      })
      .eq('id', item.id);

    await admin
      .from('generation_tasks')
      .update({
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .eq('id', item.task_id);

    after(async () => {
      await runGenerationTaskItemProcess({
        item,
        actorEmail: user.email ?? null,
      });
    });

    return NextResponse.json(
      {
        data: {
          item: {
            ...item,
            status: 'running',
            slot_total_count:
              Array.isArray(item.llm_input?.slot_schema) ? item.llm_input.slot_schema.length : 0,
            slot_completed_count: 0,
            processing_trace: '',
            error_message: null,
          },
        },
      },
      { status: 202 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        code: 'GENERATION_TASK_ITEM_PROCESS_FAILED',
        message: error instanceof Error ? error.message : 'PDF 填充处理失败，请稍后重试。',
      },
      { status: 500 },
    );
  }
}
