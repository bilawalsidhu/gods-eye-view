import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLlmStatusHandler,
  llmStatusPayload,
  parseLlmStatusQuery,
  probeLlmProvider,
} from './status.js';
import { llmRequestedConfig, llmRuntimeConfig } from './config.js';

const OLLAMA_ENV = { GEV_LLM_PROVIDER: 'ollama' };
const LLAMACPP_ENV = { GEV_LLM_PROVIDER: 'llamacpp' };

/** A fetch stand-in that records its calls and answers from a script. */
function stubFetch(answer) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const result = typeof answer === 'function' ? answer(url, init) : answer;
    if (result instanceof Error) throw result;
    return result;
  };
  impl.calls = calls;
  return impl;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function invoke(handler, { method = 'GET', url = '/' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = new Map();
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers.set(String(name).toLowerCase(), String(value));
      },
      end(body = '') {
        resolve({
          statusCode: this.statusCode,
          headers: Object.fromEntries(headers),
          body: body ? JSON.parse(String(body)) : null,
        });
      },
    };
    Promise.resolve(
      handler({ method, url, headers: {}, socket: {} }, res),
    ).catch(reject);
  });
}

test('an Ollama probe reads /api/tags and lists its models', async () => {
  const fetchImpl = stubFetch(json({ models: [{ name: 'llama3.1:8b' }] }));
  const probe = await probeLlmProvider({
    config: llmRuntimeConfig(OLLAMA_ENV),
    fetchImpl,
  });
  assert.equal(fetchImpl.calls[0].url, 'http://localhost:11434/api/tags');
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
  assert.equal(fetchImpl.calls[0].init.redirect, 'error');
  assert.equal(
    fetchImpl.calls[0].init.headers.Authorization,
    undefined,
    'a local server is never sent a credential',
  );
  assert.deepEqual(probe, {
    reachable: true,
    models: ['llama3.1:8b'],
    endpoint: 'http://localhost:11434/api/tags',
    error: null,
  });
});

test('a llama.cpp probe reads the OpenAI-compatible /v1/models', async () => {
  const fetchImpl = stubFetch(json({ data: [{ id: 'qwen2.5-7b-instruct' }] }));
  const probe = await probeLlmProvider({
    config: llmRuntimeConfig(LLAMACPP_ENV),
    fetchImpl,
  });
  assert.equal(fetchImpl.calls[0].url, 'http://localhost:8080/v1/models');
  assert.deepEqual(probe.models, ['qwen2.5-7b-instruct']);
  assert.equal(probe.reachable, true);
});

test('nothing listening is reported, never thrown', async () => {
  const refused = Object.assign(new Error('fetch failed'), {
    cause: { code: 'ECONNREFUSED' },
  });
  const probe = await probeLlmProvider({
    config: llmRuntimeConfig(OLLAMA_ENV),
    fetchImpl: stubFetch(refused),
  });
  assert.equal(probe.reachable, false);
  assert.deepEqual(probe.models, []);
  assert.equal(probe.error, 'fetch failed');
});

test('a timeout says so in seconds, and a 404 still counts as listening', async () => {
  const timedOut = Object.assign(new Error('The operation was aborted'), {
    name: 'TimeoutError',
  });
  const slow = await probeLlmProvider({
    config: llmRuntimeConfig(OLLAMA_ENV),
    fetchImpl: stubFetch(timedOut),
    timeoutMs: 4000,
  });
  assert.equal(slow.reachable, false);
  assert.match(slow.error, /within 4s/);

  const wrongPath = await probeLlmProvider({
    config: llmRuntimeConfig(LLAMACPP_ENV),
    fetchImpl: stubFetch(json({ error: 'nope' }, 404)),
  });
  assert.equal(wrongPath.reachable, true);
  assert.match(wrongPath.error, /answered 404/);
  assert.deepEqual(wrongPath.models, []);
});

test('a malformed body degrades instead of crashing the handler', async () => {
  const probe = await probeLlmProvider({
    config: llmRuntimeConfig(OLLAMA_ENV),
    fetchImpl: stubFetch(
      new Response('<html>not json</html>', { status: 200 }),
    ),
  });
  assert.equal(probe.reachable, false);
  assert.deepEqual(probe.models, []);
  assert.ok(probe.error);
});

