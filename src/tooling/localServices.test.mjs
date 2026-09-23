import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { overpassProxy } from 'gods-eye-view/server/providers/overpass';
import { militaryInstallationsProxy } from 'gods-eye-view/server/providers/military-installations';
import {
  regionalBriefProxy,
  weatherEffectsProxy,
} from 'gods-eye-view/server/providers/regional';
import { openAiRealtimeProxy } from 'gods-eye-view/server/providers/openai';
import { keySetupEndpoint } from 'gods-eye-view/server/standalone/key-setup';
import { realtimeInstructions } from '../../server/providers/openai/instructions.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';

function install(plugin, preview = false) {
  const routes = new Map();
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
    restart: async () => {},
  });
  return routes;
}
function request(
  handler,
  {
    method = 'GET',
    url = '/',
    body = '',
    origin = 'http://localhost:4173',
  } = {},
) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(req, {
      method,
      url,
      headers: {
        host: 'localhost:4173',
        origin,
        'content-type': 'application/json',
      },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers[name.toLowerCase()] = value;
      },
      writeHead(status, values) {
        this.statusCode = status;
        for (const [k, v] of Object.entries(values)) this.setHeader(k, v);
      },
      end(body = '') {
        resolve({
          status: this.statusCode,
          headers,
          body: String(body),
          json: () => JSON.parse(String(body)),
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}
function env(t, name, value) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  });
}
function root(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-services-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('standalone service guards run in development and preview without upstream acquisition', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('invalid requests must not fetch');
  });
  for (const preview of [false, true]) {
    for (const [factory, route] of [
      [overpassProxy, '/api/overpass'],
      [militaryInstallationsProxy, '/api/military-installations'],
      [regionalBriefProxy, '/api/regional-brief'],
      [weatherEffectsProxy, '/api/weather-effects'],
    ]) {
      const routes = install(factory(), preview);
      assert.equal(
        (await request(routes.get(route), { method: 'DELETE' })).status,
        405,
      );
      assert.equal(
        (
          await request(routes.get(route), {
            method: route === '/api/overpass' ? 'POST' : 'GET',
          })
        ).status,
        400,
      );
    }
  }
});

test('weather-only requests share upstream work and retain fresh and stale responses', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    assert.equal(new URL(url).hostname, 'api.open-meteo.com');
    if (calls > 1) throw Error('offline');
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({
      current: {
        time: '2026-09-12T12:00',
        temperature_2m: 20,
        weather_code: 0,
        wind_speed_10m: 10,
      },
    });
  });
  const handler = install(weatherEffectsProxy()).get('/api/weather-effects');
  const query = { url: '/?latitude=34.61&longitude=-112.43' };
  const pair = await Promise.all([
    request(handler, query),
    request(handler, query),
  ]);
  assert.deepEqual(pair.map((r) => r.headers['x-weather-effects']).sort(), [
    'INFLIGHT',
    'MISS',
  ]);
  assert.equal(calls, 1);
  assert.equal(
    (await request(handler, query)).headers['x-weather-effects'],
    'HIT',
  );
  now += 6 * 60_000;
  assert.equal(
    (await request(handler, query)).headers['x-weather-effects'],
    'STALE',
  );
});

test('Realtime handler preserves tools and default instructions, isolates supplied annotation guidance, and keeps the upstream key server-side', async (t) => {
  env(t, 'OPENAI_API_KEY', 'fixture-upstream-secret');
  env(t, 'GEV_RATELIMIT_OPENAI_PER_MIN', undefined);
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/realtime/client_secrets');
    assert.equal(
      options.headers.Authorization,
      'Bearer fixture-upstream-secret',
    );
    sent.push(JSON.parse(options.body));
    return Response.json({ value: 'fixture-ephemeral' });
  });
  for (const [options, guidance] of [
    [{}, undefined],
    [
      { annotationGuidance: 'Fixture annotation instruction.' },
      'Fixture annotation instruction.',
    ],
    [{}, undefined],
  ]) {
    const response = await request(
      install(openAiRealtimeProxy(options)).get('/api/realtime/token'),
      { url: '/?tier=unknown' },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-gev-voice-tier'], 'standard');
    assert.equal(response.headers['x-gev-voice-tier-fallback'], '1');
    assert.equal(response.body.includes('fixture-upstream-secret'), false);
    assert.equal(
      sent.at(-1).session.instructions,
      realtimeInstructions(guidance),
    );
    assert.deepEqual(sent.at(-1).session.tools, GEV_REALTIME_TOOLS);
  }
  assert.notEqual(sent[0].session.instructions, sent[1].session.instructions);
  assert.equal(sent[0].session.instructions, sent[2].session.instructions);
});

