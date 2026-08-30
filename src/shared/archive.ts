import JSZip from 'jszip';
import { Gunzip } from 'fflate';
import type { AnalysisResult, AnalysisSection, Evidence, Finding, InspectionFile } from './types.ts';
import { digestHex, formatBytes, formatNumber, shortFingerprint } from './utils.ts';
import { evidence, finding, ensureNotAborted, extension, limitArray, readBytes } from './analysis-utils.ts';

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_GZIP_OUTPUT = 256 * 1024 * 1024;

function identity(file: InspectionFile, format: string, fingerprint: string) {
  return {
    name: file.name,
    type: format,
    format,
    mimeType: file.mimeType,
    size: file.size,
    location: file.path,
    created: new Date(file.lastModified).toLocaleString(),
    modified: new Date(file.lastModified).toLocaleString(),
    fingerprint: shortFingerprint(fingerprint)
  };
}

function build(file: InspectionFile, format: string, fingerprint: string, capabilities: string[], sections: AnalysisSection[], evidenceList: Evidence[], unusual: Finding[], recommendations: Finding[], limitations: string[], summary: string): AnalysisResult {
  return {
    objectKind: 'file',
    analyzerId: 'archive',
    analyzerName: `${format} archive analyzer`,
    capabilities,
    limitations,
    targetName: file.name,
    identity: identity(file, format, fingerprint),
    sections,
    important: [],
    unusual,
    recommendations,
    evidence: evidenceList,
    progressLabel: `${format} archive analysis complete`,
    cacheKey: fingerprint,
    generatedAt: new Date().toISOString(),
    sourceSummary: summary
  };
}

function normalizePath(value: string): string {
  return value.replace(/\\+/g, '/').replace(/\/+/g, '/');
}

function isSuspiciousPath(pathValue: string): boolean {
  const normalized = normalizePath(pathValue);
  return normalized.startsWith('/') || normalized.startsWith('../') || normalized.includes('/../') || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('~');
}

/**
 * Parse TAR entries without extracting anything. Supports ustar/gnu long names
 * (typeflag 'L') and pax extended headers (typeflag 'x') in a bounded way.
 */
function parseTarEntries(bytes: Uint8Array): Array<{ name: string; size: number; type: string }> {
  const entries: Array<{ name: string; size: number; type: string }> = [];
  let offset = 0;
  let pendingLongName: string | null = null;
  const text = new TextDecoder('utf-8', { fatal: false });
  let guard = 0;
  while (offset + 512 <= bytes.length && guard < MAX_ARCHIVE_ENTRIES) {
    guard += 1;
    const header = bytes.slice(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      break;
    }
    const name = text.decode(header.slice(0, 100)).replace(/\0.*$/, '');
    const sizeOct = text.decode(header.slice(124, 136)).replace(/\0.*$/, '').trim();
    const typeflag = text.decode(header.slice(156, 157)).replace(/\0.*$/, '') || '0';
    const size = parseInt(sizeOct || '0', 8) || 0;
    const type = typeflag || '0';
    const blocks = Math.ceil(size / 512);
    const payloadStart = offset + 512;
    if (type === 'L' && payloadStart + size <= bytes.length) {
      pendingLongName = text.decode(bytes.slice(payloadStart, payloadStart + size)).replace(/\0.*$/, '');
      offset += 512 + blocks * 512;
      continue;
    }
    if (type === 'x' || type === 'g') {
      // pax extended header: read path= entries and skip the payload.
      if (payloadStart + size <= bytes.length) {
        const pax = text.decode(bytes.slice(payloadStart, payloadStart + size));
        for (const line of pax.split('\n')) {
          const pathMatch = line.match(/^\d+ path=(.*)$/);
          if (pathMatch) {
            pendingLongName = pathMatch[1];
          }
        }
      }
      offset += 512 + blocks * 512;
      continue;
    }
    const finalName = pendingLongName || name;
    pendingLongName = null;
    entries.push({ name: normalizePath(finalName), size, type });
    offset += 512 + blocks * 512;
  }
  return entries;
}

