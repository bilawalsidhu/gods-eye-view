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
import { createDebugLogHandler } from '../../server/providers/openai/debug-log.js';
import { attachVoiceResult } from '../voice/speech.js';
import { sanitizeDebugValue } from '../voice/realtimeDiagnostics.js';
import { standaloneVoiceTools } from '../../server/standalone/voiceTools.js';

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
    remoteAddress = '127.0.0.1',
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
      socket: { remoteAddress },
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

test('Realtime handler keeps API key as default and uses OAuth only when requested', async (t) => {
  env(t, 'GEV_RATELIMIT_OPENAI_PER_MIN', undefined);
  let oauthReads = 0;
  const authorizations = [];
  const routes = install(
    openAiRealtimeProxy({
      realtime: {
        resolveApiKey: () => 'fixture-api-key',
        resolveOAuthAccessToken: () => {
          oauthReads += 1;
          return 'fixture-oauth-token';
        },
        fetchImpl: async (_url, options) => {
          authorizations.push(options.headers.Authorization);
          return Response.json({ value: 'fixture-ephemeral' });
        },
      },
    }),
  );
  const token = routes.get('/api/realtime/token');

  const apiResponse = await request(token);
  assert.equal(apiResponse.status, 200);
  assert.equal(apiResponse.headers['x-gev-voice-auth'], 'env');
  assert.equal(oauthReads, 0, 'default cloud voice does not read OAuth');
  assert.equal(authorizations.at(-1), 'Bearer fixture-api-key');

  const oauthResponse = await request(token, { url: '/?auth=oauth' });
  assert.equal(oauthResponse.status, 200);
  assert.equal(oauthResponse.headers['x-gev-voice-auth'], 'codex-oauth');
  assert.equal(oauthReads, 1);
  assert.equal(authorizations.at(-1), 'Bearer fixture-oauth-token');
});

test('a Codex OAuth pin refuses API-key minting without silently switching modes', async (t) => {
  env(t, 'GEV_RATELIMIT_OPENAI_PER_MIN', undefined);
  const authorizations = [];
  const routes = install(
    openAiRealtimeProxy({
      realtime: {
        environment: { GEV_PREFER_CODEX_OAUTH: 'true' },
        resolveApiKey: () => assert.fail('pinned OAuth cannot read an API key'),
        resolveOAuthAccessToken: () => 'fixture-oauth-token',
        fetchImpl: async (_url, options) => {
          authorizations.push(options.headers.Authorization);
          return Response.json({ value: 'fixture-ephemeral' });
        },
      },
    }),
  );
  const token = routes.get('/api/realtime/token');
  const refused = await request(token);
  assert.equal(refused.status, 503);
  assert.equal(refused.json().code, 'CODEX_OAUTH_REQUIRED');
  assert.equal(authorizations.length, 0);
  assert.equal((await request(token, { url: '/?auth=oauth' })).status, 200);
  assert.deepEqual(authorizations, ['Bearer fixture-oauth-token']);
});

test('OAuth status and token minting never expose local OAuth to remote clients', async () => {
  let oauthReads = 0;
  const routes = install(
    openAiRealtimeProxy({
      realtime: {
        resolveOAuthAccessToken: () => {
          oauthReads += 1;
          return 'must-not-be-read-remotely';
        },
        fetchImpl: () =>
          assert.fail('remote OAuth request must not reach OpenAI'),
      },
    }),
  );
  const remote = { remoteAddress: '192.168.1.20' };
  assert.equal(
    (await request(routes.get('/api/realtime/oauth-status'), remote)).status,
    403,
  );
  assert.equal(
    (
      await request(routes.get('/api/realtime/token'), {
        ...remote,
        url: '/?auth=oauth',
      })
    ).status,
    403,
  );
  assert.equal(oauthReads, 0);
});

test('OAuth status reports local sign-in availability without returning the token', async () => {
  const routes = install(
    openAiRealtimeProxy({
      realtime: { resolveOAuthAccessToken: () => 'fixture-oauth-secret' },
    }),
  );
  const response = await request(routes.get('/api/realtime/oauth-status'));
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), { available: true });
  assert.equal(response.body.includes('fixture-oauth-secret'), false);
});

