// PDF text extraction.
//
// Primary: pdfjs-dist (a real runtime dependency) produces accurate text,
// correct word counts, per-page text, and document metadata. It is loaded
// lazily and only when a PDF is actually analyzed.
//
// Fallback: a bounded, regex-based extractor that handles literal strings,
// hex strings, Tj/TJ/" operators, and FlateDecode content streams. It is
// used only when pdfjs cannot load the document, so the app still reports
// something useful instead of failing outright.
//
// Strictly read-only: the source bytes are never modified.

import { unzlibSync } from 'fflate';
import { ensureNotAborted, tokenizeWords } from './analysis-utils.ts';

export interface PdfMetadata {
  title?: string;
  author?: string;
  creator?: string;
  producer?: string;
  created?: string;
  modified?: string;
}

export interface PdfPageGeometry {
  width: number;
  height: number;
  rotate: number;
}

export interface PdfStructure {
  encrypted: boolean;
  hasAcroForm: boolean;
  linearized: boolean;
  pageSizes: PdfPageGeometry[];
  outlineCount: number;
  destinationsCount: number;
}

export interface PdfExtraction {
  ok: boolean;
  pageCount: number;
  /** Text per page (empty for the regex fallback, which cannot segment pages). */
  perPage: string[];
  /** Full extracted text. */
  text: string;
  /** Individual text items/snippets (used for counts and previews). */
  snippets: string[];
  wordCount: number;
  characterCount: number;
  metadata?: PdfMetadata;
  structure?: PdfStructure;
  warnings: string[];
  error?: string;
  usedPdfjs: boolean;
}

/* ------------------------------------------------------------------ */
/* pdfjs-dist loading (environment aware)                             */
/* ------------------------------------------------------------------ */

interface PdfJsApi {
  getDocument: (source: Record<string, unknown>) => { promise: Promise<PdfDocument>; destroy: () => Promise<void> };
  GlobalWorkerOptions: { workerSrc: string };
}

interface PdfDocument {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
  getMetadata: () => Promise<{ info?: Record<string, string> }>;
  getOutline: () => Promise<unknown[] | null>;
  getDestinations: () => Promise<Record<string, unknown> | null>;
}

interface PdfPage {
  getTextContent: () => Promise<{ items?: Array<{ str?: string }> }>;
  view: number[];
  rotate: number;
}

interface LoadedPdfjs {
  api: PdfJsApi;
  cMapUrl?: string;
  standardFontDataUrl?: string;
}

let pdfjsPromise: Promise<LoadedPdfjs | null> | null = null;

function isNodeEnvironment(): boolean {
  return typeof process !== 'undefined' && Boolean(process.versions?.node);
}

async function loadPdfjs(): Promise<LoadedPdfjs | null> {
  if (pdfjsPromise) {
    return pdfjsPromise;
  }
  pdfjsPromise = (async () => {
    try {
      // The "legacy" build is used everywhere: it ships the core-js polyfills
      // (e.g. Uint8Array.prototype.toHex) that pdf.js v6 needs on engines such
      // as Electron 33 / Chromium 130 where those typed-array methods are not
      // yet native. Using the standard build crashes with
      // "n.toHex is not a function" inside the worker on those engines.
      const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
      if (isNodeEnvironment()) {
        // Node cannot use workerPort (the global Worker check fails), so point
        // workerSrc at the legacy worker module. import.meta.resolve returns a
        // file:// URL which pdf.js's node stream layer accepts.
        mod.GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
        const packageUrl = import.meta.resolve('pdfjs-dist/package.json');
        return {
          api: mod as unknown as PdfJsApi,
          cMapUrl: new URL('./cmaps/', packageUrl).href,
          standardFontDataUrl: new URL('./standard_fonts/', packageUrl).href
        };
      }
      const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
      mod.GlobalWorkerOptions.workerSrc = worker.default as string;
      return { api: mod as unknown as PdfJsApi };
    } catch {
      return null;
    }
  })();
  return pdfjsPromise;
}

/* ------------------------------------------------------------------ */
/* pdfjs extraction                                                    */
/* ------------------------------------------------------------------ */

