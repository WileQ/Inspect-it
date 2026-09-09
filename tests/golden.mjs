// Golden real-world-style regression tests (deterministic; no real network).
// The network boundary is mocked: the URL tests exercise the same renderer
// analysis path with a stubbed desktop web-fetch bridge or a stubbed global
// fetch, so GitHub/website behavior is deterministic in CI.
import assert from 'node:assert/strict';
import { analyzeItem } from '../src/shared/analyzers.ts';
import { classifyFetchError } from '../src/shared/web.ts';
import { runInspection } from '../src/shared/inspection.ts';
import { loadSettings, saveSettings } from '../src/shared/history.ts';
import { makeScannedPdfItem, makeOcrTextItem, makePatternPngItem, makeGitFolderItem, makeRichCsvItem, makeComplexCodeItem } from './fixtures.mjs';

const signal = new AbortController().signal;

function fileItem(name, text, mime = 'text/plain') {
  const bytes = new TextEncoder().encode(text);
  const file = new File([bytes], name, { type: mime, lastModified: 1_700_000_000_000 });
  return { kind: 'file', name, path: name, size: file.size, lastModified: file.lastModified, mimeType: mime, file };
}
function urlItem(href) {
  const url = new URL(href);
  return { kind: 'url', name: url.hostname, path: href, url: href };
}
function hasFinding(result, id) {
  return [...(result.unusual || []), ...(result.important || [])].some((f) => f.id === id);
}

