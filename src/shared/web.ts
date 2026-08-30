import type { AnalysisResult, AnalysisSection, Evidence, Finding, InspectionUrl } from './types.ts';
import { digestHex, formatNumber, shortFingerprint } from './utils.ts';
import {
  evidence,
  ensureNotAborted,
  extractHeadingsFromHtml,
  extractLinksFromHtml,
  finding,
  isUrl,
  limitArray,
  parseXml
} from './analysis-utils.ts';

function identity(url: URL, fingerprint: string): AnalysisResult['identity'] {
  return {
    name: url.hostname,
    type: 'website',
    format: 'HTML document',
    mimeType: 'text/html',
    size: 0,
    location: url.href,
    fingerprint: shortFingerprint(fingerprint)
  };
}

function headersEvidence(headers: Headers): Evidence[] {
  return [
    evidence('web-header-csp', 'Content-Security-Policy', headers.get('content-security-policy') || 'Not present'),
    evidence('web-header-xfo', 'X-Frame-Options', headers.get('x-frame-options') || 'Not present'),
    evidence('web-header-hsts', 'Strict-Transport-Security', headers.get('strict-transport-security') || 'Not present'),
    evidence('web-header-referrer', 'Referrer-Policy', headers.get('referrer-policy') || 'Not present'),
    evidence('web-header-permissions', 'Permissions-Policy', headers.get('permissions-policy') || 'Not present'),
    evidence('web-header-nosniff', 'X-Content-Type-Options', headers.get('x-content-type-options') || 'Not present')
  ];
}

async function readBoundedBody(response: Response, limitBytes: number, signal: AbortSignal): Promise<{ text: string; bytes: Uint8Array; truncated: boolean }> {
  const contentType = response.headers.get('content-type') || 'text/plain';
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const sliced = bytes.slice(0, limitBytes);
    return {
      bytes: sliced,
      text: new TextDecoder(contentType.includes('charset=utf-8') ? 'utf-8' : 'utf-8', { fatal: false }).decode(sliced),
      truncated: bytes.length > limitBytes
    };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    ensureNotAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.length > limitBytes) {
      const remaining = Math.max(0, limitBytes - total);
      if (remaining > 0) {
        chunks.push(value.slice(0, remaining));
        total += remaining;
      }
      truncated = true;
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, text: new TextDecoder('utf-8', { fatal: false }).decode(bytes), truncated };
}

function parseMetaTags(html: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const match of html.matchAll(/<meta\s+[^>]*?(?:name|property)=["']([^"']+)["'][^>]*content=["']([^"']+)["'][^>]*>/gi)) {
    meta[match[1].toLowerCase()] = match[2];
  }
  return meta;
}

function parseTitle(html: string): string {
  return html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1]?.replace(/\s+/g, ' ').trim() || '';
}

function parseCanonical(html: string): string {
  return html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i)?.[1] || '';
}

function parseLang(html: string): string {
  return html.match(/<html[^>]*\blang=["']([^"']+)["']/i)?.[1] || '';
}

function parseStructuredData(html: string): number {
  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/gis)];
  let count = 0;
  for (const match of scripts) {
    try {
      const parsed = JSON.parse(match[1].trim());
      count += Array.isArray(parsed) ? parsed.length : 1;
    } catch {
      count += 0;
    }
  }
  return count;
}

