import { z } from 'zod';
import { templateSlotExtractionResultSchema } from '@/src/app/api/types/template-slot-extraction';

export const templateExtractionTaskStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
]);

export const templateExtractionTaskResponseSchema = z.object({
  id: z.string().uuid(),
  status: templateExtractionTaskStatusSchema,
  source_docx_name: z.string(),
  prompt: z.string(),
  total_paragraphs: z.number().int().nonnegative(),
  completed_paragraphs: z.number().int().nonnegative(),
  processing_trace: z.string().default(''),
  upload_text: z.string().nullable().optional(),
  upload_html: z.string().nullable().optional(),
  result: templateSlotExtractionResultSchema.nullable().optional(),
  error_message: z.string().nullable().optional(),
  created_at: z.string(),
  started_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
});

export type TemplateExtractionTaskStatus = z.infer<typeof templateExtractionTaskStatusSchema>;
export type TemplateExtractionTaskResponse = z.infer<typeof templateExtractionTaskResponseSchema>;
