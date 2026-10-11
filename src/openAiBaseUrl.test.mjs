import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import {
  OPENAI_DEFAULT_BASE_URL,
  openAiBaseUrl,
  openAiEndpoint,
  usesCustomOpenAiBaseUrl,
} from '../server/providers/openai/endpoints.js';
import {
  createRealtimeCallsRelayHandler,
  createRealtimeTokenHandler,
} from '../server/providers/openai/realtime.js';
import { openAiRealtimeProxy } from '../server/providers/openai.js';
import { handleHudSummary } from '../server/providers/openai/hud-summary.js';
import { createRealtimeBackend } from './voice/realtimeBackend.js';

const GATEWAY = 'https://gateway.example/v1';

/** Set an env var for one test and put the old value back afterwards. */
function env(t, name, value) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  });
}

// Each test uses its own client address so the module-scoped per-IP OpenAI
// throttle never couples one test's outcome to another's request count.
let nextAddress = 10;
function request(
  handler,
  { url = '/', method = 'POST', headers = {}, body = '', remoteAddress } = {},
) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(req, {
      method,
      url,
      headers: { host: 'localhost:4173', ...headers },
      socket: { remoteAddress: remoteAddress ?? `10.0.0.${nextAddress++}` },
    });
    const resHeaders = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        resHeaders[name.toLowerCase()] = value;
      },
      end(payload = '') {
        resolve({
          status: this.statusCode,
          headers: resHeaders,
          body: String(payload),
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function recordingFetch(reply = () => Response.json({ value: 'minted' })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return reply(url, init);
  };
  return { calls, fetchImpl };
}

test('OPENAI_BASE_URL resolves to a plain base, and anything else to OpenAI', () => {
  assert.equal(openAiBaseUrl({}), OPENAI_DEFAULT_BASE_URL);
  assert.equal(
    openAiBaseUrl({ OPENAI_BASE_URL: '  ' }),
    OPENAI_DEFAULT_BASE_URL,
  );
  assert.equal(openAiBaseUrl({ OPENAI_BASE_URL: `${GATEWAY}/` }), GATEWAY);
  assert.equal(
    openAiBaseUrl({ OPENAI_BASE_URL: 'http://litellm.llm:4000/v1' }),
    'http://litellm.llm:4000/v1',
  );
  for (const bad of [
    'not a url',
    'ftp://gateway.example/v1',
    'https://user:pass@gateway.example/v1',
    'https://gateway.example/v1?key=x',
    'https://gateway.example/v1#x',
  ]) {
    assert.equal(
      openAiBaseUrl({ OPENAI_BASE_URL: bad }),
      OPENAI_DEFAULT_BASE_URL,
      bad,
    );
  }
  assert.equal(usesCustomOpenAiBaseUrl({}), false);
  assert.equal(usesCustomOpenAiBaseUrl({ OPENAI_BASE_URL: GATEWAY }), true);
});

test('OAuth endpoints ignore OPENAI_BASE_URL', () => {
  const environment = { OPENAI_BASE_URL: GATEWAY };
  assert.equal(
    openAiEndpoint('realtime/client_secrets', { environment }),
    `${GATEWAY}/realtime/client_secrets`,
  );
  assert.equal(
    openAiEndpoint('realtime/client_secrets', { environment, oauth: true }),
    `${OPENAI_DEFAULT_BASE_URL}/realtime/client_secrets`,
  );
});

test('without OPENAI_BASE_URL the token is minted at OpenAI and no relay is announced', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const handler = createRealtimeTokenHandler({
    environment: {},
    fetchImpl,
    resolveApiKey: () => 'fixture-openai-key',
  });
  const reply = await request(handler, { method: 'GET' });
  assert.equal(reply.status, 200);
  assert.equal(
    calls[0].url,
    `${OPENAI_DEFAULT_BASE_URL}/realtime/client_secrets`,
  );
  assert.equal(reply.headers['x-gev-realtime-calls'], undefined);
});

test('with OPENAI_BASE_URL the token is minted at the gateway and the relay is announced', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const handler = createRealtimeTokenHandler({
    environment: { OPENAI_BASE_URL: GATEWAY },
    fetchImpl,
    resolveApiKey: () => 'fixture-gateway-key',
  });
  const reply = await request(handler, { method: 'GET' });
  assert.equal(reply.status, 200);
  assert.equal(calls[0].url, `${GATEWAY}/realtime/client_secrets`);
  assert.equal(
    calls[0].init.headers.Authorization,
    'Bearer fixture-gateway-key',
  );
  assert.equal(reply.headers['x-gev-realtime-calls'], '/api/realtime/calls');
});

test('ChatGPT OAuth never sends its bearer to the gateway', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const handler = createRealtimeTokenHandler({
    environment: { OPENAI_BASE_URL: GATEWAY },
    fetchImpl,
    resolveOAuthAccessToken: () => 'fixture-chatgpt-token',
  });
  const reply = await request(handler, {
    method: 'GET',
    url: '/?auth=oauth',
    remoteAddress: '127.0.0.1',
  });
  assert.equal(reply.status, 200);
  assert.equal(
    calls[0].url,
    `${OPENAI_DEFAULT_BASE_URL}/realtime/client_secrets`,
  );
  assert.equal(reply.headers['x-gev-realtime-calls'], undefined);
});