async function archiveErrorResult(file: InspectionFile, format: string, message: string): Promise<AnalysisResult> {
  const fingerprint = await digestHex(new TextEncoder().encode(`${file.name}|${file.size}`));
  return build(
    file,
    format,
    fingerprint,
    ['error-handling'],
    [{ id: 'archive-error', title: 'Facts', items: [evidence('archive-error', 'Parse error', message)] }],
    [evidence('archive-error', 'Parse error', message)],
    [finding('archive-invalid', `Invalid ${format} archive`, message, 'high', ['archive-error'])],
    [],
    ['No extraction was performed'],
    message
  );
}

async function analyzeZip(file: InspectionFile, bytes: Uint8Array): Promise<AnalysisResult> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files);
  const fileNames = names.filter((name) => !zip.files[name]?.dir);
  let uncompressed = 0;
  let suspicious = 0;
  let nestedArchives = 0;
  const duplicates = new Map<string, number>();
  const paths = fileNames.map((name) => normalizePath(name));
  for (const entry of Object.values(zip.files)) {
    if (!entry.dir) {
      uncompressed += (entry as any)._data?.uncompressedSize ?? 0;
      const norm = normalizePath(entry.name);
      duplicates.set(norm, (duplicates.get(norm) ?? 0) + 1);
      if (/\.(zip|tar|tgz|gz|7z|rar|bz2)$/i.test(norm)) nestedArchives += 1;
      if (isSuspiciousPath(norm)) suspicious += 1;
    }
  }
  const duplicateCount = [...duplicates.values()].filter((count) => count > 1).reduce((acc, count) => acc + count - 1, 0);
  const ratio = uncompressed && file.size ? uncompressed / file.size : 0;
  const fingerprint = await digestHex(bytes);
  const truncated = fileNames.length > MAX_ARCHIVE_ENTRIES;
  const evidenceList = [
    evidence('zip-files', 'Files', formatNumber(fileNames.length)),
    evidence('zip-uncompressed', 'Uncompressed size', formatBytes(uncompressed)),
    evidence('zip-compressed', 'Compressed size', formatBytes(file.size)),
    evidence('zip-ratio', 'Expansion ratio', ratio ? ratio.toFixed(2) : '0.00'),
    evidence('zip-nested', 'Nested archives', formatNumber(nestedArchives)),
    evidence('zip-duplicates', 'Duplicate names', formatNumber(duplicateCount)),
    evidence('zip-suspicious', 'Suspicious paths', formatNumber(suspicious))
  ];
  const sections: AnalysisSection[] = [
    { id: 'zip-facts', title: 'Facts', items: evidenceList },
    { id: 'zip-structure', title: 'Structure', items: limitArray(paths, 15).map((pathValue, index) => evidence(`zip-entry-${index}`, `Entry ${index + 1}`, pathValue)) }
  ];
  const unusual: Finding[] = [];
  if (ratio > 10) unusual.push(finding('zip-bomb-risk', 'Large expansion ratio', 'The archive expands much more than it compresses.', 'high', ['zip-ratio']));
  if (suspicious > 0) unusual.push(finding('zip-traversal', 'Suspicious paths', 'One or more entries contain path traversal or absolute-path patterns.', 'high', ['zip-suspicious']));
  if (duplicateCount > 0) unusual.push(finding('zip-duplicates', 'Duplicate archive names', 'Repeated entry names are present in the archive.', 'medium', ['zip-duplicates']));
  if (truncated) unusual.push(finding('zip-large', 'Very large archive', 'The archive contains an unusually high number of entries.', 'info', ['zip-files']));
  return build(file, 'ZIP', fingerprint, ['file-list', 'structure', 'compression-ratio', 'nested-archives', 'path-safety'], sections, evidenceList, unusual, [], ['Read-only archive listing only; no extraction to disk'], `${formatNumber(fileNames.length)} entries`);
}

