// Email (.eml) analyzer — fully local, read-only RFC 822 parsing.
//
// Extracts headers (From/To/Subject/Date/Message-ID), decodes MIME encoded
// words, walks multipart bodies, counts text/HTML parts and attachments,
// extracts hyperlinks from HTML parts, and reports lightweight security
// signals (DKIM/SPF presence) without ever executing content.
import type { AnalysisResult, AnalysisSection, Evidence, Finding, InspectionFile } from './types.ts';
import { digestHex, formatNumber, shortFingerprint } from './utils.ts';
import { ensureNotAborted, evidence, extractLinksFromHtml, finding, readBytes, stripTags, tokenizeWords } from './analysis-utils.ts';

const MAX_EMAIL_BYTES = 16 * 1024 * 1024;

function identity(file: InspectionFile, format: string, fingerprint: string) {
  return {
    name: file.name,
    type: 'email',
    format,
    mimeType: file.mimeType,
    size: file.size,
    location: file.path,
    created: new Date(file.lastModified).toLocaleString(),
    modified: new Date(file.lastModified).toLocaleString(),
    fingerprint: shortFingerprint(fingerprint)
  };
}

interface EmailPart {
  contentType: string;
  disposition: string;
  filename: string | null;
  kind: 'text' | 'html' | 'attachment' | 'inline';
  content: string;
}

interface ParsedEmail {
  headers: Map<string, string[]>;
  parts: EmailPart[];
  bodyStart: number;
}

function parseHeadersAndBody(source: string): ParsedEmail {
  const headers = new Map<string, string[]>();
  const lines = source.split(/\r?\n/);
  let current: string | null = null;
  let index = 0;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      break;
    }
    if (/^[ \t]/.test(line) && current) {
      const list = headers.get(current) ?? [];
      if (list.length) {
        list[list.length - 1] += ` ${line.trim()}`;
        headers.set(current, list);
      }
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    current = name;
    const list = headers.get(name) ?? [];
    list.push(value);
    headers.set(name, list);
  }
  const body = source.slice(index);
  const parts = splitParts(body, headers.get('content-type')?.[0]);
  return { headers, parts, bodyStart: index };
}

/** Decode RFC 2047 encoded words: =?charset?B|Q?text?= */
export function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_match, charset: string, encoding: string, text: string) => {
    try {
      if (encoding.toLowerCase() === 'b') {
        const clean = text.replace(/\s+/g, '');
        const bytes = Uint8Array.from(atob(clean), (char) => char.charCodeAt(0));
        return new TextDecoder(charset || 'utf-8', { fatal: false }).decode(bytes);
      }
      const decoded = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_h, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i) & 0xff;
      return new TextDecoder(charset || 'utf-8', { fatal: false }).decode(bytes);
    } catch {
      return text;
    }
  });
}

function splitParts(body: string, contentType: string | undefined): EmailPart[] {
  const boundaryMatch = contentType?.match(/boundary\s*=\s*"([^"]+)"|boundary\s*=\s*([^;\s]+)/i);
  if (!boundaryMatch) {
    const isHtml = /text\/html/i.test(contentType ?? '');
    return [{ contentType: contentType ?? 'text/plain', disposition: '', filename: null, kind: isHtml ? 'html' : 'text', content: body }];
  }
  const boundary = boundaryMatch[1] ?? boundaryMatch[2];
  const parts: EmailPart[] = [];
  for (const raw of body.split(`--${boundary}`)) {
    const trimmed = raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    if (!trimmed || trimmed.startsWith('--')) continue;
    const parsed = parseHeadersAndBody(trimmed);
    const partContentType = parsed.headers.get('content-type')?.[0] ?? 'text/plain';
    const disposition = parsed.headers.get('content-disposition')?.[0] ?? '';
    const filename =
      partContentType.match(/name\s*=\s*"([^"]+)"/i)?.[1] ??
      disposition.match(/filename\s*=\s*"([^"]+)"/i)?.[1] ??
      null;
    let kind: EmailPart['kind'] = 'text';
    if (filename || /attachment/i.test(disposition)) kind = 'attachment';
    else if (/inline/i.test(disposition) && /^image\//i.test(partContentType)) kind = 'inline';
    else if (/text\/html/i.test(partContentType)) kind = 'html';
    parts.push({ contentType: partContentType, disposition, filename, kind, content: parsed.parts[0]?.content ?? '' });
  }
  return parts;
}

