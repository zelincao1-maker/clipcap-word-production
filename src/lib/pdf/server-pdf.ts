import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { PdfVisionPageInput } from '@/src/lib/llm/fill-template-from-pdf';

const require = createRequire(import.meta.url);
const OCR_RENDER_SCALE = 6.0;
const OCR_IMAGE_FORMAT = 'image/png';
const VENDORED_CANVAS_MODULE_PATH = path.join(
  process.cwd(),
  'vendor-runtime',
  'napi-rs-runtime',
  'node_modules',
  '@napi-rs',
  'canvas',
  'index.js',
);
const PDFJS_CMAP_URL = `${pathToFileURL(
  path.join(
    process.cwd(),
    'node_modules',
    'pdfjs-dist',
    'cmaps',
  ),
).href}/`;
const PDFJS_STANDARD_FONT_DATA_URL = `${pathToFileURL(
  path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts'),
).href}/`;

export async function renderPdfPagesForVisionOnServer(input: {
  pdfBytes: Uint8Array;
  originalPageNumbers: number[];
}): Promise<PdfVisionPageInput[]> {
  const pdfjsGlobal = globalThis as typeof globalThis & {
    pdfjsWorker?: unknown;
  };
  const canvasModule = require(VENDORED_CANVAS_MODULE_PATH) as typeof import('@napi-rs/canvas');
  const { DOMMatrix, ImageData, Path2D, createCanvas } = canvasModule;

  if (typeof globalThis.DOMMatrix === 'undefined') {
    globalThis.DOMMatrix = DOMMatrix as typeof globalThis.DOMMatrix;
  }

  if (typeof globalThis.ImageData === 'undefined') {
    globalThis.ImageData = ImageData as typeof globalThis.ImageData;
  }

  if (typeof globalThis.Path2D === 'undefined') {
    globalThis.Path2D = Path2D as typeof globalThis.Path2D;
  }

  if (typeof pdfjsGlobal.pdfjsWorker === 'undefined') {
    const workerModule = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    pdfjsGlobal.pdfjsWorker = workerModule;
  }

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const pdfDocument = await pdfjs.getDocument({
    data: input.pdfBytes,
    cMapUrl: PDFJS_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_URL,
    useSystemFonts: true,
  }).promise;

  const results: PdfVisionPageInput[] = [];

  for (const [index, originalPageNumber] of input.originalPageNumbers.entries()) {
    const page = await pdfDocument.getPage(originalPageNumber);
    const viewport = page.getViewport({ scale: OCR_RENDER_SCALE });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');

    await page.render({
      canvasContext: context as never,
      viewport,
      canvas: canvas as never,
    }).promise;

    results.push({
      page_number: index + 1,
      image_data_url: canvas.toDataURL(OCR_IMAGE_FORMAT),
    });
  }

  return results;
}
