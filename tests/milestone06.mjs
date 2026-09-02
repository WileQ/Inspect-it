// Milestone 06 - OCR regression tests.
//
// Runs the REAL local OCR engine (tesseract.js) against deterministic
// synthetic images so the suite fails if the engine or its bundled assets
// break. Images are generated in-memory (bitmap font -> PNG / embedded JPEG),
// so no network, canvas, or system fonts are required.
//
// The deterministic scanned-PDF fixture embeds a PNG (FlateDecode) page image:
// PNG decoding is uniform across every tesseract.js-core WASM variant, which
// keeps this regression test independent of the libjpeg quirks that differ
// between the SIMD/relaxed-SIMD cores. JPEG page images (like real scanners
// produce) are covered by a second end-to-end test and by the JPEG->PNG
// normalization unit checks.
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzeItem } from '../src/shared/analyzers.ts';
import { isOcrAvailable, ocrImage, validateOcrText } from '../src/shared/ocr.ts';
import { decodeJpegToPng, jpegDimensions, looksLikeJpeg } from '../src/shared/image-codec.ts';
import { diagnosePdfImageStreams, extractPdfJpegs, extractPdfPageImages } from '../src/shared/pdf.ts';
import {
  makeCorruptScannedPdfItem,
  makeJpegScannedPdfItem,
  makeOcrTextItem,
  makeScannedPdfItem
} from './fixtures.mjs';
import { renderTextPng } from './ocr-font.mjs';

const signal = new AbortController().signal;

function hasEvidence(result, id) {
  return result.evidence.some((entry) => entry.id === id);
}

function hasFinding(result, id) {
  return result.unusual.some((finding) => finding.id === id);
}

/** Dump diagnostics (no file contents) when a scanned-PDF OCR check fails. */
async function diagnoseScannedPdf(makeItem, label) {
  const item = await makeItem();
  const pdfBytes = new Uint8Array(await item.file.arrayBuffer());
  const images = extractPdfPageImages(pdfBytes, 12);
  if (label === 'png') {
    // Report the PNG bytes BEFORE they are embedded, to separate a generator
    // problem from a PDF-assembly or extraction problem in CI.
    const generated = renderTextPng('HELLO WORLD', { scale: 12, pad: 24 });
    console.error(
      `[milestone06][png] generated PNG head=[${Array.from(generated.bytes.slice(0, 4)).map((b) => b.toString(16).padStart(2, '0')).join(' ')}] size=${generated.bytes.length}`
    );
  }
  console.error(`[milestone06][${label}] pdf name=${item.name} size=${pdfBytes.length} images=${images.length}`);
  console.error(`[milestone06][${label}] streams: ${diagnosePdfImageStreams(pdfBytes).join(' | ')}`);
  for (const image of images) {
    const dims = image.kind === 'jpeg' ? jpegDimensions(image.bytes) : null;
    console.error(
      `[milestone06][${label}] embedded image kind=${image.kind} bytes=${image.bytes.length}` +
        (dims ? ` dims=${dims.width}x${dims.height}` : '')
    );
    const outcome = await ocrImage(image.bytes);
    console.error(
      `[milestone06][${label}] ocrImage available=${outcome.available} textLength=${outcome.text.length} message=${(outcome.message ?? '').slice(0, 160)}`
    );
    if (image.kind === 'jpeg') {
      const png = await decodeJpegToPng(image.bytes);
      console.error(`[milestone06][${label}] jpeg normalized to png=${png ? png.length : 'null (not decodable)'}`);
    }
  }
  // Persist the failing PDF to a temp dir so CI artifacts can capture it.
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'inspect-this-ocr-'));
    const file = path.join(dir, item.name);
    writeFileSync(file, Buffer.from(pdfBytes));
    console.error(`[milestone06][${label}] wrote failing fixture to ${file}`);
  } catch {
    // Best-effort diagnostics only.
  }
}

async function assertScannedPdfOcr(makeItem, label) {
  const result = await analyzeItem(await makeItem(), { signal });
  const ocrEvidence = result.evidence.find((entry) => entry.id === 'pdf-ocr-text');
  if (!ocrEvidence || !ocrEvidence.value.trim()) {
    await diagnoseScannedPdf(makeItem, label);
  }
  assert.equal(Boolean(ocrEvidence && ocrEvidence.value.trim()), true, `${label} scanned PDF has OCR text evidence`);
  const upper = (ocrEvidence?.value ?? '').toUpperCase();
  assert.ok(upper.includes('HELLO'), `${label} scanned PDF OCR recovered HELLO`);
  assert.ok(upper.includes('WORLD'), `${label} scanned PDF OCR recovered WORLD`);
  assert.equal(hasFinding(result, 'pdf-ocr-text-recovered'), true, `${label} scanned PDF marks recovered text`);
  assert.ok(result.sections.some((section) => section.id === 'pdf-ocr'), `${label} scanned PDF has an OCR section`);
}

