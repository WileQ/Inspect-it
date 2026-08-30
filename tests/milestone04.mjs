// Milestone 04 - optional LLM layer tests.
// Uses a local mock OpenAI-compatible HTTP server; never calls a real AI API
// and requires no internet access.
import assert from 'node:assert/strict';
import { analyzeItem } from '../src/shared/analyzers.ts';
import {
  aiCacheKeyFor,
  AI_RAW_SYSTEM_PROMPT,
  buildAiContext,
  buildAiRawUserPrompt,
  buildChatPayload,
  buildRawContentBlock,
  clearAiCache,
  clearApiKey,
  DEFAULT_LLM_SETTINGS,
  errorKindForStatus,
  getAiCached,
  hasUsableAi,
  LlmError,
  loadLlmSettings,
  normalizeLlmSettings,
  parseAiExplanation,
  parseChatCompletionResponse,
  parseSseEvent,
  extractRawContentForAi,
  requestLlmChat,
  runAiExplanation,
  saveLlmSettings,
  setApiKey,
  testAiConnection
} from '../src/shared/llm/index.ts';
import { storageRemove } from '../src/shared/storage.ts';
import { createLlmMockServer } from './llm-mock.mjs';
import { makeMultiSelectionFolder, makePdfItem, makeRichCsvItem } from './fixtures.mjs';

const signal = new AbortController().signal;

function llmSettings(overrides = {}) {
  return normalizeLlmSettings({
    enabled: true,
    autoRun: false,
    provider: 'Mock',
    baseUrl: 'http://127.0.0.1:1/v1',
    model: 'mock-model',
    timeoutMs: 2000,
    stream: false,
    maxContextChars: 24000,
    ...overrides
  });
}

function chatRequest(baseUrl, overrides = {}) {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
    baseUrl,
    model: 'mock-model',
    messages: [{ role: 'user', content: 'hello' }],
    timeoutMs: 2000,
    stream: false,
    ...overrides
  };
}

function findEvidence(result, id) {
  const inEvidence = result.evidence.find((entry) => entry.id === id);
  if (inEvidence) return inEvidence;
  for (const section of result.sections) {
    const found = section.items.find((entry) => entry.id === id);
    if (found) return found;
  }
  return null;
}

