'use client';

import { useMutation } from '@tanstack/react-query';
import type { CreateGenerationTaskResponse } from '@/src/app/api/types/generation-task';
import type { ParsedPdfDocument } from '@/src/lib/pdf/client-pdf';

export interface CreateGenerationTaskFileInput {
  file: File;
  parsedPdf: ParsedPdfDocument;
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
            parsed_pdf: item.parsedPdf,
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

      const payload = (await response.json()) as {
        message?: string;
        data?: CreateGenerationTaskResponse;
      };

      if (!response.ok || !payload.data) {
        throw new Error(payload.message ?? '创建批量生成任务失败，请稍后重试。');
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

      const payload = (await response.json()) as {
        message?: string;
        data?: { id: string };
      };

      if (!response.ok || !payload.data) {
        throw new Error(payload.message ?? '删除批量生成任务失败，请稍后重试。');
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

      const payload = (await response.json()) as {
        message?: string;
        data?: { id: string; task_id: string | null; already_deleted?: boolean };
      };

      if (!response.ok || !payload.data) {
        throw new Error(payload.message ?? '删除任务项失败，请稍后重试。');
      }

      return payload.data;
    },
  });
}
