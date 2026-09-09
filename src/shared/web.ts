import type { AnalysisResult, AnalysisSection, Evidence, Finding, InspectionUrl } from './types.ts';
import { digestHex, formatNumber, shortFingerprint } from './utils.ts';
import { APP_VERSION } from './app-meta.ts';
import { loadSettings } from './history.ts';
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

function securityHeaderValue(outcome: WebFetchOk, key: 'csp' | 'xfo' | 'hsts' | 'referrer' | 'permissions' | 'nosniff'): string {
  const value = outcome.headers ? outcome.headers[key] : undefined;
  return value && value.trim() ? value : 'Not present';
}

function headersEvidence(outcome: WebFetchOk): Evidence[] {
  return [
    evidence('web-header-csp', 'Content-Security-Policy', securityHeaderValue(outcome, 'csp')),
    evidence('web-header-xfo', 'X-Frame-Options', securityHeaderValue(outcome, 'xfo')),
    evidence('web-header-hsts', 'Strict-Transport-Security', securityHeaderValue(outcome, 'hsts')),
    evidence('web-header-referrer', 'Referrer-Policy', securityHeaderValue(outcome, 'referrer')),
    evidence('web-header-permissions', 'Permissions-Policy', securityHeaderValue(outcome, 'permissions')),
    evidence('web-header-nosniff', 'X-Content-Type-Options', securityHeaderValue(outcome, 'nosniff'))
  ];
}

