// Synthetic OCR test images: renders text with a built-in 5x7 bitmap font and
// encodes a PNG, so OCR tests are deterministic and need no system fonts,
// canvas, or network. Used by fixtures for the OCR regression test and for the
// scanned-PDF fixture.
import { gzipSync, zlibSync } from 'fflate';

const FONT_5X7 = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '11110', '10001', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '11110', '10000', '10000', '10000', '11111'],
  F: ['11111', '10000', '11110', '10000', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '11111', '10001', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '11110', '10000', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '11110', '10100', '10010', '10001', '10001'],
  S: ['01111', '10000', '01110', '00001', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '01010', '00100', '00100', '00100', '01010', '10001'],
  Y: ['10001', '01010', '00100', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00110', '00001', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '01110', '10001', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '00110', '00110'],
  ',': ['00000', '00000', '00000', '00000', '00110', '00100', '01000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ':': ['00000', '00110', '00110', '00000', '00110', '00110', '00000']
};

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  out.set(Uint8Array.from(type, (c) => c.charCodeAt(0)), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Uint8Array.from([
    ...Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...pngChunk('IHDR', ihdr),
    ...pngChunk('IDAT', zlibSync(raw, { level: 9 })),
    ...pngChunk('IEND', new Uint8Array(0))
  ]);
}

/**
 * Render `text` as a high-contrast bitmap (black on white RGBA) using a 5x7
 * font scaled by `scale`. Returns { data, width, height }.
 */
export function renderTextRgba(text, options = {}) {
  const scale = options.scale ?? 10;
  const pad = options.pad ?? 20;
  const glyphWidth = 5;
  const glyphHeight = 7;
  const spacing = 1;
  const chars = [...text.toUpperCase()];
  const cellW = glyphWidth * scale;
  const cellH = glyphHeight * scale;
  const width = pad * 2 + chars.reduce((acc, ch) => acc + cellW + spacing * scale, 0) - spacing * scale;
  const height = pad * 2 + cellH;
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255); // white background
  let cursorX = pad;
  for (const ch of chars) {
    const glyph = FONT_5X7[ch] ?? FONT_5X7[' '];
    for (let gy = 0; gy < glyphHeight; gy += 1) {
      const row = glyph[gy];
      for (let gx = 0; gx < glyphWidth; gx += 1) {
        if (row[gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            const x = cursorX + gx * scale + sx;
            const y = pad + gy * scale + sy;
            const index = (y * width + x) * 4;
            data[index] = 0;
            data[index + 1] = 0;
            data[index + 2] = 0;
          }
        }
      }
    }
    cursorX += cellW + spacing * scale;
  }
  return { data, width, height };
}

/**
 * Render `text` as a high-contrast bitmap PNG (black on white) using a 5x7
 * font scaled by `scale`. Returns { bytes, width, height }.
 */
export function renderTextPng(text, options = {}) {
  const { data, width, height } = renderTextRgba(text, options);
  return { bytes: encodePng(width, height, data), width, height };
}

/** Gzip helper for producing eng.traineddata.gz-style payloads if ever needed. */
export { gzipSync };
