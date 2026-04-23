import { z } from 'zod';
import {
  getTextLlmApiKey,
  getTextLlmBaseUrl,
  getTextLlmModel,
  getVisionLlmApiKey,
  getVisionLlmBaseUrl,
  getVisionLlmModel,
} from '@/src/lib/llm/env';

export interface GenerationSlotSchemaItem {
  slot_key: string;
  field_category: string;
  meaning_to_applicant: string;
}

export interface PdfPageInput {
  page_number: number;
  text: string;
}

export interface PdfVisionPageInput {
  page_number: number;
  image_data_url: string;
}

interface ModelMatch {
  value?: string;
  snippet?: string;
  page_number?: number | null;
}

interface ModelResultCandidate {
  slot_key?: string;
  slot_name?: string;
  final_value?: string;
  matches?: ModelMatch[];
}

const generationExtractedItemSchema = z.object({
  slot_key: z.string(),
  field_category: z.string(),
  meaning_to_applicant: z.string(),
  original_value: z.string(),
  evidence: z.string().nullable().optional(),
  evidence_page_numbers: z.array(z.number().int()).optional().default([]),
  notes: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

const generationPdfFillResultSchema = z.object({
  document_summary: z.string().nullable().optional(),
  extracted_items: z.array(generationExtractedItemSchema).optional().default([]),
});

const PDF_SLOT_FILL_TEXT_TIMEOUT_MS = 90000;
const PDF_SLOT_FILL_VISION_TIMEOUT_MS = 240000;
const MAX_TEXT_PAGES_PER_CHUNK = 2;
const MAX_TEXT_CHARS_PER_CHUNK = 2200;
const MAX_VISION_PAGES_PER_REQUEST = 1;
const MAX_VISION_BATCH_CONCURRENCY = 6;
const MAX_TEXT_SLOT_CONCURRENCY = 4;

function normalizeJsonText(rawContent: string) {
  const trimmed = rawContent.trim();
  const withoutCodeFence = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (withoutCodeFence.startsWith('{') || withoutCodeFence.startsWith('[')) {
    return withoutCodeFence;
  }

  const firstBrace = withoutCodeFence.indexOf('{');
  const lastBrace = withoutCodeFence.lastIndexOf('}');

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return withoutCodeFence.slice(firstBrace, lastBrace + 1);
  }

  return withoutCodeFence;
}

function repairCommonJsonBarewords(rawJson: string) {
  return rawJson
    .replace(
      /(:\s*)(无|空|未知|未提及|未找到|暂无|缺失|没有)(?=\s*[,}\]])/g,
      '$1null',
    )
    .replace(
      /([\[,]\s*)(无|空|未知|未提及|未找到|暂无|缺失|没有)(?=\s*[,}\]])/g,
      '$1null',
    );
}

function parseModelJson<T>(rawContent: string): T {
  const normalized = normalizeJsonText(rawContent);
  const repaired = repairCommonJsonBarewords(normalized);

  try {
    return JSON.parse(repaired) as T;
  } catch (error) {
    const preview = repaired.slice(0, 240);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Model JSON parse failed: ${reason}. Snippet: ${preview}`);
  }
}

function normalizeSlotIdentifier(value: string | null | undefined) {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。,、“”"'`（）()\[\]【】{}<>《》\-_/]/g, '');
}

function findResultForSlot(
  slot: GenerationSlotSchemaItem,
  results: ModelResultCandidate[] | undefined,
  options?: { fallbackToSingleResult?: boolean },
) {
  if (!results?.length) {
    return null;
  }

  const normalizedSlotKey = normalizeSlotIdentifier(slot.slot_key);
  const normalizedSlotName = normalizeSlotIdentifier(slot.field_category);

  const bySlotKey = results.find(
    (candidate) => normalizeSlotIdentifier(candidate.slot_key) === normalizedSlotKey,
  );

  if (bySlotKey) {
    return bySlotKey;
  }

  const byExactName = results.find(
    (candidate) => normalizeSlotIdentifier(candidate.slot_name) === normalizedSlotName,
  );

  if (byExactName) {
    return byExactName;
  }

  const byLooseName = results.find((candidate) => {
    const normalizedCandidateName = normalizeSlotIdentifier(candidate.slot_name);

    return (
      Boolean(normalizedCandidateName) &&
      (normalizedCandidateName.includes(normalizedSlotName) ||
        normalizedSlotName.includes(normalizedCandidateName))
    );
  });

  if (byLooseName) {
    return byLooseName;
  }

  if (options?.fallbackToSingleResult && results.length === 1) {
    return results[0] ?? null;
  }

  return null;
}

