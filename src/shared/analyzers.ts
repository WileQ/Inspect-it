import type {
  AnalysisResult,
  AnalysisSection,
  Evidence,
  Finding,
  InspectionFile,
  InspectionFolder,
  InspectionItem,
  IdentitySummary,
  ProgressSnapshot,
  Visualization
} from './types.ts';
import { analyzeArchiveFile } from './archive.ts';
import { analyzeCodeFile, collectProjectSignals } from './code.ts';
import { analyzeGitMetadataFile } from './git-file.ts';
import { collectDependencyGraph, dependencyRelationships } from './dependencies.ts';
import { analyzeDocumentFile } from './documents.ts';
import { analyzeMediaFile } from './media.ts';
import { analyzeSqliteFile } from './sqlite.ts';
import { analyzeUrlItem } from './web.ts';
import {
  anomalyToFinding,
  coefficientOfVariation,
  constantRatio,
  duplicateRatio,
  histogram as buildHistogram,
  missingRatio,
  skewness,
  uniqueRatio
} from './anomaly.ts';
import { decodeImage, findExactDuplicates, findTextNearDuplicates, imageHashOf, imageSimilarity, summarizeDuplicates } from './duplicates.ts';
import { analyzePixels, classifyImageScene, extractJpegExif } from './image-analysis.ts';
import { findCrossObjectRelationships } from './relationships.ts';
import { contentIdentityChecks, filenameChecks } from './object-identity.ts';
import { isOcrAvailable, ocrImage, ocrWorthwhile } from './ocr.ts';
import {
  digestHex,
  formatBytes,
  formatDate,
  formatNumber,
  isLikelyDate,
  mean,
  median,
  percent,
  quantile,
  shortFingerprint,
  standardDeviation,
  toNumber
} from './utils.ts';

export interface AnalyzeOptions {
  signal: AbortSignal;
  onProgress?: (progress: ProgressSnapshot) => void;
  onPartial?: (result: Partial<AnalysisResult>) => void;
  /** Test seam: force the OCR availability state reported to analyzers. */
  ocrAvailableOverride?: boolean;
}

export interface Analyzer {
  id: string;
  name: string;
  canHandle(item: InspectionItem): boolean;
  analyze(item: InspectionItem, options: AnalyzeOptions): Promise<AnalysisResult>;
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Analysis cancelled', 'AbortError');
  }
}

function createEvidence(id: string, label: string, value: string): Evidence {
  return { id, label, value };
}

function createFinding(id: string, title: string, summary: string, severity: Finding['severity'], evidence: string[]): Finding {
  return { id, title, summary, severity, evidence };
}

function baseSections(id: string, title: string, entries: Evidence[]): AnalysisSection[] {
  return [{ id, title, items: entries }];
}

async function fileBytes(file: File, limit?: number): Promise<Uint8Array> {
  const slice = limit ? file.slice(0, limit) : file;
  return new Uint8Array(await slice.arrayBuffer());
}

function inferKind(name: string, mimeType: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  if (['json', 'jsonl'].includes(ext) || mimeType.includes('json')) {
    return 'structured document';
  }
  if (['csv', 'tsv'].includes(ext) || mimeType.includes('csv') || mimeType.includes('tab-separated')) {
    return 'table';
  }
  if (['md', 'markdown'].includes(ext)) {
    return 'markdown';
  }
  if (['txt', 'log', 'ini', 'toml', 'yml', 'yaml'].includes(ext) || mimeType.startsWith('text/')) {
    return 'text';
  }
  return 'file';
}

async function fingerprintFile(source: File | InspectionFile): Promise<string> {
  const file = source instanceof File ? source : source.file;
  const sampleSize = Math.min(file.size, 1024 * 1024);
  const head = await fileBytes(file, sampleSize);
  const tail = file.size > sampleSize ? new Uint8Array(await file.slice(Math.max(0, file.size - sampleSize), file.size).arrayBuffer()) : new Uint8Array();
  const payload = new Uint8Array(head.length + tail.length + 32);
  payload.set(head, 0);
  payload.set(tail, head.length);
  const descriptor = new TextEncoder().encode(`${file.name}|${file.size}|${file.lastModified}|${file.type}`);
  payload.set(descriptor.slice(0, 32), head.length + tail.length);
  return digestHex(payload);
}

async function fingerprintFolder(folder: InspectionFolder): Promise<string> {
  const childHashes = await Promise.all(
    folder.children.map(async (child) => {
      if (child.kind === 'file') {
        return fingerprintFile(child.file);
      }
      if (child.kind === 'folder') {
        return fingerprintFolder(child);
      }
      return digestHex(new TextEncoder().encode(child.url));
    })
  );
  return digestHex(new TextEncoder().encode([folder.name, folder.path, ...childHashes].join('|')));
}

function describeLocation(item: InspectionItem): string {
  return item.path || item.name;
}

function sortDescending(entries: Array<[string, number]>): Array<[string, number]> {
  return [...entries].sort((left, right) => right[1] - left[1]);
}

function isTextLikeName(name: string): boolean {
  return /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ini|toml|yml|yaml|xml|ts|tsx|js|jsx|c|cc|cpp|cs|py|rs|go|java|php|rb|sh|bat|ps1|html|css|scss|less|sql)$/i.test(name);
}

function makeIdentity(file: InspectionFile, fingerprint: string, format: string): IdentitySummary {
  return {
    name: file.name,
    type: inferKind(file.name, file.mimeType),
    format,
    mimeType: file.mimeType,
    size: file.size,
    location: describeLocation(file),
    created: formatDate(file.lastModified),
    modified: formatDate(file.lastModified),
    fingerprint: shortFingerprint(fingerprint)
  };
}

function makeFolderIdentity(folder: InspectionFolder, fingerprint: string, size: number, type: string = 'folder'): IdentitySummary {
  return {
    name: folder.name,
    type,
    format: 'directory',
    mimeType: 'inode/directory',
    size,
    location: describeLocation(folder),
    fingerprint: shortFingerprint(fingerprint)
  };
}

interface DecodedText { text: string; encoding: string; validUtf8: boolean; }

function decodeTextBytes(bytes: Uint8Array): DecodedText {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8 (BOM)', validUtf8: true };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16 LE (BOM)', validUtf8: false };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'UTF-16 BE (BOM)', validUtf8: false };
  }
  let validUtf8 = true;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { validUtf8 = false; }
  if (validUtf8) {
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'UTF-8', validUtf8: true };
  }
  // Fall back to Latin-1 instead of silently emitting replacement characters.
  return { text: new TextDecoder('latin1').decode(bytes), encoding: 'Latin-1 (non-UTF-8)', validUtf8: false };
}

function binaryControlRatio(bytes: Uint8Array): number {
  if (!bytes.length) return 0;
  const sample = bytes.slice(0, 8192);
  let control = 0;
  for (const value of sample) {
    if (value === 0 || value < 7 || (value > 13 && value < 32)) control += 1;
  }
  return control / sample.length;
}

