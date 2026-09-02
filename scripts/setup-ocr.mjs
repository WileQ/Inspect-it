// Copies the tesseract.js worker and tesseract.js-core (WASM) files into
// public/ocr/ so Vite ships them with the renderer and the packaged app can
// run OCR fully offline (no CDN). Runs automatically before dev/build via the
// "predev" / "prebuild" npm hooks.
//
// The language data (public/ocr/eng.traineddata.gz) is committed to the repo;
// the worker + core files are copied from the installed node_modules so they
// always match the installed tesseract.js version.
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'ocr');
const coreOut = join(outDir, 'core');
const workerSource = join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js');
const coreSource = join(root, 'node_modules', 'tesseract.js-core');

function fail(message) {
  console.error(`[setup-ocr] ${message}`);
  process.exit(1);
}

if (!existsSync(workerSource)) fail('tesseract.js is not installed (run npm install).');
if (!existsSync(coreSource)) fail('tesseract.js-core is not installed (run npm install).');

mkdirSync(coreOut, { recursive: true });

// Worker script (used by the browser path).
cpSync(workerSource, join(outDir, 'worker.min.js'), { force: true });

// Core loader + WASM files. tesseract.js picks the right variant per device,
// so copy every *.wasm.js and *.wasm pair.
for (const entry of ['tesseract-core.wasm.js', 'tesseract-core.wasm', 'tesseract-core-simd.wasm.js', 'tesseract-core-simd.wasm', 'tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm', 'tesseract-core-relaxedsimd.wasm.js', 'tesseract-core-relaxedsimd.wasm', 'tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm']) {
  const source = join(coreSource, entry);
  if (existsSync(source)) {
    cpSync(source, join(coreOut, entry), { force: true });
  }
}

const size = (p) => statSync(p).size;
console.log(
  `[setup-ocr] OCR assets ready in public/ocr/ (worker ${Math.round(size(join(outDir, 'worker.min.js')) / 1024)} KB, core ${Math.round(size(join(coreOut, 'tesseract-core-simd.wasm')) / 1024)} KB+)`
);