function resolveChatCompletionsUrl(baseUrl: string) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  if (normalizedBaseUrl.endsWith('/chat/completions')) {
    return normalizedBaseUrl;
  }

  return `${normalizedBaseUrl}/chat/completions`;
}

function getSlotSemanticHint(slotName: string) {
  if (slotName.includes('身份证')) {
    return 'Target field is a Chinese identity card number or certificate number.';
  }

  if (slotName.includes('电话') || slotName.includes('手机') || slotName.includes('联系')) {
    return 'Target field is a contact phone number or mobile number.';
  }

  if (slotName.includes('出生')) {
    return 'Target field is a birth date.';
  }

  if (slotName.includes('住址') || slotName.includes('地址')) {
    return 'Target field is an address or residence.';
  }

  return 'Find the value that best matches the meaning of this slot.';
}

function getSlotKeywords(slotName: string) {
  const base = [slotName, '被申请人', '被告', '借款人', '乙方', '客户', '共同借款人'];

  if (slotName.includes('身份证')) {
    return [...base, '身份证', '公民身份号码', '身份证号', '证件号码'];
  }

  if (slotName.includes('电话') || slotName.includes('手机') || slotName.includes('联系')) {
    return [...base, '电话', '手机', '联系电话', '联系方式', '手机号'];
  }

  if (slotName.includes('出生')) {
    return [...base, '出生', '出生日期', '生日', '生于'];
  }

  if (slotName.includes('住址') || slotName.includes('地址')) {
    return [...base, '住址', '地址', '住所地', '联系地址', '通讯地址', '户籍地址'];
  }

  return base;
}

function scorePageForSlot(slotName: string, page: PdfPageInput) {
  const keywords = getSlotKeywords(slotName);
  let score = 0;

  for (const keyword of keywords) {
    if (page.text.includes(keyword)) {
      score += keyword === slotName ? 4 : 1;
    }
  }

  if (
    page.text.includes('身份证') ||
    page.text.includes('借款人') ||
    page.text.includes('客户') ||
    page.text.includes('申请人') ||
    page.text.includes('姓名') ||
    page.text.includes('地址') ||
    page.text.includes('电话')
  ) {
    score += 1;
  }

  return score;
}