function pdfMetadataFromInfo(info: Record<string, string> | undefined): PdfMetadata | undefined {
  if (!info) return undefined;
  const pick = (key: string): string | undefined => {
    const value = info[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const metadata: PdfMetadata = {};
  const title = pick('Title');
  const author = pick('Author');
  const creator = pick('Creator');
  const producer = pick('Producer');
  const created = pick('CreationDate');
  const modified = pick('ModDate');
  if (title) metadata.title = title;
  if (author) metadata.author = author;
  if (creator) metadata.creator = creator;
  if (producer) metadata.producer = producer;
  if (created) metadata.created = created;
  if (modified) metadata.modified = modified;
  return Object.keys(metadata).length ? metadata : undefined;
}

async function extractWithPdfjs(
  loaded: LoadedPdfjs,
  bytes: Uint8Array,
  options: { signal: AbortSignal; maxPages: number }
): Promise<PdfExtraction> {
  const { api, cMapUrl, standardFontDataUrl } = loaded;
  // pdf.js transfers (detaches) the data buffer to its worker; pass a copy so
  // the caller's bytes remain usable afterwards (e.g. for JPEG extraction).
  const dataCopy = bytes.slice();
  const loadingTask = api.getDocument({
    data: dataCopy,
    cMapUrl,
    standardFontDataUrl,
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    // Errors only: silence pdfjs font-fallback chatter that is noise for
    // extraction-focused inspection (e.g. unembedded standard fonts).
    verbosity: 0
  });
  let pdf: PdfDocument | null = null;
  try {
    pdf = await loadingTask.promise;
    const pageCount = pdf.numPages;
    const pagesToRead = Math.max(1, Math.min(pageCount, options.maxPages));
    const perPage: string[] = [];
    const snippets: string[] = [];
    const warnings: string[] = [];
    const pageSizes: PdfPageGeometry[] = [];
    for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber += 1) {
      ensureNotAborted(options.signal);
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items ?? [];
      let pageText = '';
      for (const item of items) {
        const value = (item.str ?? '').trim();
        if (value) {
          snippets.push(value);
          pageText += `${value} `;
        }
      }
      perPage.push(pageText.trim());
      const view = page.view ?? [0, 0, 0, 0];
      const rotate = typeof page.rotate === 'number' ? page.rotate : 0;
      pageSizes.push({ width: view[2] ?? 0, height: view[3] ?? 0, rotate });
    }
    let outlineCount = 0;
    let destinationsCount = 0;
    try {
      const outline = await pdf.getOutline();
      outlineCount = Array.isArray(outline) ? outline.length : 0;
    } catch {
      outlineCount = 0;
    }
    try {
      const destinations = await pdf.getDestinations();
      destinationsCount = destinations ? Object.keys(destinations).length : 0;
    } catch {
      destinationsCount = 0;
    }
    if (pageCount > pagesToRead) {
      warnings.push(`Text extracted from the first ${pagesToRead} of ${pageCount} pages to respect resource limits.`);
    }
    const text = perPage.join('\n');
    const metadata = await pdf.getMetadata().then((result) => pdfMetadataFromInfo(result.info)).catch(() => undefined);
    return {
      ok: true,
      pageCount,
      perPage,
      text,
      snippets,
      wordCount: tokenizeWords(text).length,
      characterCount: text.replace(/\s/g, '').length,
      metadata,
      structure: {
        encrypted: false,
        hasAcroForm: false,
        linearized: false,
        pageSizes,
        outlineCount,
        destinationsCount
      },
      warnings,
      usedPdfjs: true
    };
  } finally {
    try {
      await loadingTask.destroy();
    } catch {
      // Worker teardown is best-effort; ignore so we never mask extraction errors.
    }
  }
}

/* ------------------------------------------------------------------ */
/* Regex fallback extractor                                            */
/* ------------------------------------------------------------------ */

const FALLBACK_SCAN_BYTES = 24 * 1024 * 1024;

/** Decode a PDF string token: literal `(...)` or hex `<...>`. */
function decodePdfStringToken(token: string): string {
  if (token.startsWith('<')) {
    const hex = token.slice(1, -1).replace(/[^0-9A-Fa-f]/g, '');
    if (!hex.length) return '';
    const bytes = new Uint8Array(Math.floor(hex.length / 2));
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    // UTF-16BE with BOM is the common non-ASCII hex encoding in PDFs.
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      let decoded = '';
      for (let index = 2; index + 1 < bytes.length; index += 2) {
        decoded += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
      }
      return decoded;
    }
    return new TextDecoder('latin1', { fatal: false }).decode(bytes);
  }
  return token
    .slice(1, -1)
    .replace(/\\([()\\nrtbf])/g, (_, ch: string) => {
      switch (ch) {
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'b': return '\b';
        case 'f': return '\f';
        default: return ch;
      }
    })
    .replace(/\\([0-7]{1,3})/g, (_, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)));
}

