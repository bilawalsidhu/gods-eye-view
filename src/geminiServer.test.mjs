import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, preview } from 'vite';
import { hostCheckPlugin, resolveAllowedHosts } from '../build/allowedHosts.js';
import { geminiLiveProxy } from '../server/providers/gemini.js';
import { createGeminiTokenHandler } from '../server/providers/gemini/realtime.js';
import {
  GEMINI_TOKEN_ENDPOINT,
  GEMINI_LIVE_WEBSOCKET_URL,
  createGeminiLiveConfig,
} from '../server/providers/gemini/config.js';
import { GEV_REALTIME_TOOLS } from '../server/providers/openai/tools.js';
import { standaloneVoiceTools } from '../server/standalone/voiceTools.js';
import { PROXY_SIGNALS } from './localRequestGate.mjs';

const API_KEY = 'private-gemini-test-key-never-return';
const TOKEN = 'auth_tokens/short-lived-test';
const ISSUED_AT = Date.parse('2026-09-29T12:00:00Z');

async function fixture(t, options = {}) {
  const calls = [];
  const handler = createGeminiTokenHandler({
    resolveApiKey: () => API_KEY,
    resolveModel: () => 'gemini-3.8-live',
    resolveHost: () => '',
    resolveAllowedHosts: () => '',
    resolveRateLimit: () => '0',
    now: () => ISSUED_AT,
    fetchImpl: async (...args) => {
      calls.push(args);
      return Response.json({
        name: TOKEN,
        privateDebug: API_KEY,
        upstreamUrl: GEMINI_TOKEN_ENDPOINT,
      });
    },
    ...options,
  });
  const server = http.createServer((req, res) => void handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const send = (overrides = {}) => {
    const { headers, ...rest } = overrides;
    return fetch(origin, {
      method: 'POST',
      body: '{}',
      ...rest,
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...headers,
      },
    });
  };
  const sendRaw = (overrides = {}) =>
    new Promise((resolve, reject) => {
      const { headers, body = '{}', ...rest } = overrides;
      const req = http.request(
        origin,
        {
          method: 'POST',
          ...rest,
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: res.headers,
              }),
            ),
          );
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  return { calls, origin, send, sendRaw };
}

test('dev and preview install the same bounded Gemini token endpoint', () => {
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    const installed = [];
    geminiLiveProxy()[hook]({
      middlewares: { use: (...args) => installed.push(args) },
    });
    assert.equal(installed.length, 1);
    assert.equal(installed[0][0], '/api/gemini/token');
    assert.equal(typeof installed[0][1], 'function');
  }
});

test('mint locks canonical action schemas and server instructions with no permanent credential in browser data', async (t) => {
  const f = await fixture(t, {
    annotationGuidance: 'Keep existing annotations.',
  });
  const response = await f.send();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const data = await response.json();
  assert.deepEqual(Object.keys(data).sort(), [
    'config',
    'model',
    'token',
    'websocketUrl',
  ]);
  assert.equal(data.token, TOKEN);
  assert.equal(data.model, 'gemini-3.8-live');
  assert.equal(data.websocketUrl, GEMINI_LIVE_WEBSOCKET_URL);
  assert.equal(new URL(data.websocketUrl).search, '');
  assert.equal(JSON.stringify(data).includes(API_KEY), false);
  assert.deepEqual(data.config.generationConfig, {
    responseModalities: ['AUDIO'],
  });
  assert.match(
    data.config.systemInstruction.parts[0].text,
    /Keep existing annotations\./,
  );
  assert.deepEqual(data.config.inputAudioTranscription, {});
  assert.deepEqual(data.config.outputAudioTranscription, {});
  assert.equal(
    data.config.realtimeInputConfig?.automaticActivityDetection?.disabled,
    undefined,
  );
  const functions = data.config.tools[0].functionDeclarations;
  assert.deepEqual(
    functions.map((tool) => tool.name),
    GEV_REALTIME_TOOLS.map((tool) => tool.name),
  );
  for (let i = 0; i < functions.length; i++) {
    assert.equal(functions[i].behavior, 'BLOCKING');
    assert.deepEqual(
      functions[i].parametersJsonSchema,
      GEV_REALTIME_TOOLS[i].parameters,
    );
    assert.equal(functions[i].parameters, undefined);
  }
  const [url, init] = f.calls[0];
  assert.equal(url, GEMINI_TOKEN_ENDPOINT);
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['x-goog-api-key'], API_KEY);
  const request = JSON.parse(init.body);
  assert.equal(request.uses, 1);
  assert.equal(Date.parse(request.expireTime) - ISSUED_AT, 30 * 60_000);
  assert.equal(Date.parse(request.newSessionExpireTime) - ISSUED_AT, 60_000);
  assert.equal(request.fieldMask, undefined);
  assert.equal(request.liveConnectConstraints, undefined);
  assert.deepEqual(request.bidiGenerateContentSetup, {
    model: 'models/gemini-3.8-live',
    ...data.config,
  });
});