export async function runMilestoneFourTests() {
  clearAiCache();
  storageRemove('inspect-this.ai-key');
  storageRemove('inspect-this.ai-settings');

  // --- Configuration -------------------------------------------------------
  {
    assert.equal(DEFAULT_LLM_SETTINGS.enabled, false, 'LLM analysis is OFF by default');
    const clamped = normalizeLlmSettings({ ...DEFAULT_LLM_SETTINGS, timeoutMs: 99999999, maxContextChars: 1 });
    assert.equal(clamped.timeoutMs, 300000, 'timeout clamped to max');
    assert.equal(clamped.maxContextChars, 4000, 'max context clamped to min');
    const saved = normalizeLlmSettings({ enabled: true, provider: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1', timeoutMs: 5000, stream: false, maxContextChars: 8000 });
    saveLlmSettings(saved);
    const loaded = loadLlmSettings();
    assert.equal(loaded.enabled, true, 'settings round-trip enabled');
    assert.equal(loaded.model, 'llama3.1', 'settings round-trip model');
    assert.equal(loaded.stream, false, 'settings round-trip stream');
    storageRemove('inspect-this.ai-settings');
  }

  // --- Request formatting / response parsing (pure functions) --------------
  {
    const payload = buildChatPayload({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, maxTokens: 8 });
    assert.equal(payload.model, 'm');
    assert.equal(payload.stream, true);
    assert.equal(payload.max_tokens, 8);
    assert.equal(parseChatCompletionResponse({ choices: [{ message: { content: 'hi' } }] }), 'hi');
    assert.throws(() => parseChatCompletionResponse({}), (error) => error instanceof LlmError && error.kind === 'empty-response');
    assert.throws(() => parseChatCompletionResponse(null), (error) => error instanceof LlmError && error.kind === 'malformed-response');
    assert.equal(parseSseEvent('data: {"choices":[{"delta":{"content":"x"}}]}')?.content, 'x');
    assert.equal(parseSseEvent('data: [DONE]')?.done, true);
    assert.equal(parseSseEvent(': keep-alive'), null);
    assert.equal(parseSseEvent('data: not-json'), null);
    assert.equal(errorKindForStatus(401), 'invalid-key');
    assert.equal(errorKindForStatus(403), 'invalid-key');
    assert.equal(errorKindForStatus(429), 'rate-limit');
    assert.equal(errorKindForStatus(500), 'provider-unavailable');
    assert.equal(errorKindForStatus(404), 'invalid-base-url');
  }

  // --- Non-stream provider chat (mock server) ------------------------------
  {
    const server = createLlmMockServer({ mode: 'ok' });
    await server.started;
    try {
      await setApiKey('sk-test-secret');
      const chatResult = await requestLlmChat(chatRequest(server.base), {});
      const content = chatResult.content;
      assert.ok(content.includes('Mock AI summary'), 'non-stream content parsed');
      assert.equal(server.requests.length, 1, 'exactly one request');
      const recorded = server.requests[0];
      assert.equal(recorded.headers.authorization, 'Bearer sk-test-secret', 'key sent to provider as Bearer header');
      assert.ok(!recorded.url.includes('sk-test-secret'), 'key never appears in the URL');
      assert.ok(!recorded.body.includes('sk-test-secret'), 'key never appears in the request body');
      const sent = JSON.parse(recorded.body);
      assert.equal(sent.model, 'mock-model');
      assert.equal(sent.stream, false);
    } finally {
      await server.close();
      await clearApiKey();
    }
  }

  // --- Streaming (SSE) -----------------------------------------------------
  {
    const server = createLlmMockServer({ mode: 'stream' });
    await server.started;
    try {
      await setApiKey('sk-test');
      const deltas = [];
      const streamResult = await requestLlmChat(chatRequest(server.base, { stream: true }), { onDelta: (delta) => deltas.push(delta) });
      const content = streamResult.content;
      assert.equal(content, 'Hello from the mock provider.', 'streamed content accumulated');
      assert.ok(deltas.length >= 3, 'deltas streamed progressively');
      assert.equal(deltas.join(''), content, 'deltas reconstruct the full text');
    } finally {
      await server.close();
      await clearApiKey();
    }
  }

  // --- HTTP error mapping --------------------------------------------------
  {
    const cases = [
      [401, 'invalid-key'],
      [429, 'rate-limit'],
      [500, 'provider-unavailable'],
      [404, 'invalid-base-url'],
      [408, 'timeout']
    ];
    for (const [status, kind] of cases) {
      const server = createLlmMockServer({ mode: 'status', status });
      await server.started;
      try {
        await setApiKey('sk-test');
        await assert.rejects(
          () => requestLlmChat(chatRequest(server.base), {}),
          (error) => error instanceof LlmError && error.kind === kind,
          `status ${status} maps to ${kind}`
        );
      } finally {
        await server.close();
        await clearApiKey();
      }
    }
  }

  // --- Malformed / empty responses -----------------------------------------
  {
    for (const mode of ['malformed', 'empty']) {
      const server = createLlmMockServer({ mode });
      await server.started;
      try {
        await setApiKey('sk-test');
        await assert.rejects(
          () => requestLlmChat(chatRequest(server.base), {}),
          (error) => error instanceof LlmError && (mode === 'malformed' ? error.kind === 'malformed-response' : error.kind === 'empty-response'),
          `${mode} response handled`
        );
      } finally {
        await server.close();
        await clearApiKey();
      }
    }
  }

  // --- Timeout -------------------------------------------------------------
  {
    const server = createLlmMockServer({ mode: 'hang' });
    await server.started;
    try {
      await setApiKey('sk-test');
      await assert.rejects(
        () => requestLlmChat(chatRequest(server.base, { timeoutMs: 150 }), {}),
        (error) => error instanceof LlmError && error.kind === 'timeout',
        'hang + short timeout -> timeout error'
      );
    } finally {
      await server.close();
      await clearApiKey();
    }
  }

  // --- Cancellation --------------------------------------------------------
  {
    const server = createLlmMockServer({ mode: 'stream' });
    await server.started;
    try {
      await setApiKey('sk-test');
      const controller = new AbortController();
      await assert.rejects(
        () =>
          requestLlmChat(chatRequest(server.base, { stream: true }), {
            signal: controller.signal,
            onDelta: () => controller.abort()
          }),
        (error) => error instanceof LlmError && error.kind === 'cancelled',
        'abort mid-stream -> cancelled error'
      );
    } finally {
      await server.close();
      await clearApiKey();
    }
  }

  // --- Bounded context + evidence preservation -----------------------------
  {
    const csv = await analyzeItem(makeRichCsvItem(), { signal });
    const context = buildAiContext([csv], { maxChars: 12000 });
    assert.ok(context.text.includes('OBJECT'), 'context has OBJECT section');
    assert.ok(context.text.includes('SUMMARY FACTS'), 'context has SUMMARY FACTS section');
    assert.ok(context.chars <= 12000, 'context respects the budget');
    assert.equal(context.counts.objects, 1);

    const tiny = buildAiContext([csv], { maxChars: 600 });
    assert.equal(tiny.truncated, true, 'tiny budget truncates');
    assert.ok(tiny.chars <= 600, 'truncated context stays within budget');

    // Every finding referenced evidence (short enough to survive clipping)
    // must be preserved verbatim in the EVIDENCE section.
    for (const finding of [...csv.unusual, ...csv.important]) {
      for (const id of finding.evidence) {
        const entry = findEvidence(csv, id);
        if (!entry || entry.value.length > 180) continue;
        const line = `- ${entry.label}: ${entry.value}`;
        assert.ok(context.text.includes(line), `finding ${finding.id} preserves evidence "${line}"`);
      }
    }
  }

  // --- Multi-object context -------------------------------------------------
  {
    const csv = await analyzeItem(makeRichCsvItem(), { signal });
    const folder = await analyzeItem(makeMultiSelectionFolder(), { signal });
    const context = buildAiContext([csv, folder]);
    assert.ok(context.text.includes(folder.identity.name), 'multi-object context includes the second object');
    assert.ok(context.text.includes(csv.identity.name), 'multi-object context includes the first object');
    assert.equal(context.counts.objects, 2);
    if ((folder.relationships ?? []).length) {
      assert.ok(context.text.includes('RELATIONSHIPS'), 'multi-object context includes relationships');
    }
  }

  // --- AI output parsing ----------------------------------------------------
  {
    const meta = { providerName: 'Mock', model: 'm' };
    const json = parseAiExplanation(
      '{"summary":"S","important":["A","B"],"whyItMatters":"W","unusual":["U"],"investigate":["I"],"limitations":["L"],"uncertainty":"Un"}',
      meta
    );
    assert.equal(json.structured, true);
    assert.equal(json.summary, 'S');
    assert.deepEqual(json.important, ['A', 'B']);
    assert.equal(json.whyItMatters, 'W');
    const fenced = parseAiExplanation('```json\n{"summary":"Fenced"}\n```', meta);
    assert.equal(fenced.structured, true);
    assert.equal(fenced.summary, 'Fenced');
    const free = parseAiExplanation('This is a free-form explanation with no JSON at all.', meta);
    assert.equal(free.structured, false);
    assert.ok(free.summary.includes('free-form'), 'free text preserved as summary');
    const hostile = parseAiExplanation('<img src=x onerror=alert(1)> {"summary":"ok"}', meta);
    assert.equal(hostile.structured, true, 'provider text with markup still parses as inert data');
    assert.equal(hostile.summary, 'ok');
  }

  // --- End-to-end: runAiExplanation with mock provider ----------------------
  {
    const server = createLlmMockServer({ mode: 'ok' });
    await server.started;
    const csv = await analyzeItem(makeRichCsvItem(), { signal });
    const folder = await analyzeItem(makeMultiSelectionFolder(), { signal });
    try {
      await setApiKey('sk-test-secret');
      const settings = llmSettings({ baseUrl: server.base });
      const explanation = await runAiExplanation([csv, folder], settings, {});
      assert.equal(explanation.structured, true, 'structured explanation parsed');
      assert.equal(explanation.summary, 'Mock AI summary');
      assert.equal(explanation.fromCache, false);
      assert.equal(server.requests.length, 1);
      const recorded = server.requests[0];
      const sent = JSON.parse(recorded.body);
      const sentText = JSON.stringify(sent);
      assert.ok(sentText.includes('OBJECT'), 'provider receives bounded structured context');
      assert.ok(sentText.includes(folder.identity.name), 'multi-object context sent');
      assert.ok(!sentText.includes('sk-test-secret'), 'API key never sent in the body');
      assert.ok(!sentText.includes('PRIVATE'), 'no raw file content sent');
      assert.ok(explanation.contextChars !== undefined && explanation.contextChars > 0, 'context size reported');
    } finally {
      await server.close();
      await clearApiKey();
    }
  }

  // --- Cache: reuse, invalidation, no secrets -------------------------------
  {
    const server = createLlmMockServer({ mode: 'ok' });
    await server.started;
    const csv = await analyzeItem(makeRichCsvItem(), { signal });
    try {
      await setApiKey('sk-test');
      const settings = llmSettings({ baseUrl: server.base });
      const first = await runAiExplanation([csv], settings, {});
      assert.equal(server.requests.length, 1, 'first call hits the provider');
      assert.equal(first.fromCache, false);
      const second = await runAiExplanation([csv], settings, {});
      assert.equal(server.requests.length, 1, 'unchanged result + config served from cache');
      assert.equal(second.fromCache, true);
      assert.equal(second.summary, first.summary);

      const otherModel = llmSettings({ baseUrl: server.base, model: 'other-model' });
      const third = await runAiExplanation([csv], otherModel, {});
      assert.equal(server.requests.length, 2, 'model change invalidates the cache');
      assert.equal(third.fromCache, false);

      const key1 = await aiCacheKeyFor([csv], settings);
      const key2 = await aiCacheKeyFor([csv], otherModel);
      assert.notEqual(key1, key2, 'cache keys differ by model');
      const cached = getAiCached(key1);
      assert.ok(cached, 'cached entry exists');
      assert.ok(!JSON.stringify(cached).includes('sk-test'), 'cache never contains the API key');
    } finally {
      await server.close();
      await clearApiKey();
      clearAiCache();
    }
  }

  // --- Local-only operation with AI disabled --------------------------------
  {
    const server = createLlmMockServer({ mode: 'ok' });
    await server.started;
    const csv = await analyzeItem(makeRichCsvItem(), { signal });
    try {
      const disabled = llmSettings({ enabled: false, baseUrl: server.base });
      await assert.rejects(
        () => runAiExplanation([csv], disabled, {}),
        (error) => error instanceof LlmError && error.kind === 'configuration',
        'disabled AI throws a configuration error'
      );
      assert.equal(server.requests.length, 0, 'no network request when AI is disabled');
    } finally {
      await server.close();
    }
  }

  // --- No key configured -----------------------------------------------------
  {
    const server = createLlmMockServer({ mode: 'ok' });
    await server.started;
    const csv = await analyzeItem(makeRichCsvItem(), { signal });
    try {
      await clearApiKey();
      await assert.rejects(
        () => runAiExplanation([csv], llmSettings({ baseUrl: server.base }), {}),
        (error) => error instanceof LlmError && error.kind === 'configuration',
        'missing key throws configuration error'
      );
      assert.equal(server.requests.length, 0, 'no network request without a key');
    } finally {
      await server.close();
    }
  }

  // --- Connection test --------------------------------------------------------
  {
    const server = createLlmMockServer({ mode: 'ok' });
    await server.started;
    try {
      await setApiKey('sk-test');
      const ok = await testAiConnection(llmSettings({ baseUrl: server.base }));
      assert.equal(ok.ok, true, 'connection test succeeds against mock');
      await clearApiKey();
      const missing = await testAiConnection(llmSettings({ baseUrl: server.base }));
      assert.equal(missing.ok, false, 'connection test fails without key');
      const disabled = await testAiConnection(llmSettings({ enabled: false, baseUrl: server.base }));
      assert.equal(disabled.ok, false, 'connection test reports disabled');
    } finally {
      await server.close();
      await clearApiKey();
    }
  }

  // --- Privacy: key never leaks into errors -----------------------------------
  {
    const server = createLlmMockServer({ mode: 'status', status: 401 });
    await server.started;
    try {
      await setApiKey('sk-test-secret');
      try {
        await requestLlmChat(chatRequest(server.base), {});
        assert.fail('should have thrown');
      } catch (error) {
        assert.ok(error instanceof LlmError && error.kind === 'invalid-key');
        assert.ok(!error.message.includes('sk-test-secret'), 'error message never contains the API key');
      }
    } finally {
      await server.close();
      await clearApiKey();
    }
  }

  // --- hasUsableAi ------------------------------------------------------------
  {
    await clearApiKey();
    assert.equal(await hasUsableAi(llmSettings({ baseUrl: 'http://127.0.0.1:1/v1' })), false, 'no key -> not usable');
    await setApiKey('sk-test');
    assert.equal(await hasUsableAi(llmSettings({ baseUrl: 'http://127.0.0.1:1/v1' })), true, 'key + config -> usable');
    assert.equal(await hasUsableAi(llmSettings({ enabled: false, baseUrl: 'http://127.0.0.1:1/v1' })), false, 'disabled -> not usable');
    await clearApiKey();
  }

  // --- Raw-content mode: settings defaults + normalization -------------------
  {
    assert.equal(DEFAULT_LLM_SETTINGS.allowRawContent, false, 'raw content is OFF by default');
    assert.equal(DEFAULT_LLM_SETTINGS.rawContentMaxChars, 20000, 'raw content budget default');
    const norm = normalizeLlmSettings({ ...DEFAULT_LLM_SETTINGS, allowRawContent: true, rawContentMaxChars: 999999 });
    assert.equal(norm.allowRawContent, true, 'raw content gate round-trips');
    assert.equal(norm.rawContentMaxChars, 120000, 'raw content budget clamped to max');
    const clamped = normalizeLlmSettings({ ...DEFAULT_LLM_SETTINGS, rawContentMaxChars: 1 });
    assert.equal(clamped.rawContentMaxChars, 2000, 'raw content budget clamped to min');
  }

  // --- Raw-content block builder ---------------------------------------------
  {
    const long = 'x'.repeat(5000);
    const block = buildRawContentBlock(
      [
        { targetName: 'notes.txt', content: 'hello world\nsecond line' },
        { targetName: 'big.log', content: long }
      ],
      3000
    );
    assert.ok(block.text.includes('[RAW CONTENT] notes.txt'), 'raw block labels the object');
    assert.ok(block.text.includes('hello world'), 'raw block keeps content');
    assert.ok(block.text.includes('truncated'), 'truncated content is marked');
    assert.ok(block.truncated, 'truncation flag set');
    assert.ok(block.chars <= 3200, 'raw block stays bounded');
    const empty = buildRawContentBlock([{ targetName: 'photo.png', content: '', note: 'binary not sent' }], 2000);
    assert.ok(empty.text.includes('binary not sent'), 'binary objects produce a note, not content');
    assert.equal(empty.includedObjects, 0, 'no content objects counted for binary');
  }

  // --- Raw-content prompt -----------------------------------------------------
  {
    const prompt = buildAiRawUserPrompt('SUMMARY LINE', '[RAW CONTENT] a.txt\n<content>abc</content>', 1);
    assert.ok(prompt.includes('<raw-content>'), 'raw user prompt includes the raw block');
    assert.ok(prompt.includes('contentFindings'), 'raw user prompt requests contentFindings');
    assert.ok(AI_RAW_SYSTEM_PROMPT.includes('RAW OR EXTRACTED CONTENT'), 'raw system prompt explains the mode');
    assert.ok(AI_RAW_SYSTEM_PROMPT.includes('do NOT reproduce them verbatim'), 'raw system prompt redacts secrets');
  }

  // --- parseAiExplanation handles raw fields ---------------------------------
  {
    const parsed = parseAiExplanation(
      '{"summary":"s","important":["i"],"contentFindings":["Line 12 references a credential"],"questions":["Who owns the token?"],"unusual":["u"]}',
      { providerName: 'Mock', model: 'm', rawContentIncluded: true, rawContentChars: 123 }
    );
    assert.equal(parsed.contentFindings.length, 1, 'contentFindings parsed');
    assert.equal(parsed.questions.length, 1, 'questions parsed');
    assert.equal(parsed.rawContentIncluded, true, 'rawContentIncluded meta preserved');
    assert.equal(parsed.rawContentChars, 123, 'rawContentChars meta preserved');
  }

  // --- Cache key separates summary-only vs raw content ------------------------
  {
    const csv = await analyzeItem(makeRichCsvItem(), { signal });
    const settings = llmSettings();
    const summaryKey = await aiCacheKeyFor([csv], settings);
    const rawKey = await aiCacheKeyFor([csv], settings, [{ targetName: 'deep.csv', content: 'id,category\n1,a' }]);
    const rawKey2 = await aiCacheKeyFor([csv], settings, [{ targetName: 'deep.csv', content: 'id,category\n2,b' }]);
    assert.notEqual(summaryKey, rawKey, 'raw content changes the cache key');
    assert.notEqual(rawKey, rawKey2, 'different raw content changes the cache key');
  }

  // --- extractRawContentForAi: text + PDF + binary ----------------------------
  {
    const csv = makeRichCsvItem();
    const pdf = await makePdfItem();
    const extracted = await extractRawContentForAi([csv, pdf], signal);
    assert.ok(extracted.length === 2, 'one entry per object');
    assert.ok(extracted[0].content.includes('id,name') && extracted[0].content.includes('Alice'), 'CSV text content extracted');
    assert.ok(extracted[1].content.includes('Hello PDF'), 'PDF text content extracted');
    assert.ok(extracted[1].note.includes('PDF'), 'PDF entry notes extraction source');
  }

  // --- End-to-end: raw content blocked when the gate is off --------------------
  {
    const server = createLlmMockServer({ mode: 'ok' });
    await server.started;
    try {
      const csv = await analyzeItem(makeRichCsvItem(), { signal });
      await setApiKey('sk-test');
      const gated = llmSettings({ baseUrl: server.base, allowRawContent: false });
      await assert.rejects(
        () => runAiExplanation([csv], gated, { rawContent: [{ targetName: 'deep.csv', content: 'id\n1' }] }),
        (error) => error instanceof LlmError && error.kind === 'configuration',
        'raw content without the gate throws a configuration error'
      );
      assert.equal(server.requests.length, 0, 'no request when raw content is gated off');
    } finally {
      await server.close();
      await clearApiKey();
    }
  }

  // --- End-to-end: raw content sent when enabled -------------------------------
  {
    const server = createLlmMockServer({ mode: 'ok' });
    await server.started;
    try {
      const csv = await analyzeItem(makeRichCsvItem(), { signal });
      await setApiKey('sk-test');
      server.setJsonBody({
        id: 'chatcmpl-raw',
        object: 'chat.completion',
        model: 'mock-model',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content:
                '{"summary":"Raw summary","important":["A"],"whyItMatters":"B","unusual":["U"],"contentFindings":["Found a suspicious pattern in the content"],"investigate":["Trace it"],"questions":["Where does it come from?"],"limitations":["Content was truncated"],"uncertainty":"Some"}' 
            },
            finish_reason: 'stop'
          }
        ]
      });
      const settings = llmSettings({ baseUrl: server.base, allowRawContent: true });
      const explanation = await runAiExplanation([csv], settings, {
        rawContent: [{ targetName: 'deep.csv', content: 'id,category,score\n1,common,3\n2,rare,1000' }]
      });
      assert.equal(explanation.rawContentIncluded, true, 'explanation marks raw content');
      assert.equal(explanation.contentFindings.length, 1, 'contentFindings surfaced');
      assert.equal(explanation.questions.length, 1, 'questions surfaced');
      const sent = JSON.parse(server.requests[0].body);
      const userMessage = sent.messages.find((m) => m.role === 'user').content;
      assert.ok(userMessage.includes('<raw-content>'), 'raw block included in the request');
      assert.ok(userMessage.includes('deep.csv'), 'raw block labels the object');
      assert.ok(sent.messages[0].role === 'system' && sent.messages[0].content.includes('RAW OR EXTRACTED CONTENT'), 'raw system prompt used');
    } finally {
      await server.close();
      await clearApiKey();
    }
  }

  clearAiCache();
  storageRemove('inspect-this.ai-key');
  storageRemove('inspect-this.ai-settings');
  console.log('Milestone 04 LLM-layer tests passed.');
}
