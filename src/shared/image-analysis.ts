// Pixel-level image analysis (colors, brightness, contrast, sharpness,
// colorfulness, perceptual hash). Runs fully on-device; no canvas required
// so it also works in Node for PNG/BMP inputs.
import { dHash } from './duplicates.ts';
import type { DecodedImage } from './duplicates.ts';

export interface DominantColor {
  hex: string;
  ratio: number;
}

export interface ImagePixelAnalysis {
  dominantColors: DominantColor[];
  /** Mean luminance, normalized 0..1. */
  brightness: number;
  /** Standard deviation of luminance, normalized 0..1. */
  contrast: number;
  /** Laplacian variance on a downsampled grid, normalized 0..1 (higher = sharper). */
  sharpness: number;
  /** Fraction of pixels with strong saturation (0..1). */
  colorfulness: number;
  /** Fraction of sampled cells with a strong local gradient (text/edges). */
  edgeDensity: number;
  /** Mean saturation (max(R,G,B) - min(R,G,B)) normalized 0..1. */
  saturation: number;
  /** Distinct quantized colors / sampled pixels (0..1). */
  uniqueColorRatio: number;
  /** Perceptual hash (dHash) as hex. */
  perceptualHash: string;
  /** Number of sampled pixels. */
  sampleCount: number;
}

const ANALYSIS_GRID = 96;

function estimateSharpness(grid: number[][], gridWidth: number, gridHeight: number): number {
  if (gridWidth < 3 || gridHeight < 3) return 0;
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < gridHeight - 1; y += 1) {
    for (let x = 1; x < gridWidth - 1; x += 1) {
      const laplacian =
        4 * grid[y][x] -
        grid[y - 1][x] -
        grid[y + 1][x] -
        grid[y][x - 1] -
        grid[y][x + 1];
      sum += laplacian;
      sumSquares += laplacian * laplacian;
      count += 1;
    }
  }
  if (!count) return 0;
  const mean = sum / count;
  const variance = sumSquares / count - mean * mean;
  // Normalize: Laplacian variance above ~900 on 0..255 luma is very sharp.
  return Math.max(0, Math.min(1, variance / 900));
}

export interface JpegExif {
  make?: string;
  model?: string;
  software?: string;
  dateTime?: string;
  dateTimeOriginal?: string;
  orientation?: number;
  /** Raw GPS latitude/longitude when present (DMS decimal degrees). */
  gpsLatitude?: number;
  gpsLongitude?: number;
}