async function readBoundedBody(response: Response, limitBytes: number, signal: AbortSignal): Promise<{ text: string; bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const sliced = bytes.slice(0, limitBytes);
    return {
      bytes: sliced,
      text: new TextDecoder('utf-8', { fatal: false }).decode(sliced),
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

function parseSecurityTechnologies(outcome: WebFetchOk, html: string): string[] {
  const tech = new Set<string>();
  const server = outcome.headers?.server;
  const poweredBy = outcome.headers?.xPoweredBy;
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

/* ------------------------------------------------------------------ */
/* Bounded, categorized web fetching                                   */
/*                                                                     */
/* Desktop (Electron) fetches in the MAIN process via the IPC bridge   */
/* (`window.inspectItDesktop.web.fetch`) so GitHub and other CORS-     */
/* restricted sites work. Browser/tests fall back to the global fetch. */
/* ------------------------------------------------------------------ */

export type WebFetchFailureCategory = 'dns' | 'connection' | 'tls' | 'timeout' | 'redirect' | 'http' | 'aborted' | 'network' | 'unknown' | 'desktop-bridge-unavailable' | 'web-analysis-disabled';

export interface WebFetchOk {
  ok: true;
  requestedUrl: string;
  finalUrl: string;
  status: number;
  statusText: string;
  redirected: boolean;
  redirectCount: number;
  contentType: string;
  size: number;
  truncated: boolean;
  text: string;
  durationMs: number;
  /** Minimal security-relevant headers surfaced by the fetch layer. */
  transport?: 'desktop-bridge' | 'browser-fetch';
  headers?: {
    csp?: string; xfo?: string; hsts?: string; referrer?: string; permissions?: string; nosniff?: string;
    server?: string; xPoweredBy?: string;
  };
}

export interface WebFetchError {
  ok: false;
  category: WebFetchFailureCategory;
  message: string;
  requestedUrl: string;
  status?: number;
  durationMs: number;
  transport?: 'desktop-bridge' | 'browser-fetch';
}

export type WebFetchOutcome = WebFetchOk | WebFetchError;

/** Map a fetch exception to a stable failure category. */
export function classifyFetchError(error: unknown): { category: WebFetchFailureCategory; message: string } {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const code = String(cause?.code ?? (error as { code?: string })?.code ?? '');
  const message = cause?.message || (error instanceof Error ? error.message : String(error));
  if ((error as Error)?.name === 'AbortError' || /aborted/i.test(message) || code === 'ABORT_ERR') {
    return { category: 'aborted', message: 'Request was aborted or timed out.' };
  }
  if (/timed? ?out|ETIMEDOUT|timeout/i.test(message) || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return { category: 'timeout', message: 'The request timed out.' };
  }
  if (/ENOTFOUND|EAI_AGAIN|dns/i.test(message) || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { category: 'dns', message: 'The host could not be resolved (DNS failure).' };
  }
  if (/ECONNREFUSED|ECONNRESET|EADDRNOTAVAIL|EHOSTUNREACH|ENETUNREACH|socket/i.test(message) || /ECONNREFUSED|ECONNRESET/.test(code)) {
    return { category: 'connection', message: 'The connection could not be established.' };
  }
  if (/tls|ssl|certificate|cert/i.test(message) || /TLS|SSL|CERT/.test(code)) {
    return { category: 'tls', message: 'The TLS/SSL handshake or certificate verification failed.' };
  }
  if (/redirect|too many redirects/i.test(message)) {
    return { category: 'redirect', message: 'The redirect chain failed.' };
  }
  return { category: 'network', message: message || 'Network request failed.' };
}

function desktopWebBridge(): { fetch(payload: { url: string; timeoutMs?: number }): Promise<WebFetchOutcome> } | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { inspectItDesktop?: { web?: { fetch(payload: { url: string; timeoutMs?: number }): Promise<WebFetchOutcome> } } }).inspectItDesktop?.web;
  return bridge?.fetch ? bridge : null;
}

async function fetchViaGlobal(url: URL, signal: AbortSignal, timeoutMs: number): Promise<WebFetchOutcome> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Inspect It/1.0.4 (+https://github.com/WileQ/Inspect-it)'
      }
    });
    const contentType = response.headers.get('content-type') || '';
    const body = await readBoundedBody(response, 1024 * 1024, signal);
    return {
      ok: true,
      requestedUrl: url.href,
      finalUrl: response.url || url.href,
      status: response.status,
      statusText: response.statusText,
      redirected: response.redirected,
      redirectCount: response.redirected ? 1 : 0,
      contentType,
      size: body.bytes.length,
      truncated: body.truncated,
      text: body.text,
      durationMs: Date.now() - started,
      transport: 'browser-fetch' as const,
      headers: {
        csp: response.headers.get('content-security-policy') || undefined,
        xfo: response.headers.get('x-frame-options') || undefined,
        hsts: response.headers.get('strict-transport-security') || undefined,
        referrer: response.headers.get('referrer-policy') || undefined,
        permissions: response.headers.get('permissions-policy') || undefined,
        nosniff: response.headers.get('x-content-type-options') || undefined,
        server: response.headers.get('server') || undefined,
        xPoweredBy: response.headers.get('x-powered-by') || undefined
      }
    };
  } catch (error) {
    if ((error as Error)?.name === 'AbortError' && signal.aborted) {
      throw error;
    }
    const classified = classifyFetchError(error);
    return { ok: false, category: classified.category, message: classified.message, requestedUrl: url.href, durationMs: Date.now() - started, transport: 'browser-fetch' as const };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

interface RendererEnv {
  desktopBridgePresent: boolean;
  webFetchBridgePresent: boolean;
  appVersion: string;
  rendererLocation: string;
  runtime: string;
  impl: string;
}

function rendererEnvironment(): RendererEnv {
  const desktop = typeof window !== 'undefined' && Boolean((window as unknown as { inspectItDesktop?: unknown }).inspectItDesktop);
  const web = desktop ? (window as unknown as { inspectItDesktop?: { web?: { fetch?: unknown } } }).inspectItDesktop?.web : null;
  const win = typeof window !== 'undefined' ? (window as unknown as { location?: { href?: string; protocol?: string } }) : undefined;
  const location = win?.location?.href ?? 'n/a';
  const protocol = win?.location?.protocol ?? '';
  return {
    desktopBridgePresent: desktop,
    webFetchBridgePresent: Boolean(web && typeof web.fetch === 'function'),
    appVersion: APP_VERSION,
    rendererLocation: location,
    runtime: !win ? 'node' : protocol === 'file:' ? 'packaged-desktop' : desktop ? 'desktop-dev' : 'browser',
    impl: 'web-fetch-v1'
  };
}

const WEB_ANALYZER_RUNTIME_MARKER = 'inspect-it-web-runtime-2026-09';

function webRuntimeEvidence(transport?: 'desktop-bridge' | 'browser-fetch'): Evidence[] {
  return [
    evidence('web-runtime-marker', 'Web analyzer runtime', WEB_ANALYZER_RUNTIME_MARKER),
    evidence('web-transport-marker', 'Transport', transport === 'desktop-bridge' ? 'desktop-bridge-v1' : 'browser-fetch-v1'),
    evidence('web-fresh-marker', 'Fresh analysis', 'yes')
  ];
}

function diagEvidence(transport?: 'desktop-bridge' | 'browser-fetch'): Evidence[] {
  const env = rendererEnvironment();
  return [
    evidence('web-diag-desktop-bridge', 'Desktop bridge present', String(env.desktopBridgePresent)),
    evidence('web-diag-web-bridge', 'Web-fetch bridge present', String(env.webFetchBridgePresent)),
    evidence('web-diag-bridge-used', 'Bridge used', String(transport === 'desktop-bridge')),
    evidence('web-diag-runtime', 'Runtime', env.runtime),
    evidence('web-diag-app-version', 'App version', env.appVersion),
    evidence('web-diag-renderer-url', 'Renderer URL', env.rendererLocation),
    evidence('web-diag-impl', 'Fetch implementation', env.impl)
  ];
}

/** Fetch a single page, bounded, with the desktop main-process bridge when present. */
export async function fetchWebPage(url: URL, signal: AbortSignal, timeoutMs = 10000): Promise<WebFetchOutcome> {
  ensureNotAborted(signal);
  const env = rendererEnvironment();
  const bridge = desktopWebBridge();
  const isPrimaryPage = timeoutMs >= 10000;
  const logCtx = { url: url.href, protocol: url.protocol, ...env, bridgeUsed: Boolean(bridge) };
  const shouldLog = isPrimaryPage && typeof window !== 'undefined' && Boolean((window as unknown as { location?: unknown }).location);
  if (shouldLog) console.error('[web-debug] ACTUAL RENDERER FETCH', JSON.stringify(logCtx));
  if (env.desktopBridgePresent && !bridge) {
    const error: WebFetchError = {
      ok: false,
      category: 'desktop-bridge-unavailable',
      message: 'Desktop web-fetch bridge unavailable. Restart/rebuild Inspect It.',
      requestedUrl: url.href,
      durationMs: 0,
      transport: 'desktop-bridge'
    };
    if (shouldLog) console.error('[web-debug] ACTUAL RENDERER RESULT', JSON.stringify(error));
    return error;
  }
  if (bridge) {
    const started = Date.now();
    try {
      const outcome = await bridge.fetch({ url: url.href, timeoutMs });
      if (outcome && typeof outcome.ok === 'boolean') {
        const tagged = { ...outcome, transport: 'desktop-bridge' as const };
        if (shouldLog) console.error('[web-debug] ACTUAL RENDERER RESULT', JSON.stringify({ url: url.href, ok: tagged.ok, status: tagged.ok ? tagged.status : undefined, category: tagged.ok ? undefined : tagged.category, finalUrl: tagged.ok ? tagged.finalUrl : undefined, durationMs: tagged.durationMs }));
        return tagged;
      }
      const invalid: WebFetchError = { ok: false, category: 'network', message: 'The fetch bridge returned an invalid response.', requestedUrl: url.href, durationMs: Date.now() - started, transport: 'desktop-bridge' };
      if (shouldLog) console.error('[web-debug] ACTUAL RENDERER RESULT', JSON.stringify(invalid));
      return invalid;
    } catch (error) {
      const classified = classifyFetchError(error);
      const failure: WebFetchError = { ok: false, category: classified.category, message: classified.message, requestedUrl: url.href, durationMs: Date.now() - started, transport: 'desktop-bridge' };
      if (shouldLog) console.error('[web-debug] ACTUAL RENDERER RESULT', JSON.stringify(failure));
      return failure;
    }
  }
  if (shouldLog) console.error('[web-debug] ACTUAL RENDERER RESULT (browser fetch fallback)');
  return fetchViaGlobal(url, signal, timeoutMs);
}

function webFailureResult(item: InspectionUrl, fingerprint: string, error: WebFetchError, disabled = false): AnalysisResult {
  const evidenceList: Evidence[] = [
    ...webRuntimeEvidence(error.transport),
    ...diagEvidence(error.transport),
    evidence('web-url', 'Requested URL', error.requestedUrl),
    evidence('web-error-category', 'Failure category', error.category),
    evidence('web-error', 'Request failed', error.message)
  ];
  if (typeof error.status === 'number') {
    evidenceList.push(evidence('web-status', 'HTTP status', String(error.status)));
  }
  if (error.durationMs !== undefined) {
    evidenceList.push(evidence('web-duration', 'Fetch duration', `${error.durationMs} ms`));
  }
  const summary = error.status !== undefined
    ? `The server responded with HTTP ${error.status}; content was not analyzed.`
    : error.message;
  const findingId = disabled ? 'web-analysis-disabled' : 'web-unreachable';
  const findingTitle = disabled ? 'Web analysis disabled' : 'Website unreachable';
  const findingSeverity = disabled ? 'medium' : 'high';
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
    unusual: [finding(findingId, findingTitle, summary, findingSeverity, ['web-error'])],
    recommendations: [],
    evidence: evidenceList,
    progressLabel: 'Website analysis failed',
    cacheKey: fingerprint,
    generatedAt: new Date().toISOString(),
    sourceSummary: 'Unreachable'
  };
}