test('OAuth status and token minting report expired sign-in as re-auth required', async () => {
  const expired = () => {
    const error = new Error('ChatGPT sign-in has expired.');
    error.code = 'CODEX_OAUTH_REAUTH_REQUIRED';
    throw error;
  };
  const routes = install(
    openAiRealtimeProxy({
      realtime: {
        resolveOAuthAccessToken: expired,
        fetchImpl: () => assert.fail('expired OAuth must not reach OpenAI'),
      },
    }),
  );

  const status = await request(routes.get('/api/realtime/oauth-status'));
  assert.equal(status.status, 200);
  assert.deepEqual(status.json(), {
    available: false,
    error: 'ChatGPT sign-in has expired.',
    code: 'CODEX_OAUTH_REAUTH_REQUIRED',
    reauthRequired: true,
  });

  const token = await request(routes.get('/api/realtime/token'), {
    url: '/?auth=oauth',
  });
  assert.equal(token.status, 503);
  assert.equal(token.json().code, 'CODEX_OAUTH_REAUTH_REQUIRED');
});

test('OAuth login endpoint shares pending attempts and never exposes credentials', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let starts = 0;
  let spawnReady;
  let exit;
  const plugin = openAiRealtimeProxy({
    realtime: {
      resolveOAuthAccessToken: () => {
        throw new Error('not signed in');
      },
      startOAuthLogin: async () => {
        starts += 1;
        await new Promise((resolve) => {
          spawnReady = resolve;
        });
        return {
          completion: new Promise((resolve) => {
            exit = resolve;
          }),
          cancel() {},
        };
      },
    },
  });
  t.after(plugin.closeBundle);
  const routes = install(plugin);
  const handler = routes.get('/api/realtime/oauth-login');

  const firstRequest = request(handler, { method: 'POST' });
  const concurrent = await request(handler, { method: 'POST' });
  assert.equal(concurrent.status, 202);
  assert.equal(concurrent.json().started, false);
  assert.equal(starts, 1, 'reserve the attempt before awaiting spawn');
  spawnReady();
  const started = await firstRequest;
  assert.equal(started.status, 202);
  assert.deepEqual(started.json(), {
    available: false,
    started: true,
    pending: true,
  });
  assert.equal(starts, 1);

  t.mock.timers.tick(31_000);
  const duplicate = await request(handler, { method: 'POST' });
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.json().pending, true);
  assert.equal(starts, 1, 'rapid retries must not spawn another login');

  const remote = await request(handler, {
    method: 'POST',
    remoteAddress: '192.168.1.20',
  });
  assert.equal(remote.status, 403);
  assert.equal(starts, 1);

  const crossOrigin = await request(handler, {
    method: 'POST',
    origin: 'https://example.com',
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(starts, 1);

  exit({ exitCode: 1 });
  await Promise.resolve();
  const failed = await request(routes.get('/api/realtime/oauth-status'));
  assert.equal(failed.json().loginFailed, true);
  assert.equal(failed.json().code, 'CODEX_OAUTH_LOGIN_FAILED');
});

test('OAuth status follows process completion, permits retry, and checks credential storage', async (t) => {
  let token = null;
  let exit;
  let starts = 0;
  const plugin = openAiRealtimeProxy({
    realtime: {
      resolveOAuthAccessToken: () => token,
      startOAuthLogin: async () => {
        starts += 1;
        return {
          completion: new Promise((resolve) => {
            exit = resolve;
          }),
          cancel() {},
        };
      },
    },
  });
  t.after(plugin.closeBundle);
  const routes = install(plugin);
  const launch = () =>
    request(routes.get('/api/realtime/oauth-login'), { method: 'POST' });
  const status = () => request(routes.get('/api/realtime/oauth-status'));
  await launch();
  exit({ exitCode: 0 });
  await Promise.resolve();
  assert.equal(
    (await status()).json().code,
    'CODEX_OAUTH_STORAGE_UNAVAILABLE',
    'exit success alone is not usable sign-in',
  );
  await launch();
  assert.equal(starts, 2, 'failed attempts can be retried immediately');
  token = 'fixture-private-token';
  exit({ exitCode: 0 });
  await Promise.resolve();
  const ready = await status();
  assert.deepEqual(ready.json(), { available: true });
  assert.equal(ready.body.includes(token), false);
});

