// Milestone 03 - deep local analysis tests. Deterministic fixtures, no network.
import assert from 'node:assert/strict';
import { analyzeItem } from '../src/shared/analyzers.ts';
import {
  iqrBounds,
  median,
  skewness,
  temporalSpikes,
  zscore,
  anomalyToFinding,
  histogram
} from '../src/shared/anomaly.ts';
import {
  decodeImage,
  dHash,
  findExactDuplicates,
  imageSimilarity,
  textSimilarity,
  findTextNearDuplicates
} from '../src/shared/duplicates.ts';
import { isOcrAvailable, ocrImage, ocrWorthwhile, validateOcrText } from '../src/shared/ocr.ts';
import { analyzePixels, classifyImageScene, extractJpegExif } from '../src/shared/image-analysis.ts';
import { analyzeFunctionMetrics } from '../src/shared/code.ts';
import { collectDependencyGraph, dependencyRelationships } from '../src/shared/dependencies.ts';
import { findCrossObjectRelationships } from '../src/shared/relationships.ts';
import {
  makeDeepCsvItem,
  makePatternPngItem,
  makePatternPngResizedItem,
  makeTextLikePngItem,
  makeComplexCodeItem,
  makeProjectWithManifests,
  makeLogSpikeItem,
  makeXlsxDeepItem,
  makeMultiSelectionFolder,
  makeDuplicateFolderItem,
  makeExifJpegItem,
  makePdfItem,
  toItem
} from './fixtures.mjs';

const signal = new AbortController().signal;

function hasFinding(result, id) {
  return result.unusual.some((f) => f.id === id) || result.important.some((f) => f.id === id);
}

function hasEvidence(result, label, value) {
  return result.evidence.some((entry) => entry.label === label && (value === undefined || entry.value === value));
}

