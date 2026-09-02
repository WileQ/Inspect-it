// Milestone 06 - OCR regression tests.
//
// Runs the REAL local OCR engine (tesseract.js) against deterministic
// synthetic images so the suite fails if the engine or its bundled assets
// break. Images are generated in-memory (bitmap font -> PNG / embedded JPEG),
// so no network, canvas, or system fonts are required.
import assert from 'node:assert/strict';
import { analyzeItem } from '../src/shared/analyzers.ts';
import { isOcrAvailable, ocrImage, validateOcrText } from '../src/shared/ocr.ts';
import { makeOcrTextItem, makeScannedPdfItem } from './fixtures.mjs';

const signal = new AbortController().signal;

function hasEvidence(result, id) {
  return result.evidence.some((entry) => entry.id === id);
}

function hasFinding(result, id) {
  return result.unusual.some((finding) => finding.id === id);
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

  // --- Scanned PDF: embedded page images are OCR'd locally -------------------
  {
    const result = await analyzeItem(await makeScannedPdfItem(), { signal });
    assert.equal(hasEvidence(result, 'pdf-ocr-text'), true, 'scanned PDF has OCR text evidence');
    const ocr = result.evidence.find((entry) => entry.id === 'pdf-ocr-text');
    const upper = (ocr?.value ?? '').toUpperCase();
    assert.ok(upper.includes('HELLO'), 'scanned PDF OCR recovered HELLO');
    assert.ok(upper.includes('WORLD'), 'scanned PDF OCR recovered WORLD');
    assert.equal(hasFinding(result, 'pdf-ocr-text-recovered'), true, 'scanned PDF marks recovered text');
    assert.ok(result.sections.some((section) => section.id === 'pdf-ocr'), 'scanned PDF has an OCR section');
  }

  // --- Validation: real text accepted, phantom text rejected -----------------
  {
    assert.equal(validateOcrText('HELLO WORLD', 47).accepted, true, 'two real words at moderate confidence accepted');
    assert.equal(validateOcrText('a b c d', 90).accepted, false, 'isolated single letters rejected');
    assert.equal(validateOcrText('x7q 9', 45).accepted, false, 'single low-confidence word rejected');
    assert.equal(validateOcrText('The quick brown fox', 25).accepted, false, 'very low confidence rejected');
    assert.equal(validateOcrText('').accepted, false, 'empty output rejected');
  }

  console.log('Milestone 06 OCR tests passed.');
}
