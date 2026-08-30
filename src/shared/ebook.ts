// EPUB (.epub) analyzer — reads the package (OPF), metadata, spine and text
// content out of the ZIP container. Fully local and read-only.
import JSZip from 'jszip';
import type { AnalysisResult, AnalysisSection, Evidence, Finding, InspectionFile } from './types.ts';
import { digestHex, formatNumber, shortFingerprint } from './utils.ts';
import { ensureNotAborted, evidence, finding, parseXml, readBytes, stripTags, tokenizeWords } from './analysis-utils.ts';

const MAX_EPUB_BYTES = 64 * 1024 * 1024;

function identity(file: InspectionFile, format: string, fingerprint: string) {
  return {
    name: file.name,
    type: 'ebook',
    format,
    mimeType: file.mimeType,
    size: file.size,
    location: file.path,
    created: new Date(file.lastModified).toLocaleString(),
    modified: new Date(file.lastModified).toLocaleString(),
    fingerprint: shortFingerprint(fingerprint)
  };
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function resolveZipPath(baseDir: string, href: string): string {
  const clean = href.split('#')[0].trim();
  if (!clean) return '';
  if (clean.startsWith('/')) return clean.replace(/^\/+/, '');
  const base = baseDir ? baseDir.split('/').filter(Boolean) : [];
  for (const segment of clean.split('/')) {
    if (segment === '..') base.pop();
    else if (segment && segment !== '.') base.push(segment);
  }
  return base.join('/');
}

interface EpubItem {
  id: string;
  href: string;
  mediaType: string;
}

interface EpubPackage {
  opfPath: string;
  title?: string;
  creator?: string;
  language?: string;
  identifier?: string;
  publisher?: string;
  date?: string;
  manifest: EpubItem[];
  spineHrefs: string[];
}

function extractOpfPath(containerXml: string): string | null {
  const parsed = parseXml(containerXml) as Record<string, unknown>;
  const rootfiles = (parsed as { container?: { rootfiles?: { rootfile?: unknown } } })?.container?.rootfiles;
  const rootfile = asArray(rootfiles?.rootfile)[0] as { '@_full-path'?: string } | undefined;
  return rootfile?.['@_full-path'] ?? null;
}

export function extractPackage(opf: string, opfPath: string): EpubPackage {
  const parsed = parseXml(opf) as Record<string, unknown>;
  const pkg = (parsed as { package?: Record<string, unknown> })?.package ?? parsed;
  const metadata = (pkg as { metadata?: Record<string, unknown> })?.metadata ?? {};
  const manifestNode = (pkg as { manifest?: { item?: unknown } })?.manifest;
  const spineNode = (pkg as { spine?: { itemref?: unknown } })?.spine;
  const manifest = asArray(manifestNode?.item).map((item) => {
    const attrs = (item ?? {}) as { '@_id'?: string; '@_href'?: string; '@_media-type'?: string };
    return { id: attrs['@_id'] ?? '', href: attrs['@_href'] ?? '', mediaType: attrs['@_media-type'] ?? '' };
  });
  const spineRefs = new Set(asArray(spineNode?.itemref).map((ref) => (ref as { '@_idref'?: string })?.['@_idref'] ?? ''));
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const byId = new Map(manifest.map((item) => [item.id, item]));
  const spineHrefs = [...spineRefs]
    .map((id) => byId.get(id)?.href)
    .filter((href): href is string => Boolean(href))
    .map((href) => resolveZipPath(baseDir, href))
    .filter(Boolean);
  const pick = (key: string): string | undefined => {
    const value = (metadata as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object' && typeof (value as { '#text'?: unknown })['#text'] === 'string') {
      const text = (value as { '#text': string })['#text'].trim();
      if (text) return text;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && entry.trim()) return entry.trim();
        if (entry && typeof entry === 'object' && typeof (entry as { '#text'?: unknown })['#text'] === 'string') {
          const text = (entry as { '#text': string })['#text'].trim();
          if (text) return text;
        }
      }
    }
    return undefined;
  };
  return {
    opfPath,
    title: pick('dc:title'),
    creator: pick('dc:creator'),
    language: pick('dc:language'),
    identifier: pick('dc:identifier'),
    publisher: pick('dc:publisher'),
    date: pick('dc:date'),
    manifest,
    spineHrefs
  };
}

async function readZipText(zip: JSZip, entryPath: string): Promise<string> {
  const entry = zip.file(entryPath);
  if (!entry) return '';
  return entry.async('string');
}

