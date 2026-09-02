// Local, dependency-light image codec helpers used by OCR.
//
// tesseract.js-core ships leptonica builds whose JPEG support (libjpeg) is not
// uniform across the SIMD/relaxed-SIMD WASM variants: some builds reject JPEGs
// that other decoders (libjpeg-turbo in browsers/PIL) accept. PNG support
// (libpng) IS uniform. To make OCR deterministic on every platform and WASM
// variant, JPEG inputs are decoded locally (jpeg-js, pure JS) and re-encoded
// as PNG before being handed to the OCR engine. All decoding stays on-device.
import { zlibSync } from 'fflate';

/** Max decoded pixels for OCR normalization (bounds memory on hostile input). */
const MAX_NORMALIZE_PIXELS = 24_000_000;

export function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/** Read JPEG dimensions from the SOF markers without decoding the whole file. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (!looksLikeJpeg(bytes)) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && offset + 9 <= bytes.length) {
      return { height: (bytes[offset + 5] << 8) | bytes[offset + 6], width: (bytes[offset + 7] << 8) | bytes[offset + 8] };
    }
    offset += 2 + length;
  }
  return null;
}

/** Encode RGBA pixels as a PNG (no canvas required; works in Node + browser). */
export function encodePng(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  const crc32 = (data: Uint8Array): number => {
    let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length, false);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
    return out;
  };
  return Uint8Array.from([
    ...Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', zlibSync(raw, { level: 9 })),
    ...chunk('IEND', new Uint8Array(0))
  ]);
}

/**
 * Decode a JPEG to PNG bytes. Returns null when the input is not a decodable
 * JPEG or exceeds the pixel budget (the caller then falls back to the original
 * bytes or reports OCR failure honestly).
 */
export async function decodeJpegToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (!looksLikeJpeg(bytes)) return null;
  const dims = jpegDimensions(bytes);
  if (!dims) return null;
  if (dims.width <= 0 || dims.height <= 0 || dims.width * dims.height > MAX_NORMALIZE_PIXELS) return null;
  try {
    const jpeg = await import('jpeg-js');
    const decoded = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 512 });
    const width = decoded.width;
    const height = decoded.height;
    if (!width || !height || width * height > MAX_NORMALIZE_PIXELS) return null;
    return encodePng(decoded.data, width, height);
  } catch {
    return null;
  }
}
