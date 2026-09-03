// Generates the Inspect It app icons (PNG) without external image libraries:
//   build/icon.png  (512x512)  - used by electron-builder for the app/installer icon
//   build/tray.png  (32x32)    - system tray icon
//
// The icon matches the app: a warm orange circle with a cream four-point spark,
// on a transparent background. Rendering is per-pixel with anti-aliasing.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- Minimal PNG writer ------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// --- Rendering ---------------------------------------------------------------
function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

// Spark polygon vertices (4-point star), scaled around the circle center.
function sparkVertices(cx, cy, scale) {
  const view = [
    [12, 1.5], [14, 10], [22.5, 12], [14, 14], [12, 22.5], [10, 14], [1.5, 12], [10, 10]
  ];
  return view.map(([x, y]) => [cx + (x - 12) * scale, cy + (y - 12) * scale]);
}

function pointInPolygon(px, py, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
    const [xi, yi] = vertices[i];
    const [xj, yj] = vertices[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function renderIcon(size) {
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.46;
  const light = hexToRgb('#ffc27a');
  const mid = hexToRgb('#ff9e4f');
  const deep = hexToRgb('#d95f14');
  const cream = hexToRgb('#fff6e5');
  // Spark width target ~ 42% of the canvas; the 24-unit viewBox star is 21 units wide.
  const starScale = (size * 0.42) / 21;
  const vertices = sparkVertices(cx, cy, starScale);
  const ss = 4; // supersampling
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let insideCircle = 0;
      let insideStar = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          const dx = px - cx;
          const dy = py - cy;
          if (Math.hypot(dx, dy) <= radius) insideCircle += 1;
          if (pointInPolygon(px, py, vertices)) insideStar += 1;
        }
      }
      const circleCoverage = insideCircle / (ss * ss);
      const starCoverage = insideStar / (ss * ss);
      if (circleCoverage <= 0) {
        // Fully transparent
        continue;
      }
      // Diagonal gradient from top-left light to bottom-right deep.
      const t = Math.min(1, Math.max(0, (x + y) / (2 * size)));
      let color = t < 0.5 ? mix(light, mid, t * 2) : mix(mid, deep, (t - 0.5) * 2);
      // Slight edge darkening for a softer rim.
      const d = Math.hypot(x - cx, y - cy) / radius;
      const shade = 1 - 0.12 * Math.pow(Math.min(1, d), 2);
      color = color.map((channel) => Math.round(channel * shade));
      let final = color;
      if (starCoverage > 0) {
        final = mix(color, cream, Math.min(1, starCoverage + 0.15));
      }
      const alpha = Math.round(255 * circleCoverage);
      const index = (y * size + x) * 4;
      rgba[index] = final[0];
      rgba[index + 1] = final[1];
      rgba[index + 2] = final[2];
      rgba[index + 3] = alpha;
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build', 'icon.png'), renderIcon(512));
writeFileSync(join(root, 'build', 'tray.png'), renderIcon(32));
console.log('icons written: build/icon.png (512x512), build/tray.png (32x32)');
