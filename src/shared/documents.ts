import JSZip from 'jszip';
import { unzlibSync } from 'fflate';
import { isOcrAvailable } from './ocr.ts';
import type { AnalysisResult, AnalysisSection, Evidence, Finding, InspectionFile } from './types.ts';
import { digestHex, formatNumber, percent, shortFingerprint } from './utils.ts';
import { evidence, finding, parseXml, readBytes } from './analysis-utils.ts';
import { ensureNotAborted, limitArray, extension, mean, median, safeNumber, stddev } from './analysis-utils.ts';

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

function buildResult(file: InspectionFile, analyzerId: string, analyzerName: string, format: string, fingerprint: string, capabilities: string[], sections: AnalysisSection[], evidenceList: Evidence[], important: Finding[], unusual: Finding[], recommendations: Finding[], limitations: string[], sourceSummary: string): AnalysisResult {
  return {
    objectKind: 'file',
    analyzerId,
    analyzerName,
    capabilities,
    limitations,
    targetName: file.name,
    identity: identity(file, format, fingerprint),
    sections,
    important,
    unusual,
    recommendations,
    evidence: evidenceList,
    progressLabel: `${analyzerName} complete`,
    cacheKey: fingerprint,
    generatedAt: new Date().toISOString(),
    sourceSummary
  };
}

﻿function extractPdfStrings(source: string): string[] {
  const strings: string[] = [];
  for (const match of source.matchAll(/\((?:\\.|[^()])+\)\s*T[jJ]/g)) {
    const raw = match[0].match(/\((?:\\.|[^()])+\)/)?.[0]?.slice(1, -1) ?? '';
    strings.push(raw.replace(/\\([()\\nrtbf])/g, '$1').replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8))));
  }
  for (const match of source.matchAll(/\[((?:\((?:\\.|[^()])+\)\s*(?:-?\d+\.?\d*)?\s*)+)\]\s*TJ/g)) {
    for (const inner of match[1].matchAll(/\(((?:\\.|[^()])+)\)/g)) {
      strings.push(inner[1].replace(/\\([()\\nrtbf])/g, '$1').replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8))));
    }
  }
  return strings;
}

/**
 * Extract and decompress FlateDecode streams from a PDF so text operators can be
 * located inside compressed content streams. Memory stays bounded because each
 * stream is decompressed independently and only the first maxBytes of the
 * decompressed payload are retained for text scanning.
 */
function extractPdfStreamText(source: string, maxBytes = 4 * 1024 * 1024): string {
  const chunks: string[] = [];
  const streamPattern = /stream\r?\n([\s\S]*?)endstream/g;
  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = streamPattern.exec(source)) !== null && guard < 400) {
    guard += 1;
    const raw = match[1];
    if (!raw.length) continue;
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
      bytes[index] = raw.charCodeAt(index) & 0xff;
    }
    let decoded: Uint8Array | null = null;
    try {
      decoded = unzlibSync(bytes);
    } catch {
      decoded = null;
    }
    if (decoded) {
      chunks.push(new TextDecoder('latin1', { fatal: false }).decode(decoded.slice(0, maxBytes)));
    }
  }
  return chunks.join('\n');
}

function pdfPageCount(source: string): number {
  const countMatches = [...source.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,400}?\/Count\s+(\d+)/g)];
  if (countMatches.length) {
    const counts = countMatches.map((match) => Number(match[1])).filter((value) => Number.isFinite(value));
    if (counts.length) {
      return Math.max(...counts);
    }
  }
  return (source.match(/\/Type\s*\/Page\b/g) ?? []).length;
}