async function analyzeTextFile(file: InspectionFile, bytes: Uint8Array, options: AnalyzeOptions): Promise<AnalysisResult> {
  ensureNotAborted(options.signal);
  options.onProgress?.({ completed: 1, total: 4, step: 'Reading text' });
  const decoded = decodeTextBytes(bytes);
  const text = decoded.text;
  const controlRatio = binaryControlRatio(bytes);
  options.onProgress?.({ completed: 2, total: 4, step: 'Measuring lines and words' });
  const lines = text.split(/\r\n|\n|\r/);
  const words = text.match(/\b[\p{L}\p{N}_-]+\b/gu) ?? [];
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  const blankLines = lines.length - nonEmptyLines.length;
  const longestLine = lines.reduce((longest, line) => (line.length > longest.length ? line : longest), '');
  const repeatedLineEntries = new Map<string, number>();
  for (const line of nonEmptyLines) {
    repeatedLineEntries.set(line, (repeatedLineEntries.get(line) ?? 0) + 1);
  }
  const repeated = sortDescending([...repeatedLineEntries.entries()].filter(([, count]) => count > 1)).slice(0, 5);
  const fingerprint = await fingerprintFile(file);
  const identity = makeIdentity(file, fingerprint, decoded.encoding.startsWith('UTF-16') ? 'unicode text' : 'plain text');
  const evidence = [
    createEvidence('text-lines', 'Lines', formatNumber(lines.length)),
    createEvidence('text-words', 'Words', formatNumber(words.length)),
    createEvidence('text-blank', 'Blank lines', formatNumber(blankLines)),
    createEvidence('text-longest', 'Longest line', `${longestLine.length} characters`),
    createEvidence('text-encoding', 'Encoding', decoded.encoding)
  ];
  const repeatedEvidence = repeated.map(([line, count], index) => {
    const first = lines.findIndex((candidate) => candidate.trim() === line);
    const base = createEvidence(`repeated-${index}`, `Repeated line ${index + 1}`, `"${line.slice(0, 80)}" appears ${count} times`);
    return first >= 0 ? { ...base, location: { type: 'line' as const, label: `line ${first + 1}`, startLine: first + 1 } } : base;
  });
  options.onProgress?.({ completed: 3, total: 4, step: 'Summarizing text structure' });
  const sections = [
    ...baseSections('text-summary', 'Facts', evidence),
    {
      id: 'text-patterns',
      title: 'Structure',
      items: repeatedEvidence.length ? repeatedEvidence : [createEvidence('text-patterns-none', 'Repeated patterns', 'No repeated lines detected')]
    }
  ];
  const unusual: Finding[] = [];
  if (repeated[0] && repeated[0][1] > 3) {
    unusual.push(createFinding('text-repeat', 'Repeated line cluster', 'The file repeats the same line multiple times.', 'medium', ['repeated-0']));
  }
  if (decoded.encoding.startsWith('UTF-16')) {
    unusual.push({ id: 'text-utf16', title: 'UTF-16 encoded text', summary: `Text was decoded as ${decoded.encoding}; UTF-16 files are common for Windows exports but unusual for plain source/text.`, severity: 'info', evidence: ['text-encoding'], methodology: 'fact', confidence: 'measured', category: 'structure' });
  } else if (decoded.encoding === 'Latin-1 (non-UTF-8)') {
    unusual.push({ id: 'text-latin1', title: 'Non-UTF-8 (Latin-1) text', summary: 'The file is not valid UTF-8 and was decoded using the Latin-1 fallback to avoid replacement-character corruption.', severity: 'low', evidence: ['text-encoding'], methodology: 'heuristic', confidence: 'high', category: 'structure' });
  }
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lfOnly = (text.match(/(?<!\r)\n/g) ?? []).length;
  const crOnly = (text.match(/\r(?!\n)/g) ?? []).length;
  const mixedEndings = (crlf > 0 && (lfOnly > 0 || crOnly > 0)) || (lfOnly > 0 && crOnly > 0);
  if (mixedEndings) {
    evidence.push(createEvidence('text-line-endings', 'Line endings', `CRLF ${crlf}, LF ${lfOnly}, CR ${crOnly}`));
    unusual.push({ id: 'text-mixed-line-endings', title: 'Mixed line endings', summary: `The file mixes line-ending styles (CRLF ${crlf}, LF ${lfOnly}, CR ${crOnly}), which can indicate merged or generated text.`, severity: 'low', evidence: ['text-line-endings'], methodology: 'anomaly', confidence: 'high', category: 'structure', metrics: { crlf, lf: lfOnly, cr: crOnly } });
  }
  if (longestLine.length > 50000) {
    evidence.push(createEvidence('text-huge-line', 'Longest line', `${longestLine.length} characters`));
    unusual.push({ id: 'text-huge-line', title: 'Pathologically long line', summary: `One line is ${longestLine.length} characters, which can break line-oriented tooling.`, severity: 'low', evidence: ['text-huge-line'], methodology: 'anomaly', confidence: 'high', category: 'structure', metrics: { lineLength: longestLine.length } });
  }
  if (controlRatio > 0.05 && !decoded.encoding.startsWith('UTF-16') && decoded.encoding !== 'Latin-1 (non-UTF-8)') {
    evidence.push(createEvidence('text-binary-signal', 'Binary content signal', `${Math.round(controlRatio * 100)}% NUL/control bytes`));
    unusual.push({ id: 'text-binary-content', title: 'Binary or mixed content in text file', summary: `The file contains NUL/control bytes (${Math.round(controlRatio * 100)}% of the sample); it is not clean UTF-8 text.`, severity: 'medium', evidence: ['text-binary-signal', 'text-encoding'], methodology: 'anomaly', confidence: 'high', category: 'structure', metrics: { controlRatio: Number(controlRatio.toFixed(3)) } });
  }
  const result: AnalysisResult = {
    objectKind: 'file',
    analyzerId: 'text',
    analyzerName: 'Text analyzer',
    targetName: file.name,
    identity,
    sections,
    important: [],
    unusual,
    recommendations: repeated.length
      ? [createFinding('text-review', 'Review repeated lines', 'Repeated lines can indicate logs, generated text, or accidental duplication.', 'low', ['repeated-0'])]
      : [],
    evidence,
    progressLabel: 'Text analysis complete',
    cacheKey: fingerprint,
    generatedAt: new Date().toISOString(),
    sourceSummary: `${formatNumber(lines.length)} lines, ${formatNumber(words.length)} words`
  };
  options.onProgress?.({ completed: 4, total: 4, step: 'Text analysis complete' });
  options.onPartial?.(result);
  return result;
}

function normalizeJsonValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  if (value === null) {
    return 'null';
  }
  return typeof value;
}