test('OAuth login timeout and server shutdown cancel the owned process', async () => {
  let timeout;
  let cancelled = 0;
  let cleared = 0;
  const plugin = openAiRealtimeProxy({
    realtime: {
      resolveOAuthAccessToken: () => null,
      startOAuthLogin: async () => ({
        completion: new Promise(() => {}),
        cancel() {
          cancelled += 1;
        },
      }),
      setTimer(callback, duration) {
        timeout = callback;
        assert.equal(duration, 120_000);
        return 1;
      },
      clearTimer() {
        cleared += 1;
      },
    },
  });
  const routes = install(plugin);
  const launch = () =>
    request(routes.get('/api/realtime/oauth-login'), { method: 'POST' });
  await launch();
  timeout();
  assert.equal(cancelled, 1);
  const status = await request(routes.get('/api/realtime/oauth-status'));
  assert.equal(status.json().code, 'CODEX_OAUTH_LOGIN_TIMEOUT');
  await launch();
  plugin.closeBundle();
  plugin.closeBundle();
  assert.equal(cancelled, 2, 'shutdown is idempotent');
  assert.equal(cleared, 2);
});

test('OAuth launch errors are safe and cross-origin status requests cannot read credentials', async () => {
  let reads = 0;
  const routes = install(
    openAiRealtimeProxy({
      realtime: {
        resolveOAuthAccessToken() {
          reads += 1;
          return null;
        },
        startOAuthLogin: async () => {
          throw new Error('private-token-fixture');
        },
      },
    }),
  );
  const remote = await request(routes.get('/api/realtime/oauth-status'), {
    origin: 'https://example.com',
  });
  assert.equal(remote.status, 403);
  assert.equal(reads, 0);
  const failed = await request(routes.get('/api/realtime/oauth-login'), {
    method: 'POST',
  });
  assert.equal(failed.status, 503);
  assert.equal(failed.json().code, 'CODEX_OAUTH_LOGIN_FAILED');
  assert.equal(failed.body.includes('private-token-fixture'), false);
});

test('a login that spawns after timeout is cancelled and cannot replace a retry', async (t) => {
  let timeout;
  let releaseSpawn;
  let cancelled = 0;
  let launches = 0;
  const plugin = openAiRealtimeProxy({
    realtime: {
      resolveOAuthAccessToken: () => null,
      startOAuthLogin: async () => {
        launches += 1;
        if (launches === 1)
          await new Promise((resolve) => {
            releaseSpawn = resolve;
          });
        return {
          completion: new Promise(() => {}),
          cancel() {
            cancelled += 1;
          },
        };
      },
      setTimer(callback) {
        timeout = callback;
        return 1;
      },
      clearTimer() {},
    },
  });
  t.after(plugin.closeBundle);
  const routes = install(plugin);
  const launch = () =>
    request(routes.get('/api/realtime/oauth-login'), { method: 'POST' });
  const first = launch();
  timeout();
  await launch();
  releaseSpawn();
  await first;
  assert.equal(launches, 2);
  assert.equal(cancelled, 1, 'late process must not become an orphan');
  const status = (
    await request(routes.get('/api/realtime/oauth-status'))
  ).json();
  assert.equal(status.pending, true);
  assert.equal(
    status.loginFailed,
    undefined,
    'the older attempt cannot fail the retry',
  );
});

test('OAuth login endpoint selects an existing local sign-in without launching Codex', async () => {
  const handler = install(
    openAiRealtimeProxy({
      realtime: {
        resolveOAuthAccessToken: () => 'fixture-existing-secret',
        startOAuthLogin: () =>
          assert.fail('existing auth must not launch login'),
      },
    }),
  ).get('/api/realtime/oauth-login');
  const response = await request(handler, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), {
    available: true,
    started: false,
    pending: false,
  });
  assert.equal(response.body.includes('fixture-existing-secret'), false);
});

