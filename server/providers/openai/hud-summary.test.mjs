import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createHudSummaryHandler } from './hud-summary.js';
import { HUD_SUMMARY_UNCONFIGURED_CODE } from '../../../src/hudSummaryResponse.js';

const UNCONFIGURED = {
  configured: false,
  code: HUD_SUMMARY_UNCONFIGURED_CODE,
  error: null,
  summary: null,
};

function stubFetch(answer) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(url, init) : answer;
  };
  impl.calls = calls;
  return impl;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function post(handler, context = { place: 'Lisbon' }) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(context))]);
    req.method = 'POST';
    req.url = '/';
    req.headers = {};
    req.socket = {};
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
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('the default configuration still calls OpenAI Responses exactly as before', async () => {
  const fetchImpl = stubFetch(
    json({ output_text: 'Harbor cranes at dusk now' }),
  );
  const response = await post(
    createHudSummaryHandler({
      fetchImpl,
      env: { OPENAI_API_KEY: 'sk-test' },
    }),
  );
  assert.equal(fetchImpl.calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer sk-test');
  assert.equal(fetchImpl.calls[0].body.model, 'gpt-5-nano');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    summary: 'Harbor cranes at dusk now',
    error: null,
  });
});

test('a keyless OpenAI setup keeps returning the graceful capability response', async () => {
  const fetchImpl = stubFetch(json({}));
  const response = await post(createHudSummaryHandler({ fetchImpl, env: {} }));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, UNCONFIGURED);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a local provider answers the HUD line over chat completions, no key', async () => {
  const fetchImpl = stubFetch(
    json({
      choices: [{ message: { content: 'Ships tracked off Lisbon coast.' } }],
    }),
  );
  const response = await post(
    createHudSummaryHandler({
      fetchImpl,
      env: {
        GEV_LLM_PROVIDER: 'ollama',
        GEV_LLM_MODEL: 'llama3.1:8b',
        GEV_LLM_BASE_URL: 'http://127.0.0.1:11434',
      },
    }),
  );
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(call.init.headers.Authorization, undefined);
  assert.equal(call.body.model, 'llama3.1:8b');
  assert.equal(call.body.messages[1].content, '{"place":"Lisbon"}');
  assert.equal(response.statusCode, 200);
  // Still exactly five words, punctuation stripped — the HUD contract is the
  // provider's problem to meet and ours to enforce.
  assert.deepEqual(response.body, {
    summary: 'Ships tracked off Lisbon coast',
    error: null,
  });
});

test('an unreachable local model degrades to the keyless fallback, never a 5xx', async () => {
  for (const answer of [
    new Error('connect ECONNREFUSED 127.0.0.1:11434'),
    json({ error: 'model not found' }, 404),
    json({ choices: [{ message: { content: '' } }] }),
  ]) {
    const response = await post(
      createHudSummaryHandler({
        fetchImpl: stubFetch(answer),
        env: { GEV_LLM_PROVIDER: 'ollama', GEV_LLM_MODEL: 'llama3.1:8b' },
      }),
    );
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, UNCONFIGURED);
  }
});

test('a local provider with no model id never reaches the network', async () => {
  const fetchImpl = stubFetch(json({}));
  const response = await post(
    createHudSummaryHandler({
      fetchImpl,
      env: { GEV_LLM_PROVIDER: 'llamacpp' },
    }),
  );
  assert.equal(fetchImpl.calls.length, 0);
  assert.deepEqual(response.body, UNCONFIGURED);
});

test('a local provider is used even when an OpenAI key happens to be present', async () => {
  const fetchImpl = stubFetch(
    json({ choices: [{ message: { content: 'Local model answered here' } }] }),
  );
  const response = await post(
    createHudSummaryHandler({
      fetchImpl,
      env: {
        OPENAI_API_KEY: 'sk-test',
        GEV_LLM_PROVIDER: 'llamacpp',
        GEV_LLM_MODEL: 'qwen2.5',
      },
    }),
  );
  assert.equal(
    fetchImpl.calls[0].url,
    'http://localhost:8080/v1/chat/completions',
  );
  assert.equal(
    fetchImpl.calls[0].init.headers.Authorization,
    undefined,
    'the OpenAI key must never leak to a local server',
  );
  assert.equal(response.body.summary, 'Local model answered here');
});

test('non-POST is refused', async () => {
  const handler = createHudSummaryHandler({ env: {} });
  const result = await new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body) {
        resolve({ statusCode: this.statusCode, body: JSON.parse(body) });
      },
    };
    handler({ method: 'GET', headers: {}, socket: {} }, res);
  });
  assert.equal(result.statusCode, 405);
});
