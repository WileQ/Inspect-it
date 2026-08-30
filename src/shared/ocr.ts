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
      const blob = new Blob([bytes as unknown as BlobPart]);
      const result = await worker.recognize(blob);
      await worker.terminate();
      return {
        available: true,
        provider: 'tesseract.js',
        text: (result?.data?.text as string | undefined) ?? '',
        confidence: typeof result?.data?.confidence === 'number' ? result.data.confidence : undefined,
        pages: result?.data?.text ? [{ page: 1, text: result.data.text, confidence: result.data.confidence }] : undefined
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
}): { worthwhile: boolean; reason: string } {
  if (input.isScreenshot) {
    return { worthwhile: true, reason: 'screenshot-like content' };
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
