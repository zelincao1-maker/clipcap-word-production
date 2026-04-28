import { NextResponse } from 'next/server';
import { logEvent } from '@/src/lib/logging/log-event';
import { createSupabaseServerClient } from '@/src/lib/supabase/server';

interface ClientLogRequestBody {
  level?: 'info' | 'warning' | 'error';
  eventType?: string;
  message?: string;
  route?: string | null;
  templateId?: string | null;
  taskId?: string | null;
  taskItemId?: string | null;
  payload?: Record<string, unknown> | null;
}

function createUnauthorizedResponse() {
  return NextResponse.json(
    {
      code: 'UNAUTHORIZED',
      message: '请先登录后再继续。',
    },
    { status: 401 },
  );
}

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return createUnauthorizedResponse();
  }

  try {
    const body = (await request.json()) as ClientLogRequestBody;
    const eventType = typeof body.eventType === 'string' ? body.eventType.trim() : '';
    const message = typeof body.message === 'string' ? body.message.trim() : '';

    if (!eventType || !message) {
      return NextResponse.json(
        {
          code: 'CLIENT_LOG_INVALID',
          message: '前端日志缺少必要字段。',
        },
        { status: 400 },
      );
    }

    await logEvent({
      ownerId: user.id,
      actorEmail: user.email ?? null,
      level: body.level ?? 'error',
      eventType,
      message,
      route: body.route ?? null,
      templateId: body.templateId ?? null,
      taskId: body.taskId ?? null,
      taskItemId: body.taskItemId ?? null,
      payload: body.payload ?? {},
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        code: 'CLIENT_LOG_WRITE_FAILED',
        message: error instanceof Error ? error.message : '前端日志写入失败。',
      },
      { status: 500 },
    );
  }
}
