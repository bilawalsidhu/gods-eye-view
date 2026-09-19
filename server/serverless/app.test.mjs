import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerlessApi } from './app.js';

/** Minimal http.ServerResponse-shaped mock: enough for router + createServerlessApi().handle(). */
function mockRes() {
  const listeners = { finish: [], close: [] };
  return {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    getHeader(name) {
      return this.headers[name];
    },
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
    },
    once(event, fn) {
      (listeners[event] ||= []).push(fn);
    },
    end(chunk) {
      this.headersSent = true;
      this.writableEnded = true;
      if (chunk !== undefined) this.body += chunk;
      queueMicrotask(() => {
        for (const fn of listeners.finish.splice(0)) fn();
      });
    },
  };
}

function mockReq(url, { method = 'GET' } = {}) {
  return { url, method, headers: {} };
}

// The serverless AIS route reads its credentials per request; these tests
// exercise the keyless path (demo replay), which is entirely offline.
const AIS_ENV_KEYS = [
  'AISSTREAM_API_KEY',
  'AISHUB_USERNAME',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
];
const savedAisEnv = Object.fromEntries(
  AIS_ENV_KEYS.map((key) => [key, process.env[key]]),
);
for (const key of AIS_ENV_KEYS) delete process.env[key];
test.after(() => {
  for (const key of AIS_ENV_KEYS) {
    if (savedAisEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedAisEnv[key];
  }
});

// A single serverless-mode instance is reused across these tests (matches
// how a warm Vercel function instance behaves via getServerlessApi()), and
// keeps us from repeatedly importing server/providers/local.js.
const apiPromise = createServerlessApi({ serverlessMode: true });

test('serverless /api/ais-live is served by the bounded collector: keyless Galveston scene answers 200 demo replay (degraded), not 501', async () => {
  const api = await apiPromise;
  const res = mockRes();
  await api.handle(
    mockReq('/api/ais-live?bbox=28.9,-95.5,29.9,-94&maxRows=10'),
    res,
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'degraded');
  assert.equal(body.source, 'Demo replay');
  assert.equal(
    body.error,
    'AISSTREAM_API_KEY not set - demo replay, not live AIS',
  );
  assert.ok(body.rows.length > 0 && body.rows.length <= 10);
  assert.match(body.rows[0].name, /^DEMO REPLAY \d+$/);
  assert.equal(body.collector.mode, 'demo');
  assert.equal(res.headers['X-Provider-Status'], 'degraded');
  assert.equal(res.headers['X-Provider-Source'], 'Demo replay');
  assert.equal(
    res.headers['Cache-Control'],
    'public, max-age=0, s-maxage=30, stale-while-revalidate=60',
  );
});

test('serverless /api/ais-live: an inland (Austin) scene is a legitimate empty scene with guidance, not a fault', async () => {
  const api = await apiPromise;
  const res = mockRes();
  await api.handle(
    mockReq('/api/ais-live?bbox=28.77,-99.24,31.77,-96.24&maxRows=10'),
    res,
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'empty');
  assert.deepEqual(body.rows, []);
  assert.equal(
    body.statusMessage,
    'No vessels in scene (demo replay covers the Texas Gulf coast)',
  );
  assert.equal(body.error, null);
});

test('serverless /api/ais-live without any scene hint answers idle (never 501); /track sub-path is mounted', async () => {
  const api = await apiPromise;
  const idle = mockRes();
  await api.handle(mockReq('/api/ais-live?maxRows=10'), idle);
  assert.equal(idle.statusCode, 200);
  assert.equal(JSON.parse(idle.body).status, 'idle');

  const track = mockRes();
  await api.handle(mockReq('/api/ais-live/track?mmsi=123456789'), track);
  assert.equal(track.statusCode, 200);
  assert.deepEqual(JSON.parse(track.body).samples, []);

  const demoTrack = mockRes();
  await api.handle(mockReq('/api/ais-live/track?mmsi=999000001'), demoTrack);
  assert.equal(demoTrack.statusCode, 200);
  assert.ok(JSON.parse(demoTrack.body).samples.length > 10);

  const bad = mockRes();
  await api.handle(mockReq('/api/ais-live/track?mmsi=nope'), bad);
  assert.equal(bad.statusCode, 400);
});

test('serverless guard: /api/realtime/token answers 501 unavailable_in_serverless', async () => {
  const api = await apiPromise;
  const res = mockRes();
  await api.handle(mockReq('/api/realtime/token'), res);
  assert.equal(res.statusCode, 501);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'unavailable_in_serverless',
    feature: 'voice-realtime',
    message:
      'Voice control (OpenAI Realtime ephemeral session) is unavailable in the serverless deployment',
  });
});

