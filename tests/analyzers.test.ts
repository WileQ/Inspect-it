import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeItem, fingerprintItem } from '../src/shared/analyzers';
import { getCachedResult, loadHistory, loadCache } from '../src/shared/history';
import { runInspection } from '../src/shared/inspection';
import { InspectionFile, InspectionFolder } from '../src/shared/types';
import { storageRemove } from '../src/shared/storage';

const fixtures = (name: string) => path.join(process.cwd(), 'tests', 'fixtures', name);

function fileFromFixture(name: string, type: string): InspectionFile {
  const filePath = fixtures(name);
  const data = fs.readFileSync(filePath);
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

function folderFixture(): InspectionFolder {
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

function pngFile(): InspectionFile {
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

afterEach(() => {
  storageRemove('inspect-this.history');
  storageRemove('inspect-this.cache');
});

describe('analysis engine', () => {
  it('produces real CSV statistics and evidence', async () => {
    const item = fileFromFixture('sample.csv', 'text/csv');
    const result = await analyzeItem(item, { signal: new AbortController().signal });

    expect(result.analyzerId).toBe('csv');
    expect(result.sourceSummary).toContain('4 rows');
    expect(result.evidence.some((entry) => entry.label === 'Rows' && entry.value === '4')).toBe(true);
    expect(result.unusual.some((finding) => finding.id === 'csv-duplicates')).toBe(true);
  });

  it('produces structural JSON analysis', async () => {
    const item = fileFromFixture('sample.json', 'application/json');
    const result = await analyzeItem(item, { signal: new AbortController().signal });

    expect(result.analyzerId).toBe('json');
    expect(result.evidence.some((entry) => entry.label === 'Root type' && entry.value === 'object')).toBe(true);
    expect(result.evidence.some((entry) => entry.label === 'Objects')).toBe(true);
    expect(result.sections.some((section) => section.id === 'json-structure')).toBe(true);
  });

  it('reads real image metadata from the file header', async () => {
    const item = pngFile();
    const result = await analyzeItem(item, { signal: new AbortController().signal });

    expect(result.analyzerId).toBe('image');
    expect(result.evidence.some((entry) => entry.label === 'Dimensions' && entry.value.includes('1 x 1'))).toBe(true);
  });

  it('summarizes folder structure and bytes', async () => {
    const folder = folderFixture();
    const result = await analyzeItem(folder, { signal: new AbortController().signal });

    expect(result.analyzerId).toBe('folder');
    expect(result.evidence.some((entry) => entry.label === 'Files' && entry.value === '2')).toBe(true);
    expect(result.evidence.some((entry) => entry.label === 'Folders' && entry.value === '2')).toBe(true);
    expect(result.sourceSummary).toContain('2 files');
  });

  it('supports cancellation', async () => {
    const folder = folderFixture();
    const controller = new AbortController();
    controller.abort();

    await expect(analyzeItem(folder, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stores history and cache for repeated inspections', async () => {
    const item = fileFromFixture('sample.txt', 'text/plain');
    const controller = new AbortController();
    const first = await runInspection({
      target: item,
      signal: controller.signal,
      onProgress: () => undefined,
      onPartial: () => undefined,
      onState: () => undefined
    });
    const second = await runInspection({
      target: item,
      signal: controller.signal,
      onProgress: () => undefined,
      onPartial: () => undefined,
      onState: () => undefined
    });

    expect(first.cacheKey).toBe(second.cacheKey);
    expect(loadHistory().length).toBe(1);
    expect(getCachedResult(first.cacheKey) ?? loadCache()[first.cacheKey]).toBeDefined();
  });

  it('computes stable fingerprints for the same file contents', async () => {
    const item = fileFromFixture('sample.txt', 'text/plain');
    const first = await fingerprintItem(item);
    const second = await fingerprintItem(item);
    expect(first).toBe(second);
  });
});