test('debug logging resolves each supplied application directory independently', async (t) => {
  const first = root(t),
    second = root(t);
  for (const [sourceRoot, marker] of [
    [first, 'first'],
    [second, 'second'],
  ]) {
    const handler = install(openAiRealtimeProxy({ sourceRoot })).get(
      '/api/realtime/debug-log',
    );
    assert.equal(
      (
        await request(handler, {
          method: 'POST',
          body: JSON.stringify({ marker }),
        })
      ).status,
      204,
    );
    const file = path.join(
      sourceRoot,
      '.gev-logs/realtime-conversations.jsonl',
    );
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).marker, marker);
  }
});

test('key setup writes only the supplied application root, retains request guards and stays absent from preview', async (t) => {
  const first = root(t),
    untouched = root(t);
  env(t, 'OPENAI_API_KEY', undefined);
  const plugin = keySetupEndpoint({ sourceRoot: first });
  assert.equal(plugin.apply({}, { command: 'serve', isPreview: true }), false);
  assert.equal(plugin.configurePreviewServer, undefined);
  const routes = install(plugin);
  const handler = routes.get('/api/setup/keys');
  const body = JSON.stringify({
    OPENAI_API_KEY: 'sk-fixture-only-not-a-real-key',
  });
  assert.equal(
    (
      await request(handler, {
        method: 'POST',
        body,
        origin: 'https://example.com',
      })
    ).status,
    403,
  );
  assert.equal(existsSync(path.join(first, '.env')), false);
  const saved = await request(handler, { method: 'POST', body });
  assert.equal(saved.status, 200);
  assert.match(
    readFileSync(path.join(first, '.env'), 'utf8'),
    /OPENAI_API_KEY=sk-fixture-only-not-a-real-key/,
  );
  if (process.platform !== 'win32')
    assert.equal(statSync(path.join(first, '.env')).mode & 0o777, 0o600);
  assert.equal(saved.body.includes('sk-fixture-only-not-a-real-key'), false);
  assert.equal(existsSync(path.join(untouched, '.env')), false);
});

test('Cloudflare test-connection endpoint is local-only, bounded and never relays provider errors', async (t) => {
  const secret = 'fixture-radar-token-never-return-this';
  let tested = 0;
  const routes = install(
    keySetupEndpoint({
      sourceRoot: root(t),
      testProvider: async (provider) => {
        assert.equal(provider, 'cloudflare-radar');
        tested++;
        throw Object.assign(new Error(secret), { code: 'invalid_credentials' });
      },
    }),
  );
  const handler = routes.get('/api/setup/test');
  assert.equal((await request(handler, { method: 'GET' })).status, 405);
  assert.equal(
    (
      await request(handler, {
        method: 'POST',
        body: JSON.stringify({ provider: 'unknown' }),
      })
    ).status,
    400,
  );
  const failed = await request(handler, {
    method: 'POST',
    body: JSON.stringify({ provider: 'cloudflare-radar' }),
  });
  assert.equal(failed.status, 200);
  assert.deepEqual(failed.json(), {
    ok: false,
    message:
      'Cloudflare rejected this token. Check its permissions and replace it in Provider Settings.',
  });
  assert.doesNotMatch(failed.body, /fixture-radar-token|authorization|stack/i);
  assert.equal(tested, 1);
  const oversized = await request(handler, {
    method: 'POST',
    body: 'x'.repeat(1025),
  });
  assert.equal(oversized.status, 413);
});

test('Realtime service configuration selects compatible endpoint/model without forwarding request model IDs or keys', async () => {
  const handler = install(
    openAiRealtimeProxy({
      realtime: {
        endpoint: 'https://voice.example/client-secrets',
        models: { standard: 'configured-model' },
        resolveApiKey: () => 'server-fixture',
        fetchImpl: async (url, options) => {
          assert.equal(url, 'https://voice.example/client-secrets');
          assert.equal(options.redirect, 'error');
          assert.equal(options.headers.Authorization, 'Bearer server-fixture');
          const payload = JSON.parse(options.body);
          assert.equal(payload.session.model, 'configured-model');
          assert.deepEqual(payload.session.tools, GEV_REALTIME_TOOLS);
          return Response.json({ value: 'short-lived-fixture' });
        },
      },
    }),
  ).get('/api/realtime/token');
  const response = await request(handler, {
    url: '/?tier=arbitrary-model&model=other',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), { value: 'short-lived-fixture' });
  assert.equal(response.headers['x-gev-voice-model'], 'configured-model');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.doesNotMatch(response.body, /server-fixture|voice\.example/);
});