async function analyzeJsonFile(file: InspectionFile, bytes: Uint8Array, options: AnalyzeOptions): Promise<AnalysisResult> {
  ensureNotAborted(options.signal);
  options.onProgress?.({ completed: 1, total: 5, step: 'Parsing JSON' });
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const fingerprint = await fingerprintFile(file);
  const identity = makeIdentity(file, fingerprint, file.name.toLowerCase().endsWith('.jsonl') ? 'jsonl' : 'json');
  const evidence: Evidence[] = [];
  const sections: AnalysisSection[] = [];
  let parsed: unknown;
  try {
    parsed = file.name.toLowerCase().endsWith('.jsonl')
      ? text
          .split(/\r\n|\n|\r/)
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line))
      : JSON.parse(text);
  } catch (error) {
    const summary = error instanceof Error ? error.message : 'JSON parse failure';
    return {
      objectKind: 'file',
      analyzerId: 'json',
      analyzerName: 'JSON analyzer',
      targetName: file.name,
      identity,
      sections: [
        {
          id: 'json-error',
          title: 'Facts',
          items: [createEvidence('json-error', 'Parse error', summary)]
        }
      ],
      important: [],
      unusual: [createFinding('json-invalid', 'Invalid JSON', summary, 'high', ['json-error'])],
      recommendations: [],
      evidence: [createEvidence('json-error', 'Parse error', summary)],
      progressLabel: 'JSON parse failed',
      cacheKey: fingerprint,
      generatedAt: new Date().toISOString(),
      sourceSummary: summary
    };
  }
  options.onProgress?.({ completed: 2, total: 5, step: 'Traversing JSON structure' });
  const rootType = Array.isArray(parsed) ? 'array' : typeof parsed;
  const queue: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }];
  const keyCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  let objectCount = 0;
  let arrayCount = 0;
  let maxDepth = 0;
  let scalarCount = 0;
  while (queue.length) {
    ensureNotAborted(options.signal);
    const current = queue.shift()!;
    maxDepth = Math.max(maxDepth, current.depth);
    const currentType = normalizeJsonValue(current.value);
    typeCounts.set(currentType, (typeCounts.get(currentType) ?? 0) + 1);
    if (Array.isArray(current.value)) {
      arrayCount += 1;
      for (const item of current.value) {
        queue.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    if (current.value && typeof current.value === 'object') {
      objectCount += 1;
      for (const [key, value] of Object.entries(current.value as Record<string, unknown>)) {
        keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
        queue.push({ value, depth: current.depth + 1 });
      }
      continue;
    }
    scalarCount += 1;
  }
  options.onProgress?.({ completed: 4, total: 5, step: 'Deriving structural evidence' });
  const topKeys = sortDescending([...keyCounts.entries()]).slice(0, 8);
  const jsonKeyPath = (key: string): string => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `$.${key}` : `$[${JSON.stringify(key)}]`;
  const topKeysEvidence = topKeys.map(([key, count], index) => {
    const base = createEvidence(`json-key-${index}`, `Key ${index + 1}`, `${key} appears ${count} times`);
    const path = jsonKeyPath(key);
    return { ...base, location: { type: 'json-path' as const, label: path, path } };
  });
  evidence.push(
    createEvidence('json-root', 'Root type', rootType),
    createEvidence('json-objects', 'Objects', formatNumber(objectCount)),
    createEvidence('json-arrays', 'Arrays', formatNumber(arrayCount)),
    createEvidence('json-depth', 'Max depth', formatNumber(maxDepth)),
    createEvidence('json-scalars', 'Scalars', formatNumber(scalarCount))
  );
  sections.push(
    { id: 'json-facts', title: 'Facts', items: evidence },
    {
      id: 'json-structure',
      title: 'Structure',
      items: topKeysEvidence.length ? topKeysEvidence : [createEvidence('json-keys-none', 'Object keys', 'No object keys detected')]
    }
  );
  const unusual: Finding[] = [];
  if (maxDepth >= 8) {
    unusual.push(createFinding('json-deep', 'Deeply nested structure', 'The JSON structure has substantial nesting depth.', 'medium', ['json-depth']));
  }
  if (topKeys.some(([, count]) => count === 1) && objectCount > 1) {
    unusual.push(createFinding('json-unique-keys', 'Sparse shared schema', 'Several keys appear only once across the structure.', 'low', ['json-key-0']));
  }
  const result: AnalysisResult = {
    objectKind: 'file',
    analyzerId: 'json',
    analyzerName: 'JSON analyzer',
    targetName: file.name,
    identity,
    sections,
    important: [],
    unusual,
    recommendations: topKeys.length
      ? [createFinding('json-review', 'Review high-frequency keys', 'Frequently repeated keys define the backbone of the structure.', 'low', ['json-key-0'])]
      : [],
    evidence,
    progressLabel: 'JSON analysis complete',
    cacheKey: fingerprint,
    generatedAt: new Date().toISOString(),
    sourceSummary: `${formatNumber(objectCount)} objects, ${formatNumber(arrayCount)} arrays, ${formatNumber(maxDepth)} max depth`
  };
  options.onProgress?.({ completed: 5, total: 5, step: 'JSON analysis complete' });
  options.onPartial?.(result);
  return result;
}

function detectDelimiter(text: string): string {
  const sample = text.split(/\r\n|\n|\r/).filter(Boolean).slice(0, 8).join('\n');
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestScore = -1;
  for (const candidate of candidates) {
    const counts = sample
      .split(/\r\n|\n|\r/)
      .map((line) => (line.match(new RegExp(`\\${candidate === '\t' ? '\\t' : candidate}`, 'g')) ?? []).length)
      .filter((count) => count > 0);
    const score = counts.reduce((acc, count) => acc + count, 0) + counts.length * 10;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }
    if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    if (char === '\r') {
      continue;
    }
    cell += char;
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((current) => current.some((value) => value.trim().length > 0));
}

function inferColumnType(values: string[]): string {
  const trimmed = values.filter((value) => value.trim().length > 0);
  if (!trimmed.length) {
    return 'empty';
  }
  const numeric = trimmed.filter((value) => toNumber(value) !== null).length;
  const dates = trimmed.filter((value) => isLikelyDate(value)).length;
  if (numeric === trimmed.length) {
    return 'numeric';
  }
  if (dates === trimmed.length) {
    return 'date';
  }
  if (numeric / trimmed.length > 0.8) {
    return 'mostly numeric';
  }
  return 'text';
}

async function analyzeCsvFile(file: InspectionFile, bytes: Uint8Array, options: AnalyzeOptions): Promise<AnalysisResult> {
  ensureNotAborted(options.signal);
  options.onProgress?.({ completed: 1, total: 5, step: 'Detecting delimiter' });
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const delimiter = detectDelimiter(text);
  options.onProgress?.({ completed: 2, total: 5, step: 'Parsing table' });
  const rows = parseDelimited(text, delimiter);
  const fingerprint = await fingerprintFile(file);
  const identity = makeIdentity(file, fingerprint, delimiter === '\t' ? 'tsv' : 'csv');
  const header = rows[0] ?? [];
  const dataRows = rows.slice(1);
  const rowCount = dataRows.length;
  const columnCount = header.length || rows[0]?.length || 0;
  const columns = Array.from({ length: columnCount }, (_, index) => ({
    name: header[index] || `Column ${index + 1}`,
    values: dataRows.map((row) => row[index] ?? '')
  }));
  const missingCells = columns.reduce((acc, column) => acc + column.values.filter((value) => value.trim().length === 0).length, 0);
  const duplicateRows = new Map<string, { count: number; indices: number[] }>();
  dataRows.forEach((row, index) => {
    const key = row.join('\u0001');
    const entry = duplicateRows.get(key) ?? { count: 0, indices: [] };
    entry.count += 1;
    entry.indices.push(index);
    duplicateRows.set(key, entry);
  });
  const duplicateGroups = [...duplicateRows.entries()].filter(([, entry]) => entry.count > 1);
  const duplicateRowCount = duplicateGroups.reduce((acc, [, entry]) => acc + entry.count - 1, 0);
  const duplicateExample = duplicateGroups[0];
  const duplicateRowNumbers = duplicateGroups.slice(0, 10).flatMap(([, entry]) => entry.indices.map((index) => index + 2));
  options.onProgress?.({ completed: 3, total: 5, step: 'Measuring columns' });
  const numericColumns = columns
    .map((column) => ({ column, type: inferColumnType(column.values) }))
    .filter((entry) => entry.type === 'numeric' || entry.type === 'mostly numeric');
  const statsEvidence = columns.flatMap((column, index) => {
    const numericValues = column.values.map(toNumber).filter((value): value is number => value !== null);
    if (!numericValues.length) {
      return [];
    }
    const average = mean(numericValues);
    const med = median(numericValues);
    const sd = standardDeviation(numericValues);
    const min = Math.min(...numericValues);
    const max = Math.max(...numericValues);
    return [
      createEvidence(`csv-stat-${index}-min`, `${column.name} min`, String(min)),
      createEvidence(`csv-stat-${index}-max`, `${column.name} max`, String(max)),
      createEvidence(`csv-stat-${index}-avg`, `${column.name} mean`, average.toFixed(3)),
      createEvidence(`csv-stat-${index}-med`, `${column.name} median`, med.toFixed(3)),
      createEvidence(`csv-stat-${index}-sd`, `${column.name} stdev`, sd.toFixed(3))
    ];
  });
  statsEvidence.forEach((entry) => {
    const mm = entry.id.match(/^csv-stat-(\d+)-/);
    if (mm) {
      const col = columns[Number(mm[1])];
      if (col) entry.location = { type: 'column' as const, label: `${col.name} (column ${Number(mm[1]) + 1})`, column: Number(mm[1]), columnIndex: Number(mm[1]) };
    }
  });
  const outlierEvidence = columns.flatMap((column, index) => {
    const numericValues = column.values.map(toNumber).filter((value): value is number => value !== null);
    if (numericValues.length < 4) {
      return [];
    }
    const q1 = quantile(numericValues, 0.25);
    const q3 = quantile(numericValues, 0.75);
    const iqr = q3 - q1;
    const lower = q1 - 1.5 * iqr;
    const upper = q3 + 1.5 * iqr;
    const outliers = numericValues.filter((value) => value < lower || value > upper);
    if (!outliers.length) {
      return [];
    }
    return [createEvidence(`csv-outlier-${index}`, `${column.name} outliers`, `${outliers.length} value(s) outside the IQR fence`)];
  });
  outlierEvidence.forEach((entry) => {
    const mm = entry.id.match(/^csv-outlier-(\d+)/);
    if (mm) {
      const col = columns[Number(mm[1])];
      if (col) entry.location = { type: 'column' as const, label: `${col.name} (column ${Number(mm[1]) + 1})`, column: Number(mm[1]), columnIndex: Number(mm[1]) };
    }
  });
  const columnTypes = columns.map((column, index) => {
    const type = inferColumnType(column.values);
    const missing = column.values.filter((value) => value.trim().length === 0).length;
    return createEvidence(
      `csv-col-${index}`,
      column.name,
      `${type}, ${formatNumber(missing)} missing, ${formatNumber(new Set(column.values.filter((value) => value.trim().length > 0)).size)} unique`
    );
  });
  columnTypes.forEach((entry) => {
    const mm = entry.id.match(/^csv-col-(\d+)/);
    if (mm) {
      const col = columns[Number(mm[1])];
      if (col) entry.location = { type: 'column' as const, label: `${col.name} (column ${Number(mm[1]) + 1})`, column: Number(mm[1]), columnIndex: Number(mm[1]) };
    }
  });
  options.onProgress?.({ completed: 4, total: 5, step: 'Deriving statistics' });
  const evidence: Evidence[] = [
    createEvidence('csv-rows', 'Rows', formatNumber(rowCount)),
    createEvidence('csv-columns', 'Columns', formatNumber(columnCount)),
    createEvidence('csv-missing', 'Missing cells', formatNumber(missingCells)),
    createEvidence('csv-duplicate-rows', 'Duplicate rows', formatNumber(duplicateRowCount)),
    createEvidence('csv-delimiter', 'Delimiter', delimiter === '\t' ? 'tab' : delimiter)
  ];
  if (duplicateRowNumbers.length) {
    const shown = duplicateRowNumbers.slice(0, 20).join(', ');
    evidence.push(createEvidence('csv-duplicate-rows-at', 'Duplicate rows at', `rows ${shown}${duplicateRowNumbers.length > 20 ? '...' : ''}`));
  }
  if (duplicateExample) {
    const example = duplicateExample[0].split('\u0001').slice(0, 4).join('", "');
    {
      const dupRow = duplicateExample[1].indices[0] + 2;
      const rowEvidence = createEvidence('csv-duplicate-example', 'Duplicate example', `row ${dupRow}: "${example}" repeats ${duplicateExample[1].count} times`);
      evidence.push({ ...rowEvidence, location: { type: 'row' as const, label: `row ${dupRow}`, row: dupRow } });
    }
  }
  // Columns whose values are identical to another column.
  const columnSignatures = columns.map((column, index) => ({ index, name: column.name, signature: column.values.join('\u0001') }));
  const signatureGroups = new Map<string, number[]>();
  columnSignatures.forEach((column) => {
    const group = signatureGroups.get(column.signature) ?? [];
    group.push(column.index);
    signatureGroups.set(column.signature, group);
  });
  const duplicateColumns = [...signatureGroups.entries()].filter(([, indexes]) => indexes.length > 1);
  if (duplicateColumns.length) {
    const names = duplicateColumns[0][1].map((index) => columns[index].name);
    evidence.push(createEvidence('csv-duplicate-columns', 'Duplicate columns', `${names.join(' and ')} have identical values`));
  }
  // Columns where a single value dominates (repeating values).
  const repeatedValueEvidence = columns.flatMap((column, index) => {
    const counts = new Map<string, number>();
    for (const value of column.values) {
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }
      counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
    if (top && rowCount >= 5 && top[1] / rowCount > 0.5) {
      return [createEvidence(`csv-repeat-${index}`, `${column.name} repeated value`, `"${top[0].slice(0, 60)}" appears in ${top[1]} of ${rowCount} rows`)];
    }
    return [];
  });
  evidence.push(...repeatedValueEvidence.slice(0, 8));
  evidence.push(...statsEvidence.slice(0, 20));
  const sections: AnalysisSection[] = [
    { id: 'csv-facts', title: 'Facts', items: evidence.slice(0, 8) },
    { id: 'csv-columns', title: 'Structure', items: columnTypes }
  ];
  if (statsEvidence.length) {
    sections.push({ id: 'csv-stats', title: 'Detailed statistics', items: statsEvidence.slice(0, 20) });
  }
  if (outlierEvidence.length) {
    sections.push({ id: 'csv-outliers', title: 'Unusual', items: outlierEvidence.slice(0, 10) });
  }
  const unusual: Finding[] = [];
  if (duplicateRowCount > 0) {
    const rowsText = duplicateRowNumbers.length ? ` at rows ${duplicateRowNumbers.slice(0, 12).join(', ')}${duplicateRowNumbers.length > 12 ? '...' : ''}` : '';
    unusual.push(createFinding('csv-duplicates', 'Duplicate rows present', `${duplicateRowCount} duplicate row(s) found${rowsText}.`, 'medium', ['csv-duplicate-rows-at', 'csv-duplicate-rows', 'csv-duplicate-example']));
  }
  if (duplicateColumns.length) {
    const names = duplicateColumns[0][1].map((index) => columns[index].name);
    unusual.push(createFinding('csv-dup-columns', 'Duplicate columns', `Columns ${names.join(' and ')} contain identical values.`, 'medium', ['csv-duplicate-columns']));
  }
  repeatedValueEvidence.slice(0, 4).forEach((repeated, index) => {
    unusual.push(createFinding(`csv-repeat-finding-${index}`, 'Repeated values in a column', `${repeated.label}: ${repeated.value}.`, 'low', [repeated.id]));
  });
  const cellMissingRatio = rowCount && columnCount ? missingCells / (rowCount * columnCount) : 0;
  if (cellMissingRatio > 0.1) {
    unusual.push(createFinding('csv-missing', 'Missing data concentration', `Missing values account for ${percent(cellMissingRatio)} of all cells.`, 'medium', ['csv-missing']));
  }
  const recommendations: Finding[] = [];
  if (numericColumns.length) {
    recommendations.push(createFinding('csv-numeric', 'Review numeric columns', 'Inspect columns with strong numeric structure for outliers and data-entry errors.', 'low', ['csv-columns']));
  }
  // ---- Deep statistical analysis ------------------------------------------
  const deepEvidence: Evidence[] = [];
  const deepFindings: Finding[] = [];
  const visualizations: Visualization[] = [];
  for (const column of columns) {
    const numericValues = column.values.map(toNumber).filter((value): value is number => value !== null);
    if (numericValues.length >= 8) {
      const skew = skewness(numericValues);
      const cv = coefficientOfVariation(numericValues);
      const absSkew = Math.abs(skew);
      if (absSkew > 1.5) {
        const id = `csv-deep-skew-${column.name}`;
        deepEvidence.push(createEvidence(id, `${column.name} skewness`, `${skew.toFixed(2)} (right-tailed if positive, left-tailed if negative)`));
        deepFindings.push(anomalyToFinding(
          {
            id: `csv-skew-${column.name}`,
            label: `Column ${column.name} is ${skew > 0 ? 'right-' : 'left-'}skewed`,
            measured: `skewness ${skew.toFixed(2)}`,
            baseline: '|skewness| <= 1.5',
            deviation: `${absSkew.toFixed(2)}x the threshold`,
            confidence: absSkew > 2.5 ? 'high' : 'medium',
            strength: Math.min(1, absSkew / 4),
            evidenceIds: [id]
          },
          'Skewed numeric column',
          'low',
          'statistics'
        ));
      }
      if (cv > 2) {
        const id = `csv-deep-cv-${column.name}`;
        deepEvidence.push(createEvidence(id, `${column.name} coefficient of variation`, cv.toFixed(2)));
        deepFindings.push(anomalyToFinding(
          {
            id: `csv-cv-${column.name}`,
            label: `Column ${column.name} has extreme spread`,
            measured: `CV ${cv.toFixed(2)}`,
            baseline: 'CV <= 2',
            deviation: `${cv.toFixed(2)}x spread`,
            confidence: 'medium',
            strength: Math.min(1, cv / 4),
            evidenceIds: [id]
          },
          'Extreme numeric spread',
          'low',
          'statistics'
        ));
      }
      if (!visualizations.length && column.values.length >= 4) {
        const hist = buildHistogram(numericValues, 8);
        visualizations.push({
          id: `csv-hist-${column.name}`,
          kind: 'histogram',
          title: `${column.name} distribution`,
          labels: hist.labels,
          values: hist.counts,
          unit: 'values'
        });
      }
    }
    const constant = constantRatio(column.values);
    if (constant > 0.9 && rowCount >= 5) {
      const id = `csv-deep-constant-${column.name}`;
      deepEvidence.push(createEvidence(id, `${column.name} constant ratio`, percent(constant)));
      deepFindings.push(anomalyToFinding(
        {
          id: `csv-constant-${column.name}`,
          label: `Column ${column.name} is nearly constant`,
          measured: `${percent(constant)} of rows share one value`,
          baseline: '<= 90% repeated',
          deviation: `${((constant - 0.9) * 100).toFixed(1)} points above threshold`,
          confidence: 'high',
          strength: Math.min(1, constant),
          evidenceIds: [id]
        },
        'Nearly constant column',
        'low',
        'statistics'
      ));
    }
    const missing = missingRatio(column.values);
    if (missing > 0.3 && rowCount >= 5) {
      const id = `csv-deep-missing-${column.name}`;
      deepEvidence.push(createEvidence(id, `${column.name} missing ratio`, percent(missing)));
      deepFindings.push(anomalyToFinding(
        {
          id: `csv-missing-col-${column.name}`,
          label: `Column ${column.name} is mostly empty`,
          measured: `${percent(missing)} missing`,
          baseline: '<= 30% missing',
          deviation: `${((missing - 0.3) * 100).toFixed(1)} points above threshold`,
          confidence: 'high',
          strength: Math.min(1, missing),
          evidenceIds: [id]
        },
        'Extreme missingness',
        'medium',
        'statistics'
      ));
    }
    const dupShare = duplicateRatio(column.values);
    if (dupShare > 0.5 && rowCount >= 5) {
      const id = `csv-deep-dup-${column.name}`;
      deepEvidence.push(createEvidence(id, `${column.name} duplicate share`, percent(dupShare)));
      deepFindings.push(anomalyToFinding(
        {
          id: `csv-dup-col-${column.name}`,
          label: `Column ${column.name} is duplicate-heavy`,
          measured: `${percent(dupShare)} of values repeat`,
          baseline: '<= 50% repeating values',
          deviation: `${((dupShare - 0.5) * 100).toFixed(1)} points above threshold`,
          confidence: 'high',
          strength: Math.min(1, dupShare),
          evidenceIds: [id]
        },
        'Duplicate-heavy column',
        'low',
        'statistics'
      ));
    }
    const uniques = uniqueRatio(column.values);
    if (rowCount >= 10 && uniques > 0 && uniques < 0.05 && column.values.some((value) => value.trim().length > 0)) {
      const id = `csv-deep-cardinality-${column.name}`;
      deepEvidence.push(createEvidence(id, `${column.name} cardinality`, percent(uniques) + ' unique'));
      deepFindings.push(anomalyToFinding(
        {
          id: `csv-cardinality-${column.name}`,
          label: `Column ${column.name} has very low cardinality`,
          measured: `${percent(uniques)} unique values`,
          baseline: '>= 5% unique',
          deviation: `${((0.05 - uniques) * 100).toFixed(1)} points below threshold`,
          confidence: 'medium',
          strength: Math.min(1, (0.05 - uniques) * 10),
          evidenceIds: [id]
        },
        'Unexpected cardinality',
        'low',
        'statistics'
      ));
    }
  }
  if (deepEvidence.length) {
    evidence.push(...deepEvidence.slice(0, 10));
    sections.push({ id: 'csv-deep', title: 'Deep analysis', items: deepEvidence.slice(0, 12) });
  }
  unusual.push(...deepFindings.slice(0, 8));
  const result: AnalysisResult = {
    objectKind: 'file',
    analyzerId: 'csv',
    analyzerName: 'CSV analyzer',
    targetName: file.name,
    identity,
    sections,
    important: [],
    unusual,
    recommendations,
    evidence,
    progressLabel: 'CSV analysis complete',
    cacheKey: fingerprint,
    generatedAt: new Date().toISOString(),
    sourceSummary: `${formatNumber(rowCount)} rows, ${formatNumber(columnCount)} columns`,
    visualizations: visualizations.length ? visualizations : undefined
  };
  options.onProgress?.({ completed: 5, total: 5, step: 'CSV analysis complete' });
  options.onPartial?.(result);
  return result;
}

function parsePng(bytes: Uint8Array): { width: number; height: number; format: string; alpha: boolean } | null {
  if (bytes.length < 24) {
    return null;
  }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const colorType = bytes[25] ?? 0;
  return { width, height, format: 'PNG', alpha: colorType === 4 || colorType === 6 };
}

function parseGif(bytes: Uint8Array): { width: number; height: number; format: string; alpha: boolean } | null {
  if (bytes.length < 10) {
    return null;
  }
  const header = new TextDecoder().decode(bytes.slice(0, 6));
  if (header !== 'GIF87a' && header !== 'GIF89a') {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true), format: 'GIF', alpha: header === 'GIF89a' };
}

