/**
 * `x-ondemand-key` per-request override (docs/ENTITY_CHAT.md "Key override").
 *
 * Pins the whole contract in one file:
 *   - the header value becomes the upstream `apikey` for THAT request only
 *     (sessions + chat sync + chat stream + capability-loop's bound fetch);
 *   - without the header the server key is used, exactly as before;
 *   - the response carries `X-OnDemand-Key-Source: request|server` — a NAME;
 *   - the key never appears in any response body or console line;
 *   - a malformed header is a 400, never a silent fallback;
 *   - a BYO-key session is never written to the proxy's userId store;
 *   - health.js / selftest.js never consult the header (source-level + live).
 *
 * Run: npm run test:ondemand
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { __reloadConfigForTests } from './config.js';
import { __resetStoreForTests, getStore } from './sessions-store.js';
import {
  isValidKeyOverride,
  resolveRequestKey,
  bindOndemandFetch,
  KEY_OVERRIDE_HEADER,
  KEY_SOURCE_HEADER,
  KEY_OVERRIDE_MAX_LEN,
} from './client.js';
import {
  makeReq,
  makeRes,
  stubFetchSequence,
  jsonResponse,
  sseResponse,
} from './test-helpers.mjs';
import sessionsHandler from '../../api/ondemand/sessions.js';
import chatHandler from '../../api/ondemand/chat.js';
import healthHandler, {
  __resetSpeechProbeCacheForTests,
} from '../../api/ondemand/health.js';

const SERVER_KEY = 'server-key-9f1e2d3c';
const USER_KEY = 'user-key-DO-NOT-LEAK-a1b2c3';
const ENV_KEYS = [
  'ONDEMAND_API_KEY',
  'ONDEMAND_FULFILLMENT_ENDPOINT_ID',
  'ONDEMAND_ENDPOINT_ID',
  'ONDEMAND_SPATIAL_AGENT_ID',
];
let savedEnv;
let activeStub;
let consoleLines;
let originalConsole;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  __resetStoreForTests();
  __resetSpeechProbeCacheForTests();
  // Mock console: every handler line is captured so the key can be proven
  // absent from ALL of them, not just the response body.
  consoleLines = [];
  originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };
  for (const level of Object.keys(originalConsole)) {
    console[level] = (...args) => {
      consoleLines.push(args.map((a) => stringify(a)).join(' '));
    };
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __reloadConfigForTests();
  __resetStoreForTests();
  __resetSpeechProbeCacheForTests();
  if (activeStub) {
    activeStub.restore();
    activeStub = undefined;
  }
  for (const level of Object.keys(originalConsole))
    console[level] = originalConsole[level];
});

function stringify(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function configureServerKey() {
  process.env.ONDEMAND_API_KEY = SERVER_KEY;
  __reloadConfigForTests();
}

function sessionCreated(id = 'sess-override') {
  return jsonResponse(201, { message: 'ok', data: { id, createdAt: 't' } });
}

function syncAnswer(answer = 'ok') {
  return jsonResponse(200, {
    message: 'Chat query submitted successfully',
    data: { sessionId: 's', messageId: 'm', answer, status: 'completed' },
  });
}

/** Everything a leaked key could hide in: response bytes + console lines. */
function assertNoLeak(res) {
  const body = res.text();
  assert.equal(body.includes(USER_KEY), false, 'key leaked into the body');
  for (const [name, value] of Object.entries(res._headers)) {
    assert.equal(
      String(value).includes(USER_KEY),
      false,
      `key leaked into response header ${name}`,
    );
  }
  for (const line of consoleLines) {
    assert.equal(line.includes(USER_KEY), false, 'key leaked into console');
  }
}

