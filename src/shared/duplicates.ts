// Duplicate detection: exact (hash) and near (text shingles / image dHash).
// Read-only: files are only read, never modified.
import { unzlibSync } from 'fflate';
import { digestHex, formatBytes, formatNumber } from './utils.ts';

export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA
}

export interface DuplicateGroup {
  id: string;
  paths: string[];
  copies: number;
  wastedBytes: number;
  representative: string;
  method: 'exact' | 'sampled-hash';
}

/* ------------------------------------------------------------------ */
/* Image decoding (no canvas needed so it works in Node tests too)    */
/* ------------------------------------------------------------------ */

function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

/** Minimal PNG decoder: 8/16-bit, color types 0/2/3/6. */
export function decodePng(bytes: Uint8Array): DecodedImage | null {
  if (!isPng(bytes)) return null;
  const text = new TextDecoder('latin1');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const palette: number[] = [];
  const idat: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3];
    const type = text.decode(bytes.slice(offset + 4, offset + 8));
    const data = bytes.slice(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = bytes[offset + 8] * 0x1000000 + bytes[offset + 9] * 0x10000 + bytes[offset + 10] * 0x100 + bytes[offset + 11];
      height = bytes[offset + 12] * 0x1000000 + bytes[offset + 13] * 0x10000 + bytes[offset + 14] * 0x100 + bytes[offset + 15];
      bitDepth = bytes[offset + 16];
      colorType = bytes[offset + 17];
    } else if (type === 'PLTE') {
      for (let index = 0; index + 2 < data.length; index += 3) {
        palette.push(data[index], data[index + 1], data[index + 2]);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
  }
  if (!width || !height || !idat.length || (bitDepth !== 8 && bitDepth !== 16)) return null;
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 3 ? 1 : 0;
  if (!channels) return null;
  const totalIdat = idat.reduce((acc, chunk) => acc + chunk.length, 0);
  const combinedIdat = new Uint8Array(totalIdat);
  let idatOffset = 0;
  for (const chunk of idat) {
    combinedIdat.set(chunk, idatOffset);
    idatOffset += chunk.length;
  }
  const raw = unzlibSync(combinedIdat);
  const stride = width * channels * (bitDepth === 16 ? 2 : 1);
  const out = Buffer.alloc(height * stride);
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      const cur = raw[rowStart + x];
      const left = x >= channels * (bitDepth === 16 ? 2 : 1) ? out[y * stride + x - channels * (bitDepth === 16 ? 2 : 1)] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upleft = y > 0 && x >= channels * (bitDepth === 16 ? 2 : 1) ? out[(y - 1) * stride + x - channels * (bitDepth === 16 ? 2 : 1)] : 0;
      let val = cur;
      if (filter === 1) val = (cur + left) & 0xff;
      else if (filter === 2) val = (cur + up) & 0xff;
      else if (filter === 3) val = (cur + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) val = (cur + paeth(left, up, upleft)) & 0xff;
      out[y * stride + x] = val;
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  const bytesPerPixel = channels * (bitDepth === 16 ? 2 : 1);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const srcIndex = y * stride + x * bytesPerPixel;
      const dstIndex = (y * width + x) * 4;
      if (colorType === 6) {
        rgba[dstIndex] = out[srcIndex];
        rgba[dstIndex + 1] = out[srcIndex + 1];
        rgba[dstIndex + 2] = out[srcIndex + 2];
        rgba[dstIndex + 3] = out[srcIndex + 3];
      } else if (colorType === 2) {
        rgba[dstIndex] = out[srcIndex];
        rgba[dstIndex + 1] = out[srcIndex + 1];
        rgba[dstIndex + 2] = out[srcIndex + 2];
        rgba[dstIndex + 3] = 255;
      } else if (colorType === 0) {
        rgba[dstIndex] = out[srcIndex];
        rgba[dstIndex + 1] = out[srcIndex];
        rgba[dstIndex + 2] = out[srcIndex];
        rgba[dstIndex + 3] = 255;
      } else if (colorType === 3) {
        const paletteIndex = out[srcIndex] * 3;
        rgba[dstIndex] = palette[paletteIndex] ?? 0;
        rgba[dstIndex + 1] = palette[paletteIndex + 1] ?? 0;
        rgba[dstIndex + 2] = palette[paletteIndex + 2] ?? 0;
        rgba[dstIndex + 3] = 255;
      }
    }
  }
  return { width, height, data: rgba };
}