test('serverless guard: /api/realtime/debug-log is a silent 204 no-op', async () => {
  const api = await apiPromise;
  const res = mockRes();
  await api.handle(mockReq('/api/realtime/debug-log', { method: 'POST' }), res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, '');
});

test('/api/openai/hud-summary is left mounted (only token + debug-log are guarded)', async () => {
  const api = await apiPromise;
  const res = mockRes();
  // GET is rejected by the real handler (it only accepts POST) — reaching
  // THAT 405 (not our 501 guard, and not the 404 not-found layer) proves the
  // real openai-realtime-proxy handler is still mounted for this sub-route.
  await api.handle(mockReq('/api/openai/hud-summary'), res);
  assert.equal(res.statusCode, 405);
});

test('key setup is never mounted: /api/setup/status falls through to the not-found layer', async () => {
  const api = await apiPromise;
  const res = mockRes();
  await api.handle(mockReq('/api/setup/status'), res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'Unknown API route' });
});

test('an unknown /api route gets the same 404 JSON as the Vite dev server', async () => {
  const api = await apiPromise;
  const res = mockRes();
  await api.handle(mockReq('/api/does-not-exist'), res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'Unknown API route' });
});

test('getServerlessApi() memoises: two calls return the same instance', async () => {
  const { getServerlessApi } = await import('./app.js');
  const first = await getServerlessApi();
  const second = await getServerlessApi();
  assert.equal(first, second);
});

// ---------------------------------------------------------------------------
// /api/ondemand/workflow/<sub-path> → api/ondemand/workflow.js `?action=`
// (server/serverless/ondemand-workflow-mount.js). Upstream fetch is mocked;
// ONDEMAND_API_KEY is set for the duration so the handler passes its
// isConfigured() gate and the delegation is observable at the fetch boundary.
// ---------------------------------------------------------------------------

/** Response mock that also records streamed writes (SSE) and close listeners. */
function mockStreamRes() {
  const res = mockRes();
  const closeListeners = [];
  res.write = function write(chunk) {
    this.body += chunk;
    return true;
  };
  res.flushHeaders = function flushHeaders() {
    this.headersSent = true;
  };
  res.on = function on(event, fn) {
    if (event === 'close') closeListeners.push(fn);
  };
  res.off = function off() {};
  return res;
}