function first(headers: Map<string, string[]>, name: string): string | undefined {
  return headers.get(name)?.[0];
}

export async function analyzeEmailFile(file: InspectionFile, options: { signal: AbortSignal }): Promise<AnalysisResult | null> {
  ensureNotAborted(options.signal);
  if (!/\.eml$/i.test(file.name)) return null;
  const bytes = await readBytes(file, MAX_EMAIL_BYTES);
  const fingerprint = await digestHex(bytes);
  const source = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const parsed = parseHeadersAndBody(source);
  const headers = parsed.headers;
  const subject = decodeEncodedWords(first(headers, 'subject') ?? '');
  const from = decodeEncodedWords(first(headers, 'from') ?? '');
  const to = decodeEncodedWords(first(headers, 'to') ?? '');
  const cc = decodeEncodedWords(first(headers, 'cc') ?? '');
  const date = first(headers, 'date') ?? '';
  const messageId = first(headers, 'message-id') ?? '';
  const replyTo = decodeEncodedWords(first(headers, 'reply-to') ?? '');
  const returnPath = first(headers, 'return-path') ?? '';
  const dkim = first(headers, 'dkim-signature');
  const spf = first(headers, 'received-spf');
  const authResults = first(headers, 'authentication-results');
  const xMailer = first(headers, 'x-mailer') ?? '';

  const textParts = parsed.parts.filter((part) => part.kind === 'text');
  const htmlParts = parsed.parts.filter((part) => part.kind === 'html');
  const attachments = parsed.parts.filter((part) => part.kind === 'attachment');
  const inlineImages = parsed.parts.filter((part) => part.kind === 'inline');
  const links = new Set<string>();
  const bodyTexts: string[] = [];
  for (const part of parsed.parts) {
    if (part.kind === 'html') {
      bodyTexts.push(stripTags(part.content));
      for (const link of extractLinksFromHtml(part.content)) links.add(link);
    } else if (part.kind === 'text') {
      bodyTexts.push(part.content);
    }
  }
  const bodyText = bodyTexts.join('\n').replace(/\s+/g, ' ').trim();
  const wordCount = tokenizeWords(bodyText).length;
  const lines = source.split(/\r?\n|\r/).length;

  const evidenceList: Evidence[] = [
    evidence('email-from', 'From', from || 'Not present'),
    evidence('email-to', 'To', to || 'Not present'),
    evidence('email-subject', 'Subject', subject || 'Not present'),
    evidence('email-date', 'Date', date || 'Not present'),
    evidence('email-message-id', 'Message-ID', messageId || 'Not present'),
    evidence('email-body-words', 'Body words', formatNumber(wordCount)),
    evidence('email-lines', 'Lines', formatNumber(lines)),
    evidence('email-text-parts', 'Text parts', formatNumber(textParts.length)),
    evidence('email-html-parts', 'HTML parts', formatNumber(htmlParts.length)),
    evidence('email-attachments', 'Attachments', formatNumber(attachments.length)),
    evidence('email-inline-images', 'Inline images', formatNumber(inlineImages.length)),
    evidence('email-links', 'Links', formatNumber(links.size)),
    evidence('email-dkim', 'DKIM signature', dkim ? 'Present' : 'Not present'),
    evidence('email-spf', 'SPF record', spf ? 'Present' : 'Not present')
  ];
  if (cc) evidenceList.push(evidence('email-cc', 'Cc', cc));
  if (replyTo) evidenceList.push(evidence('email-reply-to', 'Reply-To', replyTo));
  if (returnPath) evidenceList.push(evidence('email-return-path', 'Return-Path', returnPath));
  if (xMailer) evidenceList.push(evidence('email-mailer', 'Mailer', xMailer));
  if (authResults) evidenceList.push(evidence('email-auth-results', 'Authentication results', authResults.slice(0, 200)));
  if (bodyText) evidenceList.push(evidence('email-body-preview', 'Body preview', bodyText.slice(0, 300)));

  const sections: AnalysisSection[] = [
    { id: 'email-facts', title: 'Facts', items: evidenceList },
    { id: 'email-headers', title: 'Structure', items: evidenceList.slice(0, 14) },
    {
      id: 'email-attachments',
      title: 'Attachments',
      items: attachments.length
        ? attachments.slice(0, 10).map((part, index) => evidence(`email-attachment-${index}`, `Attachment ${index + 1}`, part.filename || part.contentType))
        : [evidence('email-no-attachments', 'Attachments', 'None')]
    },
    {
      id: 'email-links',
      title: 'Links',
      items: links.size
        ? [...links].slice(0, 10).map((value, index) => evidence(`email-link-${index}`, `Link ${index + 1}`, value))
        : [evidence('email-no-links', 'Links', 'No links detected')]
    }
  ];

  const unusual: Finding[] = [];
  if (!from) unusual.push(finding('email-no-from', 'Missing sender', 'The message has no From header, which is unusual for a normal email.', 'high', ['email-from']));
  if (!subject) unusual.push(finding('email-no-subject', 'Missing subject', 'The message has no Subject header.', 'low', ['email-subject']));
  if (replyTo && from && replyTo !== from && !from.includes(replyTo) && !replyTo.includes(from)) {
    unusual.push({
      id: 'email-reply-mismatch',
      title: 'Reply-To differs from sender',
      summary: 'The Reply-To address does not match the From address; verify the sender before replying.',
      severity: 'low',
      evidence: ['email-reply-to', 'email-from'],
      methodology: 'heuristic',
      confidence: 'medium',
      category: 'relationships'
    });
  }
  const fromCount = headers.get('from')?.length ?? 0;
  if (fromCount > 1) unusual.push(finding('email-multiple-from', 'Multiple From headers', 'The message contains more than one From header.', 'low', ['email-from']));
  if (!dkim && !spf) {
    unusual.push({
      id: 'email-no-auth',
      title: 'No authentication headers',
      summary: 'Neither DKIM nor SPF headers are present; the message may lack sender authentication.',
      severity: 'info',
      evidence: ['email-dkim', 'email-spf'],
      methodology: 'heuristic',
      confidence: 'medium',
      category: 'metadata'
    });
  }

  const recommendations: Finding[] = [];
  if (attachments.length) {
    recommendations.push(finding('email-attachments-reco', 'Review attachments', 'Inspect attachments before opening them, especially from unexpected senders.', 'low', ['email-attachments']));
  }
  if (links.size) {
    recommendations.push(finding('email-links-reco', 'Verify links', 'Hover links before clicking; phishing emails often hide destinations behind text.', 'low', ['email-links']));
  }

  return {
    objectKind: 'file',
    analyzerId: 'email',
    analyzerName: 'Email analyzer',
    capabilities: ['headers', 'mime', 'attachments', 'links', 'security-signals'],
    limitations: ['Header and MIME structure only; no network lookups and no content execution'],
    targetName: file.name,
    identity: identity(file, 'EML', fingerprint),
    sections,
    important: [],
    unusual,
    recommendations,
    evidence: evidenceList,
    progressLabel: 'Email analysis complete',
    cacheKey: fingerprint,
    generatedAt: new Date().toISOString(),
    sourceSummary: subject ? `"${subject.slice(0, 60)}"` : `${formatNumber(attachments.length)} attachments`
  };
}