async function safeFetchText(url: URL, signal: AbortSignal): Promise<string> {
  const outcome = await fetchWebPage(url, signal, 6000);
  if (!outcome.ok || outcome.status !== 200) return '';
  return outcome.text.slice(0, 256 * 1024);
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
  if (url.username || url.password) {
    const credError: WebFetchError = {
      ok: false,
      category: 'unknown',
      message: 'URLs with embedded credentials are not allowed.',
      requestedUrl: url.href,
      durationMs: 0
    };
    return webFailureResult(item, await digestHex(new TextEncoder().encode(url.href)), credError);
  }
  const fingerprint = await digestHex(new TextEncoder().encode(url.href));
  const settings = loadSettings();
  if (!settings.webAnalysisEnabled) {
    const disabledError: WebFetchError = {
      ok: false,
      category: 'web-analysis-disabled',
      message: 'Web analysis is disabled. Enable Web Analysis in Settings to inspect websites.',
      requestedUrl: url.href,
      durationMs: 0
    };
    return webFailureResult(item, fingerprint, disabledError, true);
  }
  const outcome = await fetchWebPage(url, options.signal, 10000);
  if (!outcome.ok) {
    return webFailureResult(item, fingerprint, outcome);
  }
  if (outcome.status >= 400) {
    // HTTP error: report it clearly; never produce content findings from the error page.
    return webFailureResult(item, fingerprint, {
      ok: false,
      category: 'http',
      message: `The server responded with HTTP ${outcome.status} ${outcome.statusText.trim()}.`,
      requestedUrl: outcome.requestedUrl,
      status: outcome.status,
      durationMs: outcome.durationMs
    });
  }
  const contentType = outcome.contentType || '';
  const isHtml = /html/i.test(contentType);
  const isXml = /xml/i.test(contentType);
  const looksTextual = /text|json|javascript|svg/i.test(contentType);
  const extractionStatus = (isHtml || isXml || looksTextual) ? (outcome.truncated ? 'parsed (truncated)' : 'parsed') : 'not parsed (non-textual content)';
  const html = (isHtml || isXml || looksTextual) ? outcome.text : '';
  const title = parseTitle(html);
  const headings = extractHeadingsFromHtml(html);
  const links = extractLinksFromHtml(html);
  const images = [...html.matchAll(/<img\b[^>]*>/gi)];
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)];
  const canonical = parseCanonical(html);
  const lang = parseLang(html);
  const structuredDataCount = parseStructuredData(html);
  const meta = parseMetaTags(html);
  const technologies = parseSecurityTechnologies(outcome, html);
  const securityHeaders = headersEvidence(outcome);
  const robotsUrl = new URL('/robots.txt', url);
  const sitemapUrl = new URL('/sitemap.xml', url);
  const robotsText = await safeFetchText(robotsUrl, options.signal);
  const sitemapText = await safeFetchText(sitemapUrl, options.signal);
  const robotsLines = robotsText ? robotsText.split(/\r\n|\n|\r/).filter(Boolean) : [];
  const sitemapEntries = sitemapText ? (parseXml(sitemapText) as Record<string, unknown>) : {};
  const evidenceList: Evidence[] = [
    ...webRuntimeEvidence(outcome.transport),
    ...diagEvidence(outcome.transport),
    evidence('web-url', 'Requested URL', outcome.requestedUrl),
    evidence('web-final-url', 'Final URL', outcome.finalUrl !== outcome.requestedUrl ? outcome.finalUrl : 'Same as requested'),
    evidence('web-status', 'HTTP status', `${outcome.status} ${outcome.statusText}`.trim()),
    evidence('web-content-type', 'Content type', contentType || 'Not provided'),
    evidence('web-size', 'Response size', `${formatNumber(outcome.size)} bytes${outcome.truncated ? ' (truncated)' : ''}`),
    evidence('web-redirects', 'Redirects', formatNumber(outcome.redirectCount)),
    evidence('web-duration', 'Fetch duration', `${outcome.durationMs} ms`),
    evidence('web-extraction', 'Extraction', extractionStatus),
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
    unusual.push(finding('web-non-html', 'Non-HTML response', 'The endpoint did not return an HTML document, so only headers and the raw response were inspected.', 'info', ['web-content-type']));
  }
  if (!title && isHtml) {
    unusual.push(finding('web-no-title', 'Missing title', 'The page does not define a document title.', 'low', ['web-title']));
  }
  if (!headings.length && isHtml) {
    unusual.push(finding('web-no-headings', 'No headings detected', 'The page appears to have no visible heading structure.', 'low', ['web-headings']));
  }
  if (outcome.truncated) {
    unusual.push(finding('web-truncated', 'Response truncated', 'Only a bounded portion of the response body was analyzed.', 'info', ['web-size']));
  }
  const recommendations: Finding[] = [];
  if (!canonical && isHtml) {
    recommendations.push(finding('web-canonical-reco', 'Add canonical URL', 'The page does not declare a canonical URL.', 'low', ['web-canonical']));
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