function parseBmp(bytes: Uint8Array): { width: number; height: number; format: string; alpha: boolean } | null {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)), format: 'BMP', alpha: false };
}

function parseJpeg(bytes: Uint8Array): { width: number; height: number; format: string; alpha: boolean } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) {
      break;
    }
    const length = (bytes[offset + 2] << 8) + bytes[offset + 3];
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) &&
      offset + 8 < bytes.length
    ) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { width: view.getUint16(offset + 7, false), height: view.getUint16(offset + 5, false), format: 'JPEG', alpha: false };
    }
    offset += 2 + length;
  }
  return null;
}

function parseWebp(bytes: Uint8Array): { width: number; height: number; format: string; alpha: boolean } | null {
  if (bytes.length < 30) {
    return null;
  }
  const riff = new TextDecoder().decode(bytes.slice(0, 4));
  const webp = new TextDecoder().decode(bytes.slice(8, 12));
  if (riff !== 'RIFF' || webp !== 'WEBP') {
    return null;
  }
  const chunkType = new TextDecoder().decode(bytes.slice(12, 16));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readUint24LE = (offset: number): number => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  if (chunkType === 'VP8X') {
    const flags = bytes[20] ?? 0;
    return {
      width: readUint24LE(24) + 1,
      height: readUint24LE(27) + 1,
      format: 'WebP',
      alpha: Boolean(flags & 0b00010000)
    };
  }
  if (chunkType === 'VP8 ' && bytes.length >= 30) {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff, format: 'WebP', alpha: false };
  }
  return null;
}

