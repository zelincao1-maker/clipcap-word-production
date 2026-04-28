import { NextResponse } from 'next/server';
import { buildErrorLogPayload, logEvent } from '@/src/lib/logging/log-event';
import { extractTemplateSlotsFromDocx } from '@/src/lib/llm/extract-template-slots';
import { createSupabaseAdminClient } from '@/src/lib/supabase/admin';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 800;

function createUnauthorizedResponse() {
  return NextResponse.json(
    {
      code: 'UNAUTHORIZED',
      message: '请先登录后再继续。',
    },
    { status: 401 },
  );
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await context.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  const admin = createSupabaseAdminClient();

  try {
    const { data: task, error } = await supabase
      .from('template_extraction_tasks')
      .select(
        'id, owner_id, source_docx_name, source_docx_base64, prompt, status, total_paragraphs, completed_paragraphs',
      )
      .eq('id', taskId)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!task) {
      return NextResponse.json(
        {
          code: 'TEMPLATE_EXTRACTION_TASK_NOT_FOUND',
          message: '未找到该槽位抽取任务。',
        },
        { status: 404 },
      );
    }

    if (task.status === 'completed') {
      return NextResponse.json({
        data: {
          id: task.id,
          status: task.status,
        },
      });
    }

    if (task.status === 'running') {
      return NextResponse.json({
        data: {
          id: task.id,
          status: task.status,
        },
      });
    }

    await admin
      .from('template_extraction_tasks')
      .update({
        status: 'running',
        completed_paragraphs: 0,
        error_message: null,
        started_at: new Date().toISOString(),
        finished_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id);

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'info',
      eventType: 'template_extraction_task_started',
      message: `Started template extraction task for ${task.source_docx_name}.`,
      route: '/api/template-extraction-tasks/[taskId]/process',
      payload: {
        taskId: task.id,
        totalParagraphs: task.total_paragraphs,
      },
    });

    const buffer = Buffer.from(task.source_docx_base64, 'base64');
    let lastPersistedCompletedParagraphs = 0;
    let lastLoggedCompletedParagraphs = 0;

    const result = await extractTemplateSlotsFromDocx({
      buffer,
      fileName: task.source_docx_name,
      prompt: task.prompt ?? '',
      onParagraphComplete: async ({ completedParagraphs, totalParagraphs }) => {
        if (completedParagraphs === lastPersistedCompletedParagraphs) {
          return;
        }

        lastPersistedCompletedParagraphs = completedParagraphs;

        await admin
          .from('template_extraction_tasks')
          .update({
            total_paragraphs: totalParagraphs,
            completed_paragraphs: completedParagraphs,
            updated_at: new Date().toISOString(),
          })
          .eq('id', task.id);

        const shouldLogProgress =
          completedParagraphs === totalParagraphs ||
          completedParagraphs - lastLoggedCompletedParagraphs >= 5;

        if (shouldLogProgress) {
          lastLoggedCompletedParagraphs = completedParagraphs;

          await logEvent({
            ownerId: user.id,
            actorEmail: user.email ?? null,
            level: 'info',
            eventType: 'template_extraction_task_progress',
            message: `Template extraction task progressed to ${completedParagraphs}/${totalParagraphs} paragraphs.`,
            route: '/api/template-extraction-tasks/[taskId]/process',
            payload: {
              taskId: task.id,
              completedParagraphs,
              totalParagraphs,
              remainingParagraphs: Math.max(0, totalParagraphs - completedParagraphs),
            },
          });
        }
      },
    });

    await admin
      .from('template_extraction_tasks')
      .update({
        status: 'completed',
        total_paragraphs: result.totalParagraphs,
        completed_paragraphs: result.totalParagraphs,
        upload_text: result.uploadText,
        upload_html: result.uploadHtml,
        result: {
          document_info: result.document_info,
          extraction_result: result.extraction_result,
        },
        error_message: null,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id);

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'info',
      eventType: 'template_extraction_task_completed',
      message: `Completed template extraction task for ${task.source_docx_name}.`,
      route: '/api/template-extraction-tasks/[taskId]/process',
      payload: {
        taskId: task.id,
        totalParagraphs: result.totalParagraphs,
        extractedParagraphs: result.extraction_result.length,
        uploadTextLength: result.uploadText.length,
      },
    });

    return NextResponse.json({
      data: {
        id: task.id,
        status: 'completed',
      },
    });
  } catch (error) {
    await admin
      .from('template_extraction_tasks')
      .update({
        status: 'failed',
        error_message: error instanceof Error ? error.message : '槽位抽取失败，请稍后重试。',
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', taskId);

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: 'error',
      eventType: 'template_extraction_task_failed',
      message: error instanceof Error ? error.message : 'Failed to process template extraction task.',
      route: '/api/template-extraction-tasks/[taskId]/process',
      payload: buildErrorLogPayload(error, {
        taskId,
      }),
    });

    return NextResponse.json(
      {
        code: 'TEMPLATE_EXTRACTION_TASK_PROCESS_FAILED',
        message: error instanceof Error ? error.message : '槽位抽取失败，请稍后重试。',
      },
      { status: 500 },
    );
  }
}
