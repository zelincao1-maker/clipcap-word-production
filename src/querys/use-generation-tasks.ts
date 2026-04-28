'use client';

import { useMutation } from '@tanstack/react-query';
import type { CreateGenerationTaskResponse } from '@/src/app/api/types/generation-task';

export interface CreateGenerationTaskFileInput {
  file: File;
  selectedOriginalPageNumbers: number[];
  uploadedPageNumberMapping: Array<{
    uploaded_page_number: number;
    original_page_number: number;
  }>;
  originalTotalPages: number;
  selectedPageRangeLabel: string;
  forceOcr: boolean;
}

export interface CreateGenerationTaskInput {
  templateId: string;
  templateName: string;
  files: CreateGenerationTaskFileInput[];
}

async function reportClientError(input: {
  eventType: string;
  message: string;
  route: string;
  templateId?: string | null;
  payload?: Record<string, unknown>;
}) {
  try {
    await fetch('/api/client-logs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        level: 'error',
        eventType: input.eventType,
        message: input.message,
        route: input.route,
        templateId: input.templateId ?? null,
        payload: input.payload ?? {},
      }),
    });
  } catch (error) {
    console.error('[Client Log] Failed to report frontend error', {
      eventType: input.eventType,
      message: input.message,
      error,
    });
  }
}

async function parseApiPayload<T>(
  response: Response,
): Promise<{
  payload: T | null;
  message: string | null;
}> {
  const contentType = response.headers.get('content-type') ?? '';
  const rawText = await response.text();

  if (!rawText) {
    return { payload: null, message: null };
  }

  if (contentType.includes('application/json')) {
    try {
      const payload = JSON.parse(rawText) as T & { message?: string };
      return {
        payload,
        message:
          typeof payload === 'object' &&
          payload !== null &&
          'message' in payload &&
          typeof payload.message === 'string'
            ? payload.message
            : null,
      };
    } catch {
      return { payload: null, message: rawText };
    }
  }

  return { payload: null, message: rawText };
}

export function useCreateGenerationTask() {
  return useMutation({
    mutationFn: async (input: CreateGenerationTaskInput) => {
      const formData = new FormData();
      formData.append('templateId', input.templateId);
      formData.append('templateName', input.templateName);
      formData.append(
        'fileMetadatas',
        JSON.stringify(
          input.files.map((item) => ({
            file_name: item.file.name,
            selected_original_page_numbers: item.selectedOriginalPageNumbers,
            uploaded_page_number_mapping: item.uploadedPageNumberMapping,
            original_total_pages: item.originalTotalPages,
            selected_page_count: item.selectedOriginalPageNumbers.length,
            selected_page_range_label: item.selectedPageRangeLabel,
            force_ocr: item.forceOcr,
          })),
        ),
      );

      input.files.forEach((item) => {
        formData.append('files', item.file);
      });

      const response = await fetch('/api/generation-tasks', {
        method: 'POST',
        body: formData,
      });

      const { payload, message } = await parseApiPayload<{
        message?: string;
        data?: CreateGenerationTaskResponse;
      }>(response);

      if (!response.ok || !payload?.data) {
        const errorMessage = message ?? '创建批量生成任务失败，请稍后重试。';
        console.error('[Generation Task] Create failed', {
          status: response.status,
          statusText: response.statusText,
          message: errorMessage,
          templateId: input.templateId,
          templateName: input.templateName,
          fileCount: input.files.length,
          fileNames: input.files.map((item) => item.file.name),
        });

        await reportClientError({
          eventType: 'generation_task_create_failed_frontend',
          message: errorMessage,
          route: '/api/generation-tasks',
          templateId: input.templateId,
          payload: {
            status: response.status,
            statusText: response.statusText,
            templateName: input.templateName,
            fileCount: input.files.length,
            fileNames: input.files.map((item) => item.file.name),
          },
        });

        throw new Error(errorMessage);
      }

      return payload.data;
    },
  });
}

export function useDeleteGenerationTask() {
  return useMutation({
    mutationFn: async (taskId: string) => {
      const response = await fetch(`/api/generation-tasks/${taskId}`, {
        method: 'DELETE',
      });

      const { payload, message } = await parseApiPayload<{
        message?: string;
        data?: { id: string };
      }>(response);

      if (!response.ok || !payload?.data) {
        throw new Error(message ?? '删除批量生成任务失败，请稍后重试。');
      }

      return payload.data;
    },
  });
}

export function useDeleteGenerationTaskItem() {
  return useMutation({
    mutationFn: async (taskItemId: string) => {
      const response = await fetch(`/api/generation-task-items/${taskItemId}`, {
        method: 'DELETE',
      });

      const { payload, message } = await parseApiPayload<{
        message?: string;
        data?: { id: string; task_id: string | null; already_deleted?: boolean };
      }>(response);

      if (!response.ok || !payload?.data) {
        throw new Error(message ?? '删除任务项失败，请稍后重试。');
      }

      return payload.data;
    },
  });
}
