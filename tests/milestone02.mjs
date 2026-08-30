// Milestone 02 analyzer tests. Uses real, in-memory fixtures (no network).
import assert from 'node:assert/strict';
import { analyzeItem } from '../src/shared/analyzers.ts';
import {
  makeZipItem,
  makeTarItem,
  makeGzipTextItem,
  makeGzipTarItem,
  makeGzipZipItem,
  makePdfItem,
  makeHexPdfItem,
  makeInvalidPdfItem,
  makeDocxItem,
  makePptxItem,
  makeXlsxItem,
  makeLegacyXlsItem,
  makeEmlItem,
  makeEpubItem,
  makeSqliteItem,
  makeInvalidSqliteItem,
  makeWavItem,
  makeMp3Item,
  makeFlacItem,
  makeMp4Item,
  makeWebMItem,
  makeTypeScriptItem,
  makePythonItem,
  makePackageJsonItem,
  makeRequirementsItem,
  makeLogItem,
  makeGitFolderItem,
  makeTruncatedZipItem,
  makeCorruptGzipItem,
  makeRandomBinItem,
  makeEmptyTextItem,
  makeRichCsvItem,
  makeDuplicateFolderItem,
  startMockWebServer,
  urlItem
} from './fixtures.mjs';

const signal = new AbortController().signal;

function hasEvidence(result, label, value) {
  return result.evidence.some((entry) => entry.label === label && (value === undefined || entry.value === value));
}

function hasFinding(result, id) {
  return result.unusual.some((finding) => finding.id === id) || result.important.some((finding) => finding.id === id);
}

function sectionHas(result, sectionId, predicate) {
  const section = result.sections.find((candidate) => candidate.id === sectionId);
  return section ? section.items.some(predicate) : false;
}