function jsonUpstream(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Queue canned upstream responses; records (url, init) per call. */
function stubUpstream(responses) {
  const calls = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return typeof next === 'function' ? next(url, init) : next;
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function withOndemandKey(run) {
  const saved = process.env.ONDEMAND_API_KEY;
  process.env.ONDEMAND_API_KEY = 'unit-test-key-never-logged';
  const { __reloadConfigForTests } = await import('../ondemand/config.js');
  __reloadConfigForTests();
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env.ONDEMAND_API_KEY;
    else process.env.ONDEMAND_API_KEY = saved;
    __reloadConfigForTests();
  }
}

test('POST /api/ondemand/workflow/execute maps onto ?action=execute (upstream POST …/workflow/{id}/execute, no body)', async () => {
  const api = await apiPromise;
  await withOndemandKey(async () => {
    const upstream = stubUpstream([
      jsonUpstream(200, { executionID: 'exec-sub-1' }),
    ]);
    try {
      const res = mockRes();
      const req = mockReq('/api/ondemand/workflow/execute', { method: 'POST' });
      req.body = {}; // Vercel pre-parsed JSON body shape
      await api.handle(req, res);
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(JSON.parse(res.body), { executionID: 'exec-sub-1' });
      assert.equal(upstream.calls.length, 1);
      assert.equal(upstream.calls[0].method, 'POST');
      assert.match(
        upstream.calls[0].url,
        /\/automation\/api\/workflow\/[^/]+\/execute$/,
      );
    } finally {
      upstream.restore();
    }
  });
});

test('GET /api/ondemand/workflow/status|logs|outputs carry the original query onto the action url', async () => {
  const api = await apiPromise;
  await withOndemandKey(async () => {
    const upstream = stubUpstream([
      jsonUpstream(200, { data: { status: 'executing' } }),
      jsonUpstream(200, { data: [{ nodeKey: 'planner', message: 'x' }] }),
      jsonUpstream(200, { data: { outputs: {} } }),
    ]);
    try {
      const status = mockRes();
      await api.handle(
        mockReq('/api/ondemand/workflow/status?executionId=abc%2F1'),
        status,
      );
      assert.equal(status.statusCode, 200, status.body);
      assert.equal(JSON.parse(status.body).data.status, 'executing');

      const logs = mockRes();
      await api.handle(
        mockReq('/api/ondemand/workflow/logs?executionId=abc'),
        logs,
      );
      assert.equal(logs.statusCode, 200, logs.body);
      assert.equal(JSON.parse(logs.body).data[0].nodeKey, 'planner');

      const outputs = mockRes();
      await api.handle(
        mockReq('/api/ondemand/workflow/outputs?executionId=abc'),
        outputs,
      );
      assert.equal(outputs.statusCode, 200, outputs.body);

      assert.deepEqual(
        upstream.calls.map((c) => c.method),
        ['GET', 'GET', 'GET'],
      );
      assert.match(upstream.calls[0].url, /\/automation\/api\/execution\/abc%2F1$/);
      assert.match(upstream.calls[1].url, /\/automation\/api\/execution\/abc\/logs$/);
      assert.match(
        upstream.calls[2].url,
        /\/automation\/api\/execution\/abc\/node\/outputs$/,
      );
    } finally {
      upstream.restore();
    }
  });
});

test('GET /api/ondemand/workflow/status without executionId is the handler\u2019s own 400 (delegation, not a shadow route)', async () => {
  const api = await apiPromise;
  await withOndemandKey(async () => {
    const upstream = stubUpstream([]);
    try {
      const res = mockRes();
      await api.handle(mockReq('/api/ondemand/workflow/status'), res);
      assert.equal(res.statusCode, 400);
      assert.equal(JSON.parse(res.body).error, 'executionId_required');
      assert.equal(upstream.calls.length, 0);
    } finally {
      upstream.restore();
    }
  });
});

test('an unknown /api/ondemand/workflow sub-path is a 404 listing the supported ones; the bare path falls through', async () => {
  const api = await apiPromise;
  const res = mockRes();
  await api.handle(mockReq('/api/ondemand/workflow/nope'), res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'unknown_workflow_subpath',
    supported: ['execute', 'status', 'logs', 'outputs', 'stream'],
  });
  // No sub-path: not ours (Vercel's literal function owns it) → not-found layer here.
  const bare = mockRes();
  await api.handle(mockReq('/api/ondemand/workflow?action=status'), bare);
  assert.equal(bare.statusCode, 404);
  assert.deepEqual(JSON.parse(bare.body), { error: 'Unknown API route' });
});