/** Minimal uncompressed 24/32-bit BMP decoder. */
export function decodeBmp(bytes: Uint8Array): DecodedImage | null {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pixelOffset = view.getUint32(10, true);
  const headerSize = view.getUint32(14, true);
  const width = view.getInt32(18, true);
  const heightRaw = view.getInt32(22, true);
  const bpp = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  if (headerSize < 40 || compression !== 0 || (bpp !== 24 && bpp !== 32) || width <= 0 || heightRaw === 0) return null;
  const height = Math.abs(heightRaw);
  const topDown = heightRaw < 0;
  const bytesPerPixel = bpp / 8;
  const rowSize = Math.floor((width * bpp + 31) / 32) * 4;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      const src = pixelOffset + row * rowSize + x * bytesPerPixel;
      const dst = (y * width + x) * 4;
      rgba[dst] = bytes[src + 2] ?? 0;
      rgba[dst + 1] = bytes[src + 1] ?? 0;
      rgba[dst + 2] = bytes[src] ?? 0;
      rgba[dst + 3] = bpp === 32 ? (bytes[src + 3] ?? 255) : 255;
    }
  }
  return { width, height, data: rgba };
}

/** Decode common image formats to RGBA. Browser canvas is preferred when available. */
export async function decodeImage(bytes: Uint8Array): Promise<DecodedImage | null> {
  // Browser path: let the platform decode PNG/JPEG/WebP/GIF etc.
  if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined') {
    try {
      const blob = new Blob([bytes as unknown as BlobPart]);
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (context) {
        context.drawImage(bitmap, 0, 0);
        const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
        bitmap.close();
        return { width: bitmap.width, height: bitmap.height, data: image.data };
      }
      bitmap.close();
    } catch {
      // fall through to built-in decoders
    }
  }
  return decodePng(bytes) || decodeBmp(bytes);
}

/* ------------------------------------------------------------------ */
/* Perceptual image hash (difference hash)                            */
/* ------------------------------------------------------------------ */

function grayscale(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    out[index] = 0.299 * rgba[offset] + 0.587 * rgba[offset + 1] + 0.114 * rgba[offset + 2];
  }
  return out;
}

/** Resize a grayscale image to size x (size-1) via box sampling (9x8 for 64-bit dHash). */
function resizeGray(gray: Float32Array, srcW: number, srcH: number, size: number): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    const srcY0 = Math.floor((y / size) * srcH);
    const srcY1 = Math.max(srcY0 + 1, Math.floor(((y + 1) / size) * srcH));
    for (let x = 0; x < size; x += 1) {
      const srcX0 = Math.floor((x / size) * srcW);
      const srcX1 = Math.max(srcX0 + 1, Math.floor(((x + 1) / size) * srcW));
      let sum = 0;
      let count = 0;
      for (let sy = srcY0; sy < srcY1; sy += 1) {
        for (let sx = srcX0; sx < srcX1; sx += 1) {
          sum += gray[sy * srcW + sx];
          count += 1;
        }
      }
      out[y * size + x] = count ? sum / count : 0;
    }
  }
  return out;
}

/** 64-bit difference hash. Returns a BigInt. */
export function dHash(rgba: Uint8ClampedArray, width: number, height: number, size = 9): bigint {
  const gray = grayscale(rgba, width, height);
  const resized = resizeGray(gray, width, height, size);
  let hash = 0n;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      hash <<= 1n;
      if (resized[y * size + x + 1] > resized[y * size + x]) {
        hash |= 1n;
      }
    }
  }
  return hash;
}

export function hammingDistance(left: bigint, right: bigint): number {
  let diff = left ^ right;
  let count = 0;
  while (diff) {
    diff &= diff - 1n;
    count += 1;
  }
  return count;
}

/** Similarity 0..1 based on dHash Hamming distance (64 bits). */
export function imageSimilarity(left: bigint, right: bigint): number {
  const bits = 64;
  return 1 - hammingDistance(left, right) / bits;
}

export async function imageHashOf(bytes: Uint8Array): Promise<bigint | null> {
  const decoded = await decodeImage(bytes);
  if (!decoded) return null;
  return dHash(decoded.data, decoded.width, decoded.height);
}

/* ------------------------------------------------------------------ */
/* Text near-duplicates (character n-gram Jaccard)                    */
/* ------------------------------------------------------------------ */

