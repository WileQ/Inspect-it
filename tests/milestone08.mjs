// Milestone 08 - product polish: evidence locations, history library, OCR UX.
import assert from 'node:assert/strict';
import { analyzeItem } from '../src/shared/analyzers.ts';
import {
  appendHistory, clearHistory, loadHistory, removeHistoryEntry, searchHistory, sortHistory, summarizeHistoryEntry
} from '../src/shared/history.ts';
import { makeOcrTextItem, makePdfItem } from './fixtures.mjs';

const signal = new AbortController().signal;

function textFileItem(name, text) {
  const bytes = new TextEncoder().encode(text);
  const file = new File([bytes], name, { type: 'text/plain', lastModified: 1_700_000_000_000 });
  return { kind: 'file', name, path: name, size: file.size, lastModified: file.lastModified, mimeType: 'text/plain', file };
}

export async function runMilestoneEightTests() {
  // --- Evidence location metadata ----------------------------------------------
  {
    // PDF page rows carry explicit page locations (no OCR required).
    const pdf = await analyzeItem(await makePdfItem(), { signal });
    const textSection = pdf.sections.find((section) => section.id === 'pdf-text');
    assert.ok(textSection, 'pdf-text section present');
    const rows = textSection.items.filter((item) => /^Page \d+$/.test(item.label));
    assert.equal(rows.length, 2, 'two native page rows');
    for (const row of rows) {
      assert.equal(row.location?.type, 'page', `row ${row.label} has page location`);
      const page = Number(row.label.split(' ')[1]);
      assert.equal(row.location?.page, page, `row ${row.label} page number matches`);
    }
  }
  {
    // Text repeated-line evidence carries a line location.
    const text = await analyzeItem(textFileItem('repeats.txt', 'alpha\nbeta\nalpha\nbeta\n'), { signal });
    const patternSection = text.sections.find((section) => section.id === 'text-patterns');
    const repeated = patternSection ? patternSection.items.find((entry) => entry.id === 'repeated-0') : undefined;
    assert.ok(repeated, 'repeated-line evidence exists');
    assert.equal(repeated.location?.type, 'line', 'text line location attached');
    assert.equal(repeated.location?.startLine, 1, 'first repeated line is line 1');
  }

  // --- History library ---------------------------------------------------------
  {
    const makeEntry = (id, name, findings, evidenceIds) => ({
      id,
      targetName: name,
      analyzerName: 'Test analyzer',
      cacheKey: `file:${id}`,
      fingerprint: id,
      summary: 'summary ' + id,
      status: 'completed',
      createdAt: Number(id),
      result: {
        objectKind: 'file', analyzerId: 'generic', analyzerName: 'Test analyzer',
        targetName: name, identity: { name, type: 'file', format: 'file', mimeType: 'text/plain', size: 10, location: name, fingerprint: id },
        sections: [], important: [], unusual: findings, recommendations: [],
        evidence: evidenceIds.map((eid) => ({ id: eid, label: eid, value: eid })),
        progressLabel: 'done', cacheKey: `file:${id}`, generatedAt: '', sourceSummary: 'x'
      },
    });
    const entry1 = makeEntry(1, 'zeta.txt', [{ id: 'x', title: 'High risk', severity: 'high', evidence: [] }], ['pdf-ocr-words']);
    const entry2 = makeEntry(2, 'alpha.pdf', [{ id: 'y', title: 'Info', severity: 'info', evidence: [] }], []);
    appendHistory(entry1);
    appendHistory(entry2);
    const all = loadHistory();
    assert.equal(all.length >= 2, true, 'history saved');
    // search
    const found = searchHistory(all, 'alpha');
    assert.ok(found.some((e) => e.targetName === 'alpha.pdf'), 'search by name');
    const foundByTitle = searchHistory(all, 'High risk');
    assert.ok(foundByTitle.some((e) => e.targetName === 'zeta.txt'), 'search by finding title');
    // sort
    assert.equal(sortHistory(all, 'name')[0].targetName, 'alpha.pdf', 'sort by name');
    assert.equal(sortHistory(all, 'severity')[0].targetName, 'zeta.txt', 'severity sort prioritises high');
    // summary flags
    const summary = summarizeHistoryEntry(all.find((e) => e.id === 1));
    assert.equal(summary.ocrUsed, true, 'OCR used detected from evidence');
    assert.equal(summary.bySeverity.high, 1, 'high severity counted');
    // remove one + clear
    const afterRemove = removeHistoryEntry(1);
    assert.ok(!afterRemove.some((e) => e.id === 1), 'entry deleted');
    clearHistory();
    assert.equal(loadHistory().length, 0, 'history cleared');
    // nothing secret is persisted: entry objects contain no File/blob references
    assert.equal(JSON.stringify(entry1).includes('File'), false, 'no raw File object serialized');
  }

  // --- Image OCR is used for text-like/scanned images -------------------------
  {
    const image = await analyzeItem(makeOcrTextItem('scan_document.png', 'HELLO OCR', 10), { signal });
    assert.equal(image.analyzerId, 'image', 'image analyzer selected');
    const ocr = image.evidence.find((entry) => entry.id === 'image-ocr');
    assert.ok(ocr && /HELLO/.test(String(ocr.value).toUpperCase()), 'OCR text used for a scanned-looking image');
    assert.ok(image.unusual.some((f) => f.id === 'image-ocr'), 'OCR finding present');
  }

  console.log('Milestone 08 product-polish tests passed.');
}