test('GET /api/ondemand/workflow/stream re-shapes status/logs polling as SSE: open → status → log → done (+ structuredResponse)', async () => {
  const api = await apiPromise;
  await withOndemandKey(async () => {
    const structured = {
      message: 'Two military tracks verified.',
      entities: [],
      actions: [{ name: 'set_layer_visibility', params: { layerId: 'military', enabled: true } }],
      evidence: [],
      sources: [],
      suggestedNextActions: [],
      runMeta: { flowVersion: 1 },
    };
    const upstream = stubUpstream([
      jsonUpstream(200, {
        data: { status: 'success', endedAtInMilliseconds: 1700000001000, timeTakenInMilliseconds: 812 },
      }),
      jsonUpstream(200, {
        data: [
          { timestamp: 1700000000500, nodeKey: 'session_context', message: 'started' },
          { timestamp: 1700000000900, nodeKey: 'structured_response', message: 'done' },
        ],
      }),
      jsonUpstream(200, {
        data: { outputs: { structured_response: { value: JSON.stringify(structured) } } },
      }),
    ]);
    try {
      const res = mockStreamRes();
      await api.handle(
        mockReq('/api/ondemand/workflow/stream?executionId=exec-9'),
        res,
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8');
      assert.equal(res.headers['X-OnDemand-Stream'], 'polling-reshaped');
      const frames = res.body
        .split('\n\n')
        .filter(Boolean)
        .map((block) => {
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          return { event, data: data ? JSON.parse(data) : null };
        });
      assert.deepEqual(
        frames.map((f) => f.event),
        ['open', 'status', 'log', 'log', 'done'],
      );
      assert.equal(frames[1].data.status, 'success');
      assert.equal(frames[2].data.nodeKey, 'session_context');
      assert.equal(frames[3].data.index, 2);
      const done = frames[4].data;
      assert.equal(done.status, 'success');
      assert.equal(done.executionId, 'exec-9');
      assert.equal(done.logCount, 2);
      assert.equal(typeof done.timeToFirstLogMs, 'number');
      assert.equal(done.resume, false);
      assert.equal(done.timeTakenInMilliseconds, 812);
      assert.deepEqual(done.structuredResponse, structured);
      assert.deepEqual(done.nodeKeys, ['structured_response']);
      // One poll cycle (status, logs) + the outputs read — no upstream stream.
      assert.deepEqual(
        upstream.calls.map((c) => c.url.replace(/^.*\/automation\/api/, '')),
        ['/execution/exec-9', '/execution/exec-9/logs', '/execution/exec-9/node/outputs'],
      );
    } finally {
      upstream.restore();
    }
  });
});

test('GET /api/ondemand/workflow/stream requires executionId (400) and only GET (405)', async () => {
  const api = await apiPromise;
  const missing = mockStreamRes();
  await api.handle(mockReq('/api/ondemand/workflow/stream'), missing);
  assert.equal(missing.statusCode, 400);
  assert.equal(JSON.parse(missing.body).error, 'executionId_required');
  const post = mockStreamRes();
  await api.handle(
    mockReq('/api/ondemand/workflow/stream?executionId=x', { method: 'POST' }),
    post,
  );
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.Allow, 'GET');
});

test('streamExecution polls with the injected sleep until terminal, dedupes logs and reports its own timeout budget', async () => {
  const { streamExecution } = await import('./ondemand-workflow-mount.js');
  const answers = [
    // poll 1
    { status: 200, json: { data: { status: 'executing' } } },
    { status: 200, json: { data: [{ timestamp: 1, nodeKey: 'a', message: 'one' }] } },
    // poll 2 (same log again + a new one)
    { status: 200, json: { data: { status: 'executing' } } },
    {
      status: 200,
      json: {
        data: [
          { timestamp: 1, nodeKey: 'a', message: 'one' },
          { timestamp: 2, nodeKey: 'b', message: 'two' },
        ],
      },
    },
  ];
  let i = 0;
  const seenUrls = [];
  const fakeHandler = async (req, res) => {
    seenUrls.push(req.url);
    const next = answers[Math.min(i, answers.length - 1)];
    i += 1;
    res.statusCode = next.status;
    res.end(JSON.stringify(next.json));
  };
  let clock = 0;
  const sleeps = [];
  const res = mockStreamRes();
  await streamExecution(
    { method: 'GET', url: '/stream', headers: {}, on() {}, off() {} },
    res,
    {
      handler: fakeHandler,
      executionId: 'exec-t',
      pollMs: 1500,
      maxMs: 2500,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    },
  );
  const events = [...res.body.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(events, ['open', 'status', 'log', 'status', 'log', 'done']);
  assert.deepEqual(sleeps, [1500]);
  const done = JSON.parse(/^event: done\ndata: (.+)$/m.exec(res.body)[1]);
  assert.equal(done.status, 'timeout');
  assert.equal(done.resume, true);
  assert.equal(done.logCount, 2);
  assert.equal(done.timeToFirstLogMs, 0);
  assert.equal(done.structuredResponse, undefined); // no outputs read on timeout
  assert.match(seenUrls[0], /^\/api\/ondemand\/workflow\?executionId=exec-t&action=status$/);
  assert.match(seenUrls[1], /^\/api\/ondemand\/workflow\?executionId=exec-t&action=logs$/);
});
