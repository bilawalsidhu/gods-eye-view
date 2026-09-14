// realtimeProxy.test.mjs — pins the DEV middleware adapter for
// `/api/realtime/debug-log` (vite/proxies/realtime.js) at its own runtime,
// mirroring the Pages adapter tests in functions/api/realtime/. The shared
// redaction logic lives in src/voice/realtimeSession.test.mjs; what is
// pinned HERE is the dev wiring: same 400 shape for non-object records, and
// the redacted record actually reaching the dev file sink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { openAiRealtimeProxy, REALTIME_DEBUG_LOG_FILE } from '../../vite/proxies/realtime.js';

/** Register the real middleware stack and return the debug-log handler. */
function debugLogHandler() {
  const handlers = new Map();
  openAiRealtimeProxy().configureServer({ middlewares: { use: (path, fn) => handlers.set(path, fn) } });
  return handlers.get('/api/realtime/debug-log');
}

const mockReq = ({ method = 'POST', headers = {}, body = '' } = {}) => ({
  method,
  headers,
  url: '/api/realtime/debug-log',
  on(event, fn) {
    if (event === 'data') setImmediate(() => fn(Buffer.from(body)));
    if (event === 'end') setImmediate(fn);
    return this;
  },
});

const mockRes = () => ({
  statusCode: 0,
  headers: {},
  body: '',
  setHeader(k, v) { this.headers[k] = v; return this; },
  end(text = '') { this.body = text; return this; },
});

test('dev middleware rejects a valid-JSON non-object body with the parity 400 shape', async () => {
  const linesBefore = readSinkLineCount();
  const handler = debugLogHandler();
  for (const body of ['[1,2,3]', 'null', '"spoof"']) {
    const res = mockRes();
    await handler(mockReq({ body }), res);
    assert.equal(res.statusCode, 400, body);
    assert.deepEqual(JSON.parse(res.body), { error: 'record must be a JSON object' }, body);
  }
  assert.equal(readSinkLineCount(), linesBefore, 'nothing is appended for a non-object record');
});

test('dev middleware redacts a credential-bearing record before it reaches the file sink', async () => {
  const handler = debugLogHandler();
  const res = mockRes();
  await handler(mockReq({
    body: JSON.stringify({
      event: 'unit_test_redaction',
      apiKey: 'sk-DDDDDDDDDDDDDDDDDDDDDDDDDDDD',
      payload: { note: 'client_secret":"ek_live_value123"', keep: 'telemetry' },
    }),
  }), res);
  assert.equal(res.statusCode, 204);

  const lastLine = readFileSync(REALTIME_DEBUG_LOG_FILE, 'utf8').trimEnd().split('\n').at(-1);
  const record = JSON.parse(lastLine);
  assert.equal(record.record.event, 'unit_test_redaction');
  assert.equal(record.record.apiKey, '[Redacted]');
  assert.doesNotMatch(lastLine, /sk-DDDD|ek_live_value123/, 'no raw secret lands in the dev sink');
  assert.equal(record.record.payload.keep, 'telemetry');
});

function readSinkLineCount() {
  try {
    return readFileSync(REALTIME_DEBUG_LOG_FILE, 'utf8').trimEnd().split('\n').length;
  } catch {
    return 0; // sink file not created yet
  }
}
