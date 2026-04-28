import mammoth from 'mammoth';
import {
  templateSlotExtractionResultSchema,
  type TemplateSlotExtractionResult,
} from '@/src/app/api/types/template-slot-extraction';
import {
  getTextLlmApiKey,
  getTextLlmBaseUrl,
  getTextLlmModel,
} from '@/src/lib/llm/env';
import { normalizeSlotCategoryLabel } from '@/src/lib/templates/slot-category';

const EXTRACTION_TIMEOUT_MS = 120000;
const EXTRACTION_MAX_RETRIES = 2;
const MIN_PARAGRAPH_CHARACTER_COUNT = 6;

const EXTRACTION_SYSTEM_PROMPT = `
你是中文法律文书模板槽位抽取助手。

你的基础抽取任务如下：
1. 只处理当前传入的单个段落，只能依据当前段落内容抽取槽位。
2. 默认优先抽取与“被申请人 / 被告 / 借款人 / 乙方 / 客户”等目标主体直接相关的信息。
3. 默认重点关注的字段包括但不限于：姓名、身份证号、民族、性别、出生日期、住址、联系电话、金额、日期、百分比、利率、分期期数等。

抽取规则：
1. 只返回 JSON，不要返回解释、Markdown、代码块或其他多余文本。
2. 只能抽取当前段落中真实出现的信息，不要编造，也不要补全未出现的值。
3. items 必须按照原文出现顺序输出。
4. original_value 必须保留原文格式。
5. original_doc_position 必须来自当前段落、能够定位到原文的精确短语或片段。
6. 同一段中如果出现多个不同含义的日期、金额、百分比、利率等，必须分别抽取，不能合并，也不能遗漏。
7. field_category 必须返回中文，不要返回 vehicle_plate_number、vehicle_brand 这种英文字段名。
8. 除非用户明确要求，否则忽略与目标主体无关的申请人、法院、仲裁委、代理人等主体信息。

固定 JSON 结构：
{
  "document_info": {
    "document_name": "文件名"
  },
  "extraction_result": [
    {
      "paragraph_index": 0,
      "paragraph_title": "段落标题",
      "items": [
        {
          "sequence": 1,
          "paragraph_index": 0,
          "field_category": "中文字段类别",
          "original_value": "原文中的具体值",
          "meaning_to_applicant": "这个值对目标主体的含义",
          "original_doc_position": "来自原文的定位片段"
        }
      ]
    }
  ]
}`.trim();

interface ExtractedParagraph {
  paragraph_index: number;
  paragraph_title: string;
  paragraph_text: string;
}

interface ParagraphProgress {
  completedParagraphs: number;
  totalParagraphs: number;
}

interface ExtractTemplateSlotsFromDocxParams {
  buffer: Buffer;
  prompt: string;
  fileName: string;
  onParagraphComplete?: (progress: ParagraphProgress) => Promise<void> | void;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveChatCompletionsUrl(baseUrl: string) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  if (normalizedBaseUrl.endsWith('/chat/completions')) {
    return normalizedBaseUrl;
  }

  return `${normalizedBaseUrl}/chat/completions`;
}

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

async function requestTextLlmJson(prompt: string) {
  for (let attempt = 0; attempt <= EXTRACTION_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);

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
              content: EXTRACTION_SYSTEM_PROMPT,
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
        }),
      });

      if (!upstream.ok) {
        const details = await upstream.text();
        const isRetryable =
          upstream.status === 408 ||
          upstream.status === 429 ||
          upstream.status >= 500;

        if (isRetryable && attempt < EXTRACTION_MAX_RETRIES) {
          await wait(1000 * (attempt + 1));
          continue;
        }

        throw new Error(`Text LLM request failed (${upstream.status}): ${details}`);
      }

      const payload = await upstream.json();
      const rawContent = payload?.choices?.[0]?.message?.content;

      if (typeof rawContent !== 'string' || !rawContent.trim()) {
        throw new Error('Text LLM returned empty content.');
      }

      return normalizeJsonText(rawContent);
    } catch (error) {
      const isTimeout = error instanceof DOMException && error.name === 'AbortError';

      if ((isTimeout || error instanceof TypeError) && attempt < EXTRACTION_MAX_RETRIES) {
        await wait(1000 * (attempt + 1));
        continue;
      }

      if (isTimeout) {
        throw new Error('Template slot extraction timed out.');
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error('Template slot extraction timed out.');
}

export async function extractTextFromDocxBuffer(buffer: Buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return value.trim();
}

export async function extractHtmlFromDocxBuffer(buffer: Buffer) {
  const { value } = await mammoth.convertToHtml({ buffer });
  return value.trim();
}

function buildParagraphTitle(paragraphText: string, paragraphIndex: number) {
  const normalized = paragraphText.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return `第 ${paragraphIndex + 1} 段`;
  }

  if (normalized.length <= 24) {
    return normalized;
  }

  return `${normalized.slice(0, 24)}...`;
}

function countMeaningfulCharacters(paragraphText: string) {
  return paragraphText.replace(/\s+/g, '').length;
}