test('caption transcription is on by default, reported to the client meter, and can be turned off', async (t) => {
  env(t, 'OPENAI_API_KEY', 'fixture-upstream-secret');
  env(t, 'GEV_RATELIMIT_OPENAI_PER_MIN', undefined);
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    sent.push(JSON.parse(options.body));
    return Response.json({ value: 'fixture-ephemeral' });
  });
  for (const [setting, expected] of [
    [undefined, 'gpt-4o-mini-transcribe'],
    ['off', 'off'],
  ]) {
    env(t, 'OPENAI_REALTIME_TRANSCRIBE_MODEL', setting);
    const response = await request(
      install(openAiRealtimeProxy()).get('/api/realtime/token'),
    );
    assert.equal(response.headers['x-gev-voice-transcribe-model'], expected);
    assert.equal(
      sent.at(-1).session.audio.input.transcription?.model ?? 'off',
      expected,
    );
  }
});

test('Realtime sessions carry supplied tools, and the standalone voice adds the catalog queries', async (t) => {
  env(t, 'OPENAI_API_KEY', 'fixture-upstream-secret');
  env(t, 'GEV_RATELIMIT_OPENAI_PER_MIN', undefined);
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    sent.push(JSON.parse(options.body));
    return Response.json({ value: 'fixture-ephemeral' });
  });
  const tools = standaloneVoiceTools();
  const response = await request(
    install(openAiRealtimeProxy({ realtime: { tools } })).get(
      '/api/realtime/token',
    ),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(sent.at(-1).session.tools, tools);
  const names = tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(
    tools.slice(0, GEV_REALTIME_TOOLS.length),
    GEV_REALTIME_TOOLS,
  );
  assert.ok(names.includes('get_weather'));
  assert.ok(names.includes('military_awareness'));
  assert.ok(!names.includes('show_in_gods_eye_view'));
  assert.ok(!names.includes('aircraft_in_area'));
  assert.ok(!names.includes('get_weather_map'));
  // The action of the same name answers satellite passes.
  assert.equal(
    tools.findLast((tool) => tool.name === 'next_satellite_pass'),
    GEV_REALTIME_TOOLS.find((tool) => tool.name === 'next_satellite_pass'),
  );
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

test('GEV_STATE_DIR moves the key store out of the source tree and leaves it alone when unset', async (t) => {
  const source = root(t),
    state = root(t);
  env(t, 'OPENAI_API_KEY', undefined);
  env(t, 'GEV_STATE_DIR', state);
  const handler = install(keySetupEndpoint({ sourceRoot: source })).get(
    '/api/setup/keys',
  );
  const saved = await request(handler, {
    method: 'POST',
    body: JSON.stringify({ OPENAI_API_KEY: 'sk-fixture-only-not-a-real-key' }),
  });
  assert.equal(saved.status, 200);
  assert.match(
    readFileSync(path.join(state, '.env'), 'utf8'),
    /OPENAI_API_KEY=sk-fixture-only-not-a-real-key/,
  );
  assert.equal(existsSync(path.join(source, '.env')), false);
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

test('the debug-log sink omits what people said and tool arguments unless content logging is enabled', async (t) => {
  const nestObject = (value, levels) => {
    let nested = value;
    for (let index = 0; index < levels; index += 1) nested = { nested };
    return nested;
  };
  const nestArray = (value, levels) => {
    let nested = value;
    for (let index = 0; index < levels; index += 1) nested = [nested];
    return nested;
  };
  const records = [
    {
      timestamp: '2026-10-05T00:00:00.000Z',
      sessionId: 'gev-session-1',
      event: 'tool.call',
      status: 'active',
      payload: {
        name: 'analyst_query',
        callId: 'call-1',
        arguments: { location: '12 Elm Street', note: 'meet Alice there' },
      },
    },
    {
      timestamp: '2026-10-05T00:00:01.000Z',
      sessionId: 'gev-session-1',
      event: 'server.event',
      status: 'active',
      payload: {
        type: 'response.function_call_arguments.done',
        eventId: 'event-1',
        responseId: 'response-1',
        payload: {
          type: 'response.function_call_arguments.done',
          event_id: 'event-1',
          response_id: 'response-1',
          item_id: 'item-1',
          output_index: 0,
          call_id: 'call-1',
          name: 'analyst_query',
          arguments: '{"query":"Tokyo Station"}',
        },
      },
    },
    {
      event: 'server.event',
      status: 'active',
      payload: {
        type: 'response.audio_transcript.done',
        transcript: 'my home address is 12 Elm Street',
        text: 'call my sister',
        delta: 'Flying to Tokyo.',
        usage: { input_tokens: 40 },
      },
    },
    {
      event: 'voice.cost',
      status: 'active',
      payload: { delta: 17, total: 41 },
    },
    {
      event: 'tool.call',
      status: 'active',
      payload: { name: 'adjust_camera_zoom', callId: 'call-2', arguments: 2 },
    },
    {
      event: 'deep.object',
      status: 'active',
      payload: nestObject(
        {
          transcript: 'deep-object-transcript-secret',
          arguments: { query: 'deep-object-argument-secret' },
        },
        14,
      ),
    },
    {
      event: 'deep.array',
      status: 'active',
      payload: nestArray(
        {
          transcript: 'deep-array-transcript-secret',
          arguments: { query: 'deep-array-argument-secret' },
        },
        14,
      ),
    },
  ];
  for (const includeContent of [false, true]) {
    const sourceRoot = root(t);
    const handler = createDebugLogHandler({ sourceRoot, includeContent });
    for (const record of records) {
      const response = await request(handler, {
        method: 'POST',
        body: JSON.stringify(record),
      });
      assert.equal(response.status, 204);
    }
    const logged = readFileSync(
      path.join(sourceRoot, '.gev-logs/realtime-conversations.jsonl'),
      'utf8',
    );
    assert.equal(logged.includes('Elm Street'), includeContent);
    assert.equal(logged.includes('call my sister'), includeContent);
    assert.equal(logged.includes('meet Alice there'), includeContent);
    assert.equal(logged.includes('Tokyo Station'), includeContent);
    assert.equal(logged.includes('Flying to Tokyo'), includeContent);
    assert.equal(
      logged.includes('deep-object-transcript-secret'),
      includeContent,
    );
    assert.equal(
      logged.includes('deep-object-argument-secret'),
      includeContent,
    );
    assert.equal(
      logged.includes('deep-array-transcript-secret'),
      includeContent,
    );
    assert.equal(logged.includes('deep-array-argument-secret'), includeContent);
    const [
      toolCall,
      serverEvent,
      transcriptEvent,
      numericDelta,
      numericArguments,
      deepObject,
      deepArray,
    ] = logged
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(toolCall.timestamp, records[0].timestamp);
    assert.equal(toolCall.sessionId, 'gev-session-1');
    assert.equal(toolCall.event, 'tool.call');
    assert.equal(toolCall.status, 'active');
    assert.equal(toolCall.payload.name, 'analyst_query');
    assert.equal(toolCall.payload.callId, 'call-1');
    assert.equal(serverEvent.payload.eventId, 'event-1');
    assert.equal(serverEvent.payload.responseId, 'response-1');
    assert.equal(serverEvent.payload.payload.event_id, 'event-1');
    assert.equal(serverEvent.payload.payload.response_id, 'response-1');
    assert.equal(serverEvent.payload.payload.item_id, 'item-1');
    assert.equal(serverEvent.payload.payload.output_index, 0);
    assert.equal(serverEvent.payload.payload.call_id, 'call-1');
    assert.equal(serverEvent.payload.payload.name, 'analyst_query');
    assert.equal(transcriptEvent.payload.usage.input_tokens, 40);
    assert.equal(numericDelta.payload.delta, 17);
    assert.equal(numericDelta.payload.total, 41);
    if (!includeContent) {
      assert.equal(toolCall.payload.arguments, '[omitted]');
      assert.match(
        serverEvent.payload.payload.arguments,
        /^\[omitted \d+ chars\]$/,
      );
      assert.equal(transcriptEvent.payload.transcript, '[omitted 32 chars]');
      assert.equal(transcriptEvent.payload.text, '[omitted 14 chars]');
      assert.equal(transcriptEvent.payload.delta, '[omitted 16 chars]');
      assert.equal(numericArguments.payload.arguments, '[omitted]');
      assert.equal(
        JSON.stringify(deepObject.payload).includes('[omitted: max depth]'),
        true,
      );
      assert.equal(
        JSON.stringify(deepArray.payload).includes('[omitted: max depth]'),
        true,
      );
    } else {
      assert.deepEqual(
        toolCall.payload.arguments,
        records[0].payload.arguments,
      );
      assert.equal(
        serverEvent.payload.payload.arguments,
        records[1].payload.payload.arguments,
      );
      assert.equal(numericArguments.payload.arguments, 2);
    }
  }
});

test('debug logs omit structured and serialized tool results unless content logging is enabled', async (t) => {
  const secret = 'private-address-fixture';
  const result = attachVoiceResult('fly_to_location', {
    ok: true,
    query: secret,
    label: secret,
    arrived: true,
    // New tool-specific fields must not need their own redaction rule.
    futureField: { nested: [secret] },
  });
  const records = [
    {
      event: 'tool.result',
      payload: { name: 'fly_to_location', callId: 'call-1', result },
    },
    {
      event: 'client.function_call_output',
      payload: {
        message: {
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: 'call-1',
            output: JSON.stringify(result),
          },
        },
      },
    },
    {
      event: 'server.event',
      payload: {
        response: {
          id: 'response-1',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: secret }],
            },
          ],
          usage: { input_tokens: 40, output_tokens: 10 },
        },
      },
    },
  ].map((record) => sanitizeDebugValue(record));
  for (const includeContent of [false, true]) {
    const sourceRoot = root(t);
    const handler = createDebugLogHandler({ sourceRoot, includeContent });
    for (const record of records) {
      const response = await request(handler, {
        method: 'POST',
        body: JSON.stringify(record),
      });
      assert.equal(response.status, 204);
    }
    const logged = readFileSync(
      path.join(sourceRoot, '.gev-logs/realtime-conversations.jsonl'),
      'utf8',
    );
    assert.equal(logged.includes(secret), includeContent);
    const [tool, client, server] = logged.trim().split('\n').map(JSON.parse);
    assert.equal(tool.payload.name, 'fly_to_location');
    assert.equal(tool.payload.callId, 'call-1');
    assert.equal(client.payload.message.item.call_id, 'call-1');
    assert.equal(server.payload.response.id, 'response-1');
    assert.equal(server.payload.response.output[0].type, 'message');
    assert.deepEqual(
      server.payload.response.usage,
      records[2].payload.response.usage,
    );
    if (includeContent) {
      assert.deepEqual(tool.payload.result, result);
      assert.equal(client.payload.message.item.output, JSON.stringify(result));
    } else {
      assert.equal(tool.payload.result, '[omitted]');
      assert.match(
        client.payload.message.item.output,
        /^\[omitted \d+ chars\]$/,
      );
    }
  }
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

  // This limiter has no opt-out, unlike the one the cost-bearing routes share:
  // 120/min per IP, far above what a voice session writes.
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