describe('server/ondemand/client.js — resolveRequestKey / isValidKeyOverride', () => {
  test('accepts printable ASCII up to the cap, rejects the rest', () => {
    assert.equal(isValidKeyOverride(USER_KEY), true);
    assert.equal(isValidKeyOverride('a'.repeat(KEY_OVERRIDE_MAX_LEN)), true);
    assert.equal(
      isValidKeyOverride('a'.repeat(KEY_OVERRIDE_MAX_LEN + 1)),
      false,
    );
    assert.equal(isValidKeyOverride(''), false);
    assert.equal(isValidKeyOverride('has space'), false);
    assert.equal(isValidKeyOverride('caf\u00e9'), false);
    assert.equal(isValidKeyOverride('tab\there'), false);
    assert.equal(isValidKeyOverride(42), false);
    assert.equal(isValidKeyOverride(undefined), false);
  });

  test('resolveRequestKey: absent -> server, valid -> request, malformed -> rejected', () => {
    assert.deepEqual(resolveRequestKey(makeReq()), {
      apiKeyOverride: undefined,
      source: 'server',
      rejected: false,
    });
    assert.deepEqual(
      resolveRequestKey(makeReq({ headers: { 'X-OnDemand-Key': USER_KEY } })),
      { apiKeyOverride: USER_KEY, source: 'request', rejected: false },
    );
    assert.deepEqual(
      resolveRequestKey(
        makeReq({ headers: { [KEY_OVERRIDE_HEADER]: `  ${USER_KEY}  ` } }),
      ),
      { apiKeyOverride: USER_KEY, source: 'request', rejected: false },
      'surrounding whitespace is trimmed',
    );
    assert.deepEqual(
      resolveRequestKey(
        makeReq({ headers: { [KEY_OVERRIDE_HEADER]: 'x'.repeat(129) } }),
      ),
      { apiKeyOverride: undefined, source: 'server', rejected: true },
    );
    assert.deepEqual(
      resolveRequestKey(makeReq({ headers: { [KEY_OVERRIDE_HEADER]: '' } })),
      { apiKeyOverride: undefined, source: 'server', rejected: false },
      'an empty header is treated as absent',
    );
  });

  test('bindOndemandFetch: the bound fetch sends the override as apikey; unbound sends the server key', async () => {
    configureServerKey();
    activeStub = stubFetchSequence([jsonResponse(200, {}), jsonResponse(200, {})]);
    await bindOndemandFetch(USER_KEY)('https://example.test/a', {
      method: 'GET',
    });
    await bindOndemandFetch(undefined)('https://example.test/b', {
      method: 'GET',
    });
    assert.equal(activeStub.calls[0].init.headers.apikey, USER_KEY);
    assert.equal(activeStub.calls[1].init.headers.apikey, SERVER_KEY);
  });
});

describe('api/ondemand/sessions.js — x-ondemand-key', () => {
  test('uses the header value as the upstream apikey, names the source, never echoes the key, never stores the session', async () => {
    configureServerKey();
    activeStub = stubFetchSequence([sessionCreated('sess-byo')]);
    const req = makeReq({
      method: 'POST',
      headers: { [KEY_OVERRIDE_HEADER]: USER_KEY },
      body: { userId: 'ondemand-spatial-entity-2026-09-18', reuse: false },
    });
    const res = makeRes();
    await sessionsHandler(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(activeStub.calls.length, 1);
    assert.equal(activeStub.calls[0].init.headers.apikey, USER_KEY);
    assert.equal(res.getHeader(KEY_SOURCE_HEADER), 'request');
    assert.equal(res.json().sessionId, 'sess-byo');
    assertNoLeak(res);
    assert.equal(
      getStore().get('ondemand-spatial-entity-2026-09-18'),
      undefined,
      'a BYO-key session must not enter the proxy userId store',
    );
  });

  test('without the header the server key is used and the source header says so', async () => {
    configureServerKey();
    activeStub = stubFetchSequence([sessionCreated('sess-srv')]);
    const req = makeReq({ method: 'POST', body: { userId: 'u-1' } });
    const res = makeRes();
    await sessionsHandler(req, res);
    assert.equal(res.statusCode, 201);
    assert.equal(activeStub.calls[0].init.headers.apikey, SERVER_KEY);
    assert.equal(res.getHeader(KEY_SOURCE_HEADER), 'server');
    assert.ok(getStore().get('u-1'), 'server-key sessions are still stored');
  });

  test('a stored server-key session is NOT reused for a BYO-key request', async () => {
    configureServerKey();
    activeStub = stubFetchSequence([
      sessionCreated('sess-srv'),
      sessionCreated('sess-byo-2'),
    ]);
    await sessionsHandler(
      makeReq({ method: 'POST', body: { userId: 'u-2' } }),
      makeRes(),
    );
    const res = makeRes();
    await sessionsHandler(
      makeReq({
        method: 'POST',
        headers: { [KEY_OVERRIDE_HEADER]: USER_KEY },
        body: { userId: 'u-2' },
      }),
      res,
    );
    assert.equal(activeStub.calls.length, 2, 'second call went upstream');
    assert.equal(activeStub.calls[1].init.headers.apikey, USER_KEY);
    assert.equal(res.json().sessionId, 'sess-byo-2');
    assert.equal(res.json().reused, false);
    assert.equal(getStore().get('u-2').sessionId, 'sess-srv', 'store intact');
  });

  test('a malformed header is 400 invalid_key_override and nothing goes upstream', async () => {
    configureServerKey();
    activeStub = stubFetchSequence([sessionCreated()]);
    const res = makeRes();
    await sessionsHandler(
      makeReq({
        method: 'POST',
        headers: { [KEY_OVERRIDE_HEADER]: 'bad key with spaces' },
        body: { userId: 'u-3' },
      }),
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'invalid_key_override');
    assert.equal(activeStub.calls.length, 0);
    assert.equal(res.getHeader(KEY_SOURCE_HEADER), 'server');
  });

  test('a valid header lets an UNCONFIGURED server serve the request with the caller key', async () => {
    __reloadConfigForTests(); // no ONDEMAND_API_KEY
    activeStub = stubFetchSequence([sessionCreated('sess-unconf')]);
    const res = makeRes();
    await sessionsHandler(
      makeReq({
        method: 'POST',
        headers: { [KEY_OVERRIDE_HEADER]: USER_KEY },
        body: { userId: 'u-4' },
      }),
      res,
    );
    assert.equal(res.statusCode, 201);
    assert.equal(activeStub.calls[0].init.headers.apikey, USER_KEY);
    assertNoLeak(res);
  });

  test('an unconfigured server without the header is still 503 not_configured', async () => {
    __reloadConfigForTests();
    activeStub = stubFetchSequence([sessionCreated()]);
    const res = makeRes();
    await sessionsHandler(
      makeReq({ method: 'POST', body: { userId: 'u-5' } }),
      res,
    );
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, 'not_configured');
    assert.equal(activeStub.calls.length, 0);
  });
});

