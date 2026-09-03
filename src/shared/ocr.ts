// Local OCR architecture.
//
// OCR runs fully on-device with tesseract.js (WASM). All assets (the worker
// script, tesseract.js-core WASM, and the English language data) are shipped
// locally - never fetched from a CDN. Three execution paths:
//
//   1. Desktop (Electron): OCR runs in the main process (Node) via the
//      `inspectItDesktop.ocr` bridge, so it works under file:// with no
//      renderer fetch restrictions.
//   2. Browser: OCR runs in a web worker using local asset URLs copied from
//      public/ocr into the build.
//   3. Node (tests): OCR runs with the local language data in public/ocr.
//
// Output is validated so phantom text from noise/photos is never reported as
// OCR text, while genuine text (even at moderate Tesseract confidence) is kept.

export interface OcrPage {
  page: number;
  text: string;
  confidence?: number;
}

export interface OcrOutcome {
  available: boolean;
  provider: string;
  text: string;
  confidence?: number;
  pages?: OcrPage[];
  message?: string;
}

export interface OcrWord {
  text?: string;
  confidence?: number;
}

export interface OcrValidation {
  accepted: boolean;
  /** Cleaned, meaningful text (empty when rejected). */
  text: string;
  /** Meaningful words that passed the quality filter. */
  words: string[];
  meanConfidence: number | null;
  reason: string;
}

export interface OcrBridgeResult {
  ok: boolean;
  text: string;
  confidence?: number;
  words?: OcrWord[];
  message?: string;
}

import { decodeJpegToPng, looksLikeJpeg } from './image-codec.ts';

/**
 * Diagnostics for OCR runs. Gated behind INSPECT_IT_OCR_DEBUG so normal
 * operation stays quiet; CI enables it to surface the exact OCR state (image
 * format, normalization, engine paths, outcome) without printing contents.
 */
function ocrDebug(...args: unknown[]): void {
  const enabled =
    typeof process !== 'undefined' &&
    Boolean((process.env as Record<string, string | undefined>)?.INSPECT_IT_OCR_DEBUG);
  if (enabled) {
    console.error('[ocr-debug]', ...args);
  }
}

// Variable specifier on purpose: keeps the optional dependency out of the
// static module graph so the dev server and bundler never try to resolve it.
const TESSERACT_MODULE = 'tesseract.js';

let availability: boolean | null = null;

export async function isOcrAvailable(): Promise<boolean> {
  if (availability !== null) {
    return availability;
  }
  try {
    await import(/* @vite-ignore */ TESSERACT_MODULE);
    availability = true;
  } catch {
    availability = false;
  }
  return availability;
}

function isNodeEnvironment(): boolean {
  return typeof process !== 'undefined' && Boolean(process.versions?.node);
}

function desktopBridge(): { run(bytes: Uint8Array): Promise<OcrBridgeResult> } | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { inspectItDesktop?: { ocr?: { run(bytes: Uint8Array): Promise<OcrBridgeResult> } } }).inspectItDesktop?.ocr;
  return bridge ?? null;
}

/**
 * Browser asset base for OCR (Vite copies public/ocr into the build root).
 * Falls back to a relative path so it also works when BASE_URL is unavailable.
 */
function browserOcrBase(): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  const base = env?.BASE_URL || './';
  return `${base}ocr/`;
}

/** Node-only language path: the repo's public/ocr directory (tests). */
function nodeOcrLangPath(): string {
  return `${process.cwd().replace(/\\/g, '/')}/public/ocr`;
}

/**
 * Decide whether OCR output is genuinely readable text rather than the
 * phantom/gibberish Tesseract sometimes produces on noise, photos, and
 * graphics. The filter is deliberately permissive on real words: Tesseract
 * confidence is unreliable (a correct read can score ~45%), so confidence only
 * rejects very low scores and single-word results.
 */