test('a debug-log record cannot supply its own timestamp', async (t) => {
  const sourceRoot = root(t);
  const handler = install(openAiRealtimeProxy({ sourceRoot })).get(
    '/api/realtime/debug-log',
  );
  const before = Date.now();
  const response = await request(handler, {
    method: 'POST',
    body: JSON.stringify({ loggedAt: '1999-01-01T00:00:00.000Z', note: 'x' }),
  });
  assert.equal(response.status, 204);
  const file = path.join(sourceRoot, '.gev-logs/realtime-conversations.jsonl');
  const [line] = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const record = JSON.parse(line);
  assert.equal(record.note, 'x');
  assert.ok(Date.parse(record.loggedAt) >= before - 1000);
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

test('the voice instructions name only tools the voice session offers', async () => {
  const { coreTools } = await import('../tools/index.js');
  const tools = new Set(standaloneVoiceTools().map((tool) => tool.name));
  const known = new Set([
    ...coreTools.map((tool) => tool.name),
    ...GEV_REALTIME_TOOLS.map((tool) => tool.name),
  ]);
  const named = new Set(
    realtimeInstructions().match(/\b[a-z]+(?:_[a-z]+)+\b/g),
  );
  const missing = [...named].filter(
    (name) => known.has(name) && !tools.has(name),
  );
  assert.deepEqual(missing, []);
});

test('the voice instructions send vessels, however heard, to the ships layer', () => {
  const text = realtimeInstructions();
  assert.match(text, /"vessels" is easily heard as "visuals"/);
  assert.match(text, /set_layer_visibility\{layerId:"ais-live-vessels"\}/);
});
