// Local OCR architecture.
//
// OCR is intentionally optional: it must run fully on-device and must not be
// faked. If a local OCR engine (tesseract.js) is installed, it is used and the
// output is clearly labelled as OCR-derived with a confidence score. If it is
// not available, analyzers report that OCR is unavailable instead of inventing
// text.
//
// No cloud OCR is ever used.

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

/**
 * Decide whether OCR output is genuinely readable text rather than the
 * phantom/gibberish Tesseract sometimes produces on noise, photos, and
 * graphics. Three independent signals are combined:
 *
 *  1. Meaningful words - tokens must contain letters (or be numeric), and
 *     isolated single characters are dropped.
 *  2. Confidence - word-level confidence when available, otherwise the
 *     overall page confidence; very low confidence is rejected outright.
 *  3. Word count - a single low-confidence token is not enough to claim text.
 *
 * Returns the cleaned text so the UI never shows garbage as OCR output.
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
    // Drop isolated single characters: Tesseract phantom output is often a
    // string of single letters/digits ("a b c d"), which is not readable text.
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
  } else if (meanConfidence !== null && meanConfidence < 40) {
    reason = 'No readable text found (OCR confidence too low: ' + meanConfidence.toFixed(0) + '%).';
  } else if (wordCount >= 3) {
    accepted = true;
    reason = 'Readable text detected.';
  } else if (wordCount === 2 && meanConfidence !== null && meanConfidence >= 60) {
    accepted = true;
    reason = 'Readable text detected.';
  } else if (wordCount === 1 && meanConfidence !== null && meanConfidence >= 80) {
    accepted = true;
    reason = 'Readable text detected.';
  } else if (meanConfidence === null && wordCount >= 2) {
    accepted = true;
    reason = 'Readable text detected (no confidence data).';
  } else {
    reason = 'No readable text found (insufficient confident words: ' + wordCount + ' word(s), confidence ' + (meanConfidence === null ? 'unknown' : meanConfidence.toFixed(0) + '%') + ').';
  }
  return { accepted, text: accepted ? text : '', words, meanConfidence, reason };
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

/**
 * Best-effort OCR preprocessing: upscale small images and convert to
 * grayscale when a canvas is available (browser/Electron). Tesseract is
 * dramatically more accurate on larger, high-contrast input. In Node tests
 * (no canvas) the original bytes are returned unchanged.
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

/**
 * Run OCR on an image (PNG/JPEG bytes). Uses tesseract.js when installed.
 * Returns an unavailable outcome (never fake text) when the engine is missing.
 */
export async function ocrImage(bytes: Uint8Array): Promise<OcrOutcome> {
  if (!(await isOcrAvailable())) {
    return {
      available: false,
      provider: 'none',
      text: '',
      message: 'Local OCR is not available. Install tesseract.js to enable on-device OCR (no cloud service is used).'
    };
  }
  try {
    const Tesseract = await import(/* @vite-ignore */ TESSERACT_MODULE);
    const worker = await Tesseract.createWorker('eng');
    try {
      const blob = await preprocessForOcr(bytes);
      const result = await worker.recognize(blob);
      await worker.terminate();
      const rawText = (result?.data?.text as string | undefined) ?? '';
      const rawConfidence = typeof result?.data?.confidence === 'number' ? result.data.confidence : undefined;
      const wordData = Array.isArray(result?.data?.words) ? result.data.words as OcrWord[] : undefined;
      const validation = validateOcrText(rawText, rawConfidence, wordData);
      if (validation.accepted) {
        return {
          available: true,
          provider: 'tesseract.js',
          text: validation.text,
          confidence: validation.meanConfidence ?? rawConfidence,
          pages: validation.text ? [{ page: 1, text: validation.text, confidence: validation.meanConfidence ?? rawConfidence }] : undefined
        };
      }
      return {
        available: true,
        provider: 'tesseract.js',
        text: '',
        confidence: validation.meanConfidence ?? rawConfidence,
        message: validation.reason
      };
    } catch (error) {
      await worker.terminate().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    return {
      available: false,
      provider: 'tesseract.js',
      text: '',
      message: error instanceof Error ? `OCR failed: ${error.message}` : 'OCR failed'
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


