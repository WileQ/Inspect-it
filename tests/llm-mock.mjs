// Local mock OpenAI-compatible server for Milestone 04 tests.
// Never talks to a real API and requires no internet access.
//
// Modes:
//   'ok'        - standard non-stream JSON chat completion
//   'stream'    - SSE streaming chat completion
//   'status'    - responds with a configurable HTTP error status
//   'malformed' - 200 with invalid JSON
//   'empty'     - 200 with '{}' (no choices)
//   'hang'      - never responds (used for timeout tests)
import http from 'node:http';

export function createLlmMockServer(options = {}) {
  const requests = [];
  const state = {
    mode: options.mode ?? 'ok',
    status: options.status ?? 401,
    jsonBody: options.jsonBody ?? null,
    delayMs: options.delayMs ?? 0
  };

  const server = http.createServer((req, res) => {
    // Swallow client-abort errors (EPIPE) so aborted requests cannot crash it.
    res.on('error', () => undefined);
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({ url: req.url, method: req.method, headers: req.headers, body });
      if (state.mode === 'hang') {
        return; // never respond
      }
      const respond = () => {
        if (state.mode === 'status') {
          res.writeHead(state.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'mock provider error' } }));
          return;
        }
        if (state.mode === 'malformed') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{ this is not json');
          return;
        }
        if (state.mode === 'empty') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        if (state.mode === 'stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const chunks = ['Hello', ' ', 'from', ' ', 'the', ' ', 'mock', ' ', 'provider.'];
          let index = 0;
          const writeNext = () => {
            if (index >= chunks.length) {
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[index] } }] })}\n\n`);
            index += 1;
            setTimeout(writeNext, 1);
          };
          writeNext();
          return;
        }
        // 'ok' - standard non-stream response.
        res.writeHead(200, { 'content-type': 'application/json' });
        const bodyJson =
          state.jsonBody ?? {
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            model: 'mock-model',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content:
                    '{"summary":"Mock AI summary","important":["Key point one"],"whyItMatters":"It matters because of X","unusual":["Something odd in the data"],"investigate":["Check column revenue"],"limitations":["Only structured context was seen"],"uncertainty":"Sample size is unknown"}'
                },
                finish_reason: 'stop'
              }
            ]
          };
        res.end(JSON.stringify(bodyJson));
      };
      if (state.delayMs > 0) {
        setTimeout(respond, state.delayMs);
      } else {
        respond();
      }
    });
  });

  return {
    started: new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
    requests,
    get port() {
      return server.address().port;
    },
    get base() {
      return `http://127.0.0.1:${server.address().port}/v1`;
    },
    setMode(mode) {
      state.mode = mode;
    },
    setStatus(status) {
      state.status = status;
    },
    setJsonBody(body) {
      state.jsonBody = body;
    },
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
    }
  };
}