function buildSlotContexts(slotName: string, pages: PdfPageInput[]) {
  const rankedPages = pages
    .map((page) => ({
      page,
      score: scorePageForSlot(slotName, page),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.page.page_number - right.page.page_number);

  const sourcePages = rankedPages.length > 0 ? rankedPages.map((item) => item.page) : pages;
  const orderedPages = [...sourcePages].sort((left, right) => left.page_number - right.page_number);
  const contexts: Array<{ pageNumbers: number[]; chunkText: string }> = [];
  let currentPages: number[] = [];
  let currentText = '';

  const flush = () => {
    if (!currentPages.length || !currentText.trim()) {
      return;
    }

    contexts.push({
      pageNumbers: [...currentPages],
      chunkText: currentText.trim(),
    });
    currentPages = [];
    currentText = '';
  };

  for (const page of orderedPages) {
    const pageText = `[Page ${page.page_number}]\n${page.text}\n`;

    if (
      currentPages.length >= MAX_TEXT_PAGES_PER_CHUNK ||
      currentText.length + pageText.length > MAX_TEXT_CHARS_PER_CHUNK
    ) {
      flush();
    }

    currentPages.push(page.page_number);
    currentText += pageText;
  }

  flush();
  return contexts;
}

async function extractSlotWithTextModel(input: {
  documentName: string;
  slot: GenerationSlotSchemaItem;
  pageNumbers: number[];
  chunkText: string;
}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PDF_SLOT_FILL_TEXT_TIMEOUT_MS);

  try {
    const upstream = await fetch(resolveChatCompletionsUrl(getTextLlmBaseUrl()), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getTextLlmApiKey()}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: getTextLlmModel(),
        messages: [
          {
            role: 'system',
            content:
              'You are a PDF slot filling assistant. Extract only the current slot from the provided PDF text chunk. Return JSON only.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              document_name: input.documentName,
              slot_key: input.slot.slot_key,
              slot_name: input.slot.field_category,
              slot_hint:
                input.slot.meaning_to_applicant || getSlotSemanticHint(input.slot.field_category),
              strict_requirement:
                'Return the exact same slot_key in results[0].slot_key. final_value must be the exact value used for filling. matches[0].value must equal final_value. matches[0].snippet must contain final_value as a direct quote from the PDF text chunk.',
              page_numbers: input.pageNumbers,
              content: input.chunkText,
              output_schema: {
                results: [
                  {
                    slot_key: input.slot.slot_key,
                    slot_name: input.slot.field_category,
                    final_value: 'final extracted value',
                    matches: [
                      {
                        value: 'matched value',
                        snippet: 'short supporting quote from the PDF text',
                        page_number: 1,
                      },
                    ],
                  },
                ],
              },
            }),
          },
        ],
      }),
    });

    if (!upstream.ok) {
      const details = await upstream.text();
      throw new Error(`Text model request failed (${upstream.status}): ${details}`);
    }

    const payload = await upstream.json();
    const rawContent = payload?.choices?.[0]?.message?.content;

    if (typeof rawContent !== 'string' || !rawContent.trim()) {
      return {
        extracted_items: [],
        document_summary: '',
      };
    }

    const normalized = parseModelJson<{
      results?: ModelResultCandidate[];
    }>(rawContent);

    const firstResult = findResultForSlot(input.slot, normalized.results, {
      fallbackToSingleResult: true,
    });
    const firstMatch = firstResult?.matches?.find(
      (match) =>
        typeof match?.value === 'string' &&
        Boolean(match.value.trim()) &&
        typeof match?.snippet === 'string' &&
        Boolean(match.snippet.trim()),
    );

    if (!firstResult && !firstMatch) {
      return {
        extracted_items: [],
        document_summary: '',
      };
    }

    const extractedValue = resolveExtractedValue(firstResult, firstMatch);

    return {
      document_summary: '',
      extracted_items: [
        {
          slot_key: input.slot.slot_key,
          field_category: input.slot.field_category,
          meaning_to_applicant: input.slot.meaning_to_applicant,
          original_value: extractedValue,
          evidence: resolveEvidenceSnippet(extractedValue, firstMatch),
          evidence_page_numbers:
            typeof firstMatch?.page_number === 'number'
              ? [firstMatch.page_number]
              : input.pageNumbers,
          notes: '',
          confidence: null,
        },
      ],
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Text slot extraction timed out.');
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function extractSlotsWithVisionModel(input: {
  documentName: string;
  slots: GenerationSlotSchemaItem[];
  visionPages: PdfVisionPageInput[];
}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PDF_SLOT_FILL_VISION_TIMEOUT_MS);

  try {
    const content: Array<
      | { type: 'image_url'; image_url: { url: string } }
      | { type: 'text'; text: string }
    > = input.visionPages.map((page) => ({
      type: 'image_url',
      image_url: {
        url: page.image_data_url,
      },
    }));

    content.push({
      type: 'text',
      text: JSON.stringify({
        task:
          'Review all provided PDF page images and extract slot values. Return JSON only. Every result item must include the exact slot_key copied from slot_definitions. final_value must be the exact value used for filling. The first match.value must equal final_value. The first match.snippet must contain final_value as a direct quote from the page.',
        document_name: input.documentName,
        slot_names: input.slots.map((slot) => slot.field_category),
        slot_definitions: input.slots.map((slot) => ({
          slot_key: slot.slot_key,
          slot_name: slot.field_category,
          slot_meaning:
            slot.meaning_to_applicant || getSlotSemanticHint(slot.field_category),
        })),
        page_numbers: input.visionPages.map((page) => page.page_number),
        output_schema: {
          results: [
            {
              slot_key: 'slot key from slot_definitions',
              slot_name: 'slot name',
              final_value: 'final extracted value',
              matches: [
                {
                  value: 'matched value',
                  snippet: 'short supporting quote from the PDF page',
                  page_number: 1,
                },
              ],
            },
          ],
        },
      }),
    });

    const upstream = await fetch(resolveChatCompletionsUrl(getVisionLlmBaseUrl()), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getVisionLlmApiKey()}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: getVisionLlmModel(),
        messages: [
          {
            role: 'system',
            content:
              'You are a PDF slot filling assistant. Read the provided PDF page images and return JSON only.',
          },
          {
            role: 'user',
            content,
          },
        ],
      }),
    });

    if (!upstream.ok) {
      const details = await upstream.text();
      throw new Error(`Vision model request failed (${upstream.status}): ${details}`);
    }

    const payload = await upstream.json();
    const rawContent = payload?.choices?.[0]?.message?.content;

    if (typeof rawContent !== 'string' || !rawContent.trim()) {
      return {
        document_summary: '',
        extracted_items: [],
      };
    }

    const normalized = parseModelJson<{
      results?: ModelResultCandidate[];
    }>(rawContent);

    const extracted_items = input.slots.flatMap((slot) => {
      const result = findResultForSlot(slot, normalized.results);
      const firstMatch = result?.matches?.find(
        (match) =>
          typeof match?.value === 'string' &&
          Boolean(match.value.trim()) &&
          typeof match?.snippet === 'string' &&
          Boolean(match.snippet.trim()),
      );

      if (!result && !firstMatch) {
        return [];
      }

      const extractedValue = resolveExtractedValue(result, firstMatch);

      return [
        {
          slot_key: slot.slot_key,
          field_category: slot.field_category,
          meaning_to_applicant: slot.meaning_to_applicant,
          original_value: extractedValue,
          evidence: resolveEvidenceSnippet(extractedValue, firstMatch),
          evidence_page_numbers:
            result?.matches
              ?.map((match) => match?.page_number)
              .filter((value): value is number => typeof value === 'number') ?? [],
          notes: '',
          confidence: null,
        },
      ];
    });

    return {
      document_summary: '',
      extracted_items,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Vision model processing timed out.');
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function mergeSlotResults(
  slots: GenerationSlotSchemaItem[],
  results: z.infer<typeof generationPdfFillResultSchema>[],
) {
  return {
    document_summary: '',
    extracted_items: slots.map((slot) => {
      const preferredMatch =
        results
          .flatMap((result) =>
            result.extracted_items.filter((item) => item.slot_key === slot.slot_key),
          )
          .find((item) => item.original_value.trim()) ?? null;

      return {
        slot_key: slot.slot_key,
        field_category: slot.field_category,
        meaning_to_applicant: slot.meaning_to_applicant,
        original_value: preferredMatch?.original_value ?? '',
        evidence: preferredMatch?.evidence ?? '',
        evidence_page_numbers: Array.from(
          new Set(
            results
              .flatMap((result) =>
                result.extracted_items.filter((item) => item.slot_key === slot.slot_key),
              )
              .flatMap((item) => item.evidence_page_numbers ?? []),
          ),
        ).sort((left, right) => left - right),
        notes: preferredMatch?.notes ?? '',
        confidence: preferredMatch?.confidence ?? null,
      };
    }),
  };
}

function buildVisionPageBatches(visionPages: PdfVisionPageInput[]) {
  const batches: PdfVisionPageInput[][] = [];

  for (let index = 0; index < visionPages.length; index += MAX_VISION_PAGES_PER_REQUEST) {
    batches.push(visionPages.slice(index, index + MAX_VISION_PAGES_PER_REQUEST));
  }

  return batches;
}

function hasFilledValue(value: string | null | undefined) {
  return Boolean(value?.trim());
}

function resolveExtractedValue(result: ModelResultCandidate | null, firstMatch?: ModelMatch) {
  return result?.final_value?.trim() || firstMatch?.value?.trim() || '';
}

function resolveEvidenceSnippet(extractedValue: string, firstMatch?: ModelMatch) {
  const snippet = firstMatch?.snippet?.trim() || '';

  if (!snippet) {
    return extractedValue;
  }

  if (extractedValue && !snippet.includes(extractedValue)) {
    return extractedValue;
  }

  return snippet;
}

async function runWithConcurrency<TInput, TOutput>(params: {
  items: TInput[];
  concurrency: number;
  worker: (item: TInput, index: number) => Promise<TOutput>;
}) {
  const { items, concurrency, worker } = params;

  if (items.length === 0) {
    return [] as TOutput[];
  }

  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  async function consume() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex] as TInput, currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => consume()));
  return results;
}