describe('api/ondemand/chat.js — x-ondemand-key', () => {
  test('sync: the override is the apikey on the query call and nothing leaks', async () => {
    configureServerKey();
    activeStub = stubFetchSequence([syncAnswer('42')]);
    const res = makeRes();
    await chatHandler(
      makeReq({
        method: 'POST',
        headers: { [KEY_OVERRIDE_HEADER]: USER_KEY },
        body: {
          sessionId: 'sess-byo',
          query: 'hello',
          endpointId: 'predefined-x',
          responseMode: 'sync',
        },
      }),
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(activeStub.calls.length, 1);
    assert.equal(activeStub.calls[0].init.headers.apikey, USER_KEY);
    assert.equal(res.getHeader(KEY_SOURCE_HEADER), 'request');
    assert.equal(res.json().data.answer, '42');
    const sentBody = JSON.parse(activeStub.calls[0].init.body);
    assert.equal(
      JSON.stringify(sentBody).includes(USER_KEY),
      false,
      'the key must travel only as the apikey header, never in a body',
    );
    assertNoLeak(res);
  });

  test('sync via userId: the auto-created session and the query both use the override', async () => {
    configureServerKey();
    activeStub = stubFetchSequence([sessionCreated('sess-auto'), syncAnswer()]);
    const res = makeRes();
    await chatHandler(
      makeReq({
        method: 'POST',
        headers: { [KEY_OVERRIDE_HEADER]: USER_KEY },
        body: {
          userId: 'u-chat',
          query: 'hello',
          endpointId: 'predefined-x',
          responseMode: 'sync',
        },
      }),
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(activeStub.calls.length, 2);
    assert.equal(activeStub.calls[0].init.headers.apikey, USER_KEY);
    assert.equal(activeStub.calls[1].init.headers.apikey, USER_KEY);
    assert.equal(
      activeStub.calls[1].url,
      'https://api.on-demand.io/chat/v1/sessions/sess-auto/query',
    );
    assert.equal(getStore().get('u-chat'), undefined);
    assertNoLeak(res);
  });

  test('stream: the override is the apikey on the SSE fetch; bytes pipe verbatim', async () => {
    configureServerKey();
    const frames = [
      'event:message\ndata:{"eventType":"fulfillment","answer":"Hi"}\n\n',
      'event:message\ndata:[DONE]\n\n',
    ];
    activeStub = stubFetchSequence([sseResponse(200, frames)]);
    const res = makeRes();
    await chatHandler(
      makeReq({
        method: 'POST',
        headers: { [KEY_OVERRIDE_HEADER]: USER_KEY },
        body: {
          sessionId: 'sess-byo',
          query: 'hi',
          endpointId: 'predefined-x',
          responseMode: 'stream',
        },
      }),
      res,
    );
    assert.equal(activeStub.calls.length, 1);
    assert.equal(activeStub.calls[0].init.headers.apikey, USER_KEY);
    assert.equal(res.getHeader(KEY_SOURCE_HEADER), 'request');
    assert.equal(
      res.getHeader('content-type'),
      'text/event-stream; charset=utf-8',
    );
    assert.equal(res.text(), frames.join(''));
    assertNoLeak(res);
  });

  test('without the header chat keeps using the server key', async () => {
    configureServerKey();
    activeStub = stubFetchSequence([syncAnswer()]);
    const res = makeRes();
    await chatHandler(
      makeReq({
        method: 'POST',
        body: {
          sessionId: 'sess-1',
          query: 'hello',
          endpointId: 'predefined-x',
          responseMode: 'sync',
        },
      }),
      res,
    );
    assert.equal(activeStub.calls[0].init.headers.apikey, SERVER_KEY);
    assert.equal(res.getHeader(KEY_SOURCE_HEADER), 'server');
  });

  test('a malformed header is 400 before any validation or upstream call', async () => {
    configureServerKey();
    activeStub = stubFetchSequence([syncAnswer()]);
    const res = makeRes();
    await chatHandler(
      makeReq({
        method: 'POST',
        headers: { [KEY_OVERRIDE_HEADER]: 'k'.repeat(KEY_OVERRIDE_MAX_LEN + 1) },
        body: { sessionId: 's', query: 'q', responseMode: 'sync' },
      }),
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'invalid_key_override');
    assert.equal(activeStub.calls.length, 0);
  });

  test('upstream 4xx/5xx envelopes are shaped as before and never carry the key', async () => {
    configureServerKey();
    activeStub = stubFetchSequence([
      jsonResponse(429, {
        message: 'rate limited',
        errorCode: 'rate_limit_exceeded',
      }),
    ]);
    const res = makeRes();
    await chatHandler(
      makeReq({
        method: 'POST',
        headers: { [KEY_OVERRIDE_HEADER]: USER_KEY },
        body: { sessionId: 's', query: 'q', endpointId: 'e', responseMode: 'sync' },
      }),
      res,
    );
    assert.equal(res.statusCode, 429);
    assertNoLeak(res);
  });
});

describe('health.js / selftest.js ignore x-ondemand-key', () => {
  test('health: with the header and NO server key the response is still "not configured" and nothing goes upstream', async () => {
    __reloadConfigForTests();
    activeStub = stubFetchSequence([jsonResponse(200, { data: [] })]);
    const res = makeRes();
    await healthHandler(
      makeReq({
        method: 'GET',
        url: '/api/ondemand/health',
        headers: { [KEY_OVERRIDE_HEADER]: USER_KEY },
      }),
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().configured, false);
    assert.equal(activeStub.calls.length, 0);
    assert.equal(res.getHeader(KEY_SOURCE_HEADER), undefined);
    assertNoLeak(res);
  });

  test('health: with the header AND a server key every probe still uses the server key', async () => {
    configureServerKey();
    activeStub = stubFetchSequence([
      jsonResponse(200, { data: [] }),
      jsonResponse(200, { data: [] }),
      jsonResponse(200, { data: [] }),
      jsonResponse(200, { data: { audioUrl: 'https://cdn.example.test/x' } }),
    ]);
    const res = makeRes();
    await healthHandler(
      makeReq({
        method: 'GET',
        url: '/api/ondemand/health',
        headers: { [KEY_OVERRIDE_HEADER]: USER_KEY },
      }),
      res,
    );
    assert.ok(activeStub.calls.length >= 3);
    for (const call of activeStub.calls) {
      assert.equal(call.init.headers.apikey, SERVER_KEY);
    }
    assertNoLeak(res);
  });

  test('source-level: only sessions.js and chat.js resolve the override; health/selftest never read the header', () => {
    const root = new URL('../../', import.meta.url);
    const read = (p) => readFileSync(new URL(p, root), 'utf8');
    for (const file of ['api/ondemand/health.js', 'api/ondemand/selftest.js']) {
      const src = read(file);
      assert.equal(src.includes('resolveRequestKey'), false, file);
      assert.equal(src.includes('x-ondemand-key'), false, file);
      assert.equal(src.includes('apiKeyOverride'), false, file);
    }
    for (const file of ['api/ondemand/sessions.js', 'api/ondemand/chat.js']) {
      assert.ok(read(file).includes('resolveRequestKey'), file);
    }
    // No console.* in the proxy prints request headers.
    for (const file of [
      'server/ondemand/client.js',
      'server/ondemand/session-service.js',
      'api/ondemand/chat.js',
      'api/ondemand/sessions.js',
    ]) {
      const src = read(file);
      assert.doesNotMatch(
        src,
        /console\.\w+\([^)]*headers/,
        `${file} must never log headers`,
      );
      assert.doesNotMatch(
        src,
        /console\.\w+\([^)]*apiKeyOverride/,
        `${file} must never log the override`,
      );
    }
  });
});