export async function analyzePdfFile(file: InspectionFile, options: { signal: AbortSignal; bytes?: Uint8Array }): Promise<AnalysisResult> {
  ensureNotAborted(options.signal);
  const bytes = options.bytes ?? await readBytes(file, 20 * 1024 * 1024);
  const text = new TextDecoder('latin1', { fatal: false }).decode(bytes);
  if (!text.startsWith('%PDF-')) {
    const fingerprint = await digestHex(bytes);
    const summary = 'Not a valid PDF header';
    return buildResult(
      file,
      'pdf',
      'PDF analyzer',
      'PDF',
      fingerprint,
      ['metadata', 'pages', 'text', 'links', 'images', 'structure'],
      [{ id: 'pdf-facts', title: 'Facts', items: [evidence('pdf-error', 'Header', summary)] }],
      [evidence('pdf-error', 'Header', summary)],
      [],
      [finding('pdf-invalid', 'Invalid PDF', summary, 'high', ['pdf-error'])],
      [],
      ['Malformed PDF'],
      summary
    );
  }
  const fingerprint = await digestHex(bytes);
  const pageCount = pdfPageCount(text);
  const streamText = extractPdfStreamText(text);
  const searchable = streamText ? `${text}\n${streamText}` : text;
  const metadata = {
    title: (searchable.match(/\/Title\s*\((.*?)\)/s)?.[1] ?? '').trim(),
    author: (searchable.match(/\/Author\s*\((.*?)\)/s)?.[1] ?? '').trim(),
    creator: (searchable.match(/\/Creator\s*\((.*?)\)/s)?.[1] ?? '').trim(),
    producer: (searchable.match(/\/Producer\s*\((.*?)\)/s)?.[1] ?? '').trim(),
    created: (searchable.match(/\/CreationDate\s*\((.*?)\)/s)?.[1] ?? '').trim(),
    modified: (searchable.match(/\/ModDate\s*\((.*?)\)/s)?.[1] ?? '').trim()
  };
  const links = limitArray([...searchable.matchAll(/\/URI\s*\((.*?)\)/g)].map((m) => m[1]), 20);
  const images = (searchable.match(/\/Subtype\s*\/Image\b/g) ?? []).length;
  const textSnippets = limitArray(extractPdfStrings(searchable), 60);
  const annotations = (searchable.match(/\/Annots\b/g) ?? []).length;
  const embeddedFiles = (searchable.match(/\/EmbeddedFiles\b/g) ?? []).length;
  const fontObjects = (searchable.match(/\/Type\s*\/Font\b/g) ?? []).length;
  const blankPages = pageCount > 0 && textSnippets.length === 0 ? pageCount : 0;
  const scannedLikely = pageCount > 0 && textSnippets.length === 0 && images > 0;
  const evidenceList: Evidence[] = [
    evidence('pdf-pages', 'Pages', formatNumber(pageCount || 0)),
    evidence('pdf-images', 'Images', formatNumber(images)),
    evidence('pdf-text-snippets', 'Text snippets', formatNumber(textSnippets.length)),
    evidence('pdf-blank-pages', 'Pages without extracted text', formatNumber(blankPages)),
    evidence('pdf-annotations', 'Annotations', formatNumber(annotations)),
    evidence('pdf-fonts', 'Font objects', formatNumber(fontObjects))
  ];
  const sections: AnalysisSection[] = [
    {
      id: 'pdf-facts',
      title: 'Facts',
      items: evidenceList
    },
    {
      id: 'pdf-metadata',
      title: 'Structure',
      items: [
        evidence('pdf-title', 'Title', metadata.title || 'Not present'),
        evidence('pdf-author', 'Author', metadata.author || 'Not present'),
        evidence('pdf-creator', 'Creator', metadata.creator || 'Not present'),
        evidence('pdf-producer', 'Producer', metadata.producer || 'Not present')
      ]
    },
    {
      id: 'pdf-links',
      title: 'Relationships',
      items: links.length ? links.map((value, index) => evidence(`pdf-link-${index}`, `Link ${index + 1}`, value)) : [evidence('pdf-links-none', 'Links', 'No external links detected')]
    }
  ];
  if (embeddedFiles > 0) {
    sections.push({
      id: 'pdf-embedded',
      title: 'Embedded files',
      items: [evidence('pdf-embedded-count', 'Embedded file attachments', formatNumber(embeddedFiles))]
    });
  }
  // Keep the flat evidence trail complete so every section item and finding
  // reference is resolvable from result.evidence.
  evidenceList.push(
    evidence('pdf-title', 'Title', metadata.title || 'Not present'),
    evidence('pdf-author', 'Author', metadata.author || 'Not present'),
    evidence('pdf-creator', 'Creator', metadata.creator || 'Not present'),
    evidence('pdf-producer', 'Producer', metadata.producer || 'Not present')
  );
  if (links.length) {
    links.forEach((value, index) => evidenceList.push(evidence(`pdf-link-${index}`, `Link ${index + 1}`, value)));
  } else {
    evidenceList.push(evidence('pdf-links-none', 'Links', 'No external links detected'));
  }
  if (embeddedFiles > 0) {
    evidenceList.push(evidence('pdf-embedded-count', 'Embedded file attachments', formatNumber(embeddedFiles)));
  }
  const ocrAvailable = await isOcrAvailable();
  const textDensity = pageCount ? textSnippets.length / pageCount : 0;
  const emptyPageRatio = pageCount ? blankPages / pageCount : 0;
  const repeatedCounts = new Map<string, number>();
  for (const snippet of textSnippets) {
    repeatedCounts.set(snippet, (repeatedCounts.get(snippet) ?? 0) + 1);
  }
  const repeatedPattern = [...repeatedCounts.entries()].find(([, count]) => count > 1);
  const pdfDateMatch = metadata.created.match(/D:(\d{4})(\d{2})(\d{2})/);
  let futureDate = false;
  if (pdfDateMatch) {
    const created = new Date(Date.UTC(Number(pdfDateMatch[1]), Number(pdfDateMatch[2]) - 1, Number(pdfDateMatch[3])));
    futureDate = created.getTime() > Date.now() + 24 * 60 * 60 * 1000;
  }
  evidenceList.push(
    evidence('pdf-text-density', 'Text density', pageCount ? `${textDensity.toFixed(2)} snippets per page` : 'n/a'),
    evidence('pdf-empty-page-ratio', 'Pages without text', pageCount ? percent(emptyPageRatio) : 'n/a')
  );
  if (repeatedPattern) {
    evidenceList.push(evidence('pdf-repeated', 'Repeated text pattern', `"${repeatedPattern[0].slice(0, 80)}" appears ${repeatedPattern[1]} times`));
  }
  evidenceList.push(evidence('pdf-ocr-available', 'Local OCR', ocrAvailable ? 'Available' : 'Not installed (tesseract.js)'));
  sections.push({
    id: 'pdf-deep',
    title: 'Deep analysis',
    items: [
      evidence('pdf-text-density', 'Text density', pageCount ? `${textDensity.toFixed(2)} snippets per page` : 'n/a'),
      evidence('pdf-empty-page-ratio', 'Pages without text', pageCount ? percent(emptyPageRatio) : 'n/a'),
      repeatedPattern ? evidence('pdf-repeated', 'Repeated text pattern', `"${repeatedPattern[0].slice(0, 80)}" appears ${repeatedPattern[1]} times`) : evidence('pdf-repeated-none', 'Repeated text pattern', 'None detected'),
      evidence('pdf-ocr-available', 'Local OCR', ocrAvailable ? 'Available' : 'Not installed (tesseract.js)')
    ]
  });
  const unusual: Finding[] = [];
  if (scannedLikely) {
    unusual.push(finding('pdf-ocr', 'OCR opportunity', 'The PDF appears to be image-only or nearly image-only.', 'medium', ['pdf-text-snippets', 'pdf-images']));
  }
  if (metadata.title && metadata.author && metadata.title === metadata.author) {
    unusual.push(finding('pdf-meta-same', 'Repeated metadata', 'Title and author are identical, which can be unusual for exported documents.', 'low', ['pdf-title', 'pdf-author']));
  }
  if (embeddedFiles > 0) {
    unusual.push(finding('pdf-embedded-files', 'Embedded attachments', 'The PDF contains embedded file attachments.', 'low', ['pdf-embedded-count']));
  }
  if (pageCount > 0 && textSnippets.length === 0 && images === 0) {
    unusual.push(finding('pdf-no-text', 'No extractable text', 'No text operators were found; the PDF may use an unusual encoding or be malformed.', 'low', ['pdf-text-snippets']));
  }
  if (pageCount >= 2 && textDensity < 0.3 && textSnippets.length > 0) {
    unusual.push({
      id: 'pdf-low-text-density',
      title: 'Low text density',
      summary: `Only ${formatNumber(textSnippets.length)} text snippets across ${formatNumber(pageCount)} pages (${percent(textDensity)} per page).`,
      severity: 'medium',
      evidence: ['pdf-text-density', 'pdf-pages'],
      methodology: 'anomaly',
      confidence: 'medium',
      category: 'anomaly',
      metrics: { density: Number(textDensity.toFixed(3)) }
    });
  }
  if (repeatedPattern) {
    unusual.push({
      id: 'pdf-repeated-header',
      title: 'Repeated text pattern',
      summary: `"${repeatedPattern[0].slice(0, 60)}" repeats ${repeatedPattern[1]} times - possible running header/footer.`,
      severity: 'low',
      evidence: ['pdf-repeated', 'pdf-text-snippets'],
      methodology: 'heuristic',
      confidence: 'medium',
      category: 'structure'
    });
  }
  if (futureDate) {
    unusual.push({
      id: 'pdf-future-date',
      title: 'Creation date in the future',
      summary: `The document creation date (${metadata.created}) is in the future.`,
      severity: 'medium',
      evidence: ['pdf-title', 'pdf-text-snippets'],
      methodology: 'anomaly',
      confidence: 'high',
      category: 'metadata'
    });
  }
  const recommendations: Finding[] = [];
  if (scannedLikely) {
    recommendations.push(finding('pdf-ocr-reco', 'Consider OCR', 'Text extraction appears limited; OCR may recover more content.', 'low', ['pdf-text-snippets']));
  }
  return buildResult(
    file,
    'pdf',
    'PDF analyzer',
    'PDF',
    fingerprint,
    ['metadata', 'pages', 'text', 'links', 'images', 'structure', 'annotations'],
    sections,
    evidenceList,
    [],
    unusual,
    recommendations,
    [scannedLikely ? 'OCR opportunity likely' : 'Read-only metadata/text inspection only'],
    `${formatNumber(pageCount || 0)} pages, ${formatNumber(images)} images`
  );
}