export async function fillTemplateSlotsFromPdf(params: {
  pdfFileName: string;
  templateName: string;
  templatePrompt: string;
  slots: GenerationSlotSchemaItem[];
  pages: PdfPageInput[];
  visionPages?: PdfVisionPageInput[];
  likelyScanned?: boolean;
  totalTextLength?: number;
}) {
  if (params.slots.length === 0) {
    return {
      document_summary: '',
      extracted_items: [],
    };
  }

  const validPages = params.pages.filter((page) => page.text.trim().length > 0);
  const validVisionPages = (params.visionPages ?? []).filter((page) =>
    page.image_data_url.startsWith('data:image/'),
  );

  const shouldUseVision =
    validVisionPages.length > 0 &&
    (params.likelyScanned === true ||
      validPages.length === 0 ||
      validPages.every((page) => page.text.trim().length <= 10) ||
      (typeof params.totalTextLength === 'number' &&
        params.totalTextLength <= Math.max(20, validPages.length * 10)));

  if (shouldUseVision) {
    const visionPageBatches = buildVisionPageBatches(validVisionPages);
    const visionResults: z.infer<typeof generationPdfFillResultSchema>[] = [];
    const resolvedSlotKeys = new Set<string>();

    for (
      let batchStartIndex = 0;
      batchStartIndex < visionPageBatches.length;
      batchStartIndex += MAX_VISION_BATCH_CONCURRENCY
    ) {
      const remainingSlots = params.slots.filter((slot) => !resolvedSlotKeys.has(slot.slot_key));

      if (remainingSlots.length === 0) {
        break;
      }

      const currentWave = visionPageBatches.slice(
        batchStartIndex,
        batchStartIndex + MAX_VISION_BATCH_CONCURRENCY,
      );

      const currentWaveResults = await runWithConcurrency({
        items: currentWave,
        concurrency: MAX_VISION_BATCH_CONCURRENCY,
        worker: async (visionPageBatch) =>
          extractSlotsWithVisionModel({
            documentName: params.pdfFileName,
            slots: remainingSlots,
            visionPages: visionPageBatch,
          }),
      });

      visionResults.push(...currentWaveResults);

      for (const result of currentWaveResults) {
        for (const item of result.extracted_items) {
          if (hasFilledValue(item.original_value)) {
            resolvedSlotKeys.add(item.slot_key);
          }
        }
      }
    }

    return mergeSlotResults(params.slots, visionResults);
  }

  const textTasks = params.slots.flatMap((slot) =>
    buildSlotContexts(slot.field_category, validPages).map((context) => ({
      slot,
      context,
    })),
  );

  const allResults = await runWithConcurrency({
    items: textTasks,
    concurrency: MAX_TEXT_SLOT_CONCURRENCY,
    worker: async ({ slot, context }) =>
      extractSlotWithTextModel({
        documentName: params.pdfFileName,
        slot,
        pageNumbers: context.pageNumbers,
        chunkText: context.chunkText,
      }),
  });

  return mergeSlotResults(params.slots, allResults);
}