export async function runGoldenTests() {
  // --- Web Analysis permission: default OFF, zero network when disabled -------
  {
    saveSettings({ ...loadSettings(), webAnalysisEnabled: false });
    assert.equal(Boolean(loadSettings().webAnalysisEnabled), false, 'web analysis defaults to OFF');
    const local = await analyzeItem(fileItem('local.txt', 'hello\n'), { signal });
    assert.equal(local.analyzerId, 'text', 'local analysis unaffected while web analysis is OFF');
    let calls = 0;
    const prevFetch = globalThis.fetch;
    const prevWindow = globalThis.window;
    globalThis.fetch = async () => { calls += 1; throw new Error('network must not be used'); };
    globalThis.window = undefined;
    try {
      const result = await analyzeItem(urlItem('https://example.com/'), { signal });
      const category = (result.evidence || []).find((entry) => entry.id === 'web-error-category');
      assert.equal(category?.value, 'web-analysis-disabled', 'disabled mode returns web-analysis-disabled');
      assert.ok((result.evidence || []).some((entry) => entry.id === 'web-error' && String(entry.value).includes('Enable Web Analysis in Settings')), 'clear enable instruction present');
      assert.equal(calls, 0, 'disabled URL analysis makes zero network calls');
    } finally {
      if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
      if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
    }
    saveSettings({ ...loadSettings(), webAnalysisEnabled: true });
    assert.equal(Boolean(loadSettings().webAnalysisEnabled), true, 'enabling persists/reloads');
  }

  // --- Ordinary local objects -------------------------------------------------
  {
    const text = await analyzeItem(fileItem('notes.txt', 'line one\nline two\n'), { signal });
    assert.equal(text.analyzerId, 'text', 'text document analyzed');
  }
  {
    const csv = await analyzeItem(fileItem('data.csv', 'a,b\n1,2\n3,4\n', 'text/csv'), { signal });
    assert.equal(csv.analyzerId, 'csv', 'CSV analyzed');
  }
  {
    const json = await analyzeItem(fileItem('data.json', '{"a":1,"b":[1,2,3]}', 'application/json'), { signal });
    assert.equal(json.analyzerId, 'json', 'JSON analyzed');
  }
  {
    const code = await analyzeItem(await makeComplexCodeItem(), { signal });
    assert.equal(code.analyzerId, 'code', 'source code analyzed');
  }
  {
    const repo = await analyzeItem(await makeGitFolderItem(), { signal });
    assert.equal(repo.analyzerId, 'folder', 'git folder analyzed as project');
  }
  {
    const photo = await analyzeItem(await makePatternPngItem('photo.png', 64, 7), { signal });
    assert.equal(photo.analyzerId, 'image', 'photograph-style image analyzed without OCR claims');
    assert.ok(!(photo.evidence || []).some((entry) => entry.id === 'image-ocr' && String(entry.value).includes('OCR text')), 'no fabricated OCR text on non-text image');
  }
  {
    const img = await analyzeItem(makeOcrTextItem('scan.png', 'HELLO', 8), { signal });
    const ocr = (img.evidence || []).find((entry) => entry.id === 'image-ocr');
    assert.ok(ocr && /HELLO/i.test(String(ocr.value)), 'text-containing image uses OCR');
  }
  {
    const pdf = await analyzeItem(await makeScannedPdfItem(), { signal });
    assert.ok(hasFinding(pdf, 'pdf-ocr-text-recovered'), 'scanned PDF OCR regression (golden)');
  }

  // --- URL analysis with a mocked desktop web-fetch bridge (GitHub-like) ------
  {
    const prev = globalThis.window;
    const html = '<html><head><title>Quantum ML on lens images</title></head><body><h1>Readme</h1><a href="/blob/main/x.ipynb">notebook</a></body></html>';
    globalThis.window = {
      inspectItDesktop: {
        web: {
          fetch: async (payload) => ({
            ok: true,
            requestedUrl: payload.url,
            finalUrl: 'https://github.com/WileQ/Quantum_machine_learning_on_lense_images',
            status: 200,
            statusText: 'OK',
            redirected: false,
            redirectCount: 0,
            contentType: 'text/html; charset=utf-8',
            size: html.length,
            truncated: false,
            text: html,
            durationMs: 42,
            headers: { csp: undefined, nosniff: 'nosniff', server: 'GitHub.com' }
          })
        }
      }
    };
    try {
      const result = await analyzeItem(urlItem('https://github.com/WileQ/Quantum_machine_learning_on_lense_images'), { signal });
      assert.equal(result.analyzerId, 'web', 'GitHub page analyzed through bridge');
      const final = (result.evidence || []).find((entry) => entry.id === 'web-final-url');
      assert.ok(final, 'final URL evidence present');
      const title = (result.evidence || []).find((entry) => entry.id === 'web-title');
      assert.equal(title?.value, 'Quantum ML on lens images', 'title extracted');
      assert.ok((result.evidence || []).some((entry) => entry.id === 'web-status' && entry.value.includes('200')), 'status evidence present');
      assert.ok(!hasFinding(result, 'web-unreachable'), 'reachable page is not reported unreachable');
      const diagBridgeUsed = (result.evidence || []).find((entry) => entry.id === 'web-diag-bridge-used');
      assert.equal(diagBridgeUsed?.value, 'true', 'diagnostics show the desktop bridge was used');
      const runtimeMarker = (result.evidence || []).find((entry) => entry.id === 'web-runtime-marker');
      assert.equal(runtimeMarker?.value, 'inspect-it-web-runtime-2026-09', 'runtime marker present on live result');
      assert.equal((result.evidence || []).find((entry) => entry.id === 'web-transport-marker')?.value, 'desktop-bridge-v1', 'transport marker present');
    } finally {
      if (prev === undefined) delete globalThis.window; else globalThis.window = prev;
    }
  }

  // --- Desktop mode with a MISSING web-fetch bridge fails loudly --------------
  {
    const prev = globalThis.window;
    let fetchCalls = 0;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetchCalls += 1; throw new Error('should not be called'); };
    globalThis.window = { inspectItDesktop: { getWindowState: async () => ({}) } };
    try {
      const result = await analyzeItem(urlItem('https://pl.wikipedia.org/wiki/Example'), { signal });
      const category = (result.evidence || []).find((entry) => entry.id === 'web-error-category');
      assert.equal(category?.value, 'desktop-bridge-unavailable', 'desktop bridge missing is reported specifically');
      assert.ok((result.evidence || []).some((entry) => entry.id === 'web-error' && String(entry.value).includes('Restart/rebuild')), 'actionable message present');
      assert.equal(fetchCalls, 0, 'no silent browser-fetch fallback in desktop mode');
    } finally {
      if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
      if (prev === undefined) delete globalThis.window; else globalThis.window = prev;
    }
  }

  // --- Failure categories with a mocked global fetch ---------------------------
  {
    const prevFetch = globalThis.fetch;
    const prevWindow = globalThis.window;
    globalThis.window = undefined;
    globalThis.fetch = async () => {
      const error = new TypeError('fetch failed');
      error.cause = { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND example.invalid' };
      throw error;
    };
    try {
      const result = await analyzeItem(urlItem('https://example.invalid/'), { signal });
      const category = (result.evidence || []).find((entry) => entry.id === 'web-error-category');
      assert.equal(category?.value, 'dns', 'DNS failure categorized');
      assert.equal(hasFinding(result, 'web-unreachable'), true, 'unreachable finding present');
      assert.equal(result.unusual.filter((f) => f.id === 'web-unreachable').length, 1, 'no content findings on failure');
    } finally {
      if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
      if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
    }
  }
  {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('<html><title>Not found</title></html>', { status: 404, statusText: 'Not Found', headers: { 'content-type': 'text/html' } });
    try {
      const result = await analyzeItem(urlItem('https://example.com/missing'), { signal });
      const category = (result.evidence || []).find((entry) => entry.id === 'web-error-category');
      assert.equal(category?.value, 'http', 'HTTP error categorized');
      assert.ok(result.unusual.every((f) => f.id === 'web-unreachable'), 'no content findings from an HTTP error page');
    } finally {
      if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
    }
  }
  {
    assert.equal(classifyFetchError({ name: 'AbortError' }).category, 'aborted');
    assert.equal(classifyFetchError({ cause: { code: 'ECONNREFUSED' } }).category, 'connection');
    assert.equal(classifyFetchError({ cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } }).category, 'tls');
    assert.equal(classifyFetchError({ cause: { code: 'ETIMEDOUT' } }).category, 'timeout');
  }

  // --- URL retries must be fresh (no stale cached failure) --------------------
  {
    const noop = () => undefined;
    let fetchCount = 0;
    const prevFetch = globalThis.fetch;
    const html = '<html><head><title>Fresh Site</title></head><body><h1>Hello</h1></body></html>';
    globalThis.fetch = async () => { fetchCount += 1; return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }); };
    const target = urlItem('https://fresh.example.com/page');
    try {
      const first = await runInspection({ target, signal, allowCache: false, onProgress: noop, onPartial: noop, onState: noop });
      assert.ok(fetchCount >= 1, 'first URL analysis performs live fetches');
      const afterFirst = fetchCount;
      assert.ok((first.evidence || []).some((entry) => entry.id === 'web-runtime-marker'), 'fresh result carries runtime marker');
      assert.equal((first.evidence || []).find((entry) => entry.id === 'web-fresh-marker')?.value, 'yes', 'fresh result marked live');
      const second = await runInspection({ target, signal, allowCache: true, onProgress: noop, onPartial: noop, onState: noop });
      assert.equal(fetchCount, afterFirst, 'cached reuse does not re-fetch');
      assert.equal((second.evidence || []).find((entry) => entry.id === 'analysis-cache')?.value.includes('CACHE_HIT'), true, 'cached result is clearly marked CACHE_HIT');
      const third = await runInspection({ target, signal, allowCache: false, onProgress: noop, onPartial: noop, onState: noop });
      assert.ok(fetchCount > afterFirst, 'retry with allowCache:false performs a fresh analysis');
      assert.equal((third.evidence || []).find((entry) => entry.id === 'web-fresh-marker')?.value, 'yes', 'fresh retry marked live');
    } finally {
      if (prevFetch === undefined) delete globalThis.fetch; else globalThis.fetch = prevFetch;
    }
  }

  console.log('Golden real-world regression tests passed.');
}