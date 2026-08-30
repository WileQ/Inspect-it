// Local type declaration for the optional tesseract.js OCR engine.
// The module is only used through dynamic import when installed; OCR degrades
// gracefully (reports unavailable) when it is not present.
declare module 'tesseract.js' {
  export interface TesseractResult {
    data: { text: string; confidence: number };
  }
  export interface TesseractWorker {
    recognize(image: Blob): Promise<TesseractResult>;
    terminate(): Promise<void>;
  }
  export function createWorker(lang?: string, oem?: number, options?: unknown): Promise<TesseractWorker>;
  export const version: string;
}