test('standalone mints lock the full voice query catalog in both credential and browser setup', async (t) => {
  const tools = standaloneVoiceTools();
  const declarations = tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parametersJsonSchema: parameters,
    behavior: 'BLOCKING',
  }));
  for (const name of ['search_places', 'get_weather', 'get_wind', 'plan_route'])
    assert.ok(
      tools.some((tool) => tool.name === name),
      name,
    );
  assert.ok(tools.length > GEV_REALTIME_TOOLS.length);
  for (const inputMode of ['open-mic', 'push-to-talk']) {
    const f = await fixture(t, { tools });
    const response = await f.send({
      body: JSON.stringify(inputMode === 'open-mic' ? {} : { inputMode }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.config.tools, [
      { functionDeclarations: declarations },
    ]);
    const request = JSON.parse(f.calls[0][1].body);
    assert.deepEqual(request.bidiGenerateContentSetup, {
      model: 'models/gemini-3.8-live',
      ...data.config,
    });
    assert.equal(request.fieldMask, undefined);
    assert.equal(JSON.stringify(data).includes(API_KEY), false);
  }
});

test('missing key and malformed model fail without an upstream request', async (t) => {
  const missing = await fixture(t, { resolveApiKey: () => '' });
  assert.equal((await missing.send()).status, 503);
  assert.equal(missing.calls.length, 0);
  for (const model of [
    '',
    'models/../../secrets',
    'https://attacker.example/model',
    'gemini-live?key=private',
    'x'.repeat(150),
  ]) {
    const f = await fixture(t, { resolveModel: () => model });
    const response = await f.send();
    assert.equal(response.status, 503);
    assert.equal(f.calls.length, 0);
    assert.equal((await response.text()).includes(model || API_KEY), false);
  }
  const valid = await fixture(t, {
    resolveModel: () =>
      ' models/gemini-2.5-flash-native-audio-preview-12-2025 ',
  });
  assert.equal(
    (await (await valid.send()).json()).model,
    'gemini-2.5-flash-native-audio-preview-12-2025',
  );
});

test('only the PTT gesture selects manual activity in the complete locked setup', async (t) => {
  const f = await fixture(t);
  const ordinary = await (await f.send()).json();
  const response = await f.send({
    body: JSON.stringify({ inputMode: 'push-to-talk' }),
  });
  assert.equal(response.status, 200);
  const manual = await response.json();
  assert.deepEqual(manual.config.realtimeInputConfig, {
    automaticActivityDetection: { disabled: true },
  });
  const { realtimeInputConfig, ...shared } = manual.config;
  assert.equal(JSON.stringify(shared), JSON.stringify(ordinary.config));
  assert.equal(
    JSON.stringify(createGeminiLiveConfig(undefined, 'open-mic')),
    JSON.stringify(ordinary.config),
  );
  assert.throws(
    () => createGeminiLiveConfig(undefined, 'unknown'),
    /input mode/,
  );
  const locked = JSON.parse(f.calls[1][1].body);
  assert.deepEqual(locked.bidiGenerateContentSetup, {
    model: 'models/gemini-3.8-live',
    ...manual.config,
  });
  assert.equal(locked.fieldMask, undefined);
  assert.equal(locked.uses, 1);
  assert.equal(Date.parse(locked.newSessionExpireTime) - ISSUED_AT, 60_000);
  assert.equal(Date.parse(locked.expireTime) - ISSUED_AT, 30 * 60_000);
  assert.equal(JSON.stringify(manual).includes(API_KEY), false);
});