function readExifValue(view: DataView, offset: number, type: number, count: number, byteOffset: number, littleEndian: boolean): string | number | null {
  const sizes: Record<number, number> = { 1: 1, 2: 2, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const size = sizes[type];
  if (!size || count <= 0) return null;
  const total = size * count;
  const dataStart = total > 4 ? byteOffset + view.getUint32(offset + 8, littleEndian) : offset + 8;
  const safe = (index: number): number | null => index >= 0 && index + 1 <= view.byteLength ? view.getUint8(index) : null;
  if (type === 2) {
    // ASCII string
    const bytes: number[] = [];
    for (let i = 0; i < Math.min(count, 64); i += 1) {
      const value = safe(dataStart + i);
      if (value === null) break;
      if (value === 0) break;
      bytes.push(value);
    }
    return bytes.length ? new TextDecoder('latin1').decode(Uint8Array.from(bytes)).trim() : null;
  }
  if (type === 3) {
    return count === 1 && dataStart + 2 <= view.byteLength ? view.getUint16(dataStart, littleEndian) : null;
  }
  if (type === 4) {
    return count === 1 && dataStart + 4 <= view.byteLength ? view.getUint32(dataStart, littleEndian) : null;
  }
  if (type === 5) {
    if (count !== 1 || dataStart + 8 > view.byteLength) return null;
    const numerator = view.getUint32(dataStart, littleEndian);
    const denominator = view.getUint32(dataStart + 4, littleEndian);
    return denominator ? numerator / denominator : null;
  }
  return null;
}

function parseExifDirectory(view: DataView, dirOffset: number, littleEndian: boolean, tiffStart: number, tags: Record<number, string>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (dirOffset + 2 > view.byteLength) return out;
  const count = view.getUint16(dirOffset, littleEndian);
  for (let i = 0; i < count; i += 1) {
    const entry = dirOffset + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    const tag = view.getUint16(entry, littleEndian);
    const type = view.getUint16(entry + 2, littleEndian);
    const valueCount = view.getUint32(entry + 4, littleEndian);
    const name = tags[tag];
    if (!name) continue;
    const value = readExifValue(view, entry, type, valueCount, tiffStart, littleEndian);
    if (value !== null) out[name] = value;
  }
  return out;
}

/** Extract common EXIF fields from JPEG bytes (APP1/Exif segment). */
export function extractJpegExif(bytes: Uint8Array): JpegExif | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const length = view.getUint16(offset + 2, false);
    if (length < 2) break;
    if (marker === 0xe1 && length >= 14 && offset + 16 <= bytes.length) {
      const header = new TextDecoder('latin1').decode(bytes.slice(offset + 4, offset + 10));
      if (header !== 'Exif\x00\x00') {
        offset += 2 + length;
        continue;
      }
      const tiffStart = offset + 10;
      const endianMark = new TextDecoder('latin1').decode(bytes.slice(tiffStart, tiffStart + 2));
      if (endianMark !== 'II' && endianMark !== 'MM') return null;
      const littleEndian = endianMark === 'II';
      if (view.getUint16(tiffStart + 2, littleEndian) !== 0x2a) return null;
      const ifd0Offset = tiffStart + view.getUint32(tiffStart + 4, littleEndian);
      const tags: Record<number, string> = {
        0x010f: 'make',
        0x0110: 'model',
        0x0112: 'orientation',
        0x0131: 'software',
        0x0132: 'dateTime',
        0x9003: 'dateTimeOriginal',
        0x9004: 'dateTimeDigitized'
      };
      const result = parseExifDirectory(view, ifd0Offset, littleEndian, tiffStart, tags);
      const exif: JpegExif = {};
      for (const key of ['make', 'model', 'software', 'dateTime', 'dateTimeOriginal'] as const) {
        if (typeof result[key] === 'string' && result[key]) exif[key] = result[key] as string;
      }
      if (typeof result.orientation === 'number') exif.orientation = result.orientation as number;
      const gps = parseGpsIfd(view, ifd0Offset, littleEndian, tiffStart);
      if (gps) {
        exif.gpsLatitude = gps.latitude;
        exif.gpsLongitude = gps.longitude;
      }
      return Object.keys(exif).length ? exif : null;
    }
    offset += 2 + length;
  }
  return null;
}

function parseGpsIfd(view: DataView, ifd0Offset: number, littleEndian: boolean, tiffStart: number): { latitude: number; longitude: number } | null {
  if (ifd0Offset + 2 > view.byteLength) return null;
  const entryCount = view.getUint16(ifd0Offset, littleEndian);
  let gpsOffset = -1;
  for (let i = 0; i < entryCount; i += 1) {
    const entry = ifd0Offset + 2 + i * 12;
    if (view.getUint16(entry, littleEndian) === 0x8825) {
      const type = view.getUint16(entry + 2, littleEndian);
      if (type === 4) {
        gpsOffset = tiffStart + view.getUint32(entry + 8, littleEndian);
      }
      break;
    }
  }
  if (gpsOffset < 0) return null;
  const readRational = (entry: number): number => {
    const numerator = view.getUint32(entry, littleEndian);
    const denominator = view.getUint32(entry + 4, littleEndian);
    return denominator ? numerator / denominator : 0;
  };
  const coord = (tag: number): number[] | null => {
    const count = view.getUint16(gpsOffset, littleEndian);
    for (let i = 0; i < count; i += 1) {
      const entry = gpsOffset + 2 + i * 12;
      if (view.getUint16(entry, littleEndian) === tag && view.getUint16(entry + 2, littleEndian) === 5) {
        const dataStart = tiffStart + view.getUint32(entry + 8, littleEndian);
        return [readRational(dataStart), readRational(dataStart + 8), readRational(dataStart + 16)];
      }
    }
    return null;
  };
  const ref = (tag: number): string | null => {
    const count = view.getUint16(gpsOffset, littleEndian);
    for (let i = 0; i < count; i += 1) {
      const entry = gpsOffset + 2 + i * 12;
      if (view.getUint16(entry, littleEndian) === tag && view.getUint16(entry + 2, littleEndian) === 2) {
        const charCode = view.getUint8(tiffStart + view.getUint32(entry + 8, littleEndian));
        return String.fromCharCode(charCode);
      }
    }
    return null;
  };
  const latParts = coord(2);
  const lonParts = coord(4);
  if (!latParts || !lonParts) return null;
  const latRef = ref(1);
  const lonRef = ref(3);
  const toDecimal = (parts: number[], negative: boolean): number => {
    const value = parts[0] + parts[1] / 60 + parts[2] / 3600;
    return negative ? -value : value;
  };
  return {
    latitude: toDecimal(latParts, latRef === 'S'),
    longitude: toDecimal(lonParts, lonRef === 'W')
  };
}