function parseSecurityTechnologies(headers: Headers, html: string): string[] {
  const tech = new Set<string>();
  const server = headers.get('server');
  const poweredBy = headers.get('x-powered-by');
  const generator = html.match(/<meta[^>]*name=["']generator["'][^>]*content=["']([^"']+)["']/i)?.[1];
  if (server) tech.add(server);
  if (poweredBy) tech.add(poweredBy);
  if (generator) tech.add(generator);
  if (/wp-content|wordpress/i.test(html)) tech.add('WordPress');
  if (/__NEXT_DATA__|next\/static/i.test(html)) tech.add('Next.js');
  if (/data-reactroot|react/i.test(html)) tech.add('React');
  if (/vite/i.test(html)) tech.add('Vite');
  return [...tech];
}

async function fetchWithTimeout(url: URL, signal: AbortSignal, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

async function safeFetchText(url: URL, signal: AbortSignal): Promise<string> {
  try {
    const response = await fetchWithTimeout(url, signal, 6000);
    if (!response.ok) return '';
    const { text } = await readBoundedBody(response, 256 * 1024, signal);
    return text;
  } catch {
    return '';
  }
}

async function webFailureResult(item: InspectionUrl, fingerprint: string, message: string): Promise<AnalysisResult> {
  const evidenceList: Evidence[] = [
    evidence('web-url', 'URL', item.url),
    evidence('web-error', 'Request failed', message)
  ];
  return {
    objectKind: 'url',
    analyzerId: 'web',
    analyzerName: 'Website analyzer',
    capabilities: ['metadata', 'headings', 'links', 'images', 'scripts', 'security-headers', 'robots', 'sitemap'],
    limitations: ['Bounded network fetches only', 'No intrusive security testing'],
    targetName: item.name || item.url,
    identity: {
      name: item.name || item.url,
      type: 'website',
      format: 'unreachable',
      mimeType: 'text/plain',
      size: 0,
      location: item.url,
      fingerprint: shortFingerprint(fingerprint)
    },
    sections: [{ id: 'web-facts', title: 'Facts', items: evidenceList }],
    important: [],
    unusual: [finding('web-unreachable', 'Website unreachable', message, 'high', ['web-error'])],
    recommendations: [],
    evidence: evidenceList,
    progressLabel: 'Website analysis failed',
    cacheKey: fingerprint,
    generatedAt: new Date().toISOString(),
    sourceSummary: 'Unreachable'
  };
}

export async function analyzeUrlItem(item: InspectionUrl, options: { signal: AbortSignal }): Promise<AnalysisResult> {
  ensureNotAborted(options.signal);
  let url: URL;
  try {
    url = new URL(item.url);
  } catch {
    throw new Error('Invalid or unsupported URL');
  }
  if (!isUrl(url.href)) {
    throw new Error('Only http and https URLs can be inspected');
  }
  const fingerprint = await digestHex(new TextEncoder().encode(url.href));
  let response: Response;
  try {
    response = await fetchWithTimeout(url, options.signal, 10000);
  } catch (error) {
    const message = error instanceof Error && error.name !== 'AbortError' ? error.message : 'Request failed or timed out';
    if ((error as Error)?.name === 'AbortError') {
      throw error;
    }
    return webFailureResult(item, fingerprint, message);
  }
  const contentType = response.headers.get('content-type') || '';
  const body = await readBoundedBody(response, 1024 * 1024, options.signal);
  const isHtml = /html/i.test(contentType);
  const isXml = /xml/i.test(contentType);
  const looksTextual = /text|json|javascript|svg/i.test(contentType);
  const html = (isHtml || isXml || looksTextual) ? body.text : '';
  const title = parseTitle(html);
  const headings = extractHeadingsFromHtml(html);
  const links = extractLinksFromHtml(html);
  const images = [...html.matchAll(/<img\b[^>]*>/gi)];
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)];
  const canonical = parseCanonical(html);
  const lang = parseLang(html);
  const structuredDataCount = parseStructuredData(html);
  const meta = parseMetaTags(html);
  const technologies = parseSecurityTechnologies(response.headers, html);
  const securityHeaders = headersEvidence(response.headers);
  const robotsUrl = new URL('/robots.txt', url);
  const sitemapUrl = new URL('/sitemap.xml', url);
  const robotsText = await safeFetchText(robotsUrl, options.signal);
  const sitemapText = await safeFetchText(sitemapUrl, options.signal);
  const robotsLines = robotsText ? robotsText.split(/\r\n|\n|\r/).filter(Boolean) : [];
  const sitemapEntries = sitemapText ? (parseXml(sitemapText) as Record<string, unknown>) : {};
  const evidenceList: Evidence[] = [
    evidence('web-url', 'URL', url.href),
    evidence('web-status', 'HTTP status', `${response.status} ${response.statusText}`.trim()),
    evidence('web-title', 'Title', title || 'Not present'),
    evidence('web-description', 'Description', meta.description || 'Not present'),
    evidence('web-headings', 'Headings', formatNumber(headings.length)),
    evidence('web-links', 'Links', formatNumber(links.length)),
    evidence('web-images', 'Images', formatNumber(images.length)),
    evidence('web-scripts', 'Scripts', formatNumber(scripts.length)),
    evidence('web-structured-data', 'Structured data blocks', formatNumber(structuredDataCount)),
    evidence('web-canonical', 'Canonical URL', canonical || 'Not present'),
    evidence('web-lang', 'Language', lang || 'Not present'),
    evidence('web-robots', 'robots.txt', robotsLines.length ? `Fetched (${robotsLines.length} lines)` : 'Not found or inaccessible'),
    evidence('web-sitemap', 'sitemap.xml', Object.keys(sitemapEntries).length ? 'Fetched' : 'Not found or inaccessible')
  ];
  const sections: AnalysisSection[] = [
    { id: 'web-facts', title: 'Facts', items: evidenceList.slice(0, 8) },
    {
      id: 'web-structure',
      title: 'Structure',
      items: [
        ...(headings.length ? headings.map((value, index) => evidence(`web-heading-${index}`, `Heading ${index + 1}`, value)) : [evidence('web-heading-none', 'Headings', 'No headings detected')]),
        ...limitArray(links, 10).map((value, index) => evidence(`web-link-${index}`, `Link ${index + 1}`, value))
      ]
    },
    {
      id: 'web-security',
      title: 'Security',
      items: securityHeaders
    }
  ];
  if (technologies.length) {
    sections.push({
      id: 'web-tech',
      title: 'Technology hints',
      items: technologies.map((value, index) => evidence(`web-tech-${index}`, `Technology ${index + 1}`, value))
    });
  }
  const unusual: Finding[] = [];
  if (!isHtml && !isXml) {
    unusual.push(finding('web-non-html', 'Non-HTML response', 'The endpoint did not return an HTML document, so only headers and the raw response were inspected.', 'info', ['web-status']));
  }
  if (!title && isHtml) {
    unusual.push(finding('web-no-title', 'Missing title', 'The page does not define a document title.', 'low', ['web-title']));
  }
  if (!headings.length && isHtml) {
    unusual.push(finding('web-no-headings', 'No headings detected', 'The page appears to have no visible heading structure.', 'low', ['web-headings']));
  }
  if (body.truncated) {
    unusual.push(finding('web-truncated', 'Response truncated', 'Only a bounded portion of the response body was analyzed.', 'info', ['web-status']));
  }
  const recommendations: Finding[] = [];
  if (!canonical && isHtml) {
    recommendations.push(finding('web-canonical-reco', 'Add canonical URL', 'The page does not declare a canonical URL.', 'low', ['web-canonical']));
  }
  if (!response.headers.get('content-security-policy')) {
    recommendations.push(finding('web-csp-reco', 'Consider a content security policy', 'No Content-Security-Policy header was detected.', 'low', ['web-header-csp']));
  }
  return {
    objectKind: 'url',
    analyzerId: 'web',
    analyzerName: 'Website analyzer',
    capabilities: ['metadata', 'headings', 'links', 'images', 'scripts', 'security-headers', 'robots', 'sitemap'],
    limitations: ['Bounded network fetches only', 'No intrusive security testing', 'Only visible response content is inspected'],
    targetName: item.name || url.href,
    identity: identity(url, fingerprint),
    sections,
    important: [],
    unusual,
    recommendations,
    evidence: evidenceList,
    progressLabel: 'Website analysis complete',
    cacheKey: fingerprint,
    generatedAt: new Date().toISOString(),
    sourceSummary: title ? `${title} on ${url.hostname}` : url.hostname
  };
}