test('other methods, missing/cross origins, hostile hosts and cross-site metadata cannot mint', async (t) => {
  const f = await fixture(t);
  for (const method of ['GET', 'OPTIONS', 'PUT', 'DELETE']) {
    const response = await f.send({ method, body: undefined });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  }
  for (const headers of [
    { Origin: '' },
    { Origin: 'null' },
    { Origin: 'https://attacker.example' },
    { Origin: `${f.origin}/path` },
    { Origin: `${f.origin}?key=secret` },
    { Origin: f.origin.replace('http:', 'https:') },
    { Host: 'attacker.example', Origin: 'http://attacker.example' },
    { Host: '127.0.0.1@attacker.example', Origin: 'http://attacker.example' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    assert.equal((await f.sendRaw({ headers })).status, 403);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.send()).status, 200);
});

test('same-origin local and explicitly bound hosts work without trusting forwarded authority', async (t) => {
  const f = await fixture(t, { resolveHost: () => 'demo.example' });
  assert.equal(
    (
      await f.sendRaw({
        headers: {
          Host: 'demo.example:4173',
          Origin: 'http://demo.example:4173',
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.sendRaw({
        headers: { Host: 'gev.local:4173', Origin: 'http://gev.local:4173' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.send({
        headers: {
          Origin: 'https://demo.example',
          'X-Forwarded-Host': 'demo.example',
          'X-Forwarded-Proto': 'https',
        },
      })
    ).status,
    403,
  );
});

test('forwarded requests cannot mint or consume the real socket peer rate cap', async (t) => {
  const f = await fixture(t, { resolveRateLimit: () => '1' });
  assert.equal(
    (await f.send({ headers: { 'X-Forwarded-For': '10.1.1.1' } })).status,
    403,
  );
  assert.equal(
    (await f.send({ headers: { 'X-Forwarded-For': '10.1.1.2' } })).status,
    403,
  );
  assert.equal((await f.send()).status, 200);
  const response = await f.send();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(f.calls.length, 1);
});

test('all shared proxy signals and same-site cross-origin metadata fail before minting', async (t) => {
  const f = await fixture(t, { resolveRateLimit: () => '1' });
  for (const header of PROXY_SIGNALS) {
    assert.equal(
      (await f.sendRaw({ headers: { [header]: 'untrusted' } })).status,
      403,
      header,
    );
  }
  assert.equal(
    (await f.sendRaw({ headers: { 'Sec-Fetch-Site': 'same-site' } })).status,
    403,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.sendRaw({ headers: { 'Sec-Fetch-Site': 'same-origin' } })).status,
    200,
  );
  assert.equal((await f.send()).status, 429);
  assert.equal(f.calls.length, 1);
});

test('LAN binding, exact configured hosts, IPs, and localhost subdomains follow the app host policy', async (t) => {
  const f = await fixture(t, {
    resolveHost: () => '0.0.0.0',
    resolveAllowedHosts: () => 'gev.local, demo.example',
  });
  for (const host of [
    'gev.local:4173',
    'demo.example:4173',
    '192.168.1.20:4173',
    '[::1]:4173',
    'demo.localhost:4173',
  ]) {
    assert.equal(
      (await f.sendRaw({ headers: { Host: host, Origin: `http://${host}` } }))
        .status,
      200,
      host,
    );
  }
  for (const host of ['arbitrary.local:4173', 'child.demo.example:4173']) {
    assert.equal(
      (await f.sendRaw({ headers: { Host: host, Origin: `http://${host}` } }))
        .status,
      403,
      host,
    );
  }
  assert.equal(f.calls.length, 5);
});

test('unset, blank, malformed and negative rate limits keep the 30-per-minute cap', async (t) => {
  for (const value of [undefined, '', '  ', '3O', 'Infinity', '-1']) {
    await t.test(String(value), async (t) => {
      const f = await fixture(t, { resolveRateLimit: () => value });
      for (let index = 0; index < 30; index++)
        assert.equal((await f.send()).status, 200, `request ${index + 1}`);
      const response = await f.send();
      assert.equal(response.status, 429);
      assert.equal(response.headers.get('retry-after'), '60');
      assert.equal(f.calls.length, 30);
    });
  }
});

test('a positive fraction applies a real cap and only explicit zero disables it', async (t) => {
  const fractional = await fixture(t, { resolveRateLimit: () => '0.5' });
  assert.equal((await fractional.send()).status, 200);
  assert.equal((await fractional.send()).status, 429);
  assert.equal(fractional.calls.length, 1);
  const unlimited = await fixture(t, { resolveRateLimit: () => '0' });
  for (let index = 0; index < 31; index++)
    assert.equal((await unlimited.send()).status, 200);
  assert.equal(unlimited.calls.length, 31);
});

test('real Vite dev and preview reject hostile hosts before the Gemini middleware', async (t) => {
  for (const mode of ['dev', 'preview']) {
    await t.test(mode, async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), 'gev-gemini-vite-test-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      await mkdir(path.join(root, 'dist'));
      await writeFile(path.join(root, 'index.html'), '<p>isolated fixture</p>');
      await writeFile(
        path.join(root, 'dist/index.html'),
        '<p>isolated fixture</p>',
      );
      let credentialReads = 0;
      let upstreamCalls = 0;
      const allowedHosts = resolveAllowedHosts('gev.local');
      const config = {
        configFile: false,
        envFile: false,
        root,
        logLevel: 'silent',
        // Deliberately put the provider first: enforce: pre must order the gate.
        plugins: [
          geminiLiveProxy({
            realtime: {
              resolveApiKey: () => {
                credentialReads++;
                return '';
              },
              resolveHost: () => '127.0.0.1',
              resolveAllowedHosts: () => 'gev.local',
              fetchImpl: async () => {
                upstreamCalls++;
                throw new Error('No upstream calls are permitted');
              },
            },
          }),
          hostCheckPlugin(),
        ],
        server: { host: '127.0.0.1', port: 0, allowedHosts, hmr: false },
        preview: { host: '127.0.0.1', port: 0, allowedHosts },
      };
      const server =
        mode === 'dev' ? await createServer(config) : await preview(config);
      t.after(() => server.close());
      if (mode === 'dev') await server.listen();
      const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
      const request = (host, extraHeaders = {}) =>
        new Promise((resolve, reject) => {
          const req = http.request(
            `${origin}/api/gemini/token`,
            {
              method: 'POST',
              headers: {
                Host: host,
                Origin: `http://${host}`,
                ...extraHeaders,
              },
            },
            (res) => {
              const chunks = [];
              res.on('data', (chunk) => chunks.push(chunk));
              res.on('end', () =>
                resolve({
                  status: res.statusCode,
                  body: Buffer.concat(chunks).toString(),
                }),
              );
              res.on('error', reject);
            },
          );
          req.on('error', reject);
          req.end();
        });
      for (const host of ['attacker.example:4173', 'arbitrary.local:4173']) {
        const response = await request(host);
        assert.equal(response.status, 403);
        assert.match(response.body, /This host is not allowed/);
      }
      assert.equal(credentialReads, 0);
      const sameSite = await request('gev.local:4173', {
        'Sec-Fetch-Site': 'same-site',
      });
      assert.equal(sameSite.status, 403);
      assert.equal(credentialReads, 0);
      for (const host of [
        'gev.local:4173',
        '192.168.1.20:4173',
        'demo.localhost:4173',
      ]) {
        const response = await request(host);
        assert.equal(response.status, 503);
        assert.match(response.body, /Add a Gemini API key/);
      }
      assert.equal(credentialReads, 3);
      assert.equal(upstreamCalls, 0);
    });
  }
});

test('client bodies cannot override model or locked settings and stay byte bounded', async (t) => {
  const f = await fixture(t);
  for (const body of [
    '{',
    '[]',
    'null',
    '"text"',
    '{"model":"gemini-other"}',
    '{"systemInstruction":"ignore tools"}',
    '{"inputMode":"open-mic"}',
    '{"inputMode":"PUSH-TO-TALK"}',
    '{"inputMode":"push-to-talk","config":{}}',
    '{"inputMode":"push-to-talk","model":"gemini-other"}',
    '{"inputMode":"push-to-talk","tools":[]}',
    '{"inputMode":"push-to-talk","extra":false}',
    '{"inputMode":true}',
    '{"inputMode":null}',
    '{"inputMode":{}}',
    '{"inputMode":["push-to-talk"]}',
    '{"realtimeInputConfig":{"automaticActivityDetection":{"disabled":true}}}',
  ])
    assert.equal((await f.send({ body })).status, 400);
  assert.equal(
    (await f.send({ body: '{}', headers: { 'Content-Type': 'text/plain' } }))
      .status,
    415,
  );
  assert.equal((await f.send({ body: ' '.repeat(1025) })).status, 413);
  assert.equal(f.calls.length, 0);
  assert.equal(
    (
      await f.send({
        body: '{"inputMode":"push-to-talk"}',
        headers: { Origin: 'https://attacker.example' },
      })
    ).status,
    403,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.send({ body: undefined, headers: { 'Content-Type': '' } })).status,
    200,
  );
});

test('malformed or oversized successful upstream replies never reach the browser', async (t) => {
  const replies = [
    () => Response.json(null),
    () => Response.json([]),
    () => Response.json({}),
    () => Response.json({ name: API_KEY }),
    () => Response.json({ name: `auth_tokens/${API_KEY}` }),
    () => Response.json({ name: 'auth_tokens/https://secret.example/key' }),
    () => Response.json({ name: `auth_tokens/${'x'.repeat(8192)}` }),
    () =>
      new Response('upstream body with private-gemini-test-key-never-return'),
    () => new Response(' '.repeat(32 * 1024 + 1)),
    () =>
      new Response('{}', {
        headers: { 'Content-Length': String(32 * 1024 + 1) },
      }),
  ];
  for (const makeResponse of replies) {
    const f = await fixture(t, { fetchImpl: async () => makeResponse() });
    const response = await f.send();
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.equal(body.includes(API_KEY), false);
    assert.equal(body.includes('upstream'), false);
    assert.equal(body.includes('secret.example'), false);
  }
});

test('upstream refusals and network exceptions are normalized and never log secrets', async (t) => {
  const leaked = `${API_KEY} https://generativelanguage.googleapis.com/v1beta/auth_tokens?key=${API_KEY}`;
  const logs = [];
  const originalWarn = console.warn;
  console.warn = (...args) => logs.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });
  for (const [status, expected] of [
    [400, 502],
    [401, 503],
    [403, 503],
    [404, 502],
    [429, 429],
    [500, 502],
    [302, 502],
  ]) {
    const f = await fixture(t, {
      fetchImpl: async () => new Response(leaked, { status }),
    });
    const response = await f.send();
    assert.equal(response.status, expected);
    assert.equal((await response.text()).includes(API_KEY), false);
  }
  const failed = await fixture(t, {
    fetchImpl: async () => {
      throw new Error(leaked);
    },
  });
  assert.equal((await failed.send()).status, 502);
  const redirected = await fixture(t, {
    fetchImpl: async () => {
      const response = Response.json({ name: TOKEN });
      Object.defineProperty(response, 'url', {
        value: 'https://attacker.example/token',
      });
      return response;
    },
  });
  assert.equal((await redirected.send()).status, 502);
  assert.equal(logs.join(' ').includes(API_KEY), false);
});

test('a stalled mint is aborted at the deadline without forwarding error details', async (t) => {
  let cancelled = false;
  const f = await fixture(t, {
    timeoutMs: 30,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            cancelled = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  });
  const response = await f.send();
  assert.equal(response.status, 504);
  assert.equal(cancelled, true);
  assert.deepEqual(await response.json(), {
    error: 'Gemini voice could not connect. Try again.',
  });
});

test('request disconnect cancels its pending mint and cannot publish a late token', async (t) => {
  let started;
  let cancelled;
  let release;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const aborted = new Promise((resolve) => {
    cancelled = resolve;
  });
  const f = await fixture(t, {
    fetchImpl: (_url, { signal }) => {
      signal.addEventListener('abort', cancelled, { once: true });
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const req = http.request(f.origin, {
    method: 'POST',
    headers: { Origin: f.origin },
  });
  req.on('error', () => {});
  req.end();
  await ready;
  req.destroy();
  await aborted;
  release(Response.json({ name: TOKEN }));
  await new Promise((resolve) => setImmediate(resolve));
});

test('timeout also bounds a stalled upstream response body', async (t) => {
  let cancelled = false;
  const f = await fixture(t, {
    timeoutMs: 30,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  assert.equal((await f.send()).status, 504);
  assert.equal(cancelled, true);
});

test('chunked client uploads are capped without starting a mint', async (t) => {
  const f = await fixture(t);
  const response = await f.sendRaw({
    body: ' '.repeat(1025),
    headers: { 'Transfer-Encoding': 'chunked' },
  });
  assert.equal(response.status, 413);
  assert.equal(f.calls.length, 0);
});

test('a partial token request cannot hold the handler beyond its deadline', async (t) => {
  const f = await fixture(t, { timeoutMs: 30 });
  const response = await new Promise((resolve, reject) => {
    const req = http.request(
      f.origin,
      {
        method: 'POST',
        headers: {
          Origin: f.origin,
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        },
      },
      resolve,
    );
    req.on('error', reject);
    t.after(() => req.destroy());
    req.write('{');
  });
  assert.equal(response.statusCode, 504);
  response.resume();
  await once(response, 'end');
  assert.equal(f.calls.length, 0);
});