function collectXmlTexts(node: unknown): string[] {
  const texts: string[] = [];
  const visit = (value: unknown, key?: string): void => {
    if (value == null) return;
    if (key && key.startsWith('@_')) {
      // Skip XML attribute values (namespaces, style ids, etc.).
      return;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed && trimmed.length < 500) texts.push(trimmed);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
        if (childKey === '#text' || childKey === '#cdata-section') {
          visit(child);
          continue;
        }
        visit(child, childKey);
      }
    }
  };
  visit(node);
  return texts;
}

const MAX_OOXML_BYTES = 64 * 1024 * 1024;

async function loadZip(file: InspectionFile): Promise<JSZip> {
  const bytes = await readBytes(file, MAX_OOXML_BYTES);
  if (file.size > MAX_OOXML_BYTES) {
    throw new Error('OOXML package exceeds the 64 MB inspection limit');
  }
  return JSZip.loadAsync(bytes);
}

function zipEntries(zip: JSZip): string[] {
  return Object.keys(zip.files);
}

async function readZipText(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(path);
  if (!entry) {
    return '';
  }
  return entry.async('string');
}

function parseCoreMetadata(xml: string): Record<string, string> {
  if (!xml.trim()) return {};
  const parsed = parseXml(xml) as Record<string, unknown>;
  const root = parsed['cp:coreProperties'] || parsed['coreProperties'] || parsed;
  const result: Record<string, string> = {};
  for (const key of ['dc:title', 'dc:creator', 'cp:lastModifiedBy', 'dcterms:created', 'dcterms:modified', 'dc:subject', 'dc:description']) {
    const value = (root as Record<string, unknown>)[key];
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

export async function analyzeDocxFile(file: InspectionFile, options: { signal: AbortSignal }): Promise<AnalysisResult> {
  ensureNotAborted(options.signal);
  const zip = await loadZip(file);
  const fingerprint = await digestHex(await readBytes(file, 1024 * 1024));
  const documentXml = await readZipText(zip, 'word/document.xml');
  const relsXml = await readZipText(zip, 'word/_rels/document.xml.rels');
  const commentsXml = await readZipText(zip, 'word/comments.xml');
  const coreXml = await readZipText(zip, 'docProps/core.xml');
  const document = documentXml ? parseXml(documentXml) : {};
  const text = collectXmlTexts(document).filter(Boolean);
  const headingStyles = [...documentXml.matchAll(/<w:pStyle\s+[^>]*w:val="(Heading[1-9])"/gi)].map((match) => match[1]);
  const headings = headingStyles.slice(0, 20);
  const tables = (documentXml.match(/<w:tbl\b/g) ?? []).length;
  const hyperlinks = [...relsXml.matchAll(/Type="[^"]*hyperlink"[^>]*Target="([^"]+)"/g)].map((m) => m[1]);
  const images = zipEntries(zip).filter((name) => !zip.files[name]?.dir && /^word\/media\//i.test(name));
  const comments = commentsXml ? (commentsXml.match(/<w:comment\b/g) ?? []).length : 0;
  const hiddenContent = /w:vanish|w:hidden/i.test(documentXml);
  const paragraphCount = (documentXml.match(/<w:p\b/g) ?? []).length;
  const emptyParagraphs = Math.max(0, paragraphCount - text.length);
  const repeatedBlocks = new Map<string, number>();
  for (const block of text) {
    repeatedBlocks.set(block, (repeatedBlocks.get(block) ?? 0) + 1);
  }
  const repeatedContent = [...repeatedBlocks.entries()].filter(([, count]) => count > 1);
  const headingCounts = {
    h1: (documentXml.match(/<w:pStyle\s+[^>]*w:val="Heading1"/gi) ?? []).length,
    h2: (documentXml.match(/<w:pStyle\s+[^>]*w:val="Heading2"/gi) ?? []).length,
    h3: (documentXml.match(/<w:pStyle\s+[^>]*w:val="Heading3"/gi) ?? []).length
  };
  const meta = parseCoreMetadata(coreXml);
  const evidenceList = [
    evidence('docx-paragraphs', 'Text blocks', formatNumber(text.length)),
    evidence('docx-headings', 'Headings', formatNumber(headings.length)),
    evidence('docx-tables', 'Tables', formatNumber(tables)),
    evidence('docx-images', 'Images', formatNumber(images.length)),
    evidence('docx-comments', 'Comments', formatNumber(comments)),
    evidence('docx-hidden', 'Hidden content', hiddenContent ? 'Present' : 'Not detected')
  ];
  if (meta['dc:title']) evidenceList.push(evidence('docx-title', 'Title', meta['dc:title']));
  if (meta['dc:creator']) evidenceList.push(evidence('docx-author', 'Author', meta['dc:creator']));
  const sections: AnalysisSection[] = [
    { id: 'docx-facts', title: 'Facts', items: evidenceList.slice(0, 6) },
    { id: 'docx-structure', title: 'Structure', items: headings.length ? headings.map((value, index) => evidence(`docx-heading-${index}`, `Heading style ${index + 1}`, value)) : [evidence('docx-headings-none', 'Headings', 'No headings detected')] },
    { id: 'docx-links', title: 'Relationships', items: hyperlinks.length ? hyperlinks.map((value, index) => evidence(`docx-link-${index}`, `Link ${index + 1}`, value)) : [evidence('docx-links-none', 'Links', 'No hyperlinks detected')] }
  ];
  evidenceList.push(
    evidence('docx-empty-paragraphs', 'Empty paragraphs', formatNumber(emptyParagraphs)),
    evidence('docx-heading-hierarchy', 'Heading hierarchy', `H1: ${headingCounts.h1}, H2: ${headingCounts.h2}, H3: ${headingCounts.h3}`)
  );
  if (repeatedContent.length) {
    evidenceList.push(evidence('docx-repeated-content', 'Repeated content', `"${repeatedContent[0][0].slice(0, 60)}" appears ${repeatedContent[0][1]} times`));
  }
  sections.push({
    id: 'docx-deep',
    title: 'Deep analysis',
    items: [
      evidence('docx-empty-paragraphs', 'Empty paragraphs', formatNumber(emptyParagraphs)),
      evidence('docx-heading-hierarchy', 'Heading hierarchy', `H1: ${headingCounts.h1}, H2: ${headingCounts.h2}, H3: ${headingCounts.h3}`),
      repeatedContent.length
        ? evidence('docx-repeated-content', 'Repeated content', `"${repeatedContent[0][0].slice(0, 60)}" appears ${repeatedContent[0][1]} times`)
        : evidence('docx-repeated-none', 'Repeated content', 'None detected')
    ]
  });
  const unusual: Finding[] = [];
  if (hiddenContent) unusual.push(finding('docx-hidden', 'Hidden content present', 'The document contains hidden text or formatting.', 'low', ['docx-hidden']));
  if (comments > 0) unusual.push(finding('docx-comments-present', 'Comments present', 'The document includes author comments or notes.', 'info', ['docx-comments']));
  if (paragraphCount > 0 && emptyParagraphs / paragraphCount > 0.3) {
    unusual.push({
      id: 'docx-empty-paragraphs',
      title: 'Many empty paragraphs',
      summary: `${formatNumber(emptyParagraphs)} of ${formatNumber(paragraphCount)} paragraphs contain no visible text.`,
      severity: 'low',
      evidence: ['docx-empty-paragraphs', 'docx-paragraphs'],
      methodology: 'heuristic',
      confidence: 'medium',
      category: 'structure'
    });
  }
  if (repeatedContent.length) {
    unusual.push({
      id: 'docx-repeated-content',
      title: 'Repeated content',
      summary: `"${repeatedContent[0][0].slice(0, 60)}" appears ${repeatedContent[0][1]} times.`,
      severity: 'low',
      evidence: ['docx-repeated-content', 'docx-paragraphs'],
      methodology: 'heuristic',
      confidence: 'medium',
      category: 'structure'
    });
  }
  return buildResult(file, 'docx', 'DOCX analyzer', 'DOCX', fingerprint, ['metadata', 'text', 'headings', 'tables', 'images', 'links', 'comments'], sections, evidenceList, [], unusual, [], ['Read-only OOXML inspection'], `${formatNumber(text.length)} text blocks, ${formatNumber(tables)} tables`);
}

export async function analyzePptxFile(file: InspectionFile, options: { signal: AbortSignal }): Promise<AnalysisResult> {
  ensureNotAborted(options.signal);
  const zip = await loadZip(file);
  const fingerprint = await digestHex(await readBytes(file, 1024 * 1024));
  const presXml = await readZipText(zip, 'ppt/presentation.xml');
  const coreXml = await readZipText(zip, 'docProps/core.xml');
  const slideFiles = zipEntries(zip).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name));
  const slideTexts = await Promise.all(slideFiles.map(async (slide) => collectXmlTexts(parseXml(await readZipText(zip, slide)))));
  const slideTitles = slideTexts.map((texts) => texts.find((value) => value.length > 0)?.slice(0, 120) ?? '').filter(Boolean);
  const emptySlides = slideTexts.filter((texts) => texts.length === 0).length;
  const notes = zipEntries(zip).filter((name) => !zip.files[name]?.dir && /^ppt\/notesSlides\//i.test(name)).length;
  const images = zipEntries(zip).filter((name) => !zip.files[name]?.dir && /^ppt\/media\//i.test(name)).length;
  const links = [...(presXml.match(/http[s]?:\/\/[^"' <]+/g) ?? [])];
  const meta = parseCoreMetadata(coreXml);
  const evidenceList = [
    evidence('pptx-slides', 'Slides', formatNumber(slideFiles.length)),
    evidence('pptx-titles', 'Titles', formatNumber(slideTitles.length)),
    evidence('pptx-empty', 'Empty slides', formatNumber(emptySlides)),
    evidence('pptx-notes', 'Notes', formatNumber(notes)),
    evidence('pptx-images', 'Images', formatNumber(images))
  ];
  if (meta['dc:title']) evidenceList.push(evidence('pptx-title-meta', 'Title', meta['dc:title']));
  if (meta['dc:creator']) evidenceList.push(evidence('pptx-author', 'Author', meta['dc:creator']));
  const sections: AnalysisSection[] = [
    { id: 'pptx-facts', title: 'Facts', items: evidenceList },
    { id: 'pptx-structure', title: 'Structure', items: slideTitles.length ? slideTitles.map((value, index) => evidence(`pptx-title-${index}`, `Slide ${index + 1}`, value)) : [evidence('pptx-titles-none', 'Slide titles', 'No slide titles detected')] },
    { id: 'pptx-links', title: 'Relationships', items: links.length ? links.map((value, index) => evidence(`pptx-link-${index}`, `Link ${index + 1}`, value)) : [evidence('pptx-links-none', 'Links', 'No links detected')] }
  ];
  const totalTextBlocks = slideTexts.reduce((acc, texts) => acc + texts.length, 0);
  const slideDensity = slideFiles.length ? totalTextBlocks / slideFiles.length : 0;
  const titleCounts = new Map<string, number>();
  for (const title of slideTitles) {
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }
  const repeatedTitles = [...titleCounts.entries()].filter(([, count]) => count > 1);
  const busiestSlide = slideTexts.reduce((best, texts, index) => (texts.length > (best?.texts.length ?? 0) ? { texts, index } : best), null as { texts: string[]; index: number } | null);
  evidenceList.push(
    evidence('pptx-slide-density', 'Text blocks per slide', slideDensity.toFixed(2)),
    evidence('pptx-total-text', 'Total text blocks', formatNumber(totalTextBlocks))
  );
  if (repeatedTitles.length) {
    evidenceList.push(evidence('pptx-repeated-title', 'Repeated slide title', `"${repeatedTitles[0][0]}" appears ${repeatedTitles[0][1]} times`));
  }
  sections.push({
    id: 'pptx-deep',
    title: 'Deep analysis',
    items: [
      evidence('pptx-slide-density', 'Text blocks per slide', slideDensity.toFixed(2)),
      evidence('pptx-total-text', 'Total text blocks', formatNumber(totalTextBlocks)),
      repeatedTitles.length
        ? evidence('pptx-repeated-title', 'Repeated slide title', `"${repeatedTitles[0][0]}" appears ${repeatedTitles[0][1]} times`)
        : evidence('pptx-repeated-none', 'Repeated slide title', 'None detected')
    ]
  });
  const unusual: Finding[] = [];
  if (emptySlides > 0) unusual.push(finding('pptx-empty-slides', 'Empty slides detected', 'One or more slides contain no visible text.', 'low', ['pptx-empty']));
  if (repeatedTitles.length) {
    unusual.push({
      id: 'pptx-repeated-title',
      title: 'Repeated slide title',
      summary: `"${repeatedTitles[0][0]}" appears on ${repeatedTitles[0][1]} slides.`,
      severity: 'low',
      evidence: ['pptx-repeated-title', 'pptx-titles'],
      methodology: 'heuristic',
      confidence: 'medium',
      category: 'structure'
    });
  }
  if (busiestSlide && slideFiles.length >= 4 && busiestSlide.texts.length > slideDensity * 3) {
    unusual.push({
      id: 'pptx-text-heavy-slide',
      title: 'Text-heavy slide',
      summary: `Slide ${busiestSlide.index + 1} contains ${busiestSlide.texts.length} text blocks - about ${(busiestSlide.texts.length / Math.max(slideDensity, 0.1)).toFixed(1)}x the average.`,
      severity: 'low',
      evidence: ['pptx-slide-density', 'pptx-total-text'],
      methodology: 'anomaly',
      confidence: 'medium',
      category: 'statistics'
    });
  }
  return buildResult(file, 'pptx', 'PPTX analyzer', 'PPTX', fingerprint, ['metadata', 'slides', 'text', 'notes', 'images', 'links'], sections, evidenceList, [], unusual, [], ['Read-only OOXML presentation inspection'], `${formatNumber(slideFiles.length)} slides`);
}

export async function analyzeXlsxFile(file: InspectionFile, options: { signal: AbortSignal }): Promise<AnalysisResult> {
  ensureNotAborted(options.signal);
  const zip = await loadZip(file);
  const fingerprint = await digestHex(await readBytes(file, 1024 * 1024));
  const workbookXml = await readZipText(zip, 'xl/workbook.xml');
  const sharedStringsXml = await readZipText(zip, 'xl/sharedStrings.xml');
  const coreXml = await readZipText(zip, 'docProps/core.xml');
  const workbook = workbookXml ? parseXml(workbookXml) as Record<string, any> : {};
  const sharedStrings = sharedStringsXml ? (parseXml(sharedStringsXml) as Record<string, any>) : {};
  const strings: string[] = [];
  const sst = sharedStrings['sst'] ?? sharedStrings['x:sst'] ?? sharedStrings['a:sst'] ?? sharedStrings;
  const si = sst?.si;
  if (Array.isArray(si)) {
    for (const entry of si) strings.push(collectXmlTexts(entry).join(' ').trim());
  } else if (si) {
    strings.push(collectXmlTexts(si).join(' ').trim());
  }
  const sheets = workbook?.workbook?.sheets?.sheet ? (Array.isArray(workbook.workbook.sheets.sheet) ? workbook.workbook.sheets.sheet : [workbook.workbook.sheets.sheet]) : [];
  const sheetNames = sheets.map((sheet: any) => sheet['@_name'] || sheet.name || 'Sheet');
  const hiddenSheets = sheets.filter((sheet: any) => String(sheet['@_state'] || sheet.state || '') !== '' && String(sheet['@_state'] || sheet.state) !== 'visible').length;
  const definedNames = workbook?.workbook?.definedNames?.definedName ? (Array.isArray(workbook.workbook.definedNames.definedName) ? workbook.workbook.definedNames.definedName : [workbook.workbook.definedNames.definedName]) : [];
  const externalLinks = Object.keys(zip.files).filter((name) => !zip.files[name]?.dir && /^xl\/externalLinks\//i.test(name));
  const sheetFiles = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name));
  let totalRows = 0;
  let totalCols = 0;
  let formulas = 0;
  let mergedCells = 0;
  let hiddenRows = 0;
  let hiddenCols = 0;
  let errors = 0;
  const numericValues: number[] = [];
  const rowSignatures = new Map<string, { count: number; sheet: string; example: string }>();
  const sheetColumnValues = new Map<string, string[][]>();
  const sheetFormulaFunctions = new Map<string, string[]>();
  for (const sheet of sheetFiles) {
    ensureNotAborted(options.signal);
    const xml = await readZipText(zip, sheet);
    const parsed = parseXml(xml) as Record<string, any>;
    const worksheet = parsed.worksheet ?? parsed['x:worksheet'] ?? parsed;
    const dimension = worksheet?.dimension?.['@_ref'] || worksheet?.dimension?.ref || '';
    if (dimension && /:/.test(dimension)) {
      const end = dimension.split(':')[1];
      const col = end.replace(/\d+/g, '');
      const row = Number(end.replace(/\D+/g, ''));
      totalCols = Math.max(totalCols, col.split('').reduce((acc: number, ch: string) => acc * 26 + (ch.charCodeAt(0) - 64), 0));
      totalRows = Math.max(totalRows, row);
    }
    const rows = worksheet?.sheetData?.row ? (Array.isArray(worksheet.sheetData.row) ? worksheet.sheetData.row : [worksheet.sheetData.row]) : [];
    totalRows += rows.length;
    for (const row of rows) {
      if (String(row['@_hidden'] || row.hidden) === '1') hiddenRows += 1;
      const cells = row.c ? (Array.isArray(row.c) ? row.c : [row.c]) : [];
      totalCols = Math.max(totalCols, cells.length);
      for (const cell of cells) {
        if (cell.f) formulas += 1;
        if (String(cell['@_t'] || cell.t) === 'e') errors += 1;
        const cellValue = safeNumber(Array.isArray(cell.v) ? cell.v[0] : cell.v);
        if (cellValue !== null) numericValues.push(cellValue);
      }
      cells.forEach((cell: any, cellIndex: number) => {
        const ref = String(cell['@_r'] || cell.r || '');
        const colIndex = ref ? columnIndexFromRef(ref) : cellIndex;
        if (colIndex < 0) return;
        const columns = sheetColumnValues.get(sheet) ?? [];
        const list = columns[colIndex] ?? (columns[colIndex] = []);
        const raw = cell.v ?? cell.is ?? '';
        list.push(typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '');
        sheetColumnValues.set(sheet, columns);
        if (cell.f) {
          const name = formulaFunctionName(String(cell.f));
          if (name) {
            const names = sheetFormulaFunctions.get(sheet) ?? [];
            names.push(name);
            sheetFormulaFunctions.set(sheet, names);
          }
        }
      });
      const rowValues = cells.map((cell: any) => String(cell.v ?? cell.is ?? '')).join('\u0001');
      if (rowValues.trim().length) {
        const key = `${sheet}|\u0001${rowValues}`;
        const entry = rowSignatures.get(key) ?? { count: 0, sheet, example: rowValues.replace(/\u0001/g, ', ') };
        entry.count += 1;
        rowSignatures.set(key, entry);
      }
    }
    mergedCells += worksheet?.mergeCells?.mergeCell ? (Array.isArray(worksheet.mergeCells.mergeCell) ? worksheet.mergeCells.mergeCell.length : 1) : 0;
    const cols = worksheet?.cols?.col ? (Array.isArray(worksheet.cols.col) ? worksheet.cols.col : [worksheet.cols.col]) : [];
    hiddenCols += cols.filter((col: any) => String(col['@_hidden'] || col.hidden) === '1').length;
  }
  const duplicateGroups = [...rowSignatures.values()].filter((entry) => entry.count > 1);
  const duplicateRowCount = duplicateGroups.reduce((acc, entry) => acc + entry.count - 1, 0);
  const stats = numericValues.length ? [
    evidence('xlsx-min', 'Min', String(Math.min(...numericValues))),
    evidence('xlsx-max', 'Max', String(Math.max(...numericValues))),
    evidence('xlsx-mean', 'Mean', mean(numericValues).toFixed(3)),
    evidence('xlsx-median', 'Median', median(numericValues).toFixed(3)),
    evidence('xlsx-stdev', 'Stdev', stddev(numericValues).toFixed(3))
  ] : [evidence('xlsx-stats-none', 'Statistics', 'No numeric cells sampled')];
  const evidenceList = [
    evidence('xlsx-sheets', 'Worksheets', formatNumber(sheetNames.length)),
    evidence('xlsx-hidden-sheets', 'Hidden sheets', formatNumber(hiddenSheets)),
    evidence('xlsx-formulas', 'Formulas', formatNumber(formulas)),
    evidence('xlsx-merged', 'Merged cells', formatNumber(mergedCells)),
    evidence('xlsx-external', 'External links', formatNumber(externalLinks.length)),
    evidence('xlsx-errors', 'Errors', formatNumber(errors)),
    evidence('xlsx-hidden-rows', 'Hidden rows', formatNumber(hiddenRows)),
    evidence('xlsx-hidden-cols', 'Hidden columns', formatNumber(hiddenCols)),
    evidence('xlsx-defined-names', 'Named ranges', formatNumber(definedNames.length))
  ];
  if (duplicateRowCount > 0) {
    const example = duplicateGroups[0];
    evidenceList.push(evidence('xlsx-duplicate-rows', 'Duplicate rows', `${formatNumber(duplicateRowCount)} in ${example.sheet} (e.g. "${example.example.slice(0, 80)}")`));
  }
  const constantColumns: Array<{ sheet: string; name: string; ratio: number; value: string }> = [];
  const emptyColumns: Array<{ sheet: string; name: string }> = [];
  for (const [sheet, columns] of sheetColumnValues) {
    columns.forEach((values, index) => {
      const nonEmpty = values.filter((value) => value.trim().length > 0);
      if (!nonEmpty.length) {
        emptyColumns.push({ sheet, name: `Column ${index + 1}` });
        return;
      }
      const counts = new Map<string, number>();
      for (const value of nonEmpty) counts.set(value, (counts.get(value) ?? 0) + 1);
      const top = Math.max(...counts.values());
      const ratio = top / nonEmpty.length;
      if (ratio > 0.95 && nonEmpty.length >= 3) {
        constantColumns.push({ sheet, name: `Column ${index + 1}`, ratio, value: [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0] });
      }
    });
  }
  const formulaSummary = [...sheetFormulaFunctions.entries()].map(([sheet, names]) => {
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    return `${sheet}: ${[...counts.entries()].map(([name, count]) => `${name} ${count}`).join(', ')}`;
  });
  if (constantColumns.length) {
    evidenceList.push(evidence('xlsx-constant-columns', 'Constant columns', formatNumber(constantColumns.length)));
    constantColumns.slice(0, 5).forEach((column, index) => {
      evidenceList.push(evidence(`xlsx-constant-${index}`, `Constant column ${index + 1}`, `${column.name} in ${column.sheet}: "${column.value.slice(0, 40)}" in ${percent(column.ratio)} of rows`));
    });
  }
  if (emptyColumns.length) {
    evidenceList.push(evidence('xlsx-empty-columns', 'Empty columns', formatNumber(emptyColumns.length)));
  }
  if (formulaSummary.length) {
    evidenceList.push(evidence('xlsx-formula-patterns', 'Formula patterns', formulaSummary.join(' | ').slice(0, 200)));
  }
  const sections: AnalysisSection[] = [
    { id: 'xlsx-facts', title: 'Facts', items: evidenceList },
    { id: 'xlsx-structure', title: 'Structure', items: sheetNames.length ? sheetNames.map((value: string, index: number) => evidence(`xlsx-sheet-${index}`, `Sheet ${index + 1}`, value)) : [evidence('xlsx-sheets-none', 'Sheets', 'No worksheet names detected')] },
    { id: 'xlsx-stats', title: 'Statistics', items: stats }
  ];
  sections.push({
    id: 'xlsx-deep',
    title: 'Deep analysis',
    items: [
      evidence('xlsx-constant-columns', 'Constant columns', formatNumber(constantColumns.length)),
      evidence('xlsx-empty-columns', 'Empty columns', formatNumber(emptyColumns.length)),
      ...constantColumns.slice(0, 5).map((column, index) => evidence(`xlsx-constant-${index}`, `Constant column ${index + 1}`, `${column.name} in ${column.sheet}: "${column.value.slice(0, 40)}" in ${percent(column.ratio)} of rows`)),
      formulaSummary.length ? evidence('xlsx-formula-patterns', 'Formula patterns', formulaSummary.join(' | ').slice(0, 200)) : evidence('xlsx-formula-none', 'Formula patterns', 'No formulas detected')
    ]
  });
  const unusual: Finding[] = [];
  if (hiddenSheets > 0) unusual.push(finding('xlsx-hidden-sheets', 'Hidden worksheets', 'One or more worksheets are hidden.', 'low', ['xlsx-hidden-sheets']));
  if (externalLinks.length > 0) unusual.push(finding('xlsx-external-links', 'External links present', 'The workbook references external links.', 'medium', ['xlsx-external']));
  if (errors > 0) unusual.push(finding('xlsx-errors', 'Cell errors present', 'At least one cell contains an error value.', 'medium', ['xlsx-errors']));
  if (duplicateRowCount > 0) {
    unusual.push(finding('xlsx-duplicate-rows', 'Duplicate rows in a worksheet', `${formatNumber(duplicateRowCount)} rows repeat exactly within a worksheet.`, 'medium', ['xlsx-duplicate-rows']));
  }
  if (constantColumns.length) {
    const column = constantColumns[0];
    unusual.push({
      id: 'xlsx-constant-column',
      title: 'Constant column',
      summary: `${column.name} in ${column.sheet} holds a single value ("${column.value.slice(0, 40)}") in ${percent(column.ratio)} of rows.`,
      severity: 'low',
      evidence: ['xlsx-constant-columns', 'xlsx-constant-0'],
      methodology: 'anomaly',
      confidence: 'high',
      category: 'statistics'
    });
  }
  if (emptyColumns.length) {
    unusual.push({
      id: 'xlsx-empty-column',
      title: 'Empty column',
      summary: `${formatNumber(emptyColumns.length)} column(s) contain no data.`,
      severity: 'low',
      evidence: ['xlsx-empty-columns'],
      methodology: 'heuristic',
      confidence: 'medium',
      category: 'structure'
    });
  }
  for (const [sheet, names] of sheetFormulaFunctions) {
    const unique = new Set(names);
    if (unique.size > 1) {
      unusual.push({
        id: 'xlsx-mixed-formulas',
        title: 'Mixed formula types',
        summary: `${sheet} mixes ${[...unique].join(', ')} formulas.`,
        severity: 'low',
        evidence: ['xlsx-formula-patterns', 'xlsx-formulas'],
        methodology: 'heuristic',
        confidence: 'medium',
        category: 'structure'
      });
      break;
    }
  }
  const meta = parseCoreMetadata(coreXml);
  if (meta['dc:title']) evidenceList.push(evidence('xlsx-title', 'Title', meta['dc:title']));
  return buildResult(file, 'xlsx', 'Spreadsheet analyzer', 'XLSX', fingerprint, ['metadata', 'worksheets', 'formulas', 'merged-cells', 'hidden-sheets', 'statistics', 'relationships'], sections, evidenceList, [], unusual, [], ['Read-only spreadsheet inspection'], `${formatNumber(sheetNames.length)} sheets`);
}

function columnIndexFromRef(ref: string): number {
  const letters = ref.replace(/[^A-Za-z]/g, '');
  if (!letters) return -1;
  return [...letters.toUpperCase()].reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
}

function formulaFunctionName(formula: string): string | null {
  const cleaned = formula.trim().replace(/^=/, '');
  const match = cleaned.match(/^([A-Za-z][A-Za-z0-9_.]*)\s*\(/);
  return match ? match[1].toUpperCase() : null;
}

async function analyzeLegacyXls(file: InspectionFile): Promise<AnalysisResult> {
  const fingerprint = await digestHex(await readBytes(file, 1024 * 1024));
  const summary = 'Legacy binary XLS is not parsed; convert the workbook to XLSX for structural inspection';
  const evidenceList: Evidence[] = [evidence('xls-legacy', 'Format', summary)];
  return buildResult(
    file,
    'xls',
    'Legacy spreadsheet detector',
    'XLS',
    fingerprint,
    ['format-detection'],
    [{ id: 'xls-facts', title: 'Facts', items: evidenceList }],
    evidenceList,
    [],
    [],
    [],
    ['Binary OLE2 XLS parsing is not implemented; no write or conversion is performed'],
    'Legacy XLS workbook (not parsed)'
  );
}

export async function analyzeDocumentFile(file: InspectionFile, options: { signal: AbortSignal }): Promise<AnalysisResult | null> {
  const ext = extension(file.name);
  if (ext === 'pdf') return analyzePdfFile(file, options);
  if (ext === 'docx') return analyzeDocxFile(file, options);
  if (ext === 'pptx') return analyzePptxFile(file, options);
  if (ext === 'xlsx') return analyzeXlsxFile(file, options);
  if (ext === 'xls') return analyzeLegacyXls(file);
  return null;
}