export function validateOcrText(raw: string, overallConfidence?: number, wordData?: OcrWord[]): OcrValidation {
  const tokens = raw.split(/\s+/).map((token) => token.trim()).filter(Boolean);
  const words: string[] = [];
  const confidences: number[] = [];
  for (const token of tokens) {
    const cleaned = token.replace(/[^\p{L}\p{N}.'\u2019-]/gu, '');
    if (!cleaned) continue;
    const hasLetter = /\p{L}/u.test(cleaned);
    const isNumeric = /^\d[\d.,]*$/.test(cleaned);
    if (!hasLetter && !isNumeric) continue;
    // Drop isolated single characters: phantom output is often "a b c d".
    if (cleaned.length === 1) continue;
    words.push(cleaned);
    if (wordData?.length) {
      const match = wordData.find((word) => (word.text ?? '').trim().toLowerCase() === token.toLowerCase());
      if (match && typeof match.confidence === 'number') {
        confidences.push(match.confidence);
      }
    }
  }
  let meanConfidence: number | null = null;
  if (confidences.length) {
    meanConfidence = confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
  } else if (overallConfidence !== undefined) {
    meanConfidence = overallConfidence;
  }
  const text = words.join(' ');
  const wordCount = words.length;
  let accepted = false;
  let reason = '';
  if (wordCount === 0) {
    reason = 'No readable text found (no meaningful words).';
  } else if (meanConfidence !== null && meanConfidence < 30) {
    reason = 'No readable text found (OCR confidence too low: ' + meanConfidence.toFixed(0) + '%).';
  } else if (wordCount >= 2) {
    accepted = meanConfidence === null || meanConfidence >= 40;
    reason = accepted
      ? 'Readable text detected.'
      : 'No readable text found (insufficient confidence: ' + meanConfidence?.toFixed(0) + '%).';
  } else if (wordCount === 1) {
    accepted = meanConfidence === null || meanConfidence >= 60;
    reason = accepted
      ? 'Readable text detected.'
      : 'No readable text found (only one low-confidence word: ' + meanConfidence?.toFixed(0) + '%).';
  } else {
    reason = 'No readable text found.';
  }
  return { accepted, text: accepted ? text : '', words, meanConfidence, reason };
}

/**
 * Best-effort OCR preprocessing: upscale small images and convert to
 * grayscale when a canvas is available (browser/Electron renderer). Tesseract
 * is more accurate on larger, high-contrast input. In Node tests (no canvas)
 * the original bytes are returned unchanged.
 */
async function preprocessForOcr(bytes: Uint8Array): Promise<Blob> {
  try {
    if (typeof createImageBitmap !== 'function') return new Blob([bytes as unknown as BlobPart]);
    const bitmap = await createImageBitmap(new Blob([bytes as unknown as BlobPart]));
    const scale = Math.max(bitmap.width, bitmap.height) < 1000 ? 2 : 1;
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(bitmap.width * scale, bitmap.height * scale)
      : document.createElement('canvas');
    canvas.width = bitmap.width * scale;
    canvas.height = bitmap.height * scale;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D | null;
    if (!context) {
      bitmap.close();
      return new Blob([bytes as unknown as BlobPart]);
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    for (let index = 0; index < data.length; index += 4) {
      const luma = 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
      data[index] = luma;
      data[index + 1] = luma;
      data[index + 2] = luma;
    }
    context.putImageData(imageData, 0, 0);
    interface BlobCanvas {
      toBlob?: (callback: (blob: Blob | null) => void, type?: string) => void;
      convertToBlob?: (options?: { type?: string }) => Promise<Blob>;
    }
    const blobCanvas = canvas as unknown as BlobCanvas;
    const blob = await new Promise<Blob | null>((resolve) => {
      if (typeof blobCanvas.toBlob === 'function') {
        blobCanvas.toBlob(resolve, 'image/png');
      } else if (typeof blobCanvas.convertToBlob === 'function') {
        blobCanvas.convertToBlob({ type: 'image/png' }).then(resolve).catch(() => resolve(null));
      } else {
        resolve(null);
      }
    });
    bitmap.close();
    return blob ?? new Blob([bytes as unknown as BlobPart]);
  } catch {
    return new Blob([bytes as unknown as BlobPart]);
  }
}

/** Validate raw OCR output into a final OcrOutcome. */
function outcomeFromRaw(rawText: string, rawConfidence: number | undefined, wordData: OcrWord[] | undefined, provider: string): OcrOutcome {
  const validation = validateOcrText(rawText, rawConfidence, wordData);
  if (validation.accepted) {
    return {
      available: true,
      provider,
      text: validation.text,
      confidence: validation.meanConfidence ?? rawConfidence,
      pages: validation.text ? [{ page: 1, text: validation.text, confidence: validation.meanConfidence ?? rawConfidence }] : undefined
    };
  }
  return {
    available: true,
    provider,
    text: '',
    confidence: validation.meanConfidence ?? rawConfidence,
    message: validation.reason
  };
}

/**
 * Run OCR on an image (PNG/JPEG bytes). Uses tesseract.js when installed,
 * routed through the Electron main process on desktop and a local web worker
 * in the browser. Never contacts a CDN. Returns an unavailable outcome (never
 * fake text) when the engine or its assets are missing.
 */
export async function ocrImage(bytes: Uint8Array): Promise<OcrOutcome> {
  // Normalize JPEGs to PNG up front (applies to the desktop main-process
  // bridge AND the local engines): tesseract.js-core's libjpeg (leptonica)
  // rejects some JPEGs on certain SIMD/relaxed-SIMD WASM variants, while PNG
  // decoding (libpng) is uniform across all of them. Decoding stays fully
  // local. If a JPEG cannot be decoded locally we fall back to the original
  // bytes and let the engine try (or fail honestly).
  const work = looksLikeJpeg(bytes) ? (await decodeJpegToPng(bytes)) ?? bytes : bytes;
  const bridge = desktopBridge();
  if (bridge) {
    try {
      const result = await bridge.run(work);
      if (result.ok) {
        return outcomeFromRaw(result.text ?? '', result.confidence, result.words, 'tesseract.js (desktop)');
      }
      return {
        available: false,
        provider: 'tesseract.js (desktop)',
        text: '',
        message: result.message || 'OCR failed in the desktop engine.'
      };
    } catch (error) {
      return {
        available: false,
        provider: 'tesseract.js (desktop)',
        text: '',
        message: error instanceof Error ? `OCR failed: ${error.message}` : 'OCR failed'
      };
    }
  }
  const engineAvailable = await isOcrAvailable();
  ocrDebug('input format:', looksLikeJpeg(bytes) ? 'jpeg' : 'other', '| normalized to png:', !looksLikeJpeg(work) && looksLikeJpeg(bytes), '| normalized png bytes:', !looksLikeJpeg(work) && looksLikeJpeg(bytes) ? work.length : 'n/a', '| engine available:', engineAvailable);
  if (!engineAvailable) {
    return {
      available: false,
      provider: 'none',
      text: '',
      message: 'Local OCR is not available. Install tesseract.js to enable on-device OCR (no cloud service is used).'
    };
  }
  try {
    const Tesseract = await import(/* @vite-ignore */ TESSERACT_MODULE);
    const options: Record<string, unknown> = {};
    // tesseract.js throws from its message handler when a job rejects and no
    // errorHandler is provided; that would crash the process on an unreadable
    // image. Supplying a handler keeps the failure inside the recognize()
    // promise, which we catch below.
    options.errorHandler = () => undefined;
    if (isNodeEnvironment()) {
      options.langPath = nodeOcrLangPath();
      // Keep tesseract's language cache out of the repo root (defaults to ./).
      options.cachePath = `${process.cwd().replace(/\\/g, '/')}/node_modules/.cache/ocr`;
    } else {
      const base = browserOcrBase();
      options.workerPath = `${base}worker.min.js`;
      options.corePath = `${base}core/`;
      options.langPath = base;
    }
    const worker = await Tesseract.createWorker('eng', 1, options);
    try {
      ocrDebug('langPath:', String(options.langPath ?? ''), '| cachePath:', String(options.cachePath ?? ''), '| workerPath:', String(options.workerPath ?? ''), '| corePath:', String(options.corePath ?? ''), '| node:', isNodeEnvironment());
      // Node reads a Buffer; the browser reads a (possibly preprocessed) Blob.
      // `work` was normalized above (JPEG -> PNG when possible).
      const input = isNodeEnvironment() ? Buffer.from(work) : await preprocessForOcr(work);
      const result = await worker.recognize(input);
      await worker.terminate();
      const rawText = (result?.data?.text as string | undefined) ?? '';
      const rawConfidence = typeof result?.data?.confidence === 'number' ? result.data.confidence : undefined;
      const wordData = Array.isArray(result?.data?.words) ? result.data.words as OcrWord[] : undefined;
      ocrDebug('recognize done | raw text length:', rawText.length, '| confidence:', rawConfidence);
      return outcomeFromRaw(rawText, rawConfidence, wordData, 'tesseract.js');
    } catch (error) {
      await worker.terminate().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OCR failed';
    ocrDebug('OCR failed:', message);
    return {
      available: false,
      provider: 'tesseract.js',
      text: '',
      message
    };
  }
}

/**
 * Decide whether OCR is worthwhile for a document/image based on cheap signals.
 * Avoids blindly OCR-ing everything.
 */
export function ocrWorthwhile(input: {
  pageCount?: number;
  textSnippetCount?: number;
  imageCount?: number;
  isImageOnly?: boolean;
  isScreenshot?: boolean;
  imageBytes?: Uint8Array;
  width?: number;
  height?: number;
  /** 0..1 deterministic text-likelihood from pixel analysis (see image-analysis). */
  textLikelihood?: number;
}): { worthwhile: boolean; reason: string } {
  if (input.isScreenshot) {
    return { worthwhile: true, reason: 'screenshot-like content' };
  }
  if (typeof input.textLikelihood === 'number') {
    if (input.textLikelihood >= 0.4) {
      return { worthwhile: true, reason: 'text-like content (' + Math.round(input.textLikelihood * 100) + '% likelihood)' };
    }
    if (input.textLikelihood < 0.25) {
      return { worthwhile: false, reason: 'content is not text-like (' + Math.round(input.textLikelihood * 100) + '% likelihood)' };
    }
  }
  if (input.width && input.height) {
    const minDim = Math.min(input.width, input.height);
    const maxDim = Math.max(input.width, input.height);
    const aspect = maxDim / minDim;
    const megapixels = (input.width * input.height) / 1_000_000;
    if (minDim >= 300 && maxDim >= 600 && aspect <= 4 && megapixels <= 20) {
      return { worthwhile: true, reason: `image dimensions (${input.width}\u00d7${input.height}) may contain readable text` };
    }
  }
  if (input.isImageOnly) {
    return { worthwhile: true, reason: 'image-only content' };
  }
  if (input.pageCount && input.pageCount > 0 && (input.textSnippetCount ?? 0) === 0) {
    return { worthwhile: true, reason: `${input.pageCount} page(s) with no extractable text` };
  }
  if (input.pageCount && input.pageCount > 0 && input.imageCount && input.imageCount > 0 && (input.textSnippetCount ?? 0) < input.pageCount) {
    return { worthwhile: true, reason: 'sparse extractable text relative to page/image count' };
  }
  return { worthwhile: false, reason: 'extractable text is already present' };
}