export async function runMilestoneSixTests() {
  // --- OCR engine availability ----------------------------------------------
  {
    assert.equal(await isOcrAvailable(), true, 'local OCR engine is installed');
  }

  // --- OCR reads real text from a synthetic image (deterministic) ------------
  {
    const item = makeOcrTextItem('ocr.png', 'HELLO WORLD', 12);
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    const outcome = await ocrImage(bytes);
    assert.equal(outcome.available, true, 'OCR engine recognized the image');
    const upper = outcome.text.toUpperCase();
    assert.ok(upper.includes('HELLO'), 'OCR output contains HELLO');
    assert.ok(upper.includes('WORLD'), 'OCR output contains WORLD');
    assert.ok(typeof outcome.confidence === 'number' && outcome.confidence > 0, 'OCR confidence is reported');
  }

  // --- OCR never fakes text on unreadable input ------------------------------
  {
    const outcome = await ocrImage(new Uint8Array([1, 2, 3]));
    assert.equal(outcome.text, '', 'no fake text for unreadable input');
    assert.ok(outcome.message && outcome.message.length > 0, 'explains why no text');
  }

  // --- Image analyzer surfaces OCR text --------------------------------------
  {
    const result = await analyzeItem(makeOcrTextItem('photo.png', 'HELLO WORLD', 12), { signal });
    assert.equal(hasEvidence(result, 'image-ocr'), true, 'image analyzer reports OCR');
    const ocr = result.evidence.find((entry) => entry.id === 'image-ocr');
    assert.ok(ocr && ocr.value.toUpperCase().includes('HELLO'), 'OCR text appears in the image report');
  }

  // --- Scanned PDF (PNG page image): OCR'd locally, deterministically --------
  {
    await assertScannedPdfOcr(makeScannedPdfItem, 'png');
  }

  // --- Scanned PDF (JPEG page image, like real scanners): OCR'd locally ------
  {
    await assertScannedPdfOcr(makeJpegScannedPdfItem, 'jpeg');
  }

  // --- Validation: real text accepted, phantom text rejected -----------------
  {
    assert.equal(validateOcrText('HELLO WORLD', 47).accepted, true, 'two real words at moderate confidence accepted');
    assert.equal(validateOcrText('a b c d', 90).accepted, false, 'isolated single letters rejected');
    assert.equal(validateOcrText('x7q 9', 45).accepted, false, 'single low-confidence word rejected');
    assert.equal(validateOcrText('The quick brown fox', 25).accepted, false, 'very low confidence rejected');
    assert.equal(validateOcrText('').accepted, false, 'empty output rejected');
  }

  // --- JPEG normalization (deterministic OCR across WASM/libjpeg variants) ----
  {
    const pdfItem = await makeJpegScannedPdfItem();
    const bytes = new Uint8Array(await pdfItem.file.arrayBuffer());
    const jpegs = extractPdfJpegs(bytes, 12);
    assert.equal(jpegs.length, 1, 'JPEG scanned PDF contains one embedded JPEG');
    const jpeg = jpegs[0];
    assert.equal(looksLikeJpeg(jpeg), true, 'embedded stream is a JPEG');
    const dims = jpegDimensions(jpeg);
    assert.ok(dims && dims.width > 0 && dims.height > 0, 'JPEG dimensions readable without full decode');
    const png = await decodeJpegToPng(jpeg);
    assert.ok(png && png.length > 0, 'JPEG normalized to PNG locally');
    assert.equal(looksLikeJpeg(png), false, 'normalized output is not a JPEG (it is PNG)');
    // Garbage that merely starts with the JPEG SOI must NOT normalize.
    const garbage = new Uint8Array(2 + 16);
    garbage[0] = 0xff;
    garbage[1] = 0xd8;
    assert.equal(await decodeJpegToPng(garbage), null, 'corrupt JPEG yields no normalized image');
  }

  // --- PNG scanned PDF extraction (raw PNG stream detected by magic) ---------
  {
    const pdfItem = await makeScannedPdfItem();
    const bytes = new Uint8Array(await pdfItem.file.arrayBuffer());
    const images = extractPdfPageImages(bytes, 12);
    assert.equal(images.length, 1, 'PNG scanned PDF contains one embedded page image');
    assert.equal(images[0].kind, 'png', 'embedded page image is a PNG');
    assert.equal(looksLikeJpeg(images[0].bytes), false, 'PNG is not mistaken for a JPEG');
  }

  // --- Corrupt embedded page image: no fabricated OCR text --------------------
  {
    const result = await analyzeItem(await makeCorruptScannedPdfItem(), { signal });
    assert.equal(result.evidence.some((entry) => entry.id === 'pdf-ocr-text'), false, 'corrupt page image yields no OCR text evidence');
    assert.ok(!(result.evidence.some((entry) => entry.id === 'pdf-ocr-text' && entry.value.trim())), 'no fabricated OCR text for a corrupt image');
    assert.equal(hasFinding(result, 'pdf-ocr-unreadable'), true, 'OCR failure is reported honestly (degraded, not silent)');
    const recovered = result.unusual.find((finding) => finding.id === 'pdf-ocr-text-recovered');
    assert.equal(recovered, undefined, 'no "text recovered" claim for a corrupt image');
  }

  console.log('Milestone 06 OCR tests passed.');
}