/** Extract readable text runs from raw (possibly decompressed) PDF content. */
function extractPdfTextRuns(source: string): string[] {
  const runs: string[] = [];
  const stringToken = String.raw`(?:\((?:\\.|[^()\\])*\)|<[0-9A-Fa-f\s]+>)`;
  // Single-string text operators: Tj, ' and " (the double-quote operator also
  // has two numeric operands before the string, so the string is the tail).
  const singleOperator = new RegExp(`${stringToken}\\s*(?:-?\\d+(?:\\.\\d+)?\\s*)?(?:Tj|'|")`, 'g');
  for (const match of source.matchAll(singleOperator)) {
    const token = match[0].match(stringToken)?.[0];
    if (!token) continue;
    const decoded = decodePdfStringToken(token);
    if (decoded.trim()) runs.push(decoded);
  }
  // TJ arrays: [ (a) -20 (b) <c> ] TJ — items are joined as the layout engine
  // would, then tokenized downstream.
  const tjArray = new RegExp(`\\[((?:\\s*(?:${stringToken}|-?\\d+(?:\\.\\d+)?)\\s*)+)\\]\\s*TJ`, 'g');
  for (const match of source.matchAll(tjArray)) {
    const parts: string[] = [];
    const innerToken = new RegExp(stringToken, 'g');
    for (const inner of match[1].matchAll(innerToken)) {
      parts.push(decodePdfStringToken(inner[0]));
    }
    const joined = parts.join('');
    if (joined.trim()) runs.push(joined);
  }
  return runs;
}

/** Decompress FlateDecode streams and return their text as a string. */
export function extractPdfStreamText(source: string, maxBytes = 4 * 1024 * 1024): string {
  const chunks: string[] = [];
  const streamPattern = /stream\r?\n([\s\S]*?)endstream/g;
  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = streamPattern.exec(source)) !== null && guard < 400) {
    guard += 1;
    const raw = match[1];
    if (!raw.length) continue;
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
      bytes[index] = raw.charCodeAt(index) & 0xff;
    }
    let decoded: Uint8Array | null = null;
    try {
      decoded = unzlibSync(bytes);
    } catch {
      decoded = null;
    }
    if (decoded) {
      chunks.push(new TextDecoder('latin1', { fatal: false }).decode(decoded.slice(0, maxBytes)));
    }
  }
  return chunks.join('\n');
}

/** Best-effort page count from the raw PDF structure. */
export function pdfPageCount(source: string): number {
  const countMatches = [...source.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,400}?\/Count\s+(\d+)/g)];
  if (countMatches.length) {
    const counts = countMatches.map((match) => Number(match[1])).filter((value) => Number.isFinite(value));
    if (counts.length) {
      return Math.max(...counts);
    }
  }
  return (source.match(/\/Type\s*\/Page\b/g) ?? []).length;
}

/**
 * Extract embedded JPEG (DCTDecode) image streams from raw PDF bytes. Scanned
 * PDFs usually contain one JPEG per page; these can be OCR'd directly without
 * rendering. Bounded by image count and scan window. Returns JPEG byte blobs
 * (starting with the FFD8 SOI marker).
 */
/** Backwards-compatible JPEG-only page-image extractor. */
export function extractPdfJpegs(bytes: Uint8Array, maxImages = 12): Uint8Array[] {
  return extractPdfPageImages(bytes, maxImages)
    .filter((image) => image.kind === 'jpeg')
    .map((image) => image.bytes);
}

export interface PdfPageImage {
  kind: 'jpeg' | 'png';
  bytes: Uint8Array;
}

/**
 * Extract page images from a scanned PDF. Supports JPEG (DCTDecode) images -
 * the common scanner output - and PNG (FlateDecode) images, so OCR never
 * depends on one encoder/decoder. Bounded by image count and scan window.
 */