test('hosted OpenAI is probed with the key, and refused without one', async () => {
  const keyless = await probeLlmProvider({
    config: llmRuntimeConfig({}),
    fetchImpl: stubFetch(json({ data: [] })),
  });
  assert.equal(keyless.reachable, false);
  assert.equal(keyless.error, 'OPENAI_API_KEY is not set');

  const fetchImpl = stubFetch(json({ data: [{ id: 'gpt-5-nano' }] }));
  const keyed = await probeLlmProvider({
    config: llmRuntimeConfig({ OPENAI_API_KEY: 'sk-test' }),
    fetchImpl,
  });
  assert.equal(fetchImpl.calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(keyed.models, ['gpt-5-nano']);
});

test('the status payload reports the configured backend plus what was probed', async () => {
  const payload = await llmStatusPayload({
    config: llmRequestedConfig({
      provider: 'llamacpp',
      baseUrl: 'http://127.0.0.1:9000',
      env: OLLAMA_ENV,
    }),
    env: OLLAMA_ENV,
    fetchImpl: stubFetch(json({ data: [{ id: 'local' }] })),
  });
  assert.equal(payload.provider, 'ollama', 'the saved configuration');
  assert.equal(payload.probed.provider, 'llamacpp', 'what was tested');
  assert.equal(payload.probed.endpoint, 'http://127.0.0.1:9000/v1/models');
  assert.equal(payload.reachable, true);
  assert.deepEqual(payload.models, ['local']);
  assert.equal(payload.capabilities.realtimeVoice, false);
  assert.ok(payload.notes.some((note) => /Realtime/.test(note)));
});

test('only a local or private base URL may be probed from a query', () => {
  assert.deepEqual(parseLlmStatusQuery('/?provider=ollama'), {
    provider: 'ollama',
    baseUrl: undefined,
    refusal: null,
  });
  assert.deepEqual(
    parseLlmStatusQuery('/?baseUrl=http%3A%2F%2F192.168.1.9%3A11434'),
    {
      provider: undefined,
      baseUrl: 'http://192.168.1.9:11434',
      refusal: null,
    },
  );
  assert.match(
    parseLlmStatusQuery('/?baseUrl=https%3A%2F%2Fevil.example.com').refusal,
    /local or private-network/,
  );
  assert.match(
    parseLlmStatusQuery('/?baseUrl=file%3A%2F%2F%2Fetc%2Fpasswd').refusal,
    /not an http\(s\) address/,
  );
  assert.match(
    parseLlmStatusQuery('/?provider=anthropic').refusal,
    /Unknown provider/,
  );
});

test('the endpoint answers 200 even when nothing is running, and refuses non-GET', async () => {
  const handler = createLlmStatusHandler({
    env: OLLAMA_ENV,
    fetchImpl: stubFetch(new Error('connect ECONNREFUSED')),
  });
  const down = await invoke(handler);
  assert.equal(down.statusCode, 200);
  assert.equal(down.body.reachable, false);
  assert.deepEqual(down.body.models, []);
  assert.equal(down.headers['cache-control'], 'no-store');
  assert.equal(down.headers['x-frame-options'], 'DENY');

  const posted = await invoke(handler, { method: 'POST' });
  assert.equal(posted.statusCode, 405);
});

test('the endpoint honors its injected admission gate and query refusals', async () => {
  const refused = await invoke(
    createLlmStatusHandler({
      env: OLLAMA_ENV,
      fetchImpl: stubFetch(json({ models: [] })),
      admit: () => ({ ok: false, status: 403, error: 'nope' }),
    }),
  );
  assert.equal(refused.statusCode, 403);
  assert.deepEqual(refused.body, { error: 'nope' });

  const bad = await invoke(
    createLlmStatusHandler({
      env: OLLAMA_ENV,
      fetchImpl: stubFetch(json({ models: [] })),
    }),
    { url: '/?baseUrl=https%3A%2F%2Fapi.openai.com' },
  );
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.error, /local or private-network/);
});