test('the relay forwards the SDP offer and client secret to the gateway', async () => {
  const { calls, fetchImpl } = recordingFetch(
    () => new Response('v=0 answer', { status: 201 }),
  );
  const handler = createRealtimeCallsRelayHandler({
    environment: { OPENAI_BASE_URL: GATEWAY },
    fetchImpl,
  });
  const reply = await request(handler, {
    headers: {
      authorization: 'Bearer minted',
      'content-type': 'application/sdp',
    },
    body: 'v=0 offer',
  });
  assert.equal(reply.status, 201);
  assert.equal(reply.body, 'v=0 answer');
  assert.equal(reply.headers['content-type'], 'application/sdp');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${GATEWAY}/realtime/calls`);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.body, 'v=0 offer');
  assert.deepEqual(calls[0].init.headers, {
    Authorization: 'Bearer minted',
    'Content-Type': 'application/sdp',
  });
});

test('the relay refuses malformed requests before reaching the gateway', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const handler = createRealtimeCallsRelayHandler({
    environment: { OPENAI_BASE_URL: GATEWAY },
    fetchImpl,
  });
  const sdp = { 'content-type': 'application/sdp' };
  const cases = [
    [{ method: 'GET', headers: { ...sdp, authorization: 'Bearer x' } }, 405],
    [
      { headers: { authorization: 'Bearer x', 'content-type': 'text/plain' } },
      415,
    ],
    [{ headers: sdp }, 401],
    [{ headers: { ...sdp, authorization: 'Basic x' } }, 401],
    [
      {
        headers: { ...sdp, authorization: 'Bearer x' },
        body: 'v'.repeat(64 * 1024 + 1),
      },
      413,
    ],
  ];
  for (const [options, status] of cases) {
    assert.equal((await request(handler, options)).status, status);
  }
  assert.equal(calls.length, 0, 'no refused request may reach the gateway');
});

test('a gateway error is reported without relaying its body', async () => {
  const { fetchImpl } = recordingFetch(() =>
    Response.json({ error: 'upstream detail sk-leak' }, { status: 401 }),
  );
  const handler = createRealtimeCallsRelayHandler({
    environment: { OPENAI_BASE_URL: GATEWAY },
    fetchImpl,
  });
  const reply = await request(handler, {
    headers: {
      authorization: 'Bearer expired',
      'content-type': 'application/sdp',
    },
    body: 'v=0',
  });
  assert.equal(reply.status, 401);
  assert.doesNotMatch(reply.body, /sk-leak/);
});

test('the relay route exists only when OPENAI_BASE_URL is set', (t) => {
  const routes = (value) => {
    env(t, 'OPENAI_BASE_URL', value);
    const installed = new Set();
    openAiRealtimeProxy().configureServer({
      middlewares: { use: (route) => installed.add(route) },
      httpServer: null,
    });
    return installed;
  };
  assert.equal(routes(undefined).has('/api/realtime/calls'), false);
  assert.equal(routes(GATEWAY).has('/api/realtime/calls'), true);
});

test('the HUD summary goes to the gateway when OPENAI_BASE_URL is set', async (t) => {
  env(t, 'OPENAI_BASE_URL', GATEWAY);
  env(t, 'OPENAI_API_KEY', 'fixture-gateway-key');
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return Response.json({ output_text: 'three ships near port' });
  };
  const reply = await request(handleHudSummary, {
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(reply.status, 200);
  assert.deepEqual(urls, [`${GATEWAY}/responses`]);
});

test('the browser honours a same-origin relay path and nothing else', async () => {
  const negotiateWith = async (header) => {
    const urls = [];
    const backend = createRealtimeBackend({
      tokenTransport: async () =>
        Response.json(
          { value: 'minted', expires_at: Math.floor(Date.now() / 1000) + 60 },
          header === undefined
            ? undefined
            : { headers: { 'X-GEV-Realtime-Calls': header } },
        ),
      connectionTransport: async (url) => {
        urls.push(url);
        return new Response('answer');
      },
    });
    const credential = await backend.requestToken();
    await backend.negotiate({ credential, offerSdp: 'offer' });
    return urls[0];
  };
  const direct = `${OPENAI_DEFAULT_BASE_URL}/realtime/calls`;
  assert.equal(await negotiateWith(undefined), direct);
  assert.equal(
    await negotiateWith('/api/realtime/calls'),
    '/api/realtime/calls',
  );
  for (const hostile of [
    'https://evil.example/calls',
    '//evil.example/api/realtime/calls',
    '/api/../evil',
    '/elsewhere/calls',
    '/api//x',
  ]) {
    assert.equal(await negotiateWith(hostile), direct, hostile);
  }
});

test('the HUD reasoning effort defaults to minimal, takes a value, and off omits it', async (t) => {
  const { hudSummaryReasoning } =
    await import('../server/providers/openai/hud-summary.js');
  assert.deepEqual(hudSummaryReasoning({}), {
    reasoning: { effort: 'minimal' },
  });
  assert.deepEqual(
    hudSummaryReasoning({ OPENAI_HUD_SUMMARY_REASONING_EFFORT: ' low ' }),
    { reasoning: { effort: 'low' } },
  );
  for (const off of ['off', 'OFF', ' Off ']) {
    assert.deepEqual(
      hudSummaryReasoning({ OPENAI_HUD_SUMMARY_REASONING_EFFORT: off }),
      {},
      off,
    );
  }

  // And the request body follows it.
  env(t, 'OPENAI_BASE_URL', GATEWAY);
  env(t, 'OPENAI_API_KEY', 'fixture-gateway-key');
  env(t, 'OPENAI_HUD_SUMMARY_REASONING_EFFORT', 'off');
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ output_text: 'Port of Rotterdam vessels nominal' });
  };
  const reply = await request(handleHudSummary, {
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(reply.status, 200);
  assert.equal('reasoning' in bodies[0], false);
  assert.equal(bodies[0].max_output_tokens, 100);
});