export async function analyzeEpubFile(file: InspectionFile, options: { signal: AbortSignal }): Promise<AnalysisResult | null> {
  ensureNotAborted(options.signal);
  if (!/\.epub$/i.test(file.name)) return null;
  const bytes = await readBytes(file, MAX_EPUB_BYTES);
  const fingerprint = await digestHex(bytes);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return {
      objectKind: 'file',
      analyzerId: 'epub',
      analyzerName: 'EPUB analyzer',
      targetName: file.name,
      identity: identity(file, 'EPUB', fingerprint),
      sections: [{ id: 'epub-facts', title: 'Facts', items: [evidence('epub-error', 'Package', 'Not a valid ZIP/EPUB container')] }],
      important: [],
      unusual: [finding('epub-invalid', 'Invalid EPUB', 'The file is not a readable ZIP/EPUB container.', 'high', ['epub-error'])],
      recommendations: [],
      evidence: [evidence('epub-error', 'Package', 'Not a valid ZIP/EPUB container')],
      progressLabel: 'EPUB analysis failed',
      cacheKey: fingerprint,
      generatedAt: new Date().toISOString(),
      sourceSummary: 'Invalid EPUB'
    };
  }
  const containerXml = await readZipText(zip, 'META-INF/container.xml');
  const opfPath = extractOpfPath(containerXml);
  if (!opfPath) {
    const summary = 'No OPF package found in META-INF/container.xml';
    return {
      objectKind: 'file',
      analyzerId: 'epub',
      analyzerName: 'EPUB analyzer',
      targetName: file.name,
      identity: identity(file, 'EPUB', fingerprint),
      sections: [{ id: 'epub-facts', title: 'Facts', items: [evidence('epub-error', 'Package', summary)] }],
      important: [],
      unusual: [finding('epub-no-opf', 'Missing package', summary, 'medium', ['epub-error'])],
      recommendations: [],
      evidence: [evidence('epub-error', 'Package', summary)],
      progressLabel: 'EPUB analysis failed',
      cacheKey: fingerprint,
      generatedAt: new Date().toISOString(),
      sourceSummary: summary
    };
  }
  const opf = await readZipText(zip, opfPath);
  const book = extractPackage(opf, opfPath);
  let wordCount = 0;
  let characterCount = 0;
  const chapterTitles: string[] = [];
  let chapterTextBytes = 0;
  for (const href of book.spineHrefs.slice(0, 200)) {
    ensureNotAborted(options.signal);
    const content = await readZipText(zip, href);
    if (!content) continue;
    const text = stripTags(content).replace(/\s+/g, ' ').trim();
    wordCount += tokenizeWords(text).length;
    characterCount += text.replace(/\s/g, '').length;
    chapterTextBytes += content.length;
    const title = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, ' ').trim();
    if (title) chapterTitles.push(title.slice(0, 120));
  }
  const imageItems = book.manifest.filter((item) => /^image\//i.test(item.mediaType));
  const cssItems = book.manifest.filter((item) => /^text\/css/i.test(item.mediaType));
  const evidenceList: Evidence[] = [
    evidence('epub-title', 'Title', book.title || 'Not present'),
    evidence('epub-creator', 'Author', book.creator || 'Not present'),
    evidence('epub-language', 'Language', book.language || 'Not present'),
    evidence('epub-identifier', 'Identifier', book.identifier || 'Not present'),
    evidence('epub-chapters', 'Chapters', formatNumber(book.spineHrefs.length)),
    evidence('epub-words', 'Words', formatNumber(wordCount)),
    evidence('epub-characters', 'Characters', formatNumber(characterCount)),
    evidence('epub-images', 'Images', formatNumber(imageItems.length)),
    evidence('epub-css', 'Stylesheets', formatNumber(cssItems.length)),
    evidence('epub-manifest-items', 'Manifest items', formatNumber(book.manifest.length))
  ];
  if (book.publisher) evidenceList.push(evidence('epub-publisher', 'Publisher', book.publisher));
  if (book.date) evidenceList.push(evidence('epub-date', 'Date', book.date));
  const sections: AnalysisSection[] = [
    { id: 'epub-facts', title: 'Facts', items: evidenceList },
    {
      id: 'epub-chapters',
      title: 'Chapters',
      items: chapterTitles.length
        ? chapterTitles.slice(0, 20).map((title, index) => evidence(`epub-chapter-${index}`, `Chapter ${index + 1}`, title))
        : [evidence('epub-no-titles', 'Chapter titles', 'No <title> tags found in spine documents')]
    }
  ];
  const unusual: Finding[] = [];
  if (!book.title) unusual.push(finding('epub-no-title', 'Missing title', 'The package metadata has no dc:title.', 'low', ['epub-title']));
  if (!book.creator) unusual.push(finding('epub-no-creator', 'Missing author', 'The package metadata has no dc:creator.', 'low', ['epub-creator']));
  if (!book.spineHrefs.length) {
    unusual.push(finding('epub-empty-spine', 'Empty spine', 'The package declares no reading-order items.', 'high', ['epub-chapters']));
  }
  if (book.spineHrefs.length > 100) {
    unusual.push({
      id: 'epub-large-spine',
      title: 'Large book',
      summary: `The spine contains ${formatNumber(book.spineHrefs.length)} chapters, which is unusually large.`,
      severity: 'info',
      evidence: ['epub-chapters'],
      methodology: 'heuristic',
      confidence: 'medium',
      category: 'structure'
    });
  }
  const recommendations: Finding[] = [];
  if (wordCount > 200000) {
    recommendations.push(finding('epub-long-reco', 'Long book', 'Over 200k words extracted; consider searching rather than reading linearly.', 'low', ['epub-words']));
  }
  return {
    objectKind: 'file',
    analyzerId: 'epub',
    analyzerName: 'EPUB analyzer',
    capabilities: ['metadata', 'chapters', 'text', 'images', 'structure'],
    limitations: ['Package and text extraction only; embedded media is not decoded'],
    targetName: file.name,
    identity: identity(file, 'EPUB', fingerprint),
    sections,
    important: [],
    unusual,
    recommendations,
    evidence: evidenceList,
    progressLabel: 'EPUB analysis complete',
    cacheKey: fingerprint,
    generatedAt: new Date().toISOString(),
    sourceSummary: book.title ? `${book.title} (${formatNumber(book.spineHrefs.length)} chapters)` : `${formatNumber(book.spineHrefs.length)} chapters`
  };
}