async function analyzeImageFile(file: InspectionFile, bytes: Uint8Array, options: AnalyzeOptions): Promise<AnalysisResult> {
  ensureNotAborted(options.signal);
  options.onProgress?.({ completed: 1, total: 3, step: 'Reading image header' });
  const fingerprint = await fingerprintFile(file);
  const identity = makeIdentity(file, fingerprint, file.mimeType.startsWith('image/') ? file.mimeType.split('/')[1].toUpperCase() : 'image');
  const parsed = parsePng(bytes) ?? parseJpeg(bytes) ?? parseGif(bytes) ?? parseBmp(bytes) ?? parseWebp(bytes);
  if (!parsed) {
    const summary = 'Unsupported or malformed image format';
    return {
      objectKind: 'file',
      analyzerId: 'image',
      analyzerName: 'Image analyzer',
      targetName: file.name,
      identity,
      sections: [{ id: 'image-error', title: 'Facts', items: [createEvidence('image-error', 'Decode', summary)] }],
      important: [],
      unusual: [createFinding('image-invalid', 'Image decode failed', summary, 'high', ['image-error'])],
      recommendations: [],
      evidence: [createEvidence('image-error', 'Decode', summary)],
      progressLabel: 'Image decode failed',
      cacheKey: fingerprint,
      generatedAt: new Date().toISOString(),
      sourceSummary: summary
    };
  }
  options.onProgress?.({ completed: 2, total: 3, step: 'Measuring image geometry' });
  const megapixels = (parsed.width * parsed.height) / 1_000_000;
  const evidence = [
    createEvidence('image-format', 'Format', parsed.format),
    createEvidence('image-dimensions', 'Dimensions', `${formatNumber(parsed.width)} x ${formatNumber(parsed.height)}`),
    createEvidence('image-aspect', 'Aspect ratio', (parsed.width / parsed.height).toFixed(3)),
    createEvidence('image-megapixels', 'Megapixels', megapixels.toFixed(2)),
    createEvidence('image-alpha', 'Alpha channel', parsed.alpha ? 'Present' : 'Not detected')
  ];
  const unusual: Finding[] = [];
  if (parsed.width === 0 || parsed.height === 0) {
    unusual.push(createFinding('image-zero', 'Zero dimension image', 'The decoded image has an invalid zero dimension.', 'high', ['image-dimensions']));
  }
  if (megapixels > 20) {
    unusual.push(createFinding('image-large', 'Large image', 'The image is large enough to be expensive to render or process.', 'medium', ['image-megapixels']));
  }
  const visualizations: Visualization[] = [];
  const limitations: string[] = [];
  let sceneLikelihood: number | undefined;
  let sceneLabel: string | undefined;
  // Pixel-level analysis: colors, brightness, contrast, sharpness, perceptual
  // hash. Decoding is bounded (small images are cheap; huge ones are skipped).
  if (megapixels <= 12 && parsed.width > 0 && parsed.height > 0) {
    try {
      const decoded = await decodeImage(bytes.slice(0, 32 * 1024 * 1024));
      if (decoded) {
        const pixels = analyzePixels(decoded);
        if (pixels) {
          evidence.push(createEvidence('image-colors', 'Dominant colors', pixels.dominantColors.map((color) => color.hex).join(', ')));
          evidence.push(createEvidence('image-brightness', 'Brightness', `${Math.round(pixels.brightness * 100)}%`));
          evidence.push(createEvidence('image-contrast', 'Contrast', `${Math.round(pixels.contrast * 100)}%`));
          evidence.push(createEvidence('image-sharpness', 'Sharpness', `${Math.round(pixels.sharpness * 100)}%`));
          evidence.push(createEvidence('image-colorfulness', 'Colorfulness', `${Math.round(pixels.colorfulness * 100)}%`));
          evidence.push(createEvidence('image-hash', 'Perceptual hash', pixels.perceptualHash.slice(0, 16)));
          if (pixels.dominantColors.length > 1) {
            visualizations.push({
              id: 'image-palette',
              kind: 'bars',
              title: 'Dominant colors',
              labels: pixels.dominantColors.map((color) => color.hex),
              values: pixels.dominantColors.map((color) => Number((color.ratio * 100).toFixed(1))),
              unit: '%'
            });
          }
          const scene = classifyImageScene(pixels);
          sceneLikelihood = scene.textLikelihood;
          sceneLabel = scene.label;
          evidence.push(createEvidence('image-scene', 'Content type', scene.label));
          evidence.push(createEvidence('image-text-likelihood', 'Text likelihood', `${Math.round(scene.textLikelihood * 100)}%`));
          evidence.push(createEvidence('image-edge-density', 'Edge density', `${Math.round(pixels.edgeDensity * 100)}%`));
          if (scene.textLikelihood >= 0.5) {
            unusual.push({
              id: 'image-text-like',
              title: 'Text-like content detected',
              summary: `Pixel analysis suggests the image may contain readable text (${Math.round(scene.textLikelihood * 100)}% likelihood); OCR extracts it locally when available (${scene.reason.toLowerCase()}).`,
              severity: 'info',
              evidence: ['image-text-likelihood', 'image-scene'],
              methodology: 'heuristic',
              confidence: 'medium',
              category: 'structure'
            });
          } else if (scene.textLikelihood < 0.25) {
            unusual.push({
              id: 'image-unlikely-text',
              title: 'Unlikely to contain text',
              summary: `Pixel analysis estimates only a ${Math.round(scene.textLikelihood * 100)}% likelihood of readable text (${scene.reason.toLowerCase()}).`,
              severity: 'info',
              evidence: ['image-text-likelihood', 'image-scene'],
              methodology: 'heuristic',
              confidence: 'medium',
              category: 'structure'
            });
          }
          if (pixels.sharpness < 0.08 && pixels.sampleCount > 64) {
            unusual.push({
              id: 'image-blurry',
              title: 'Possibly blurry image',
              summary: `Low edge sharpness (${Math.round(pixels.sharpness * 100)}%) suggests a blurred or out-of-focus image.`,
              severity: 'low',
              evidence: ['image-sharpness'],
              methodology: 'heuristic',
              confidence: 'medium',
              category: 'quality'
            });
          }
          if (pixels.brightness < 0.12) {
            unusual.push({
              id: 'image-dark',
              title: 'Very dark image',
              summary: `Mean brightness is only ${Math.round(pixels.brightness * 100)}%; most pixels are near-black.`,
              severity: 'low',
              evidence: ['image-brightness'],
              methodology: 'heuristic',
              confidence: 'high',
              category: 'quality'
            });
          }
          if (pixels.colorfulness < 0.03 && pixels.sampleCount > 64) {
            unusual.push({
              id: 'image-monochrome',
              title: 'Nearly monochrome image',
              summary: `Only ${Math.round(pixels.colorfulness * 100)}% of pixels are colorful; the image is effectively grayscale.`,
              severity: 'info',
              evidence: ['image-colorfulness'],
              methodology: 'heuristic',
              confidence: 'high',
              category: 'quality'
            });
          }
        } else {
          limitations.push('Pixel-level analysis skipped: image pixels could not be interpreted.');
        }
      } else {
        limitations.push('Pixel-level analysis not available for this format in this environment.');
      }
    } catch {
      limitations.push('Pixel-level analysis failed; continuing with header metadata.');
    }
  } else if (megapixels > 12) {
    limitations.push('Pixel-level analysis skipped for images larger than 12 megapixels.');
  }
  // EXIF metadata for JPEGs: camera, software, capture date, orientation, GPS.
  if (parsed.format === 'JPEG') {
    let exif: ReturnType<typeof extractJpegExif> = null;
    try {
      exif = extractJpegExif(bytes.slice(0, 8 * 1024 * 1024));
    } catch {
      // Malformed EXIF must never crash image analysis.
      exif = null;
    }
    if (exif) {
      if (exif.make) evidence.push(createEvidence('image-exif-make', 'Camera make', exif.make));
      if (exif.model) evidence.push(createEvidence('image-exif-model', 'Camera model', exif.model));
      if (exif.software) evidence.push(createEvidence('image-exif-software', 'Software', exif.software));
      const captured = exif.dateTimeOriginal ?? exif.dateTime;
      if (captured) evidence.push(createEvidence('image-exif-datetime', 'Date captured', captured));
      if (exif.orientation && exif.orientation !== 1) {
        evidence.push(createEvidence('image-exif-orientation', 'Orientation', `Rotated (EXIF ${exif.orientation})`));
      }
      if (exif.gpsLatitude !== undefined && exif.gpsLongitude !== undefined) {
        evidence.push(createEvidence('image-exif-gps', 'GPS', `${exif.gpsLatitude.toFixed(5)}, ${exif.gpsLongitude.toFixed(5)}`));
      }
    }
  }
  // Local OCR: attempt when it is worthwhile (screenshot-named or
  // document-sized images) and actually available. Output is validated so
  // phantom text from noise/photos is never reported as OCR text.
  let ocrSection: AnalysisSection | undefined;
  let ocrFinding: Finding | undefined;
  const ocrCheck = ocrWorthwhile({
    isScreenshot: /screenshot|screen|scan|capture|ocr/i.test(file.name),
    width: parsed.width,
    height: parsed.height,
    textLikelihood: sceneLikelihood
  });
  const textLikeScene = sceneLabel ? /document|scan|screenshot|ui|mixed/i.test(sceneLabel) : false;
  const shouldAttemptOcr = ocrCheck.worthwhile || (sceneLikelihood !== undefined && sceneLikelihood >= 0.3) || textLikeScene;
  if (!shouldAttemptOcr && sceneLikelihood !== undefined) {
    evidence.push(createEvidence('image-ocr', 'OCR', `Skipped - content is not text-like (${Math.round(sceneLikelihood * 100)}% likelihood)`));
  } else if (shouldAttemptOcr) {
    if (await isOcrAvailable()) {
      const outcome = await ocrImage(bytes.slice(0, 8 * 1024 * 1024));
      if (outcome.available && outcome.text.trim()) {
        evidence.push(createEvidence('image-ocr', 'OCR text', outcome.text.trim().slice(0, 300)));
        ocrSection = {
          id: 'image-ocr',
          title: 'OCR text',
          items: [
            createEvidence('image-ocr-text', 'OCR text', outcome.text.trim().slice(0, 800)),
            ...(outcome.confidence !== undefined ? [createEvidence('image-ocr-confidence', 'OCR confidence', `${outcome.confidence.toFixed(1)}%`)] : [])
          ]
        };
        ocrFinding = {
          id: 'image-ocr',
          title: 'OCR text extracted',
          summary: `${outcome.text.trim().length} characters of OCR-derived text were extracted locally.`,
          severity: 'info',
          evidence: ['image-ocr'],
          methodology: 'ml',
          confidence: 'medium',
          category: 'structure'
        };
      } else {
        evidence.push(createEvidence('image-ocr', 'OCR', outcome.message || 'No readable text found'));
      }
    } else {
      evidence.push(createEvidence('image-ocr', 'OCR', 'Not available - install tesseract.js for on-device OCR'));
      limitations.push('OCR not available: install tesseract.js (local, no cloud)');
    }
  }
  const sections: AnalysisSection[] = [{ id: 'image-facts', title: 'Facts', items: evidence }];
  if (ocrSection) sections.push(ocrSection);
  const result: AnalysisResult = {
    objectKind: 'file',
    analyzerId: 'image',
    analyzerName: 'Image analyzer',
    targetName: file.name,
    identity,
    sections,
    important: [],
    unusual: ocrFinding ? [...unusual, ocrFinding] : unusual,
    recommendations: megapixels > 20 ? [createFinding('image-review', 'Check image size', 'Large images can affect memory and rendering performance.', 'low', ['image-megapixels'])] : [],
    limitations: limitations.length ? limitations : undefined,
    evidence,
    progressLabel: 'Image analysis complete',
    cacheKey: fingerprint,
    generatedAt: new Date().toISOString(),
    sourceSummary: `${formatNumber(parsed.width)} x ${formatNumber(parsed.height)} image`,
    visualizations: visualizations.length ? visualizations : undefined
  };
  options.onProgress?.({ completed: 3, total: 3, step: 'Image analysis complete' });
  options.onPartial?.(result);
  return result;
}
function collectFolderStats(folder: InspectionFolder): {
  fileCount: number;
  folderCount: number;
  totalBytes: number;
  extensionCounts: Map<string, number>;
  largestFiles: Array<{ name: string; size: number; path: string }>;
  maxDepth: number;
} {
  const extensionCounts = new Map<string, number>();
  const largestFiles: Array<{ name: string; size: number; path: string }> = [];
  let fileCount = 0;
  let folderCount = 1;
  let totalBytes = 0;
  let maxDepth = 0;
  const visit = (item: InspectionItem, depth: number): void => {
    maxDepth = Math.max(maxDepth, depth);
    if (item.kind === 'file') {
      fileCount += 1;
      totalBytes += item.size;
      const extension = item.name.split('.').pop()?.toLowerCase() ?? '(none)';
      extensionCounts.set(extension, (extensionCounts.get(extension) ?? 0) + 1);
      largestFiles.push({ name: item.name, size: item.size, path: item.path });
      return;
    }
    if (item.kind === 'url') {
      return;
    }
    if (depth > 0) {
      folderCount += 1;
    }
    for (const child of item.children) {
      visit(child, depth + 1);
    }
  };
  for (const child of folder.children) {
    visit(child, 1);
  }
  largestFiles.sort((left, right) => right.size - left.size);
  return { fileCount, folderCount, totalBytes, extensionCounts, largestFiles: largestFiles.slice(0, 5), maxDepth };
}