export async function runMilestoneTwoTests() {
  // --- PDF ---
  {
    const result = await analyzeItem(await makePdfItem(), { signal });
    assert.equal(result.analyzerId, 'pdf');
    assert.equal(hasEvidence(result, 'Pages', '2'), true, 'PDF page count');
    assert.equal(hasEvidence(result, 'Words', '5'), true, 'PDF word count is accurate');
    assert.ok(Number(hasEvidence(result, 'Characters') ? result.evidence.find((e) => e.label === 'Characters').value : 0) > 0, 'PDF character count present');
    assert.ok(Number(hasEvidence(result, 'Text snippets') ? result.evidence.find((e) => e.label === 'Text snippets').value : 0) > 0, 'PDF text extracted from streams');
    assert.equal(hasEvidence(result, 'Title', 'Sample Report'), true, 'PDF metadata title');
    assert.equal(hasEvidence(result, 'Author', 'Inspect This'), true, 'PDF metadata author');
    assert.equal(sectionHas(result, 'pdf-links', (item) => item.value.includes('https://example.com/report')), true, 'PDF links');
    assert.equal(sectionHas(result, 'pdf-text', (item) => item.value.includes('Hello PDF')), true, 'PDF per-page text extracted');
  }
  {
    const result = await analyzeItem(await makeHexPdfItem(), { signal });
    assert.equal(result.analyzerId, 'pdf');
    assert.equal(hasEvidence(result, 'Words', '2'), true, 'PDF hex-string words counted correctly');
    assert.equal(hasEvidence(result, 'Title', 'Hex Report'), true, 'PDF hex fixture metadata title');
    assert.equal(sectionHas(result, 'pdf-text', (item) => item.value.includes('Hello')), true, 'PDF hex-string text decoded');
  }
  {
    const result = await analyzeItem(makeInvalidPdfItem(), { signal });
    assert.equal(hasFinding(result, 'pdf-invalid'), true, 'Invalid PDF handled gracefully');
  }
  // --- DOCX ---
  {
    const result = await analyzeItem(await makeDocxItem(), { signal });
    assert.equal(result.analyzerId, 'docx');
    assert.equal(hasEvidence(result, 'Tables', '1'), true, 'DOCX tables');
    assert.equal(hasEvidence(result, 'Comments', '1'), true, 'DOCX comments');
    assert.equal(hasEvidence(result, 'Images', '1'), true, 'DOCX images');
    assert.equal(hasEvidence(result, 'Hidden content', 'Present'), true, 'DOCX hidden content');
    assert.equal(sectionHas(result, 'docx-links', (item) => item.value.includes('https://example.com/docs')), true, 'DOCX hyperlinks');
    assert.ok(result.evidence.find((e) => e.label === 'Headings') !== undefined, 'DOCX headings present');
  }

  // --- PPTX ---
  {
    const result = await analyzeItem(await makePptxItem(), { signal });
    assert.equal(result.analyzerId, 'pptx');
    assert.equal(hasEvidence(result, 'Slides', '3'), true, 'PPTX slide count');
    assert.equal(hasEvidence(result, 'Empty slides', '1'), true, 'PPTX empty slides');
    assert.equal(hasEvidence(result, 'Notes', '1'), true, 'PPTX notes');
    assert.equal(hasEvidence(result, 'Images', '1'), true, 'PPTX images');
    assert.ok(Number(result.evidence.find((e) => e.label === 'Titles').value) >= 2, 'PPTX slide titles');
  }

  // --- XLSX ---
  {
    const result = await analyzeItem(await makeXlsxItem(), { signal });
    assert.equal(result.analyzerId, 'xlsx');
    assert.equal(hasEvidence(result, 'Worksheets', '2'), true, 'XLSX worksheets');
    assert.equal(hasEvidence(result, 'Hidden sheets', '1'), true, 'XLSX hidden sheets');
    assert.ok(Number(hasEvidence(result, 'Formulas') ? result.evidence.find((e) => e.label === 'Formulas').value : 0) >= 1, 'XLSX formulas');
    assert.ok(Number(hasEvidence(result, 'Merged cells') ? result.evidence.find((e) => e.label === 'Merged cells').value : 0) >= 1, 'XLSX merged cells');
    assert.ok(Number(hasEvidence(result, 'External links') ? result.evidence.find((e) => e.label === 'External links').value : 0) >= 1, 'XLSX external links');
    assert.ok(Number(hasEvidence(result, 'Errors') ? result.evidence.find((e) => e.label === 'Errors').value : 0) >= 1, 'XLSX cell errors');
    assert.equal(hasEvidence(result, 'Hidden rows', '1'), true, 'XLSX hidden rows');
    assert.equal(hasEvidence(result, 'Hidden columns', '1'), true, 'XLSX hidden columns');
    assert.equal(hasEvidence(result, 'Named ranges', '1'), true, 'XLSX named ranges');
    assert.equal(sectionHas(result, 'xlsx-stats', (item) => item.label === 'Min' && item.value === '1'), true, 'XLSX numeric min');
    assert.equal(sectionHas(result, 'xlsx-stats', (item) => item.label === 'Max' && item.value === '30'), true, 'XLSX numeric max');
    assert.equal(hasEvidence(result, 'Duplicate rows'), true, 'XLSX duplicate rows evidence');
    assert.equal(hasFinding(result, 'xlsx-duplicate-rows'), true, 'XLSX duplicate rows finding');
  }
  {
    const result = await analyzeItem(makeLegacyXlsItem(), { signal });
    assert.equal(result.analyzerId, 'xls', 'Legacy XLS detected without crashing');
  }

  // --- EML ---
  {
    const result = await analyzeItem(makeEmlItem(), { signal });
    assert.equal(result.analyzerId, 'email');
    assert.equal(hasEvidence(result, 'Subject', 'Hello world'), true, 'EML subject decoded from encoded words');
    assert.equal(hasEvidence(result, 'From', 'Alice <alice@example.com>'), true, 'EML sender');
    assert.equal(hasEvidence(result, 'Attachments', '1'), true, 'EML attachment count');
    assert.equal(hasEvidence(result, 'Links', '1'), true, 'EML link count');
    assert.equal(hasEvidence(result, 'DKIM signature', 'Present'), true, 'EML DKIM presence');
    assert.equal(hasEvidence(result, 'SPF record', 'Present'), true, 'EML SPF presence');
    assert.equal(sectionHas(result, 'email-links', (item) => item.value.includes('https://example.com/report')), true, 'EML links section');
  }

  // --- EPUB ---
  {
    const result = await analyzeItem(await makeEpubItem(), { signal });
    assert.equal(result.analyzerId, 'epub');
    assert.equal(hasEvidence(result, 'Title', 'Sample Ebook'), true, 'EPUB title');
    assert.equal(hasEvidence(result, 'Author', 'Jane Author'), true, 'EPUB author');
    assert.equal(hasEvidence(result, 'Chapters', '2'), true, 'EPUB chapter count');
    assert.ok(Number(hasEvidence(result, 'Words') ? result.evidence.find((e) => e.label === 'Words').value : 0) > 0, 'EPUB word count extracted from spine');
    assert.equal(hasEvidence(result, 'Images', '1'), true, 'EPUB image count');
    assert.equal(sectionHas(result, 'epub-chapters', (item) => item.value.includes('Chapter One')), true, 'EPUB chapter titles');
  }
  // --- ZIP ---
  {
    const result = await analyzeItem(await makeZipItem(), { signal });
    assert.equal(result.analyzerId, 'archive');
    assert.equal(hasEvidence(result, 'Files', '4'), true, 'ZIP file count');
    assert.ok(Number(hasEvidence(result, 'Nested archives') ? result.evidence.find((e) => e.label === 'Nested archives').value : 0) >= 1, 'ZIP nested archives');
    assert.equal(hasEvidence(result, 'Compressed size'), true, 'ZIP compressed size');
    assert.equal(sectionHas(result, 'zip-structure', (item) => item.value.includes('hello.txt')), true, 'ZIP entry listing');
  }

  // --- TAR ---
  {
    const result = await analyzeItem(makeTarItem(), { signal });
    assert.equal(result.analyzerId, 'archive');
    assert.ok(Number(hasEvidence(result, 'Files') ? result.evidence.find((e) => e.label === 'Files').value : 0) >= 4, 'TAR file count');
    assert.ok(Number(hasEvidence(result, 'Suspicious paths') ? result.evidence.find((e) => e.label === 'Suspicious paths').value : 0) >= 1, 'TAR suspicious paths');
    assert.equal(sectionHas(result, 'tar-structure', (item) => item.value.includes('very/long/path/with/many/segments')), true, 'TAR GNU long name support');
  }

  // --- GZIP ---
  {
    const result = await analyzeItem(makeGzipTextItem(), { signal });
    assert.equal(result.analyzerId, 'archive');
    assert.equal(hasEvidence(result, 'Likely inner format', 'txt'), true, 'GZIP inner format');
    assert.equal(hasEvidence(result, 'Uncompressed size'), true, 'GZIP uncompressed size');
  }
  {
    const result = await analyzeItem(await makeGzipTarItem(), { signal });
    assert.equal(hasEvidence(result, 'Likely inner format', 'tar'), true, 'TAR.GZ inner format');
  }
  {
    const result = await analyzeItem(await makeGzipZipItem(), { signal });
    assert.equal(hasEvidence(result, 'Likely inner format', 'zip'), true, 'ZIP.GZ inner format');
    assert.equal(hasFinding(result, 'gz-nested'), true, 'GZIP nested archive detected');
  }

  // --- SQLite ---
  {
    const result = await analyzeItem(await makeSqliteItem(), { signal });
    assert.equal(result.analyzerId, 'sqlite');
    assert.equal(hasEvidence(result, 'Tables', '2'), true, 'SQLite tables');
    assert.equal(hasEvidence(result, 'Indexes', '1'), true, 'SQLite indexes');
    assert.ok(Number(hasEvidence(result, 'Foreign keys') ? result.evidence.find((e) => e.label === 'Foreign keys').value : 0) >= 1, 'SQLite foreign keys');
    assert.equal(sectionHas(result, 'sqlite-table-users', (item) => item.label === 'Rows' && item.value === '3'), true, 'SQLite users row count');
    assert.equal(sectionHas(result, 'sqlite-table-users', (item) => item.label === 'email' && item.value.includes('1 nulls')), true, 'SQLite null distribution');
    assert.equal(hasFinding(result, 'sqlite-dup-users'), true, 'SQLite duplicate rows');
    assert.equal(hasEvidence(result, 'Duplicate columns checked'), true, 'SQLite duplicate columns named');
  }
  {
    const result = await analyzeItem(makeInvalidSqliteItem(), { signal });
    assert.equal(hasFinding(result, 'sqlite-invalid'), true, 'Invalid SQLite handled gracefully');
  }

  // --- Source code ---
  {
    const result = await analyzeItem(makeTypeScriptItem(), { signal });
    assert.equal(result.analyzerId, 'code');
    assert.equal(hasEvidence(result, 'Language', 'TypeScript'), true, 'TS language detection');
    assert.ok(Number(hasEvidence(result, 'Functions') ? result.evidence.find((e) => e.label === 'Functions').value : 0) >= 2, 'TS function count');
    assert.ok(Number(hasEvidence(result, 'Classes') ? result.evidence.find((e) => e.label === 'Classes').value : 0) >= 1, 'TS class count');
    assert.ok(Number(hasEvidence(result, 'TODO/FIXME markers') ? result.evidence.find((e) => e.label === 'TODO/FIXME markers').value : 0) >= 1, 'TS TODO markers');
  }
  {
    const result = await analyzeItem(makePythonItem(), { signal });
    assert.equal(hasEvidence(result, 'Language', 'Python'), true, 'Python language detection');
    assert.ok(Number(hasEvidence(result, 'Functions') ? result.evidence.find((e) => e.label === 'Functions').value : 0) >= 2, 'Python function count');
    assert.ok(Number(hasEvidence(result, 'Classes') ? result.evidence.find((e) => e.label === 'Classes').value : 0) >= 1, 'Python class count');
  }

  // --- Dependency manifests ---
  {
    const result = await analyzeItem(makePackageJsonItem(), { signal });
    assert.equal(result.analyzerId, 'manifest');
    assert.equal(hasEvidence(result, 'Direct dependencies', '2'), true, 'package.json direct deps');
    assert.equal(hasEvidence(result, 'Development dependencies', '1'), true, 'package.json dev deps');
  }
  {
    const result = await analyzeItem(makeRequirementsItem(), { signal });
    assert.equal(result.analyzerId, 'manifest');
    assert.equal(hasEvidence(result, 'Direct dependencies', '3'), true, 'requirements.txt deps');
  }

  // --- CSV with duplicate columns, duplicate rows and repeated values ---
  {
    const result = await analyzeItem(makeRichCsvItem(), { signal });
    assert.equal(result.analyzerId, 'csv');
    assert.equal(hasFinding(result, 'csv-duplicates'), true, 'CSV duplicate rows finding');
    assert.equal(hasFinding(result, 'csv-dup-columns'), true, 'CSV duplicate columns finding');
    assert.equal(hasEvidence(result, 'Duplicate columns'), true, 'CSV duplicate columns evidence');
    assert.equal(hasEvidence(result, 'Duplicate example'), true, 'CSV duplicate example evidence');
    assert.equal(hasEvidence(result, 'Duplicate rows at'), true, 'CSV duplicate row numbers clue');
    assert.equal(result.evidence.some((entry) => entry.label.endsWith(' repeated value')), true, 'CSV repeated value evidence');
  }

  // --- Logs ---
  {
    const result = await analyzeItem(makeLogItem(), { signal });
    assert.equal(result.analyzerId, 'log');
    assert.equal(hasEvidence(result, 'Total lines', '14'), true, 'log line count');
    assert.ok(Number(hasEvidence(result, 'Request IDs') ? result.evidence.find((e) => e.label === 'Request IDs').value : 0) >= 3, 'log request IDs');
    assert.ok(Number(hasEvidence(result, 'Stack traces') ? result.evidence.find((e) => e.label === 'Stack traces').value : 0) >= 1, 'log stack traces');
    assert.equal(hasFinding(result, 'log-error-rate'), true, 'log error rate finding');
  }

  // --- Media ---
  {
    const result = await analyzeItem(makeWavItem(), { signal });
    assert.equal(result.analyzerId, 'media');
    assert.equal(hasEvidence(result, 'Format', 'WAV'), true, 'WAV format');
    assert.equal(hasEvidence(result, 'Sample rate', '44,100 Hz'), true, 'WAV sample rate');
    assert.equal(hasEvidence(result, 'Channels', '2'), true, 'WAV channels');
  }
  {
    const result = await analyzeItem(makeMp3Item(), { signal });
    assert.equal(hasEvidence(result, 'Format', 'MP3'), true, 'MP3 format');
    assert.equal(hasEvidence(result, 'Bitrate', '128 kbps'), true, 'MP3 bitrate');
    assert.equal(hasEvidence(result, 'TIT2', 'Test Title'), true, 'MP3 title tag');
    assert.equal(hasEvidence(result, 'TPE1', 'Test Artist'), true, 'MP3 artist tag');
  }
  {
    const result = await analyzeItem(makeFlacItem(), { signal });
    assert.equal(hasEvidence(result, 'Format', 'FLAC'), true, 'FLAC format');
    assert.equal(hasEvidence(result, 'Sample rate', '44,100 Hz'), true, 'FLAC sample rate');
    assert.equal(hasEvidence(result, 'Channels', '2'), true, 'FLAC channels');
    assert.equal(hasEvidence(result, 'Duration', '1.00 s'), true, 'FLAC duration');
  }
  {
    const result = await analyzeItem(makeMp4Item(), { signal });
    assert.equal(hasEvidence(result, 'Format', 'MP4'), true, 'MP4 format');
    assert.equal(hasEvidence(result, 'Duration', '5.00 s'), true, 'MP4 duration');
    assert.equal(hasEvidence(result, 'Resolution', '1920 x 1080'), true, 'MP4 resolution');
    assert.equal(hasEvidence(result, 'MP4 brand', 'isom'), true, 'MP4 brand');
  }
  {
    const result = await analyzeItem(makeWebMItem(), { signal });
    assert.equal(hasEvidence(result, 'Format', 'WebM'), true, 'WebM container detection');
  }

  // --- Website (local mock server) ---
  {
    const server = await startMockWebServer();
    try {
      const result = await analyzeItem(urlItem(`${server.base}/`), { signal });
      assert.equal(result.analyzerId, 'web');
      assert.equal(hasEvidence(result, 'Title', 'Test Site'), true, 'web title');
      assert.equal(hasEvidence(result, 'HTTP status', '200 OK'), true, 'web status');
      assert.ok(Number(hasEvidence(result, 'Headings') ? result.evidence.find((e) => e.label === 'Headings').value : 0) >= 2, 'web headings');
      assert.equal(hasEvidence(result, 'Canonical URL', 'https://example.com/'), true, 'web canonical');
      assert.equal(sectionHas(result, 'web-security', (item) => item.label === 'Content-Security-Policy' && item.value !== 'Not present'), true, 'web CSP');
      assert.equal(hasEvidence(result, 'robots.txt', 'Fetched (2 lines)'), true, 'web robots.txt');
      assert.equal(hasEvidence(result, 'sitemap.xml', 'Fetched'), true, 'web sitemap');
      assert.ok(Number(hasEvidence(result, 'Links') ? result.evidence.find((e) => e.label === 'Links').value : 0) >= 2, 'web links');

      const jsonResult = await analyzeItem(urlItem(`${server.base}/data.json`), { signal });
      assert.equal(hasFinding(jsonResult, 'web-non-html'), true, 'web non-HTML handling');
    } finally {
      await server.close();
    }
    const unreachable = await analyzeItem(urlItem(`http://127.0.0.1:${server.port}/`), { signal });
    assert.equal(hasFinding(unreachable, 'web-unreachable'), true, 'web unreachable handled gracefully');
  }

  // --- Git repository signals (synthetic .git) ---
  {
    const result = await analyzeItem(makeGitFolderItem(), { signal });
    assert.equal(result.analyzerId, 'folder');
    const gitSection = result.sections.find((section) => section.id === 'folder-git');
    assert.ok(gitSection, 'git section present');
    assert.equal(gitSection.items.find((item) => item.label === 'Branches').value, '2', 'git branches');
    assert.ok(Number(gitSection.items.find((item) => item.label === 'Commit log entries').value) >= 6, 'git commit entries');
    assert.ok(Number(gitSection.items.find((item) => item.label === 'Contributors').value) >= 2, 'git contributors');
  }

  // --- Malformed inputs never crash ---
  {
    const zipResult = await analyzeItem(makeTruncatedZipItem(), { signal });
    assert.equal(hasFinding(zipResult, 'archive-invalid'), true, 'corrupt zip handled');

    const gzResult = await analyzeItem(makeCorruptGzipItem(), { signal });
    assert.equal(hasFinding(gzResult, 'archive-invalid'), true, 'corrupt gzip handled');

    const binResult = await analyzeItem(makeRandomBinItem(), { signal });
    assert.equal(binResult.analyzerId, 'generic', 'random binary falls back to generic');

    const emptyResult = await analyzeItem(makeEmptyTextItem(), { signal });
    assert.equal(emptyResult.analyzerId, 'text', 'empty text handled');
  }


  // --- Folder duplicate files: clues include the duplicate paths ---
  {
    const result = await analyzeItem(makeDuplicateFolderItem(), { signal });
    assert.equal(result.analyzerId, 'folder');
    assert.equal(hasFinding(result, 'folder-duplicates'), true, 'folder duplicate files finding');
    assert.equal(hasEvidence(result, 'Duplicate files', '1'), true, 'folder duplicate files evidence');
    assert.equal(sectionHas(result, 'folder-facts', (item) => item.label === 'Duplicate group 1' && item.value.includes('dups/a/dup.txt') && item.value.includes('dups/b/dup.txt')), true, 'folder duplicate paths clue');
  }

  // --- Routing: the right analyzer must handle the right object ------------
  {
    const matrix = [
      [await makePdfItem(), 'pdf'],
      [await makeDocxItem(), 'docx'],
      [await makePptxItem(), 'pptx'],
      [await makeXlsxItem(), 'xlsx'],
      [makeLegacyXlsItem(), 'xls'],
      [await makeZipItem(), 'archive'],
      [makeTarItem(), 'archive'],
      [makeGzipTextItem(), 'archive'],
      [await makeGzipTarItem(), 'archive'],
      [await makeGzipZipItem(), 'archive'],
      [await makeSqliteItem(), 'sqlite'],
      [makeTypeScriptItem(), 'code'],
      [makePythonItem(), 'code'],
      [makePackageJsonItem(), 'manifest'],
      [makeRequirementsItem(), 'manifest'],
      [makeLogItem(), 'log'],
      [makeWavItem(), 'media'],
      [makeMp3Item(), 'media'],
      [makeFlacItem(), 'media'],
      [makeMp4Item(), 'media'],
      [makeWebMItem(), 'media'],
      [makeRandomBinItem(), 'generic']
    ];
    for (const [item, expected] of matrix) {
      const routed = await analyzeItem(item, { signal });
      assert.equal(routed.analyzerId, expected, `${item.name} should route to ${expected}`);
    }
  }

  // --- Evidence integrity: every finding must reference a resolvable clue ---
  {
    const integrityItems = [
      await makePdfItem(), await makeDocxItem(), await makePptxItem(), await makeXlsxItem(),
      await makeZipItem(), makeTarItem(), makeGzipTextItem(), await makeGzipTarItem(), await makeGzipZipItem(),
      await makeSqliteItem(), makeTypeScriptItem(), makePythonItem(), makePackageJsonItem(), makeRequirementsItem(),
      makeLogItem(), makeWavItem(), makeMp3Item(), makeFlacItem(), makeMp4Item(), makeWebMItem(),
      makeRichCsvItem(), makeRandomBinItem(), makeEmptyTextItem(), makeGitFolderItem(), makeDuplicateFolderItem()
    ];
    for (const item of integrityItems) {
      const routed = await analyzeItem(item, { signal });
      const known = new Set(routed.evidence.map((entry) => entry.id));
      for (const section of routed.sections) {
        for (const entry of section.items) known.add(entry.id);
      }
      for (const finding of [...routed.important, ...routed.unusual, ...routed.recommendations]) {
        for (const id of finding.evidence) {
          assert.equal(known.has(id), true, `${routed.analyzerId}/${item.name}: finding "${finding.id}" references unresolved evidence "${id}"`);
        }
      }
    }
  }

  console.log('Milestone 02 analyzer tests passed.');
}