export function extractParagraphsFromRawText(uploadText: string): ExtractedParagraph[] {
  return uploadText
    .split(/\n{2,}/)
    .map((paragraphText) => paragraphText.trim())
    .filter(Boolean)
    .map((paragraphText, paragraphIndex) => ({
      paragraph_index: paragraphIndex,
      paragraph_title: buildParagraphTitle(paragraphText, paragraphIndex),
      paragraph_text: paragraphText,
    }));
}

export function filterExtractableParagraphs(paragraphs: ExtractedParagraph[]) {
  return paragraphs.filter(
    (paragraph) => countMeaningfulCharacters(paragraph.paragraph_text) >= MIN_PARAGRAPH_CHARACTER_COUNT,
  );
}

export function countExtractableParagraphsFromRawText(uploadText: string) {
  return filterExtractableParagraphs(extractParagraphsFromRawText(uploadText)).length;
}

async function extractSlotsForParagraph(params: {
  fileName: string;
  prompt: string;
  paragraph: ExtractedParagraph;
}) {
  const userPrompt = [
    `文件名：${params.fileName}`,
    params.prompt
      ? `额外抽取要求：在基础抽取内容之外，还需要额外抽取以下内容：${params.prompt}`
      : '额外抽取要求：无，按基础抽取内容执行。',
    `当前段落序号：${params.paragraph.paragraph_index}`,
    `当前段落标题：${params.paragraph.paragraph_title}`,
    '请只从下面这个段落中抽取槽位。',
    params.paragraph.paragraph_text,
  ].join('\n\n');

  const rawJson = await requestTextLlmJson(userPrompt);
  const parsed = JSON.parse(rawJson);
  const object = templateSlotExtractionResultSchema.parse(parsed);
  const extractedParagraph = object.extraction_result[0];

  if (!extractedParagraph) {
    return null;
  }

  return {
    paragraph_index: params.paragraph.paragraph_index,
    paragraph_title:
      extractedParagraph.paragraph_title?.trim() || params.paragraph.paragraph_title,
    items: extractedParagraph.items.map((item) => ({
      ...item,
      field_category: normalizeSlotCategoryLabel(item.field_category),
      paragraph_index: params.paragraph.paragraph_index,
    })),
  };
}

async function extractParagraphsConcurrently(params: {
  fileName: string;
  prompt: string;
  paragraphs: ExtractedParagraph[];
  onParagraphComplete?: (progress: ParagraphProgress) => Promise<void> | void;
}) {
  const extractedParagraphs: Array<{
    paragraph_index: number;
    paragraph_title: string;
    items: Array<{
      sequence: number;
      paragraph_index?: number | null;
      field_category: string;
      original_value: string;
      meaning_to_applicant: string;
      original_doc_position: string;
    }>;
  }> = [];

  let completedParagraphs = 0;
  const totalParagraphs = params.paragraphs.length;

  const results = await Promise.all(
    params.paragraphs.map(async (paragraph) => {
      const result = await extractSlotsForParagraph({
        fileName: params.fileName,
        prompt: params.prompt,
        paragraph,
      });

      completedParagraphs += 1;
      await params.onParagraphComplete?.({
        completedParagraphs,
        totalParagraphs,
      });

      return result;
    }),
  );

  for (const result of results) {
    if (!result || result.items.length === 0) {
      continue;
    }

    extractedParagraphs.push(result);
  }

  return extractedParagraphs;
}

export async function extractTemplateSlotsFromDocx(
  params: ExtractTemplateSlotsFromDocxParams,
): Promise<TemplateSlotExtractionResult & {
  uploadText: string;
  uploadHtml: string;
  totalParagraphs: number;
}> {
  const uploadText = await extractTextFromDocxBuffer(params.buffer);
  const uploadHtml = await extractHtmlFromDocxBuffer(params.buffer);

  if (!uploadText) {
    throw new Error('No usable text was extracted from the DOCX file.');
  }

  const paragraphs = extractParagraphsFromRawText(uploadText);

  if (paragraphs.length === 0) {
    throw new Error('No usable paragraphs were found in the DOCX file.');
  }

  const extractableParagraphs = filterExtractableParagraphs(paragraphs);

  if (extractableParagraphs.length === 0) {
    throw new Error('No extractable paragraphs were found in the DOCX file.');
  }

  const extractedParagraphs = await extractParagraphsConcurrently({
    fileName: params.fileName,
    prompt: params.prompt,
    paragraphs: extractableParagraphs,
    onParagraphComplete: params.onParagraphComplete,
  });

  extractedParagraphs.sort((left, right) => left.paragraph_index - right.paragraph_index);

  let nextSequence = 1;
  const normalizedExtractionResult = extractedParagraphs.map((paragraph) => ({
    ...paragraph,
    items: paragraph.items.map((item) => ({
      ...item,
      sequence: nextSequence++,
    })),
  }));

  return {
    document_info: {
      document_name: params.fileName,
    },
    extraction_result: normalizedExtractionResult,
    uploadText,
    uploadHtml,
    totalParagraphs: extractableParagraphs.length,
  };
}