async function analyzeTar(file: InspectionFile, bytes: Uint8Array): Promise<AnalysisResult> {
  const entries = parseTarEntries(bytes);
  let total = 0;
  let suspicious = 0;
  let nested = 0;
  for (const entry of entries) {
    total += entry.size;
    if (isSuspiciousPath(entry.name)) suspicious += 1;
    if (/\.(zip|tar|tgz|gz|7z|rar|bz2)$/i.test(entry.name)) nested += 1;
  }
  const fingerprint = await digestHex(bytes);
  const evidenceList = [
    evidence('tar-files', 'Files', formatNumber(entries.length)),
    evidence('tar-uncompressed', 'Uncompressed size', formatBytes(total)),
    evidence('tar-suspicious', 'Suspicious paths', formatNumber(suspicious)),
    evidence('tar-nested', 'Nested archives', formatNumber(nested))
  ];
  const sections: AnalysisSection[] = [
    { id: 'tar-facts', title: 'Facts', items: evidenceList },
    { id: 'tar-structure', title: 'Structure', items: limitArray(entries.map((entry) => entry.name), 15).map((value, index) => evidence(`tar-entry-${index}`, `Entry ${index + 1}`, value)) }
  ];
  const unusual: Finding[] = [];
  if (suspicious > 0) unusual.push(finding('tar-traversal', 'Suspicious paths', 'One or more TAR entries appear to use traversal or absolute paths.', 'high', ['tar-suspicious']));
  return build(file, 'TAR', fingerprint, ['file-list', 'structure', 'path-safety'], sections, evidenceList, unusual, [], ['TAR metadata only; no extraction performed'], `${formatNumber(entries.length)} entries`);
}

/**
 * Decompress gzip with a hard cap on output size to protect against gzip bombs.
 */
function cappedGunzip(bytes: Uint8Array, maxOutput: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  const gunzip = new Gunzip((chunk) => {
    if (overflow) {
      return;
    }
    if (total + chunk.length > maxOutput) {
      overflow = true;
      return;
    }
    chunks.push(chunk);
    total += chunk.length;
  });
  gunzip.push(bytes, true);
  if (overflow) {
    throw new Error(`Decompressed gzip output exceeds the ${formatBytes(maxOutput)} inspection limit`);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function analyzeGzip(file: InspectionFile, bytes: Uint8Array): Promise<AnalysisResult> {
  let uncompressed: Uint8Array;
  try {
    uncompressed = cappedGunzip(bytes, MAX_GZIP_OUTPUT);
  } catch (error) {
    return await archiveErrorResult(file, 'GZIP', error instanceof Error ? error.message : 'GZIP decompression failed');
  }
  const innerExt = extension(file.name.replace(/\.gz$/i, ''));
  const nestedArchive = /\.(tar|zip|7z|rar|bz2)$/i.test(file.name) || (uncompressed.length >= 4 && uncompressed[0] === 0x50 && uncompressed[1] === 0x4b);
  const fingerprint = await digestHex(bytes);
  const evidenceList = [
    evidence('gz-compressed', 'Compressed size', formatBytes(file.size)),
    evidence('gz-uncompressed', 'Uncompressed size', formatBytes(uncompressed.length)),
    evidence('gz-inner-format', 'Likely inner format', innerExt || 'unknown')
  ];
  const sections: AnalysisSection[] = [{ id: 'gz-facts', title: 'Facts', items: evidenceList }];
  const unusual: Finding[] = [];
  if (nestedArchive) unusual.push(finding('gz-nested', 'Nested archive detected', 'The decompressed bytes appear to contain another archive.', 'medium', ['gz-inner-format']));
  return build(file, 'GZIP', fingerprint, ['compression', 'inner-format-detection'], sections, evidenceList, unusual, [], ['GZIP payload not written to disk'], `${formatBytes(uncompressed.length)} decompressed`);
}

export async function analyzeArchiveFile(file: InspectionFile, options: { signal: AbortSignal }): Promise<AnalysisResult | null> {
  ensureNotAborted(options.signal);
  const ext = extension(file.name);
  const bytes = await readBytes(file, MAX_ARCHIVE_BYTES);
  try {
    if (ext === 'zip') return await analyzeZip(file, bytes);
    if (ext === 'tar') return analyzeTar(file, bytes);
    if (ext === 'gz' || ext === 'gzip' || ext === 'tgz') return await analyzeGzip(file, bytes);
  } catch (error) {
    return await archiveErrorResult(file, ext.toUpperCase(), error instanceof Error ? error.message : 'Archive parse failure');
  }
  return null;
}
