import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeItem, fingerprintItem } from '../src/shared/analyzers.ts';
import { getCachedResult, loadCache, loadHistory } from '../src/shared/history.ts';
import { runInspection } from '../src/shared/inspection.ts';
import { storageRemove } from '../src/shared/storage.ts';
import { runMilestoneTwoTests } from './milestone02.mjs';
import { runMilestoneThreeTests } from './milestone03.mjs';
import { runMilestoneFourTests } from './milestone04.mjs';
import { runProductionTests } from './production.mjs';
import { runMilestoneSixTests } from './milestone06.mjs';

const root = process.cwd();
const fixturePath = (name) => path.join(root, 'tests', 'fixtures', name);

function fileFromFixture(name, type) {
  const data = fs.readFileSync(fixturePath(name));
  const file = new File([data], name, { type, lastModified: 1_700_000_000_000 });
  return {
    kind: 'file',
    name,
    path: name,
    size: file.size,
    lastModified: file.lastModified,
    mimeType: type,
    file
  };
}

function folderFixture() {
  const text = new File(['hello world'], 'notes.txt', { type: 'text/plain', lastModified: 1_700_000_000_000 });
  const nested = new File(['1,2,3\n4,5,6'], 'data.csv', { type: 'text/csv', lastModified: 1_700_000_000_000 });
  return {
    kind: 'folder',
    name: 'sample',
    path: 'sample',
    children: [
      {
        kind: 'file',
        name: 'notes.txt',
        path: 'sample/notes.txt',
        size: text.size,
        lastModified: text.lastModified,
        mimeType: 'text/plain',
        file: text
      },
      {
        kind: 'folder',
        name: 'nested',
        path: 'sample/nested',
        children: [
          {
            kind: 'file',
            name: 'data.csv',
            path: 'sample/nested/data.csv',
            size: nested.size,
            lastModified: nested.lastModified,
            mimeType: 'text/csv',
            file: nested
          }
        ]
      }
    ]
  };
}

function pngFile() {
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01,
    0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00,
    0x1f, 0x15, 0xc4, 0x89,
    0x00, 0x00, 0x00, 0x0a,
    0x49, 0x44, 0x41, 0x54,
    0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01,
    0xe5, 0x27, 0xd4, 0xa8,
    0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82
  ]);
  const file = new File([bytes], 'pixel.png', { type: 'image/png', lastModified: 1_700_000_000_000 });
  return {
    kind: 'file',
    name: 'pixel.png',
    path: 'pixel.png',
    size: file.size,
    lastModified: file.lastModified,
    mimeType: 'image/png',
    file
  };
}

function clearStorage() {
  storageRemove('inspect-it.history');
  storageRemove('inspect-it.cache');
}

async function main() {
  clearStorage();

  const csv = await analyzeItem(fileFromFixture('sample.csv', 'text/csv'), { signal: new AbortController().signal });
  assert.equal(csv.analyzerId, 'csv');
  assert.equal(csv.sourceSummary.includes('4 rows'), true);
  assert.equal(csv.evidence.some((entry) => entry.label === 'Rows' && entry.value === '4'), true);
  assert.equal(csv.unusual.some((finding) => finding.id === 'csv-duplicates'), true);

  const json = await analyzeItem(fileFromFixture('sample.json', 'application/json'), { signal: new AbortController().signal });
  assert.equal(json.analyzerId, 'json');
  assert.equal(json.evidence.some((entry) => entry.label === 'Root type' && entry.value === 'object'), true);
  assert.equal(json.sections.some((section) => section.id === 'json-structure'), true);

  const image = await analyzeItem(pngFile(), { signal: new AbortController().signal });
  assert.equal(image.analyzerId, 'image');
  assert.equal(image.evidence.some((entry) => entry.label === 'Dimensions' && entry.value.includes('1 x 1')), true);

  const folder = await analyzeItem(folderFixture(), { signal: new AbortController().signal });
  assert.equal(folder.analyzerId, 'folder');
  assert.equal(folder.evidence.some((entry) => entry.label === 'Files' && entry.value === '2'), true);
  assert.equal(folder.evidence.some((entry) => entry.label === 'Folders' && entry.value === '2'), true);

  const abortController = new AbortController();
  abortController.abort();
  await assert.rejects(() => analyzeItem(folderFixture(), { signal: abortController.signal }), /AbortError/);

  const text = fileFromFixture('sample.txt', 'text/plain');
  const first = await runInspection({
    target: text,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    onPartial: () => undefined,
    onState: () => undefined
  });
  const second = await runInspection({
    target: text,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    onPartial: () => undefined,
    onState: () => undefined
  });

  assert.equal(first.cacheKey, second.cacheKey);
  assert.equal(loadHistory().length, 1);
  assert.equal(Boolean(getCachedResult(first.cacheKey) ?? loadCache()[first.cacheKey]), true);

  const fp1 = await fingerprintItem(text);
  const fp2 = await fingerprintItem(text);
  assert.equal(fp1, fp2);

  clearStorage();
  await runMilestoneTwoTests();
  await runMilestoneThreeTests();
  await runMilestoneFourTests();
  await runProductionTests();
  await runMilestoneSixTests();
  console.log('All Inspect It tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});


