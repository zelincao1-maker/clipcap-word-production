import { after, NextResponse } from 'next/server';
import { fillSlotsFromTextPages } from '@/src/lib/llm/fill-template-from-pdf';
import {
  appendProcessingTrace,
  buildFallbackReviewPayload,
  createUnauthorizedResponse,
  generationTaskItemSelect,
  type GenerationTaskItemRecord,
  getErrorMessage,
  normalizePages,
  recalculateTaskSummary,
  updateSlotProgress,
} from '@/src/lib/generation-task-items/runtime';
import { buildErrorLogPayload, logEvent } from '@/src/lib/logging/log-event';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 300;
const PROCESS_HARD_TIMEOUT_MS = maxDuration * 1000;

async function runGenerationTaskItemSlotFill(params: {
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
  const pipelineStartedAt = params.item.started_at
    ? new Date(params.item.started_at)
    : startedAt;

  try {
    if (slotSchema.length === 0) {
      throw new Error('当前模板缺少槽位定义，请重新保存模板后再试。');
    }

    if (pages.length === 0) {
      throw new Error('当前任务缺少 OCR 文本结果，请先完成 OCR 后再进行槽位回填。');
    }

    await admin
      .from('generation_task_items')
      .update({
        status: 'slot_filling',
        error_message: null,
        started_at: pipelineStartedAt.toISOString(),
        finished_at: null,
        slot_total_count: slotSchema.length,
        slot_completed_count: 0,
      })
      .eq('id', params.item.id);

    const llmStartMessage =
      `即将开始 LLM 槽位回填：PDF=${params.item.source_pdf_name}，槽位数=${slotSchema.length}，OCR文本页=${pages.length}。`;
    console.log('[Generation Task Item] LLM extraction starting', {
      taskItemId: params.item.id,
      taskId: params.item.task_id,
      sourcePdfName: params.item.source_pdf_name,
      slotCount: slotSchema.length,
      textPageCount: pages.length,
    });
    await appendProcessingTrace(admin, params.item.id, llmStartMessage);

    let lastLoggedCompletedSlots = -1;

    const llmOutput = await fillSlotsFromTextPages({
      pdfFileName: params.item.source_pdf_name,
      slots: slotSchema,
      pages,
      processStartedAtMs,
      processHardTimeoutMs: PROCESS_HARD_TIMEOUT_MS,
      onTrace: async ({ message }) => {
        await appendProcessingTrace(admin, params.item.id, message);
      },
      onProgress: async ({ completedSlots, totalSlots }) => {
        await updateSlotProgress(admin, params.item.id, {
          completedSlots,
          totalSlots,
        });

        if (
          completedSlots === totalSlots ||
          completedSlots === 0 ||
          completedSlots !== lastLoggedCompletedSlots
        ) {
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
            route: '/api/generation-task-items/[taskItemId]/slot-fill',
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
      Math.round((finishedAt.getTime() - pipelineStartedAt.getTime()) / 1000),
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
      route: '/api/generation-task-items/[taskItemId]/slot-fill',
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
      `模型自动回填失败，已转为人工核查：${getErrorMessage(error)}`,
    );

    await recalculateTaskSummary(admin, params.item.task_id);

    await logEvent({
      ownerId: params.item.owner_id,
      actorEmail: params.actorEmail,
      level: 'error',
      eventType: 'generation_task_item_slot_fill_failed',
      message: getErrorMessage(error),
      route: '/api/generation-task-items/[taskItemId]/slot-fill',
      templateId: params.item.template_id,
      taskId: params.item.task_id,
      taskItemId: params.item.id,
      payload: buildErrorLogPayload(error, {
        sourcePdfName: params.item.source_pdf_name,
        slotCount: slotSchema.length,
        pageCount: pages.length,
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

    if (['review_pending', 'reviewed', 'succeeded'].includes(item.status)) {
      return NextResponse.json({
        data: {
          item,
        },
      });
    }

    if (item.status === 'slot_filling') {
      return NextResponse.json({
        data: {
          item,
        },
      });
    }

    if (item.status !== 'ocr_completed') {
      return NextResponse.json(
        {
          code: 'GENERATION_TASK_ITEM_OCR_NOT_READY',
          message: '当前任务项尚未完成 OCR，暂时不能开始槽位回填。',
        },
        { status: 409 },
      );
    }

    after(async () => {
      await runGenerationTaskItemSlotFill({
        item,
        actorEmail: user.email ?? null,
      });
    });

    return NextResponse.json(
      {
        data: {
          item: {
            ...item,
            status: 'slot_filling',
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
      eventType: 'generation_task_item_slot_fill_request_failed',
      message,
      route: '/api/generation-task-items/[taskItemId]/slot-fill',
      taskItemId,
      payload: buildErrorLogPayload(error),
    });

    return NextResponse.json(
      {
        code: 'GENERATION_TASK_ITEM_SLOT_FILL_FAILED',
        message,
      },
      { status: 500 },
    );
  }
}