interface DeepFolderOutput {
  evidence: Evidence[];
  findings: Finding[];
  sections: AnalysisSection[];
  visualizations: Array<{ id: string; kind: 'bars' | 'histogram' | 'timeline'; title: string; labels: string[]; values: number[]; unit?: string }>;
  relationships?: AnalysisResult['relationships'];
}

async function collectAllFiles(folder: InspectionFolder): Promise<InspectionFile[]> {
  const files: InspectionFile[] = [];
  const stack: InspectionItem[] = [folder];
  while (stack.length) {
    const item = stack.pop()!;
    if (item.kind === 'file') {
      files.push(item);
    } else if (item.kind === 'folder') {
      for (const child of item.children) stack.push(child);
    }
  }
  return files;
}

async function analyzeFolderDeep(folder: InspectionFolder, stats: { fileCount: number; totalBytes: number }, options: AnalyzeOptions): Promise<DeepFolderOutput> {
  const evidence: Evidence[] = [];
  const findings: Finding[] = [];
  const sections: AnalysisSection[] = [];
  const visualizations: Array<{ id: string; kind: 'bars' | 'histogram' | 'timeline'; title: string; labels: string[]; values: number[]; unit?: string }> = [];
  const files = await collectAllFiles(folder);
  ensureNotAborted(options.signal);

  // 1) Unusually large files via percentile analysis.
  const sizes = files.map((file) => file.size).sort((a, b) => a - b);
  if (sizes.length >= 4) {
    const p95 = quantile(sizes, 0.95);
    const avg = mean(sizes);
    const sd = standardDeviation(sizes);
    const largeFiles = files.filter((file) => file.size > Math.max(p95, avg + 3 * sd) && file.size > 1024 * 1024).slice(0, 5);
    if (largeFiles.length) {
      largeFiles.forEach((file, index) => {
        evidence.push(createEvidence(`folder-deep-large-${index}`, `Large file ${index + 1}`, `${file.path} (${formatBytes(file.size)})`));
      });
      findings.push({
        id: 'folder-deep-large-files',
        title: 'Unusually large files',
        summary: `${largeFiles.length} file(s) exceed the 95th-percentile size (${formatBytes(p95)}).`,
        severity: 'low',
        evidence: largeFiles.map((_, index) => `folder-deep-large-${index}`),
        methodology: 'anomaly',
        confidence: 'medium',
        category: 'statistics',
        metrics: { p95: Math.round(p95), average: Math.round(avg), stdev: Math.round(sd) }
      });
    }
    visualizations.push({
      id: 'folder-size-distribution',
      kind: 'bars',
      title: 'Largest files',
      labels: files
        .slice()
        .sort((a, b) => b.size - a.size)
        .slice(0, 8)
        .map((file) => file.name),
      values: files
        .slice()
        .sort((a, b) => b.size - a.size)
        .slice(0, 8)
        .map((file) => file.size),
      unit: 'bytes'
    });
  }

  // 2) File-type concentration.
  const extCounts = new Map<string, number>();
  for (const file of files) {
    const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '(none)';
    extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
  }
  if (extCounts.size >= 3) {
    const top = [...extCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const share = top[1] / files.length;
    if (share > 0.5) {
      evidence.push(createEvidence('folder-deep-type-share', 'Dominant file type', `${top[0]}: ${percent(share)} of files`));
      findings.push({
        id: 'folder-deep-type-concentration',
        title: 'Concentrated file types',
        summary: `${top[0] || '(none)'} accounts for ${percent(share)} of files.`,
        severity: 'info',
        evidence: ['folder-deep-type-share'],
        methodology: 'anomaly',
        confidence: 'high',
        category: 'statistics'
      });
    }
    const topTypes = [...extCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    visualizations.push({
      id: 'folder-type-distribution',
      kind: 'bars',
      title: 'File types',
      labels: topTypes.map(([ext]) => ext || '(none)'),
      values: topTypes.map(([, count]) => count),
      unit: 'files'
    });
  }

  // 3) Directory domination (top-level children share of total bytes).
  const topLevelFolders = folder.children.filter((child): child is InspectionFolder => child.kind === 'folder');
  if (topLevelFolders.length >= 2 && stats.totalBytes > 0) {
    const folderSizes: Array<{ name: string; bytes: number }> = [];
    for (const child of topLevelFolders.slice(0, 20)) {
      const childFiles = await collectAllFiles(child);
      folderSizes.push({ name: child.name, bytes: childFiles.reduce((acc, file) => acc + file.size, 0) });
    }
    const dominant = folderSizes.sort((a, b) => b.bytes - a.bytes)[0];
    const share = stats.totalBytes ? dominant.bytes / stats.totalBytes : 0;
    if (share > 0.6) {
      evidence.push(createEvidence('folder-deep-dir-share', 'Dominant directory', `${dominant.name}: ${percent(share)} of total size`));
      findings.push({
        id: 'folder-deep-dir-domination',
        title: 'Directory dominates size',
        summary: `${dominant.name} holds ${percent(share)} of the total size (${formatBytes(dominant.bytes)}).`,
        severity: 'info',
        evidence: ['folder-deep-dir-share', 'folder-bytes'],
        methodology: 'anomaly',
        confidence: 'medium',
        category: 'statistics'
      });
    }
  }

  // 4) Exact duplicates (hash) + wasted bytes.
  if (files.length >= 2) {
    const dupFiles = files.slice(0, 300);
    const groups = await findExactDuplicates(
      dupFiles.map((file) => ({ name: file.name, size: file.size, path: file.path, file: file.file })),
      { limit: 200 }
    );
    if (groups.length) {
      const summary = summarizeDuplicates(groups);
      evidence.push(createEvidence('folder-deep-dup-groups', 'Duplicate groups', formatNumber(summary.groups)));
      evidence.push(createEvidence('folder-deep-dup-wasted', 'Wasted bytes', formatBytes(summary.wastedBytes)));
      groups.slice(0, 4).forEach((group, index) => {
        evidence.push(createEvidence(`folder-deep-dup-${index}`, `Duplicate group ${index + 1}`, `${formatNumber(group.copies)} copies, ${formatBytes(group.wastedBytes)} wasted; representative ${group.representative}`));
      });
      findings.push({
        id: 'folder-deep-exact-duplicates',
        title: 'Exact duplicate files',
        summary: `${formatNumber(summary.groups)} group(s), ${formatNumber(summary.copies)} copies, ${formatBytes(summary.wastedBytes)} wasted storage.`,
        severity: 'medium',
        evidence: ['folder-deep-dup-groups', 'folder-deep-dup-wasted'],
        methodology: 'fact',
        confidence: 'measured',
        category: 'duplicates',
        metrics: { groups: summary.groups, copies: summary.copies, wastedBytes: summary.wastedBytes }
      });
      sections.push({
        id: 'folder-deep-duplicates',
        title: 'Duplicate files',
        items: groups.slice(0, 5).map((group, index) => createEvidence(`folder-deep-dup-${index}`, `Duplicate group ${index + 1}`, `${group.paths.join(' ; ')} (${formatNumber(group.copies)} copies, ${formatBytes(group.wastedBytes)} wasted)`))
      });
    }
  }

  // 5) Similar images (perceptual hash).
  const images = files.filter((file) => /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(file.name)).slice(0, 20);
  if (images.length >= 2) {
    const hashes: Array<{ path: string; hash: bigint | null }> = [];
    for (const image of images) {
      ensureNotAborted(options.signal);
      try {
        const bytes = new Uint8Array(await image.file.slice(0, 8 * 1024 * 1024).arrayBuffer());
        hashes.push({ path: image.path, hash: await imageHashOf(bytes) });
      } catch {
        hashes.push({ path: image.path, hash: null });
      }
    }
    const pairs: Array<{ left: string; right: string; score: number }> = [];
    for (let a = 0; a < hashes.length; a += 1) {
      for (let b = a + 1; b < hashes.length; b += 1) {
        if (hashes[a].hash === null || hashes[b].hash === null) continue;
        const score = imageSimilarity(hashes[a].hash!, hashes[b].hash!);
        if (score >= 0.85) pairs.push({ left: hashes[a].path, right: hashes[b].path, score });
      }
    }
    if (pairs.length) {
      pairs.slice(0, 4).forEach((pair, index) => {
        evidence.push(createEvidence(`folder-deep-img-${index}`, `Similar images ${index + 1}`, `${pair.left} ~ ${pair.right} (${Math.round(pair.score * 100)}%)`));
      });
      findings.push({
        id: 'folder-deep-similar-images',
        title: 'Visually similar images',
        summary: `${pairs.length} image pair(s) have similar perceptual hashes (>= 85%).`,
        severity: 'low',
        evidence: pairs.slice(0, 4).map((_, index) => `folder-deep-img-${index}`),
        methodology: 'ml',
        confidence: 'medium',
        category: 'duplicates',
        metrics: { pairs: pairs.length }
      });
    }
  }

  if (evidence.length) {
    sections.push({ id: 'folder-deep', title: 'Deep analysis', items: evidence.slice(0, 14) });
  }

  // 5b) Text near-duplicates (character n-gram Jaccard).
  const textLikeFiles = files.filter((file) => /\.(txt|md|markdown|log)$/i.test(file.name) && file.size > 0 && file.size <= 1024 * 1024).slice(0, 40);
  if (textLikeFiles.length >= 2) {
    const textEntries: Array<{ path: string; name: string; text: string }> = [];
    for (const file of textLikeFiles) {
      ensureNotAborted(options.signal);
      try {
        const sample = new Uint8Array(await file.file.slice(0, 256 * 1024).arrayBuffer());
        textEntries.push({ path: file.path, name: file.name, text: new TextDecoder('utf-8', { fatal: false }).decode(sample) });
      } catch {
        // unreadable candidate skipped
      }
    }
    const textPairs = findTextNearDuplicates(textEntries, 0.75, 6, { excludeIdentical: true });
    textPairs.forEach((pair, index) => {
      evidence.push(createEvidence(`folder-deep-text-${index}`, `Similar text ${index + 1}`, `${pair.leftPath} ~ ${pair.rightPath} (${Math.round(pair.similarity * 100)}%)`));
    });
    if (textPairs.length) {
      findings.push({
        id: 'folder-deep-near-duplicate-text',
        title: 'Near-duplicate text files',
        summary: `${textPairs.length} text pair(s) are highly similar but not byte-identical (>= 75%).`,
        severity: 'low',
        evidence: textPairs.slice(0, 6).map((_, index) => `folder-deep-text-${index}`),
        methodology: 'ml',
        confidence: 'medium',
        category: 'duplicates',
        metrics: { pairs: textPairs.length }
      });
    }
  }

  // 6) Cross-object relationships (folders and multi-object selections).
  let relationships: AnalysisResult['relationships'];
  if (files.length >= 2) {
    relationships = await findCrossObjectRelationships(files.slice(0, 60), { signal: options.signal });
    if (relationships?.length) {
      sections.push({
        id: 'folder-relationships',
        title: 'Relationships',
        items: relationships.slice(0, 10).map((relationship, index) =>
          createEvidence(`folder-rel-${index}`, relationship.label, relationship.detail)
        )
      });
    }
  }

  return { evidence, findings, sections, visualizations, relationships };
}

async function analyzeFolder(folder: InspectionFolder, options: AnalyzeOptions): Promise<AnalysisResult> {
  ensureNotAborted(options.signal);
  options.onProgress?.({ completed: 1, total: 4, step: 'Walking folder tree' });
  const sizeFingerprint = await fingerprintFolder(folder);
  const stats = collectFolderStats(folder);
  const filePaths: Array<{ name: string; size: number; path: string }> = [];
  const walkPaths = (item: InspectionItem): void => {
    if (item.kind === 'file') {
      filePaths.push({ name: item.name, size: item.size, path: item.path });
    } else if (item.kind === 'folder') {
      for (const child of item.children) walkPaths(child);
    }
  };
  walkPaths(folder);
  const filesByNameAndSize = new Map<string, string[]>();
  for (const entry of filePaths) {
    const key = `${entry.name}\u0001${entry.size}`;
    const group = filesByNameAndSize.get(key) ?? [];
    group.push(entry.path);
    filesByNameAndSize.set(key, group);
  }
  const duplicateFileGroups = [...filesByNameAndSize.entries()].filter(([, paths]) => paths.length > 1);
  const duplicateFileCount = duplicateFileGroups.reduce((acc, [, paths]) => acc + paths.length - 1, 0);
  options.onProgress?.({ completed: 2, total: 4, step: 'Counting files and bytes' });
  options.onProgress?.({ completed: 3, total: 4, step: 'Inspecting project signals' });
  const projectSignals = await collectProjectSignals(folder);
  const isProject = projectSignals.sourceFiles > 0 || projectSignals.manifestFiles.length > 0 || Boolean(projectSignals.git);
  const identity = makeFolderIdentity(folder, sizeFingerprint, stats.totalBytes, projectSignals.git ? 'git repository' : isProject ? 'project folder' : 'folder');
  const extensionEvidence = [...stats.extensionCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([extension, count], index) => createEvidence(`folder-ext-${index}`, extension, `${count} files`));
  const largestEvidence = stats.largestFiles.map((entry, index) => createEvidence(`folder-large-${index}`, `Large file ${index + 1}`, `${entry.path} (${formatBytes(entry.size)})`));
  const evidence = [
    createEvidence('folder-files', 'Files', formatNumber(stats.fileCount)),
    createEvidence('folder-folders', 'Folders', formatNumber(stats.folderCount)),
    createEvidence('folder-bytes', 'Total size', formatBytes(stats.totalBytes)),
    createEvidence('folder-depth', 'Max depth', formatNumber(stats.maxDepth))
  ];
  if (duplicateFileCount > 0) {
    evidence.push(createEvidence('folder-duplicate-files', 'Duplicate files', formatNumber(duplicateFileCount)));
    duplicateFileGroups.slice(0, 5).forEach(([key, paths], index) => {
      const name = key.split('\u0001')[0];
      evidence.push(createEvidence(`folder-duplicate-${index}`, `Duplicate group ${index + 1}`, `${name} (${formatNumber(paths.length)} copies): ${paths.slice(0, 3).join(' ; ')}`));
    });
  }
  const sections: AnalysisSection[] = [
    { id: 'folder-facts', title: 'Facts', items: evidence },
    { id: 'folder-structure', title: 'Structure', items: extensionEvidence.length ? extensionEvidence : [createEvidence('folder-empty', 'Contents', 'No files detected')] }
  ];
  if (largestEvidence.length) {
    sections.push({ id: 'folder-large', title: 'Important', items: largestEvidence });
  }
  if (isProject) {
    sections.push({
      id: 'folder-project',
      title: 'Project signals',
      items: [
        createEvidence('folder-project-source', 'Source files', formatNumber(projectSignals.sourceFiles)),
        createEvidence('folder-project-logs', 'Log files', formatNumber(projectSignals.logFiles)),
        createEvidence('folder-project-manifests', 'Manifests', formatNumber(projectSignals.manifestFiles.length)),
        createEvidence('folder-project-todos', 'TODO markers', formatNumber(projectSignals.todoCount + projectSignals.fixmeCount))
      ]
    });
  }
  if (projectSignals.languageCounts.size > 0) {
    sections.push({
      id: 'folder-languages',
      title: 'Languages',
      items: [...projectSignals.languageCounts.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 8)
        .map(([language, count], index) => createEvidence(`folder-lang-${index}`, language, `${count} files`))
    });
  }
  if (projectSignals.git) {
    sections.push({
      id: 'folder-git',
      title: 'Git',
      items: [
        createEvidence('folder-git-branches', 'Branches', formatNumber(projectSignals.git.branches.length)),
        createEvidence('folder-git-commits', 'Commit log entries', formatNumber(projectSignals.git.commitCount)),
        createEvidence('folder-git-contributors', 'Contributors', formatNumber(projectSignals.git.contributors.length)),
        createEvidence('folder-git-last', 'Last commit', projectSignals.git.lastCommit || 'Not available')
      ]
    });
  }
  const unusual: Finding[] = [];
  if (duplicateFileCount > 0) {
    unusual.push(createFinding('folder-duplicates', 'Duplicate files', `${formatNumber(duplicateFileCount)} duplicate file(s) across ${formatNumber(duplicateFileGroups.length)} group(s).`, 'low', duplicateFileGroups.slice(0, 3).map((_, index) => `folder-duplicate-${index}`)));
  }
  if (stats.maxDepth >= 5) {
    unusual.push(createFinding('folder-depth-high', 'Deep nesting', 'The folder tree has multiple nested levels.', 'medium', ['folder-depth']));
  }
  if (stats.fileCount > 0 && stats.totalBytes / Math.max(stats.fileCount, 1) > 25 * 1024 * 1024) {
    unusual.push(createFinding('folder-large-average', 'Large average file size', 'The average file size is unusually large.', 'low', ['folder-bytes']));
  }
  if (projectSignals.todoCount + projectSignals.fixmeCount > 0) {
    unusual.push(createFinding('folder-todos', 'Deferred work markers present', 'TODO/FIXME markers were found in the project tree.', 'low', ['folder-project-todos']));
  }
  if (projectSignals.git && projectSignals.git.branches.length > 1) {
    unusual.push(createFinding('folder-branches', 'Multiple branches detected', 'More than one Git branch is present in the repository metadata.', 'info', ['folder-git-branches']));
  }
  // Cross-manifest dependency conflict aggregation for projects.
  let depRelationships: AnalysisResult['relationships'] = [];
  if (isProject) {
    const depGraph = await collectDependencyGraph(folder, { signal: options.signal, maxFiles: 400 });
    const conflicts = depGraph.versionInconsistencies;
    if (conflicts.length) {
      evidence.push(createEvidence('folder-dep-conflicts', 'Dependency version conflicts', formatNumber(conflicts.length)));
      conflicts.slice(0, 3).forEach((conflict, index) => {
        const detail = conflict.versions.map((entry) => entry.version + ' (' + entry.manifest + ')').join('; ');
        evidence.push(createEvidence('folder-dep-conflict-' + index, 'Conflict ' + (index + 1), conflict.name + ': ' + detail));
      });
      unusual.push({
        id: 'folder-dependency-version-conflicts',
        title: 'Conflicting dependency versions across manifests',
        summary: conflicts.length + ' shared package(s) have inconsistent version constraints across manifests (' + conflicts.slice(0, 2).map((conflict) => conflict.name).join(', ') + ').',
        severity: 'medium',
        evidence: ['folder-dep-conflicts'],
        methodology: 'anomaly',
        confidence: 'high',
        category: 'relationships',
        metrics: { conflicts: conflicts.length }
      });
    }
    if (depGraph.duplicatedDependencies.length) {
      evidence.push(createEvidence('folder-dep-shared', 'Shared dependencies across manifests', formatNumber(depGraph.duplicatedDependencies.length)));
    }
    depRelationships = dependencyRelationships(depGraph);
    if (depRelationships.length) {
      sections.push({
        id: 'folder-dependencies',
        title: 'Dependencies',
        items: [
          createEvidence('folder-dep-manifests', 'Manifests', formatNumber(depGraph.manifests.length)),
          createEvidence('folder-dep-conflicts', 'Version conflicts', formatNumber(conflicts.length)),
          createEvidence('folder-dep-shared', 'Shared dependencies', formatNumber(depGraph.duplicatedDependencies.length))
        ]
      });
    }
  }

  // Deep analysis (anomalies, duplicates, similar images, relationships, visualizations).
  const deep = await analyzeFolderDeep(folder, { fileCount: stats.fileCount, totalBytes: stats.totalBytes }, options);
  sections.push(...deep.sections);
  unusual.push(...deep.findings);
  evidence.push(...deep.evidence.slice(0, 20));
  const result: AnalysisResult = {
    objectKind: 'folder',
    analyzerId: 'folder',
    analyzerName: isProject ? 'Project analyzer' : 'Folder analyzer',
    capabilities: isProject ? ['structure', 'languages', 'dependencies', 'logs', 'git'] : ['structure'],
    limitations: projectSignals.git ? ['Git history derived from reflogs only', 'Read-only filesystem inspection'] : ['Read-only filesystem inspection'],
    targetName: folder.name,
    identity,
    sections,
    important: [],
    unusual,
    recommendations: stats.largestFiles.length
      ? [createFinding('folder-review', 'Inspect large files first', 'The largest files are usually the fastest way to understand a folder.', 'low', ['folder-large-0'])]
      : [],
    evidence,
    progressLabel: 'Folder analysis complete',
    cacheKey: sizeFingerprint,
    generatedAt: new Date().toISOString(),
    sourceSummary: `${formatNumber(stats.fileCount)} files, ${formatNumber(stats.folderCount)} folders`,
    visualizations: deep.visualizations.length ? deep.visualizations : undefined,
    relationships: (deep.relationships?.length || depRelationships.length) ? [...(deep.relationships ?? []), ...depRelationships] : undefined
  };
  options.onProgress?.({ completed: 4, total: 4, step: 'Folder analysis complete' });
  options.onPartial?.(result);
  return result;
}

async function analyzeGenericFile(file: InspectionFile, bytes: Uint8Array, options: AnalyzeOptions): Promise<AnalysisResult> {
  ensureNotAborted(options.signal);
  options.onProgress?.({ completed: 1, total: 2, step: 'Inspecting generic file' });
  const fingerprint = await fingerprintFile(file);
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const looksText = isTextLikeName(file.name) || (!bytes.includes(0) && decoded.trim().length > 0);
  if (looksText && (isTextLikeName(file.name) || bytes.length <= 2 * 1024 * 1024)) {
    return analyzeTextFile(file, bytes, options);
  }
  const evidence = [
    createEvidence('generic-size', 'Size', formatBytes(file.size)),
    createEvidence('generic-mime', 'MIME type', file.mimeType || 'application/octet-stream'),
    createEvidence('generic-extension', 'Extension', file.name.includes('.') ? file.name.split('.').pop() || '(none)' : '(none)'),
    createEvidence('generic-bytes', 'Sample bytes', formatNumber(bytes.length))
  ];
  const result: AnalysisResult = {
    objectKind: 'file',
    analyzerId: 'generic',
    analyzerName: 'Generic file analyzer',
    targetName: file.name,
    identity: makeIdentity(file, fingerprint, inferKind(file.name, file.mimeType)),
    sections: [{ id: 'generic-facts', title: 'Facts', items: evidence }],
    important: [],
    unusual: [],
    recommendations: [],
    evidence,
    progressLabel: 'Generic analysis complete',
    cacheKey: fingerprint,
    generatedAt: new Date().toISOString(),
    sourceSummary: `${formatBytes(file.size)} file`
  };
  options.onProgress?.({ completed: 2, total: 2, step: 'Generic analysis complete' });
  options.onPartial?.(result);
  return result;
}

async function fileAnalyzer(item: InspectionItem, options: AnalyzeOptions): Promise<AnalysisResult> {
  if (item.kind !== 'file') {
    throw new Error('File analyzer can only process files');
  }
  const gitMeta = await analyzeGitMetadataFile(item, { signal: options.signal });
  if (gitMeta) {
    return gitMeta;
  }
  let result: AnalysisResult | null = null;
  const document = await analyzeDocumentFile(item, { signal: options.signal, ocrAvailableOverride: options.ocrAvailableOverride });
  if (document) {
    result = document;
  } else {
    const archive = await analyzeArchiveFile(item, { signal: options.signal });
    if (archive) {
      result = archive;
    } else {
      const sqlite = await analyzeSqliteFile(item, { signal: options.signal });
      if (sqlite) {
        result = sqlite;
      } else {
        const media = await analyzeMediaFile(item, { signal: options.signal });
        if (media) {
          result = media;
        } else {
          const code = await analyzeCodeFile(item, { signal: options.signal });
          if (code) {
            result = code;
          } else {
            const bytes = await fileBytes(item.file);
            const name = item.name.toLowerCase();
            if (name.endsWith('.json') || name.endsWith('.jsonl') || item.mimeType.includes('json')) {
              result = await analyzeJsonFile(item, bytes, options);
            } else if (name.endsWith('.csv') || name.endsWith('.tsv') || item.mimeType.includes('csv') || item.mimeType.includes('tab-separated')) {
              result = await analyzeCsvFile(item, bytes, options);
            } else if (item.mimeType.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(item.name)) {
              result = await analyzeImageFile(item, bytes, options);
            } else if (isTextLikeName(item.name) || item.mimeType.startsWith('text/')) {
              result = await analyzeTextFile(item, bytes, options);
            } else {
              result = await analyzeGenericFile(item, bytes, options);
            }
          }
        }
      }
    }
  }
  // Filename + content identity checks apply to every single-file result so
  // misleading names/extensions and trivially-truncated containers surface as
  // findings regardless of which analyzer produced the report.
  const headLimit = Math.min(item.file.size, 512 * 1024);
  const head = headLimit > 0 ? new Uint8Array(await item.file.slice(0, headLimit).arrayBuffer()) : new Uint8Array();
  const nameChecks = filenameChecks(item.name);
  const contentChecks = item.file.size > 0 ? contentIdentityChecks(item.name, head, item.file.size) : { evidence: [], findings: [] };
  const knownEvidence = new Set(result.evidence.map((entry) => entry.id));
  const knownFindings = new Set([...result.unusual, ...result.important, ...result.recommendations].map((entry) => entry.id));
  for (const entry of [...nameChecks.evidence, ...contentChecks.evidence]) {
    if (!knownEvidence.has(entry.id)) {
      result.evidence.push(entry);
      knownEvidence.add(entry.id);
    }
  }
  for (const entry of [...nameChecks.findings, ...contentChecks.findings]) {
    if (!knownFindings.has(entry.id)) {
      result.unusual.push(entry);
      knownFindings.add(entry.id);
    }
  }
  return result;
}
export const analyzers: Analyzer[] = [
  {
    id: 'folder',
    name: 'Folder analyzer',
    canHandle: (item) => item.kind === 'folder',
    analyze: analyzeFolder
  },
  {
    id: 'url',
    name: 'Website analyzer',
    canHandle: (item) => item.kind === 'url',
    analyze: analyzeUrlItem
  },
  {
    id: 'file',
    name: 'File analyzer',
    canHandle: (item) => item.kind === 'file',
    analyze: fileAnalyzer
  }
];

export async function analyzeItem(item: InspectionItem, options: AnalyzeOptions): Promise<AnalysisResult> {
  ensureNotAborted(options.signal);
  options.onProgress?.({ completed: 0, total: 1, step: 'Selecting analyzer' });
  const analyzer = analyzers.find((candidate) => candidate.canHandle(item));
  if (!analyzer) {
    throw new Error('No analyzer available');
  }
  options.onProgress?.({ completed: 0, total: 1, step: analyzer.name });
  return analyzer.analyze(item, options);
}

export async function fingerprintItem(item: InspectionItem): Promise<string> {
  if (item.kind === 'file') {
    return fingerprintFile(item.file);
  }
  if (item.kind === 'url') {
    return digestHex(new TextEncoder().encode(item.url.trim().toLowerCase()));
  }
  return fingerprintFolder(item);
}

export async function summarizeItem(item: InspectionItem): Promise<AnalysisResult> {
  const controller = new AbortController();
  return analyzeItem(item, { signal: controller.signal });
}

export function buildIdentityHint(item: InspectionItem): string {
  if (item.kind === 'file') {
    return `${item.name} (${formatBytes(item.size)})`;
  }
  if (item.kind === 'url') {
    return item.url;
  }
  return `${item.name} folder`;
}