export async function runMilestoneThreeTests() {
  // --- Statistical engine ---
  {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100];
    assert.ok(zscore(100, values) > 2, 'z-score flags extreme value');
    const bounds = iqrBounds(values);
    assert.ok(bounds.upper < 100, 'IQR fence excludes extreme value');
    assert.equal(median([3, 1, 2]), 2, 'median');
    assert.ok(skewness([1, 2, 3, 4, 5, 50]) > 0, 'positive skewness for right tail');
    const spikes = temporalSpikes([1, 1, 1, 1, 25, 1, 1], { k: 3, minZ: 2, minCount: 3 });
    assert.equal(spikes.length, 1, 'temporal spike detected');
    assert.equal(spikes[0].index, 4, 'spike at correct bucket');
    const hist = histogram([1, 1, 2, 2, 2, 3, 4, 100], 4);
    assert.ok(hist.counts.length === 4 && hist.counts.reduce((a, b) => a + b, 0) === 8, 'histogram sums to n');
    const finding = anomalyToFinding({
      id: 'test-anomaly',
      label: 'test',
      measured: '5',
      baseline: '1',
      deviation: '5x',
      confidence: 'high',
      strength: 0.8,
      evidenceIds: ['e1']
    }, 'Test anomaly', 'low');
    assert.equal(finding.methodology, 'anomaly');
    assert.equal(finding.confidence, 'high');
  }

  // --- CSV deep analysis ---
  {
    const result = await analyzeItem(makeDeepCsvItem(), { signal });
    assert.equal(result.analyzerId, 'csv');
    assert.equal(hasFinding(result, 'csv-skew-score') || result.unusual.some((f) => f.id.startsWith('csv-skew-')), true, 'CSV skew finding');
    assert.equal(hasFinding(result, 'csv-constant-category'), true, 'CSV constant column finding');
    assert.equal(hasFinding(result, 'csv-dup-col-status'), true, 'CSV duplicate-heavy column finding');
    assert.equal(hasFinding(result, 'csv-missing-col-note'), true, 'CSV extreme missingness finding');
    assert.ok(result.sections.some((section) => section.id === 'csv-deep'), 'CSV deep section');
    assert.ok((result.visualizations ?? []).some((viz) => viz.kind === 'histogram'), 'CSV histogram visualization');
    const deepFinding = result.unusual.find((f) => f.id.startsWith('csv-skew-'));
    assert.equal(deepFinding?.methodology, 'anomaly', 'CSV anomaly methodology');
    assert.ok(deepFinding?.metrics?.strength !== undefined, 'CSV anomaly strength metric');
  }

  // --- Exact duplicates ---
  {
    const item = makeDuplicateFolderItem();
    const result = await analyzeItem(item, { signal });
    assert.equal(hasFinding(result, 'folder-deep-exact-duplicates'), true, 'exact duplicate finding');
    assert.equal(hasEvidence(result, 'Duplicate groups', '1'), true, 'duplicate groups evidence');
    assert.equal(hasEvidence(result, 'Wasted bytes'), true, 'wasted bytes evidence');
    const dupFinding = result.unusual.find((f) => f.id === 'folder-deep-exact-duplicates');
    assert.equal(dupFinding?.methodology, 'fact', 'exact duplicates are measured facts');
    assert.ok(dupFinding?.metrics?.wastedBytes > 0, 'wasted bytes metric');
  }
  {
    const a = toItem('a.bin', new TextEncoder().encode('hello world'), 'application/octet-stream');
    const b = toItem('b.bin', new TextEncoder().encode('hello world'), 'application/octet-stream');
    const c = toItem('c.bin', new TextEncoder().encode('different'), 'application/octet-stream');
    const groups = await findExactDuplicates([
      { name: 'a.bin', size: a.size, path: 'a.bin', file: a.file },
      { name: 'b.bin', size: b.size, path: 'b.bin', file: b.file },
      { name: 'c.bin', size: c.size, path: 'c.bin', file: c.file }
    ]);
    assert.equal(groups.length, 1, 'exact duplicate group');
    assert.equal(groups[0].copies, 2, 'two copies');
    assert.ok(groups[0].wastedBytes > 0, 'wasted bytes');
  }

  // --- Perceptual image similarity ---
  {
    const original = makePatternPngItem();
    const resized = makePatternPngResizedItem();
    const other = makePatternPngItem('other.png', 16, 7);
    const aBytes = new Uint8Array(await original.file.arrayBuffer());
    const bBytes = new Uint8Array(await resized.file.arrayBuffer());
    const cBytes = new Uint8Array(await other.file.arrayBuffer());
    const decodedA = await decodeImage(aBytes);
    const decodedB = await decodeImage(bBytes);
    const decodedC = await decodeImage(cBytes);
    assert.ok(decodedA && decodedB && decodedC, 'PNG decoding works in Node');
    const hashA = dHash(decodedA.data, decodedA.width, decodedA.height);
    const hashB = dHash(decodedB.data, decodedB.width, decodedB.height);
    const hashC = dHash(decodedC.data, decodedC.width, decodedC.height);
    const samePattern = imageSimilarity(hashA, hashB);
    const differentPattern = imageSimilarity(hashA, hashC);
    assert.ok(samePattern >= 0.85, `resized copy similar (got ${samePattern.toFixed(2)})`);
    assert.ok(differentPattern < 0.8, `different pattern not similar (got ${differentPattern.toFixed(2)})`);
  }

  // --- Text near-duplicates ---
  {
    assert.ok(textSimilarity('the quick brown fox jumps', 'the quick brown fox jumps') > 0.95, 'identical text');
    assert.ok(textSimilarity('the quick brown fox jumps over', 'the quick brown fox jumps over the lazy dog') > 0.6, 'similar text');
    assert.ok(textSimilarity('completely unrelated content here', 'the quick brown fox') < 0.3, 'unrelated text');
    const pairs = findTextNearDuplicates([
      { path: 'a.txt', name: 'a.txt', text: 'alpha beta gamma delta epsilon zeta' },
      { path: 'b.txt', name: 'b.txt', text: 'alpha beta gamma delta epsilon zeta' },
      { path: 'c.txt', name: 'c.txt', text: 'totally different words here now' }
    ], 0.75, 4);
    assert.equal(pairs.length, 1, 'one near-duplicate pair');
  }

  // --- OCR architecture (local engine present, never fakes output) ---
  {
    assert.equal(await isOcrAvailable(), true, 'local OCR engine is installed');
    const outcome = await ocrImage(new Uint8Array([1, 2, 3]));
    assert.equal(outcome.text, '', 'no fake OCR text for unreadable input');
    assert.ok(outcome.message && outcome.message.length > 0, 'explains why no text');
    assert.equal(ocrWorthwhile({ pageCount: 3, textSnippetCount: 0, imageCount: 2 }).worthwhile, true, 'image-only pages warrant OCR');
    assert.equal(ocrWorthwhile({ pageCount: 3, textSnippetCount: 40 }).worthwhile, false, 'text-rich pages do not warrant OCR');
    assert.equal(ocrWorthwhile({ isScreenshot: true }).worthwhile, true, 'screenshots warrant OCR');
  }

  // --- OCR output validation (no phantom text) ---
  {
    assert.equal(validateOcrText('').accepted, false, 'empty OCR rejected');
    assert.equal(validateOcrText('Il1 0oO ~~~ !!! ###', 30).accepted, false, 'low-confidence gibberish rejected');
    assert.equal(validateOcrText('a b c d', 90).accepted, false, 'isolated single letters rejected');
    assert.equal(validateOcrText('x7q 9', 45).accepted, false, 'two low-confidence words rejected');
    const accepted = validateOcrText('Hello world this is a report', 92);
    assert.equal(accepted.accepted, true, 'coherent multi-word text accepted');
    assert.equal(accepted.words.length, 5, 'meaningful words kept (single letters dropped)');
    const strongPair = validateOcrText('Welcome Home', 88, [{ text: 'Welcome', confidence: 90 }, { text: 'Home', confidence: 86 }]);
    assert.equal(strongPair.accepted, true, 'two high-confidence words accepted');
    assert.ok(Math.abs((strongPair.meanConfidence ?? 0) - 88) < 0.01, 'mean word confidence computed');
    const noisy = validateOcrText('The quick brown fox', 25);
    assert.equal(noisy.accepted, false, 'very low overall confidence rejects even wordy output');
  }
  {
    assert.equal(ocrWorthwhile({ width: 1600, height: 900 }).worthwhile, true, 'document-sized images warrant OCR');
    assert.equal(ocrWorthwhile({ width: 64, height: 64 }).worthwhile, false, 'tiny icons do not warrant OCR');
    assert.equal(ocrWorthwhile({ width: 800, height: 600, isScreenshot: true }).worthwhile, true, 'screenshot hint still wins');
  }

  // --- Image pixel analysis (the analyzer actually inspects the image) ---
  {
    const result = await analyzeItem(makePatternPngItem('palette.png', 64, 3), { signal });
    assert.equal(result.analyzerId, 'image');
    assert.equal(hasEvidence(result, 'Dominant colors'), true, 'dominant colors evidence');
    assert.equal(hasEvidence(result, 'Brightness'), true, 'brightness evidence');
    assert.equal(hasEvidence(result, 'Contrast'), true, 'contrast evidence');
    assert.equal(hasEvidence(result, 'Sharpness'), true, 'sharpness evidence');
    assert.equal(hasEvidence(result, 'Perceptual hash'), true, 'perceptual hash evidence');
    assert.ok((result.visualizations ?? []).some((viz) => viz.kind === 'bars' && viz.id === 'image-palette'), 'color palette visualization');
    const decoded = await decodeImage(new Uint8Array(await (await makePatternPngItem('p.png', 16, 1)).file.arrayBuffer()));
    assert.ok(decoded, 'PNG decodes for pixel analysis in Node');
    const pixels = decoded ? analyzePixels(decoded) : null;
    assert.ok(pixels && pixels.dominantColors.length > 0, 'pixel analysis produces a palette');
    assert.ok(pixels && pixels.perceptualHash.length > 0, 'pixel analysis produces a perceptual hash');
  }
  // --- Code complexity ---
  {
    const item = makeComplexCodeItem();
    const result = await analyzeItem(item, { signal });
    assert.equal(result.analyzerId, 'code');
    assert.equal(hasFinding(result, 'code-complex-function'), true, 'high-complexity function finding');
    const complexFinding = result.unusual.find((f) => f.id === 'code-complex-function');
    assert.equal(complexFinding?.methodology, 'anomaly');
    assert.ok(Number(complexFinding?.metrics?.cyclomatic) >= 10, 'cyclomatic metric');
    assert.ok(result.sections.some((section) => section.id === 'code-complexity'), 'complexity section');
    const text = new TextDecoder().decode(await item.file.arrayBuffer());
    const metrics = analyzeFunctionMetrics(text, 'ts');
    assert.ok(metrics.some((metric) => metric.cyclomatic >= 10), 'function metrics detect high complexity');
  }

  // --- Dependency relationships ---
  {
    const folder = makeProjectWithManifests();
    const graph = await collectDependencyGraph(folder, { signal });
    const duplicated = graph.duplicatedDependencies.find((dup) => dup.name === 'lodash');
    assert.ok(duplicated, 'lodash appears in multiple manifests');
    const inconsistency = graph.versionInconsistencies.find((entry) => entry.name === 'lodash');
    assert.ok(inconsistency, 'lodash version inconsistency detected');
    assert.ok(graph.internalImports.some((edge) => edge.from.endsWith('a.ts') && edge.to.endsWith('b.ts')), 'internal import edge');
    const relationships = dependencyRelationships(graph);
    assert.ok(relationships.some((rel) => rel.type === 'shared-dependency'), 'dependency relationships produced');
  }

  // --- Log spike ---
  {
    const result = await analyzeItem(makeLogSpikeItem(), { signal });
    assert.equal(result.analyzerId, 'log');
    assert.equal(hasFinding(result, 'log-spike'), true, 'log spike finding');
    const spike = result.unusual.find((f) => f.id === 'log-spike');
    assert.equal(spike?.methodology, 'anomaly');
    assert.equal(spike?.confidence, 'high');
    assert.ok((result.visualizations ?? []).some((viz) => viz.kind === 'timeline'), 'log timeline visualization');
  }

  // --- XLSX deep analysis ---
  {
    const result = await analyzeItem(await makeXlsxDeepItem(), { signal });
    assert.equal(hasFinding(result, 'xlsx-constant-column'), true, 'xlsx constant column finding');
    assert.equal(hasFinding(result, 'xlsx-mixed-formulas'), true, 'xlsx mixed formula finding');
    assert.ok(result.sections.some((section) => section.id === 'xlsx-deep'), 'xlsx deep section');
  }

  // --- JPEG EXIF extraction ---
  {
    const item = makeExifJpegItem();
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    const exif = extractJpegExif(bytes);
    assert.ok(exif, 'EXIF parsed from JPEG');
    assert.equal(exif?.make, 'Test', 'EXIF make');
    assert.equal(exif?.model, 'Camera', 'EXIF model');
    assert.equal(exif?.dateTime, '2023:01:02 03:04:05', 'EXIF date');
    assert.ok(Math.abs((exif?.gpsLatitude ?? 0) - 52.2297) < 0.001, 'EXIF GPS latitude');
    assert.ok(Math.abs((exif?.gpsLongitude ?? 0) - 21.0122) < 0.001, 'EXIF GPS longitude');
    const result = await analyzeItem(item, { signal });
    assert.equal(hasEvidence(result, 'Camera make', 'Test'), true, 'analyzer surfaces EXIF make');
    assert.equal(hasEvidence(result, 'Date captured', '2023:01:02 03:04:05'), true, 'analyzer surfaces EXIF date');
    assert.equal(hasEvidence(result, 'GPS'), true, 'analyzer surfaces GPS');
  }
  // --- Image scene classification (text-likelihood, no phantom text) ---
  {
    const docResult = await analyzeItem(makeTextLikePngItem(), { signal });
    assert.equal(hasEvidence(docResult, 'Content type', 'Document / scan'), true, 'text-like image classified as document/scan');
    assert.ok(Number(docResult.evidence.find((e) => e.id === 'image-text-likelihood').value.replace('%', '')) >= 50, 'text-like image has high text likelihood');
    assert.equal(hasFinding(docResult, 'image-text-like'), true, 'text-like image produces a text-like finding');
    assert.equal(docResult.evidence.some((e) => e.id === 'image-ocr'), true, 'OCR path is engaged for text-like images');

    const patternResult = await analyzeItem(makePatternPngItem('photo.png', 128, 2), { signal });
    assert.equal(hasFinding(patternResult, 'image-text-like'), false, 'pattern/photo images do not claim text');
    const pixels = analyzePixels({ width: 480, height: 160, data: new Uint8ClampedArray(480 * 160 * 4).fill(255) });
    // All-white image -> blank
    if (pixels) {
      const blank = classifyImageScene(pixels);
      assert.equal(blank.kind, 'blank', 'blank image classified as blank');
      assert.ok(blank.textLikelihood < 0.1, 'blank image has near-zero text likelihood');
    }
  }
  // --- Cross-object relationships ---
  {
    const folder = makeMultiSelectionFolder();
    const result = await analyzeItem(folder, { signal });
    assert.ok((result.relationships ?? []).length > 0, 'relationships produced for multi-object');
    const types = new Set((result.relationships ?? []).map((rel) => rel.type));
    assert.ok(types.has('duplicate'), 'exact duplicate relationship');
    assert.ok(types.has('same-name'), 'same-name relationship');
    assert.ok(types.has('reference'), 'reference relationship');
    assert.ok(result.sections.some((section) => section.id === 'folder-relationships'), 'relationships section');
  }
  {
    const rels = await findCrossObjectRelationships(makeMultiSelectionFolder().children, { signal });
    assert.ok(rels.some((rel) => rel.type === 'duplicate'), 'direct relationship API works');
  }

  // --- Cancellation ---
  {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => analyzeItem(makeProjectWithManifests(), { signal: controller.signal }), /AbortError/);
  }

  // --- OCR wiring in image/PDF analyzers (unavailable path, no fake text) ---
  {
    const screenshot = toItem('screenshot.png', new Uint8Array(await (await makePatternPngItem()).file.arrayBuffer()), 'image/png');
    const result = await analyzeItem(screenshot, { signal });
    assert.equal(result.analyzerId, 'image');
    assert.equal(result.evidence.some((entry) => entry.id === 'image-ocr'), true, 'image analyzer reports OCR status');
    assert.equal(result.evidence.some((entry) => entry.id === 'image-ocr' && entry.value.includes('OCR text')), false, 'no fake OCR text when engine missing');
    const pdf = await analyzeItem(await makePdfItem(), { signal });
    assert.equal(pdf.evidence.some((entry) => entry.id === 'pdf-ocr-available'), true, 'PDF analyzer reports OCR availability');
  }

  // --- Read-only guarantee ---
  {
    const item = makeDeepCsvItem();
    const before = await item.file.arrayBuffer();
    await analyzeItem(item, { signal });
    const after = await item.file.arrayBuffer();
    assert.equal(Buffer.from(before).equals(Buffer.from(after)), true, 'analyzed file is unchanged');
  }

  console.log('Milestone 03 deep-analysis tests passed.');
}





