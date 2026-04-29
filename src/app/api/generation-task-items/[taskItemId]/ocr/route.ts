import { after, NextResponse } from 'next/server';
import {
  buildTextSlotFillPromptPayload,
  extractPdfTextFromVisionPages,
} from '@/src/lib/llm/fill-template-from-pdf';
import {
  appendProcessingTrace,
  buildFallbackReviewPayload,
  createUnauthorizedResponse,
  generationTaskItemSelect,
  type GenerationTaskItemRecord,
  getErrorMessage,
  loadVisionPagesFromStoredAssets,
  normalizeOcrImageAssets,
  normalizePages,
  normalizeSelectedOriginalPageNumbers,
  normalizeVisionPages,
  recalculateTaskSummary,
} from '@/src/lib/generation-task-items/runtime';
import { buildErrorLogPayload, logEvent } from '@/src/lib/logging/log-event';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 300;
const PROCESS_HARD_TIMEOUT_MS = maxDuration * 1000;
const PROCESS_ROUTE_FINALIZATION_RESERVE_MS = 15000;

async function runGenerationTaskItemOcr(params: {
  item: GenerationTaskItemRecord;
  actorEmail: string | null;
}) {
  const admin = createSupabaseAdminClient();
  const startedAt = new Date();
  const processStartedAtMs = startedAt.getTime();
  const slotSchema = Array.isArray(params.item.llm_input?.slot_schema)
    ? params.item.llm_input.slot_schema
    : [];
  const pages = normalizePages(params.item.llm_input?.pages);
  const precomputedVisionPages = normalizeVisionPages(params.item.llm_input?.vision_pages);
  const ocrImageAssets = normalizeOcrImageAssets(params.item.llm_input?.ocr_image_assets);
  const selectedOriginalPageNumbers = normalizeSelectedOriginalPageNumbers(
    params.item.llm_input?.selected_original_page_numbers,
  );

  try {
    if (slotSchema.length === 0) {
      throw new Error('当前模板缺少槽位定义，请重新保存模板后再试。');
    }

    if (
      pages.length === 0 &&
      precomputedVisionPages.length === 0 &&
      ocrImageAssets.length === 0 &&
      selectedOriginalPageNumbers.length === 0
    ) {
      throw new Error('当前任务缺少可处理的 PDF 页码范围，请重新创建批量任务后再试。');
    }

    await admin
      .from('generation_task_items')
      .update({
        status: 'ocr_running',
        error_message: null,
        started_at: params.item.started_at ?? startedAt.toISOString(),
        finished_at: null,
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
        processing_trace: '',
      })
      .eq('id', params.item.id);

    await appendProcessingTrace(
      admin,
      params.item.id,
      `开始 OCR：${params.item.source_pdf_name}，共 ${slotSchema.length} 个槽位。`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `OCR 路由：/api/generation-task-items/${params.item.id}/ocr`,
    );

    await admin
      .from('generation_tasks')
      .update({
        status: 'running',
        started_at: params.item.started_at ?? startedAt.toISOString(),
      })
      .eq('id', params.item.task_id);

    await logEvent({
      ownerId: params.item.owner_id,
      actorEmail: params.actorEmail,
      level: 'info',
      eventType: 'generation_task_item_ocr_started',
      message: `Started OCR for ${params.item.source_pdf_name}.`,
      route: '/api/generation-task-items/[taskItemId]/ocr',
      templateId: params.item.template_id,
      taskId: params.item.task_id,
      taskItemId: params.item.id,
      payload: {
        slotCount: slotSchema.length,
        pageCount: pages.length,
        visionPageCount: precomputedVisionPages.length,
        ocrImageAssetCount: ocrImageAssets.length,
        likelyScanned: params.item.llm_input?.likely_scanned === true,
        forceOcr: params.item.llm_input?.force_ocr === true,
      },
    });

    const visionPages =
      precomputedVisionPages.length > 0
        ? precomputedVisionPages
        : await loadVisionPagesFromStoredAssets({
            admin,
            ocrImageAssets,
          });

    if (visionPages.length > 0) {
      await appendProcessingTrace(
        admin,
        params.item.id,
        `已在后台读取 OCR 页图 ${visionPages.length} 页。`,
      );
    }

    const ocrPages = await extractPdfTextFromVisionPages({
      pdfFileName: params.item.source_pdf_name,
      slots: slotSchema,
      visionPages,
      processStartedAtMs,
      processHardTimeoutMs: PROCESS_HARD_TIMEOUT_MS,
      processReserveMs: PROCESS_ROUTE_FINALIZATION_RESERVE_MS,
      onTrace: async ({ message }) => {
        await appendProcessingTrace(admin, params.item.id, message);
      },
      onProgress: async ({ completedSlots, totalSlots }) => {
        await admin
          .from('generation_task_items')
          .update({
            slot_total_count: totalSlots,
            slot_completed_count: completedSlots,
            updated_at: new Date().toISOString(),
          })
          .eq('id', params.item.id);
      },
    });

    const totalTextLength = ocrPages.reduce((sum, page) => sum + page.text.length, 0);
    const slotFillPromptPreview = {
      route: `/api/generation-task-items/${params.item.id}/slot-fill`,
      request_label: 'after-ocr-preview',
      document_name: params.item.source_pdf_name,
      messages: [
        {
          role: 'system',
          content:
            'You are a PDF slot filling assistant. Extract slot values from the provided PDF text chunk. Return JSON only.',
        },
        {
          role: 'user',
          content: buildTextSlotFillPromptPayload({
            documentName: params.item.source_pdf_name,
            slots: slotSchema,
            pageNumbers: ocrPages.map((page) => page.page_number),
            chunkText: ocrPages
              .sort((left, right) => left.page_number - right.page_number)
              .map((page) => `[Page ${page.page_number}]\n${page.text}`)
              .join('\n'),
          }),
        },
      ],
    };
    const elapsedSeconds = Math.max(
      1,
      Math.round((Date.now() - new Date(params.item.started_at ?? startedAt.toISOString()).getTime()) / 1000),
    );

    const { data: updatedOcrItem, error: updatedOcrItemError } = await admin
      .from('generation_task_items')
      .update({
        status: 'ocr_completed',
        elapsed_seconds: elapsedSeconds,
        llm_input: {
          ...(params.item.llm_input ?? {}),
          pages: ocrPages,
          total_text_length: totalTextLength,
        },
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
      })
      .eq('id', params.item.id)
      .select('id, status')
      .single();

    if (updatedOcrItemError) {
      throw updatedOcrItemError;
    }

    if (!updatedOcrItem || updatedOcrItem.status !== 'ocr_completed') {
      throw new Error('OCR completed status was not persisted correctly before slot-fill handoff.');
    }

    await recalculateTaskSummary(admin, params.item.task_id);

    await appendProcessingTrace(
      admin,
      params.item.id,
      `OCR 完成：共得到 ${ocrPages.length} 页可用文本，等待槽位回填。`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      'OCR 已完成，前端轮询检测到后将自动启动槽位回填。',
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `下一步路由：/api/generation-task-items/${params.item.id}/slot-fill`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `OCR 状态已持久化为 ${updatedOcrItem.status}。`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `[PDF Fill][TextPromptPreview][AfterOCR] ${JSON.stringify(slotFillPromptPreview)}`,
    );

    await logEvent({
      ownerId: params.item.owner_id,
      actorEmail: params.actorEmail,
      level: 'info',
      eventType: 'generation_task_item_ocr_completed',
      message: `OCR completed for ${params.item.source_pdf_name}.`,
      route: '/api/generation-task-items/[taskItemId]/ocr',
      templateId: params.item.template_id,
      taskId: params.item.task_id,
      taskItemId: params.item.id,
      payload: {
        ocrPageCount: ocrPages.length,
        totalTextLength,
        elapsedSeconds,
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
      `OCR 失败，已转为人工核查：${getErrorMessage(error)}`,
    );
    await appendProcessingTrace(
      admin,
      params.item.id,
      `[RouteErrorDetails][OCR] ${JSON.stringify(
        buildErrorLogPayload(error, {
          sourcePdfName: params.item.source_pdf_name,
          slotCount: slotSchema.length,
          pageCount: pages.length,
          visionPageCount: precomputedVisionPages.length,
          ocrImageAssetCount: ocrImageAssets.length,
        }),
      )}`,
    );

    await recalculateTaskSummary(admin, params.item.task_id);

    await logEvent({
      ownerId: params.item.owner_id,
      actorEmail: params.actorEmail,
      level: 'error',
      eventType: 'generation_task_item_ocr_failed',
      message: getErrorMessage(error),
      route: '/api/generation-task-items/[taskItemId]/ocr',
      templateId: params.item.template_id,
      taskId: params.item.task_id,
      taskItemId: params.item.id,
      payload: buildErrorLogPayload(error, {
        sourcePdfName: params.item.source_pdf_name,
        slotCount: slotSchema.length,
        pageCount: pages.length,
        visionPageCount: precomputedVisionPages.length,
        ocrImageAssetCount: ocrImageAssets.length,
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
      .select(generationTaskItemSelect)
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

    if (['review_pending', 'reviewed', 'succeeded', 'ocr_completed', 'slot_filling'].includes(item.status)) {
      return NextResponse.json({
        data: {
          item,
        },
      });
    }

    if (['running', 'ocr_running'].includes(item.status)) {
      return NextResponse.json({
        data: {
          item,
        },
      });
    }

    after(async () => {
      await runGenerationTaskItemOcr({
        item,
        actorEmail: user.email ?? null,
      });
    });

    return NextResponse.json(
      {
        data: {
          item: {
            ...item,
            status: 'ocr_running',
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
    const { taskItemId } = await context.params;
    const message = getErrorMessage(error);

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'error',
      eventType: 'generation_task_item_ocr_request_failed',
      message,
      route: '/api/generation-task-items/[taskItemId]/ocr',
      taskItemId,
      payload: buildErrorLogPayload(error),
    });

    return NextResponse.json(
      {
        code: 'GENERATION_TASK_ITEM_OCR_FAILED',
        message,
      },
      { status: 500 },
    );
  }
}
