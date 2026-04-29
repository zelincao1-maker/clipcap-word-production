'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  SavedTemplateDetail,
  SavedTemplateSummary,
} from '@/src/app/api/types/template-library';
import { logClientRequestError } from '@/src/lib/network/client-request-error';
import type { SlotReviewSessionPayload } from '@/src/lib/templates/slot-review-session';

interface SaveTemplateInput {
  templateId?: string;
  templateName: string;
  slotReviewPayload: SlotReviewSessionPayload;
  slotPreview: unknown;
}

export function useUserTemplates(enabled = true) {
  return useQuery({
    queryKey: ['saved-templates'],
    enabled,
    queryFn: async () => {
      try {
        const response = await fetch('/api/templates');
        const payload = (await response.json()) as {
          message?: string;
          data?: SavedTemplateSummary[];
        };

        if (!response.ok || !payload.data) {
          throw new Error(payload.message ?? '读取模板列表失败，请稍后重试。');
        }

        return payload.data;
      } catch (error) {
        logClientRequestError({
          label: '[Templates] Request failed',
          route: '/api/templates',
          method: 'GET',
          error,
        });
        throw error;
      }
    },
  });
}

export function useSaveTemplate() {
  return useMutation({
    mutationFn: async (input: SaveTemplateInput) => {
      try {
        const response = await fetch('/api/templates', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(input),
        });

        const payload = (await response.json()) as {
          message?: string;
          data?: SavedTemplateSummary;
        };

        if (!response.ok || !payload.data) {
          throw new Error(payload.message ?? '模板保存失败，请稍后重试。');
        }

        return payload.data;
      } catch (error) {
        logClientRequestError({
          label: '[Templates] Save failed',
          route: '/api/templates',
          method: 'POST',
          error,
          extra: {
            templateName: input.templateName,
          },
        });
        throw error;
      }
    },
  });
}

export function useLoadTemplateForReview() {
  return useMutation({
    mutationFn: async (templateId: string) => {
      try {
        const response = await fetch(`/api/templates/${templateId}`);
        const payload = (await response.json()) as {
          message?: string;
          data?: SavedTemplateDetail;
        };

        if (!response.ok || !payload.data) {
          throw new Error(payload.message ?? '读取模板详情失败，请稍后重试。');
        }

        return payload.data;
      } catch (error) {
        logClientRequestError({
          label: '[Templates] Detail request failed',
          route: `/api/templates/${templateId}`,
          method: 'GET',
          error,
          extra: { templateId },
        });
        throw error;
      }
    },
  });
}

export function useDeleteTemplate() {
  return useMutation({
    mutationFn: async (templateId: string) => {
      try {
        const response = await fetch(`/api/templates/${templateId}`, {
          method: 'DELETE',
        });

        const payload = (await response.json()) as {
          message?: string;
          data?: { id: string };
        };

        if (!response.ok || !payload.data) {
          throw new Error(payload.message ?? '删除模板失败，请稍后重试。');
        }

        return payload.data;
      } catch (error) {
        logClientRequestError({
          label: '[Templates] Delete failed',
          route: `/api/templates/${templateId}`,
          method: 'DELETE',
          error,
          extra: { templateId },
        });
        throw error;
      }
    },
  });
}