export function extractPdfPageImages(bytes: Uint8Array, maxImages = 12, maxBytesPerImage = 8 * 1024 * 1024): PdfPageImage[] {
  const text = new TextDecoder('latin1', { fatal: false }).decode(bytes.slice(0, FALLBACK_SCAN_BYTES));
  const out: PdfPageImage[] = [];
  const imageRe = /\/Subtype\s*\/Image\b/g;
  let match: RegExpExecArray | null;
  while ((match = imageRe.exec(text)) !== null && out.length < maxImages) {
    const startIndex = match.index;
    const streamPos = text.indexOf('stream', startIndex);
    if (streamPos === -1 || streamPos - startIndex > 8000) continue;
    const dict = text.slice(startIndex, streamPos);
    let bodyStart = streamPos + 'stream'.length;
    if (text.startsWith('\r\n', bodyStart)) bodyStart += 2;
    else if (text.startsWith('\n', bodyStart)) bodyStart += 1;
    const endIndex = text.indexOf('endstream', bodyStart);
    if (endIndex === -1) continue;
    const raw = text.slice(bodyStart, endIndex);
    if (!raw.length) continue;
    const rawBytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
      rawBytes[index] = raw.charCodeAt(index) & 0xff;
    }
    let end = rawBytes.length;
    while (end > 0 && (rawBytes[end - 1] === 0x0a || rawBytes[end - 1] === 0x0d)) end -= 1;
    const stream = rawBytes.slice(0, end);
    if (stream.length === 0 || stream.length > maxBytesPerImage) continue;
    if (/\/Filter\s*(\/DCTDecode|\[[^\]]*\/DCTDecode)/.test(dict)) {
      if (stream[0] === 0xff && stream[1] === 0xd8) {
        out.push({ kind: 'jpeg', bytes: stream });
      }
    } else if (/\/Filter\s*(\/FlateDecode|\[[^\]]*\/FlateDecode)/.test(dict)) {
      try {
        const decoded = unzlibSync(stream);
        if (decoded.length > 8 && decoded[0] === 0x89 && decoded[1] === 0x50 && decoded[2] === 0x4e && decoded[3] === 0x47) {
          out.push({ kind: 'png', bytes: decoded });
        }
      } catch {
        // Not a decodable Flate stream; skip this image.
      }
    }
  }
  return out;
}

/** Regex fallback: returns a best-effort extraction when pdfjs is unusable. */
function extractWithRegex(bytes: Uint8Array): PdfExtraction {
  const text = new TextDecoder('latin1', { fatal: false }).decode(bytes.slice(0, FALLBACK_SCAN_BYTES));
  const streamText = extractPdfStreamText(text);
  const searchable = streamText ? `${text}\n${streamText}` : text;
  const snippets = extractPdfTextRuns(searchable);
  const joined = snippets.join(' ');
  const warnings: string[] = [];
  if (bytes.length > FALLBACK_SCAN_BYTES) {
    warnings.push(`Text extraction is based on the first ${Math.round(FALLBACK_SCAN_BYTES / 1024 / 1024)} MB of the file.`);
  }
  return {
    ok: true,
    pageCount: pdfPageCount(text),
    perPage: [],
    text: joined,
    snippets,
    wordCount: tokenizeWords(joined).length,
    characterCount: joined.replace(/\s/g, '').length,
    structure: {
      encrypted: /\/Encrypt\b/.test(text),
      hasAcroForm: /\/AcroForm\b/.test(text),
      linearized: /\/Linearized\b/.test(text),
      pageSizes: [],
      outlineCount: 0,
      destinationsCount: 0
    },
    warnings,
    usedPdfjs: false
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function extractPdfText(
  bytes: Uint8Array,
  options: { signal: AbortSignal; maxPages?: number }
): Promise<PdfExtraction> {
  ensureNotAborted(options.signal);
  const maxPages = options.maxPages ?? 400;
  const loaded = await loadPdfjs();
  if (loaded) {
    try {
      const result = await extractWithPdfjs(loaded, bytes, { signal: options.signal, maxPages });
      ensureNotAborted(options.signal);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallback = extractWithRegex(bytes);
      return {
        ...fallback,
        warnings: [...fallback.warnings, `pdfjs could not extract text (${message}); used the built-in fallback extractor.`]
      };
    }
  }
  const fallback = extractWithRegex(bytes);
  return {
    ...fallback,
    warnings: [...fallback.warnings, 'pdfjs-dist is unavailable; used the built-in fallback extractor.']
  };
}

/** Best-effort metadata extraction from raw PDF source (Info dict). */
export function extractPdfMetadataFromRaw(source: string): PdfMetadata | undefined {
  const metadata: PdfMetadata = {};
  const pick = (key: string): string | undefined => {
    const match = source.match(new RegExp(`\\/${key}\\s*\\((.*?)\\)`, 's'));
    const value = match ? match[1].trim() : '';
    return value || undefined;
  };
  const title = pick('Title');
  const author = pick('Author');
  const creator = pick('Creator');
  const producer = pick('Producer');
  const created = pick('CreationDate');
  const modified = pick('ModDate');
  if (title) metadata.title = title;
  if (author) metadata.author = author;
  if (creator) metadata.creator = creator;
  if (producer) metadata.producer = producer;
  if (created) metadata.created = created;
  if (modified) metadata.modified = modified;
  return Object.keys(metadata).length ? metadata : undefined;
}