test('OpenAI routes answer generically when the upstream or the request fails', async (t) => {
  env(t, 'OPENAI_API_KEY', 'fixture-upstream-secret');
  env(t, 'GEV_RATELIMIT_OPENAI_PER_MIN', undefined);
  const leak =
    'fixture-upstream-secret req_fixture_1234 org-fixture quota exhausted';

  // `data.error.message` is OpenAI's own wording — request ids, organization
  // hints, quota phrasing — and was relayed verbatim whenever upstream was not ok.
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: { message: leak } }, { status: 429 }),
  );
  const summary = await request(
    install(openAiRealtimeProxy()).get('/api/openai/hud-summary'),
    { method: 'POST', body: JSON.stringify({ context: {} }) },
  );
  assert.equal(summary.json().error, 'OpenAI HUD summary request failed');
  assert.equal(summary.body.includes('req_fixture_1234'), false);
  assert.equal(summary.body.includes('fixture-upstream-secret'), false);

  // An HTTP error from the client-secret endpoint carries the same upstream
  // detail, while a successful response must still pass the ephemeral secret.
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: { message: leak } }, { status: 429 }),
  );
  const rejectedToken = await request(
    install(openAiRealtimeProxy()).get('/api/realtime/token'),
  );
  assert.equal(rejectedToken.status, 429);
  assert.equal(
    rejectedToken.headers['content-type'],
    'application/json; charset=utf-8',
  );
  assert.deepEqual(rejectedToken.json(), {
    error: 'Failed to create Realtime token',
  });
  assert.equal(rejectedToken.body.includes('req_fixture_1234'), false);
  assert.equal(rejectedToken.body.includes('fixture-upstream-secret'), false);

  // A network fault surfaced a resolver message naming the upstream host.
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error(`getaddrinfo ENOTFOUND api.openai.com ${leak}`);
  });
  const token = await request(
    install(openAiRealtimeProxy()).get('/api/realtime/token'),
  );
  assert.equal(token.status, 502);
  assert.deepEqual(token.json(), { error: 'Failed to create Realtime token' });
  assert.equal(token.body.includes('api.openai.com'), false);
  assert.equal(token.body.includes('fixture-upstream-secret'), false);
});

test('the debug-log sink stays bounded, rate limited, and quiet about failures', async (t) => {
  const sourceRoot = root(t);
  const handler = install(openAiRealtimeProxy({ sourceRoot })).get(
    '/api/realtime/debug-log',
  );
  const file = path.join(sourceRoot, '.gev-logs/realtime-conversations.jsonl');
  const write = (record) =>
    request(handler, { method: 'POST', body: JSON.stringify(record) });

  // A malformed record is the caller's fault and a 400; neither answer carries
  // the error text, which for a write failure is an errno and an absolute path.
  const malformed = await request(handler, { method: 'POST', body: '{nope' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.json(), {
    error: 'Failed to write Realtime debug log',
  });

  // The limiter is always on, unlike the opt-in one the cost-bearing routes
  // share: 120/min per IP, far above what a voice session writes.
  let limited = null;
  let accepted = 0;
  for (let n = 0; n < 130 && !limited; n += 1) {
    const response = await write({ n });
    if (response.status === 429) limited = response;
    else if (response.status === 204) accepted += 1;
  }
  assert.ok(limited, 'the sink refuses a caller past its per-minute ceiling');
  assert.equal(limited.headers['retry-after'], '60');
  assert.deepEqual(limited.json(), { error: 'Rate limit exceeded' });
  // The limiter counts requests rather than successful writes, so the malformed
  // record above already spent one of the 120 slots.
  assert.equal(accepted, 119);

  // Every accepted record is on disk and parses: the queue serializes appends,
  // so none was lost or truncated by the ones beside it.
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, accepted);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  assert.ok(lines.every((line) => JSON.parse(line).loggedAt));
});

test('an oversized debug-log request receives the fixed error response', async (t) => {
  const handler = install(openAiRealtimeProxy({ sourceRoot: root(t) })).get(
    '/api/realtime/debug-log',
  );
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/realtime/debug-log`,
    { method: 'POST', body: 'x'.repeat(8 * 1024 * 1024 + 1) },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'Failed to write Realtime debug log',
  });
});

test('the debug log rotates instead of growing without bound', async (t) => {
  const sourceRoot = root(t);
  const handler = install(openAiRealtimeProxy({ sourceRoot })).get(
    '/api/realtime/debug-log',
  );
  const file = path.join(sourceRoot, '.gev-logs/realtime-conversations.jsonl');

  // 8 MB bounds one request body; nothing bounded the file until now, so a
  // single page could grow it for as long as the dev server ran. Each record
  // here is ~1 MB, well inside the body cap.
  const pad = 'x'.repeat(1024 * 1024);
  // Seventy-two records force two rotations. The second one replaces an
  // existing `.1`, which requires an explicit removal on Windows.
  for (let n = 0; n < 72; n += 1) {
    assert.equal(
      (
        await request(handler, {
          method: 'POST',
          body: JSON.stringify({ n, pad }),
        })
      ).status,
      204,
    );
  }

  const live = statSync(file).size;
  const previous = statSync(`${file}.1`).size;
  assert.ok(live <= 32 * 1024 * 1024, `live log under the ceiling (${live})`);
  assert.ok(
    live + previous <= 64 * 1024 * 1024,
    'both generations together stay within twice the ceiling',
  );
  // Unrotated, these records would be ~75 MB in one file.
  assert.ok(live + previous < 64 * 1024 * 1024);
  assert.ok(!existsSync(`${file}.2`), 'exactly one generation is retained');
});