function shingles(text: string, n = 3): Set<string> {
  const set = new Set<string>();
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (normalized.length < n) {
    if (normalized) set.add(normalized);
    return set;
  }
  for (let index = 0; index <= normalized.length - n; index += 1) {
    set.add(normalized.slice(index, index + n));
  }
  return set;
}

/** Jaccard similarity of character n-gram sets (0..1). */
export function textSimilarity(left: string, right: string, n = 3): number {
  const a = shingles(left, n);
  const b = shingles(right, n);
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

/** Cheap length gate used for candidate filtering before expensive comparison. */
export function sameLengthFamily(left: string, right: string, tolerance = 0.25): boolean {
  if (!left.length || !right.length) return false;
  const ratio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
  return ratio >= 1 - tolerance;
}

export interface TextNearDuplicate {
  left: string;
  right: string;
  similarity: number;
  leftPath: string;
  rightPath: string;
}

/** Find near-duplicate text pairs with candidate filtering (length gate). */
export function findTextNearDuplicates(files: Array<{ path: string; name: string; text: string }>, threshold = 0.75, maxPairs = 8): TextNearDuplicate[] {
  const candidates = files.filter((file) => file.text.length > 0);
  const results: TextNearDuplicate[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      if (results.length >= maxPairs) return results;
      const left = candidates[i];
      const right = candidates[j];
      if (!sameLengthFamily(left.text, right.text)) continue;
      const similarity = textSimilarity(left.text, right.text);
      if (similarity >= threshold) {
        results.push({ left: left.path, right: right.path, similarity, leftPath: left.path, rightPath: right.path });
      }
    }
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Exact duplicates (size grouping + SHA-256)                         */
/* ------------------------------------------------------------------ */

const HASH_SAMPLE_BYTES = 16 * 1024 * 1024;

async function fileDigest(file: File): Promise<{ digest: string; sampled: boolean }> {
  if (file.size <= HASH_SAMPLE_BYTES) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { digest: await digestHex(bytes), sampled: false };
  }
  // Large files: hash head + tail so memory stays bounded; mark as sampled.
  const head = new Uint8Array(await file.slice(0, 4 * 1024 * 1024).arrayBuffer());
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 4 * 1024 * 1024)).arrayBuffer());
  const payload = new Uint8Array(head.length + tail.length + 8);
  payload.set(head, 0);
  payload.set(tail, head.length);
  payload.set(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), head.length + tail.length);
  return { digest: await digestHex(payload), sampled: true };
}

export async function findExactDuplicates(
  files: Array<{ name: string; size: number; path: string; file: File }>,
  options?: { limit?: number }
): Promise<DuplicateGroup[]> {
  const limit = options?.limit ?? 200;
  const bySize = new Map<number, Array<{ name: string; size: number; path: string; file: File }>>();
  for (const file of files) {
    const group = bySize.get(file.size) ?? [];
    group.push(file);
    bySize.set(file.size, group);
  }
  const groups: DuplicateGroup[] = [];
  for (const [, sameSize] of bySize) {
    if (sameSize.length < 2) continue;
    const byDigest = new Map<string, Array<{ name: string; size: number; path: string; file: File; sampled: boolean }>>();
    for (const entry of sameSize.slice(0, limit)) {
      const { digest, sampled } = await fileDigest(entry.file);
      const bucket = byDigest.get(digest) ?? [];
      bucket.push({ ...entry, sampled });
      byDigest.set(digest, bucket);
    }
    for (const [, bucket] of byDigest) {
      if (bucket.length < 2) continue;
      groups.push({
        id: `dup-${bucket[0].size}-${bucket[0].path}`,
        paths: bucket.map((entry) => entry.path),
        copies: bucket.length,
        wastedBytes: (bucket.length - 1) * bucket[0].size,
        representative: bucket[0].path,
        method: bucket[0].sampled ? 'sampled-hash' : 'exact'
      });
    }
  }
  return groups.sort((a, b) => b.wastedBytes - a.wastedBytes);
}

export function summarizeDuplicates(groups: DuplicateGroup[]): { groups: number; copies: number; wastedBytes: number } {
  return {
    groups: groups.length,
    copies: groups.reduce((acc, group) => acc + group.copies, 0),
    wastedBytes: groups.reduce((acc, group) => acc + group.wastedBytes, 0)
  };
}

export function formatWasted(bytes: number): string {
  return formatBytes(bytes);
}

export function formatCopies(count: number): string {
  return formatNumber(count);
}
