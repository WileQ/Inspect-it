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
  makeMultiPageScannedPdfItem,
  makeNoTextScannedPdfItem,
  makeOcrTextItem,
  makePdfItem,
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
    const dir = mkdtempSync(path.join(tmpdir(), 'inspect-it-ocr-'));
    const file = path.join(dir, item.name);
    writeFileSync(file, Buffer.from(pdfBytes));
    console.error(`[milestone06][${label}] wrote failing fixture to ${file}`);
  } catch {
    // Best-effort diagnostics only.
  }
}

async function assertScannedPdfOcr(makeItem, label) {
  const result = await analyzeItem(await makeItem(), { signal });
  const ocrSection = result.sections.find((section) => section.id === 'pdf-ocr');
  const ocrTextSection = result.sections.find((section) => section.id === 'pdf-ocr-text');
  if (!ocrSection || !ocrTextSection || !ocrTextSection.items.some((item) => item.value.trim())) {
    await diagnoseScannedPdf(makeItem, label);
  }
  assert.ok(ocrSection, `${label} scanned PDF has an OCR status section`);
  assert.equal(ocrSection.items.find((entry) => entry.id === 'pdf-ocr-status')?.value, 'Available', `${label} OCR status is Available`);
  const words = result.evidence.find((entry) => entry.id === 'pdf-ocr-words');
  assert.ok(words && Number(words.value) > 0, `${label} OCR words recovered > 0`);
  assert.ok(ocrTextSection, `${label} scanned PDF has exactly one OCR text section`);
  const allOcrText = ocrTextSection.items.map((item) => item.value).join(' ').toUpperCase();
  assert.ok(allOcrText.includes('HELLO'), `${label} OCR text contains HELLO`);
  assert.ok(allOcrText.includes('WORLD'), `${label} OCR text contains WORLD`);
  // OCR page text must NOT be duplicated into other report sections.
  const duplicatedOcrText = result.sections
    .filter((section) => section.id !== 'pdf-ocr-text')
    .some((section) => section.items.some((item) => String(item.value).toUpperCase().includes('HELLO')));
  assert.equal(duplicatedOcrText, false, `${label} OCR text appears only in the OCR text section`);
  // Native extraction facts stay honest: words = 0 for an image-only PDF.
  assert.equal(result.evidence.find((entry) => entry.id === 'pdf-words')?.value, '0', `${label} native PDF words stay 0`);
  assert.equal(hasFinding(result, 'pdf-ocr-text-recovered'), true, `${label} recovered-text finding present`);
  assert.equal(result.unusual.filter((f) => f.id.startsWith('pdf-ocr')).length, 1, `${label} exactly one OCR finding`);
  assert.equal(hasFinding(result, 'pdf-ocr'), false, `${label} no OCR-opportunity finding`);
  assert.ok(result.recommendations.every((f) => !f.id.startsWith('pdf-ocr')), `${label} no OCR recommendation after success`);
  assert.ok(!(result.limitations ?? []).some((item) => /OCR opportunity likely/i.test(item)), `${label} no stale OCR-opportunity limitation`);
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

  // --- Corrupt embedded page image: honest OCR failed state, no fake text ----
  {
    const result = await analyzeItem(await makeCorruptScannedPdfItem(), { signal });
    const ocrSection = result.sections.find((s) => s.id === 'pdf-ocr');
    assert.ok(ocrSection, 'OCR status section present for a corrupt scan');
    assert.equal(ocrSection.items.find((i) => i.id === 'pdf-ocr-status')?.value, 'OCR failed', 'corrupt scan reports OCR failed');
    assert.equal(hasFinding(result, 'pdf-ocr-unreadable'), true, 'OCR failure finding reported honestly');
    assert.equal(hasFinding(result, 'pdf-ocr-text-recovered'), false, 'no recovered-text claim for a corrupt image');
    assert.ok(!result.sections.some((s) => s.id === 'pdf-ocr-text'), 'no OCR text section for a corrupt image');
  }

  // --- Multi-page scanned PDF: per-page OCR + page association preserved -----
  {
    const result = await analyzeItem(await makeMultiPageScannedPdfItem(3), { signal });
    const ocrSection = result.sections.find((s) => s.id === 'pdf-ocr');
    assert.ok(ocrSection, 'OCR status section present');
    assert.equal(ocrSection.items.find((i) => i.id === 'pdf-ocr-status')?.value, 'Available', 'OCR status Available');
    assert.equal(ocrSection.items.find((i) => i.id === 'pdf-ocr-pages')?.value, '3', 'OCR pages processed = 3');
    const wordsRecovered = ocrSection.items.find((i) => i.id === 'pdf-ocr-words');
    assert.ok(wordsRecovered && Number(wordsRecovered.value) > 0, 'OCR words recovered > 0');
    const confidence = ocrSection.items.find((i) => i.id === 'pdf-ocr-confidence');
    assert.ok(confidence && /^\d+%$/.test(confidence.value), 'OCR average confidence present');
    const section = result.sections.find((s) => s.id === 'pdf-ocr-text');
    assert.ok(section, 'single OCR text section present');
    assert.equal(section.collapsed, true, 'OCR text section is collapsed by default');
    const pages = section.items.filter((i) => /^Page \d+$/.test(i.label));
    assert.equal(pages.length, 3, 'per-page OCR rows for all 3 pages');
    for (const page of pages) {
      assert.equal(page.location?.type, 'page', `${page.label} has page location`);
      assert.equal(page.location?.page, Number(page.label.split(' ')[1]), `${page.label} location matches page number`);
      assert.ok(page.value.toUpperCase().includes('HELLO'), `page ${page.label} carries OCR text`);
    }
    assert.equal(hasFinding(result, 'pdf-ocr-text-recovered'), true, 'recovered-text finding present');
    assert.equal(result.unusual.filter((f) => f.id.startsWith('pdf-ocr')).length, 1, 'one OCR finding only');
    assert.equal(hasFinding(result, 'pdf-ocr'), false, 'no OCR-opportunity finding');
    assert.ok(result.recommendations.every((f) => !f.id.startsWith('pdf-ocr')), 'no OCR recommendation after success');
    const density = result.evidence.find((e) => e.id === 'pdf-text-density');
    assert.ok(density && Number(density.value.replace(' words per page', '')) > 0, 'text density recalculated after OCR');
    const extracted = result.sections.find((s) => s.id === 'pdf-text');
    assert.ok(extracted, 'extracted text section present');
    const extractedPages = extracted.items.filter((i) => /^Page \d+$/.test(i.label));
    assert.equal(extractedPages.length, 3, 'extracted text shows per-page rows');
    for (const page of extractedPages) {
      assert.equal(page.value, 'No native text', 'image-only pages show No native text');
    }
  }

  // --- Case A: native text PDF needs no OCR section/recommendation ----------
  {
    const result = await analyzeItem(await makePdfItem(), { signal });
    const words = result.evidence.find((e) => e.id === 'pdf-words');
    assert.ok(words && Number(words.value) > 0, 'native text PDF has words');
    assert.equal(result.sections.some((s) => s.id === 'pdf-ocr' || s.id === 'pdf-ocr-text'), false, 'no OCR section for a healthy text PDF');
    assert.ok(result.unusual.every((f) => !f.id.startsWith('pdf-ocr')), 'no OCR findings for a healthy text PDF');
    assert.ok(result.recommendations.every((f) => !f.id.startsWith('pdf-ocr')), 'no OCR recommendations for a healthy text PDF');
  }

  // --- Case C: scanned PDF + OCR unavailable -> concise state + one rec ------
  {
    const result = await analyzeItem(await makeMultiPageScannedPdfItem(2), { signal, ocrAvailableOverride: false });
    const ocrSection = result.sections.find((s) => s.id === 'pdf-ocr');
    assert.ok(ocrSection, 'OCR section present when unavailable');
    assert.equal(ocrSection.items.find((i) => i.id === 'pdf-ocr-status')?.value, 'OCR unavailable', 'status says OCR unavailable');
    assert.ok(ocrSection.items.some((i) => i.id === 'pdf-ocr-reason' && /image-based pages/.test(i.value)), 'reason explains the scanned PDF');
    assert.equal(result.recommendations.filter((f) => f.id.startsWith('pdf-ocr')).length, 1, 'exactly one OCR recommendation');
    assert.ok(result.recommendations.some((f) => f.id === 'pdf-ocr-enable' && /Enable local OCR/.test(f.summary)), 'enable-OCR recommendation present');
    assert.equal(hasFinding(result, 'pdf-ocr'), false, 'no OCR-opportunity finding when unavailable');
    assert.equal(hasFinding(result, 'pdf-ocr-text-recovered'), false, 'no recovered-text finding when unavailable');
    assert.ok(!result.sections.some((s) => s.id === 'pdf-ocr-text'), 'no OCR text section when unavailable');
  }

  // --- Case D: OCR runs but finds no meaningful text -------------------------
  {
    const result = await analyzeItem(await makeNoTextScannedPdfItem(), { signal });
    const ocrSection = result.sections.find((s) => s.id === 'pdf-ocr');
    assert.ok(ocrSection, 'OCR section present when no text is recovered');
    assert.equal(ocrSection.items.find((i) => i.id === 'pdf-ocr-status')?.value, 'OCR completed \u2014 no meaningful text recovered', 'status says completed with no meaningful text');
    assert.equal(hasFinding(result, 'pdf-ocr-text-recovered'), false, 'no false recovered-text finding');
    assert.equal(hasFinding(result, 'pdf-ocr-unreadable'), false, 'no false failure finding when OCR ran');
    assert.ok(!result.sections.some((s) => s.id === 'pdf-ocr-text'), 'no OCR text section when nothing was recovered');
  }

  // --- Desktop bridge makes OCR available even if the renderer copy cannot load
  {
    const fakeRun = async () => ({ ok: true, text: 'BRIDGE OCR TEXT', confidence: 92, words: [] });
    const prev = globalThis.window;
    globalThis.window = { inspectItDesktop: { ocr: { run: fakeRun } } };
    try {
      assert.equal(await isOcrAvailable(), true, 'OCR available when the desktop bridge exists');
      const outcome = await ocrImage(new Uint8Array([1, 2, 3]));
      assert.equal(outcome.available, true, 'bridge OCR outcome available');
      assert.equal(outcome.text, 'BRIDGE OCR TEXT', 'ocrImage routes to the desktop bridge');
      assert.ok(outcome.provider.includes('desktop'), 'desktop provider label used');
    } finally {
      if (prev === undefined) delete globalThis.window;
      else globalThis.window = prev;
    }
  }

  console.log('Milestone 06 OCR tests passed.');
}