/** Analyze decoded RGBA pixels. Returns null for degenerate images. */
export function analyzePixels(decoded: DecodedImage): ImagePixelAnalysis | null {
  const { width, height, data } = decoded;
  if (!width || !height || data.length < width * height * 3) return null;
  const stepX = Math.max(1, Math.ceil(width / ANALYSIS_GRID));
  const stepY = Math.max(1, Math.ceil(height / ANALYSIS_GRID));
  const gridWidth = Math.ceil(width / stepX);
  const gridHeight = Math.ceil(height / stepY);
  const grid: number[][] = [];
  const buckets = new Map<number, { r: number; g: number; b: number; count: number }>();
  let luminanceSum = 0;
  let luminanceSquares = 0;
  let colorful = 0;
  let saturationSum = 0;
  let total = 0;
  for (let y = 0; y < height; y += stepY) {
    const row: number[] = [];
    for (let x = 0; x < width; x += stepX) {
      const index = (y * width + x) * 4;
      const r = data[index] ?? 0;
      const g = data[index + 1] ?? 0;
      const b = data[index + 2] ?? 0;
      const alpha = data[index + 3] ?? 255;
      if (alpha === 0) {
        row.push(-1);
        continue;
      }
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      row.push(luma);
      luminanceSum += luma;
      luminanceSquares += luma * luma;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.r += r;
        bucket.g += g;
        bucket.b += b;
        bucket.count += 1;
      } else {
        buckets.set(key, { r, g, b, count: 1 });
      }
      const maxChannel = Math.max(r, g, b);
      const minChannel = Math.min(r, g, b);
      const channelSpread = maxChannel - minChannel;
      if (channelSpread > 40) colorful += 1;
      saturationSum += channelSpread / 255;
      total += 1;
    }
    grid.push(row);
  }
  if (!total) return null;
  const meanLuma = luminanceSum / total;
  const variance = Math.max(0, luminanceSquares / total - meanLuma * meanLuma);
  const contrast = Math.sqrt(variance);
  const colors = [...buckets.entries()]
    .map(([, bucket]) => {
      const r = Math.round(bucket.r / bucket.count);
      const g = Math.round(bucket.g / bucket.count);
      const b = Math.round(bucket.b / bucket.count);
      const hex = `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
      return { hex, ratio: bucket.count / total };
    })
    .sort((left, right) => right.ratio - left.ratio)
    .slice(0, 5);
  const lumaGrid = grid.map((row) => row.map((value) => (value < 0 ? meanLuma : value)));
  let edgeCells = 0;
  let edgeTotal = 0;
  for (let y = 1; y < gridHeight - 1; y += 1) {
    for (let x = 1; x < gridWidth - 1; x += 1) {
      const horizontal = Math.abs(lumaGrid[y][x + 1] - lumaGrid[y][x - 1]);
      const vertical = Math.abs(lumaGrid[y + 1][x] - lumaGrid[y - 1][x]);
      if (Math.max(horizontal, vertical) > 24) edgeCells += 1;
      edgeTotal += 1;
    }
  }
  return {
    dominantColors: colors,
    brightness: Math.max(0, Math.min(1, meanLuma / 255)),
    contrast: Math.max(0, Math.min(1, contrast / 128)),
    sharpness: estimateSharpness(lumaGrid, gridWidth, gridHeight),
    colorfulness: colorful / total,
    edgeDensity: edgeTotal ? edgeCells / edgeTotal : 0,
    saturation: saturationSum / total,
    uniqueColorRatio: total ? buckets.size / total : 0,
    perceptualHash: dHash(data, width, height).toString(16),
    sampleCount: total
  };
}

export type ImageSceneKind = 'blank' | 'screenshot' | 'document' | 'photo' | 'graphic' | 'unknown';

export interface ImageScene {
  kind: ImageSceneKind;
  label: string;
  /** 0..1 heuristic estimate of how likely the image contains readable text. */
  textLikelihood: number;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Deterministic, fully-local scene classification. This is the "what is this
 * image?" signal that works without an LLM or OCR:
 *   - blank: almost no variation (solid color / empty scan)
 *   - document: high-contrast, edge-rich, low-color content (scans, receipts)
 *   - screenshot: edge-rich, high sharpness, often mixed color (UI captures)
 *   - photo: colorful, smooth gradients, lower edge density
 *   - graphic: limited color variety with flat regions (icons, logos, posters)
 * The textLikelihood score is used to decide when OCR is worth attempting and
 * to explain to the user why text was or was not looked for.
 */
export function classifyImageScene(pixels: ImagePixelAnalysis): ImageScene {
  const { contrast, sharpness, colorfulness, edgeDensity, saturation, sampleCount } = pixels;
  if (sampleCount < 512) {
    return { kind: 'unknown', label: 'Too small to classify', textLikelihood: 0.05, reason: 'The image is too small for reliable content analysis.', confidence: 'low' };
  }
  if (contrast < 0.05 && edgeDensity < 0.03) {
    return { kind: 'blank', label: 'Blank or solid', textLikelihood: 0.02, reason: 'Almost no tonal variation; the image is effectively blank.', confidence: 'high' };
  }
  // Hard edges on a high-contrast surface are the strongest text signal.
  const textScore = Math.min(1, edgeDensity * 1.5 + contrast * 0.6);
  if (colorfulness < 0.18 && contrast >= 0.22 && edgeDensity >= 0.12) {
    return {
      kind: 'document',
      label: 'Document / scan',
      textLikelihood: Math.max(0.6, textScore),
      reason: 'High-contrast, edge-rich, mostly monochrome content typical of a document or scan.',
      confidence: 'high'
    };
  }
  if (edgeDensity >= 0.12 && sharpness >= 0.3 && contrast >= 0.12) {
    return {
      kind: 'screenshot',
      label: 'Screenshot / UI',
      textLikelihood: Math.max(0.55, textScore),
      reason: 'Sharp, edge-dense content with UI-like contrast; screenshots usually contain readable text.',
      confidence: 'medium'
    };
  }
  if (colorfulness >= 0.3 && edgeDensity < 0.1 && sharpness < 0.4) {
    return {
      kind: 'photo',
      label: 'Photograph',
      textLikelihood: 0.12,
      reason: 'Colorful with smooth gradients and relatively few hard edges; typical of a photograph.',
      confidence: 'medium'
    };
  }
  if (saturation < 0.35 && edgeDensity < 0.08) {
    return {
      kind: 'graphic',
      label: 'Graphic / illustration',
      textLikelihood: 0.18,
      reason: 'Flat color regions with limited edge detail; looks like an illustration or graphic.',
      confidence: 'medium'
    };
  }
  return {
    kind: 'unknown',
    label: 'Mixed content',
    textLikelihood: textScore,
    reason: 'The image mixes text-like and pictorial content; treat the text estimate with caution.',
    confidence: 'low'
  };
}
