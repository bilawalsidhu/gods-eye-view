import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_PROVIDERS } from '../../server/providers/agent/registry.js';
import {
  CAPABILITY_PROBE_LIMIT,
  COMPLETION_TIMEOUT_MS,
  LOCAL_COMPLETION_TIMEOUT_MS,
  authHeaders,
  chatCompletionsUrl,
  completionTimeoutFor,
  describeTransportError,
  fetchModels,
  fetchOllamaCapabilities,
  modelsUrl,
  normalizeUpstreamError,
  requestChatCompletion,
} from '../../server/providers/agent/upstream.js';

const openai = AGENT_PROVIDERS.openai;
const openrouter = AGENT_PROVIDERS.openrouter;
const ollama = AGENT_PROVIDERS.ollama;

/**
 * A fetch stand-in that records calls and replays scripted JSON responses.
 *
 * `headers` is modelled because the capped body reader consults
 * content-length before it reads anything, and a script entry may declare one
 * to exercise the size ceiling.
 */
function stubFetch(script) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const entry =
      typeof script === 'function'
        ? script(url, init)
        : script[calls.length - 1];
    if (entry instanceof Error) throw entry;
    const { status = 200, body = {}, contentLength = null } = entry ?? {};
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(
        contentLength === null
          ? {}
          : { 'content-length': String(contentLength) },
      ),
      text: async () => text,
    };
  };
  impl.calls = calls;
  return impl;
}

test('URLs keep a provider filter query and append the completions path', () => {
  assert.equal(
    modelsUrl(openai, 'https://api.openai.com/v1'),
    'https://api.openai.com/v1/models',
  );
  assert.equal(
    modelsUrl(openrouter, 'https://openrouter.ai/api/v1'),
    'https://openrouter.ai/api/v1/models?supported_parameters=tools',
  );
  assert.equal(
    chatCompletionsUrl('http://localhost:11434/v1'),
    'http://localhost:11434/v1/chat/completions',
  );
});

test('a keyless provider sends no Authorization header', () => {
  assert.deepEqual(authHeaders(ollama, null), {
    'Content-Type': 'application/json',
  });
  assert.equal(authHeaders(openai, 'sk-x').Authorization, 'Bearer sk-x');
});

test('OpenRouter attribution identifies the project, not the operator host', () => {
  const headers = authHeaders(openrouter, 'sk-x');
  assert.equal(
    headers['HTTP-Referer'],
    'https://github.com/bilawalsidhu/gods-eye-view',
  );
  assert.equal(headers['X-Title'], "God's Eye View");
  assert.equal(authHeaders(openai, 'sk-x')['HTTP-Referer'], undefined);
});

test('a local provider gets its own budget for a cold model load', () => {
  assert.equal(completionTimeoutFor(ollama), LOCAL_COMPLETION_TIMEOUT_MS);
  assert.equal(completionTimeoutFor(openai), COMPLETION_TIMEOUT_MS);
  assert.equal(completionTimeoutFor(null), COMPLETION_TIMEOUT_MS);
  assert.ok(LOCAL_COMPLETION_TIMEOUT_MS > COMPLETION_TIMEOUT_MS);
});

test('upstream failures never relay the provider wording that carries request ids', () => {
  const body = 'org_abcdef quota exceeded for key sk-live-123 req_xyz';
  for (const status of [401, 403, 404, 429, 500, 503]) {
    const message = normalizeUpstreamError(status, body);
    assert.doesNotMatch(message, /sk-live-123/);
    assert.doesNotMatch(message, /org_abcdef/);
    assert.doesNotMatch(message, /req_xyz/);
  }
  assert.match(normalizeUpstreamError(401, ''), /credentials/);
  assert.match(normalizeUpstreamError(404, ''), /model id/);
  assert.match(normalizeUpstreamError(429, ''), /rate limit/i);
  assert.match(normalizeUpstreamError(503, ''), /HTTP 503/);
});

test('an unclassified 4xx keeps a short snippet so the cause is findable', () => {
  const message = normalizeUpstreamError(
    400,
    '  model  does not\nsupport tools  ',
  );
  assert.equal(
    message,
    'Upstream rejected the request (HTTP 400): model does not support tools',
  );
  assert.match(normalizeUpstreamError(400, ''), /\(HTTP 400\)\.$/);
  assert.match(normalizeUpstreamError(400, 'x'.repeat(500)), /x{240}$/);
});

test('a refused local daemon says so by name and address', () => {
  const error = Object.assign(new Error('fetch failed'), {
    cause: { code: 'ECONNREFUSED' },
  });
  assert.equal(
    describeTransportError(error, {
      provider: ollama,
      baseUrl: 'http://localhost:11434/v1',
    }),
    'Cannot reach Ollama at http://localhost:11434/v1. Is the daemon running?',
  );
  assert.equal(
    describeTransportError(error, { provider: openai }),
    'Cannot reach OpenAI.',
  );
});

test('a timeout and an unknown fault are both described without a stack', () => {
  assert.equal(
    describeTransportError({ name: 'AbortError' }, { provider: openai }),
    'Timed out waiting for OpenAI.',
  );
  assert.equal(
    describeTransportError(new Error('boom'), { provider: openai }),
    'Request to OpenAI failed.',
  );
  assert.equal(
    describeTransportError(new Error('boom')),
    'Request to the provider failed.',
  );
});

test('an OpenAI listing is normalized and its non-chat families removed', async () => {
  const fetchImpl = stubFetch([
    {
      body: {
        data: [
          { id: 'gpt-5-mini' },
          { id: 'whisper-1' },
          { id: 'text-embedding-3-small' },
        ],
      },
    },
  ]);
  const listing = await fetchModels({
    provider: openai,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-x',
    fetchImpl,
  });
  assert.deepEqual(listing, {
    ok: true,
    models: [
      {
        id: 'gpt-5-mini',
        label: 'gpt-5-mini',
        provider: 'openai',
        contextLength: 0,
        supportsTools: true,
        supportsVision: false,
        pricing: null,
      },
    ],
  });
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer sk-x');
});

test('a listing failure reports the sanitized upstream error and no models', async () => {
  const listing = await fetchModels({
    provider: openai,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'bad',
    fetchImpl: stubFetch([{ status: 401, body: 'key sk-live-1 invalid' }]),
  });
  assert.equal(listing.ok, false);
  assert.match(listing.error, /credentials/);
  assert.doesNotMatch(listing.error, /sk-live-1/);
});

test('an unreachable provider reports transport guidance, not an upstream status', async () => {
  const listing = await fetchModels({
    provider: ollama,
    baseUrl: 'http://localhost:11434/v1',
    apiKey: null,
    fetchImpl: stubFetch([
      Object.assign(new Error('fetch failed'), {
        cause: { code: 'ECONNREFUSED' },
      }),
    ]),
  });
  assert.deepEqual(listing, {
    ok: false,
    error:
      'Cannot reach Ollama at http://localhost:11434/v1. Is the daemon running?',
  });
});

test('Ollama models are probed on the native root for capabilities', async () => {
  const fetchImpl = stubFetch((url) => {
    if (url.endsWith('/v1/models'))
      return { body: { data: [{ id: 'qwen3:4b' }] } };
    return {
      body: {
        capabilities: ['tools'],
        model_info: { 'qwen3.context_length': 262144 },
      },
    };
  });
  const listing = await fetchModels({
    provider: ollama,
    baseUrl: 'http://localhost:11434/v1',
    apiKey: null,
    fetchImpl,
  });
  assert.equal(listing.models[0].contextLength, 262144);
  assert.equal(fetchImpl.calls[1].url, 'http://localhost:11434/api/show');
  assert.deepEqual(fetchImpl.calls[1].body, { model: 'qwen3:4b' });
});

test('models beyond the probe budget still appear, just without metadata', async () => {
  const ids = Array.from(
    { length: CAPABILITY_PROBE_LIMIT + 3 },
    (_, index) => ({
      id: `m${index}`,
    }),
  );
  const fetchImpl = stubFetch((url) =>
    url.endsWith('/v1/models')
      ? { body: { data: ids } }
      : { status: 404, body: {} },
  );
  const listing = await fetchModels({
    provider: ollama,
    baseUrl: 'http://localhost:11434/v1',
    apiKey: null,
    fetchImpl,
  });
  assert.equal(listing.models.length, ids.length);
  assert.equal(fetchImpl.calls.length, CAPABILITY_PROBE_LIMIT + 1);
});

test('a probe failure degrades to assumed capabilities, never to a lost model', async () => {
  const probed = await fetchOllamaCapabilities({
    baseUrl: 'http://localhost:11434/v1',
    modelId: 'x',
    fetchImpl: stubFetch([new Error('boom')]),
  });
  assert.equal(probed, null);
  assert.equal(
    await fetchOllamaCapabilities({
      baseUrl: 'http://localhost:11434/v1',
      modelId: 'x',
      fetchImpl: stubFetch([{ status: 404, body: {} }]),
    }),
    null,
  );
});

test('a completion sends the tools and never sends tool_choice', async () => {
  const fetchImpl = stubFetch([
    {
      body: {
        model: 'qwen3:4b',
        choices: [
          {
            message: { role: 'assistant', content: 'Done.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      },
    },
  ]);
  const completion = await requestChatCompletion({
    provider: ollama,
    baseUrl: 'http://localhost:11434/v1',
    apiKey: null,
    model: 'qwen3:4b',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'f' } }],
    fetchImpl,
  });
  assert.deepEqual(completion, {
    ok: true,
    message: { role: 'assistant', content: 'Done.' },
    finishReason: 'stop',
    usage: { prompt_tokens: 12, completion_tokens: 3 },
    model: 'qwen3:4b',
  });
  const [call] = fetchImpl.calls;
  assert.equal(call.body.tool_choice, undefined);
  assert.equal(call.body.tools.length, 1);
  assert.equal(call.init.redirect, 'error');
});

test('an empty tool list is omitted rather than sent as []', async () => {
  const fetchImpl = stubFetch([
    { body: { choices: [{ message: { role: 'assistant', content: 'x' } }] } },
  ]);
  await requestChatCompletion({
    provider: openai,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-x',
    model: 'gpt-5-mini',
    messages: [],
    tools: [],
    fetchImpl,
  });
  assert.equal(fetchImpl.calls[0].body.tools, undefined);
});

test('an upstream reply with no message is a failure, not an empty answer', async () => {
  const completion = await requestChatCompletion({
    provider: openai,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-x',
    model: 'gpt-5-mini',
    messages: [],
    fetchImpl: stubFetch([{ body: { choices: [] } }]),
  });
  assert.equal(completion.ok, false);
  assert.match(completion.error, /no message/);
});

test('a completion failure keeps the upstream status so the route can relay it', async () => {
  const completion = await requestChatCompletion({
    provider: openai,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-x',
    model: 'gpt-5-mini',
    messages: [],
    fetchImpl: stubFetch([{ status: 429, body: 'slow down' }]),
  });
  assert.equal(completion.ok, false);
  assert.equal(completion.status, 429);
  assert.match(completion.error, /rate limit/i);
});

/**
 * A response whose body opens and then never finishes, so the only thing that
 * can end the read is the deadline cancelling it.
 */
function stallingResponse() {
  let release;
  const stalled = new Promise((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    response: {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: () => stalled,
          cancel: async () => release({ done: true }),
          releaseLock: () => {},
        }),
      },
      text: async () => {
        await stalled;
        return '{}';
      },
    },
  };
}

test('the deadline covers the body, not just the headers', async () => {
  // fetch resolves the moment headers arrive, so a timer cleared at that point
  // leaves a stalled body reading forever. This hangs if the controller stops
  // at the headers.
  const stall = stallingResponse();
  const result = await requestChatCompletion({
    provider: openai,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-x',
    model: 'gpt-5-mini',
    messages: [{ role: 'user', content: 'hello' }],
    fetchImpl: async () => stall.response,
    timeoutMs: 20,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Timed out waiting for OpenAI/);
});

test('an oversized listing is a reported failure, not a thrown one', async () => {
  const fetchImpl = stubFetch([
    { status: 200, body: { data: [] }, contentLength: 64 * 1024 * 1024 },
  ]);
  const listing = await fetchModels({
    provider: openai,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-x',
    fetchImpl,
  });
  assert.equal(listing.ok, false);
  assert.match(listing.error, /more data than this server will read/);
});

test('a body that fails mid-read is a reported failure, not a thrown one', async () => {
  // readJsonResponse used to be awaited outside the try/catch, so a truncated
  // body escaped as a rejection and the route answered nothing at all.
  const truncated = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => {
      throw Object.assign(new Error('terminated'), { code: 'ECONNRESET' });
    },
  });
  const completion = await requestChatCompletion({
    provider: openai,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-x',
    model: 'gpt-5-mini',
    messages: [{ role: 'user', content: 'hello' }],
    fetchImpl: truncated,
  });
  assert.equal(completion.ok, false);
  assert.match(completion.error, /Request to OpenAI failed/);

  const listing = await fetchModels({
    provider: openai,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-x',
    fetchImpl: truncated,
  });
  assert.equal(listing.ok, false);
  assert.match(listing.error, /Request to OpenAI failed/);
});

test('an unclassified 4xx relays the upstream complaint without the key', () => {
  const key = 'sk-proj-abcdefghijklmnop';
  const echoed = `{"error":"bad request for Authorization: Bearer ${key}"}`;
  const message = normalizeUpstreamError(400, echoed, { apiKey: key });
  assert.match(message, /bad request/);
  assert.ok(!message.includes(key));
  assert.match(message, /\[redacted\]/);
});

test('a short placeholder key is not treated as a secret to strip', () => {
  const message = normalizeUpstreamError(400, 'model "key" is unknown', {
    apiKey: 'key',
  });
  assert.match(message, /model "key" is unknown/);
});

test('a 4xx relays the provider message without its account identifiers', () => {
  // The exact shape OpenRouter answers a bad model id with. The message is the
  // whole diagnostic value; `user_id` beside it is the operator's account.
  const body = JSON.stringify({
    error: {
      message: 'not-a-real/model-xyz is not a valid model ID',
      code: 400,
    },
    user_id: 'user_3BkOPdSEY2QZXHdfNlcxNr7pCfd',
  });
  const message = normalizeUpstreamError(400, body);
  assert.match(message, /not a valid model ID/);
  assert.ok(!message.includes('user_3BkOPdSEY2QZXHdfNlcxNr7pCfd'));
  assert.ok(!message.includes('user_id'));
});

test('a JSON body with no message of its own contributes no snippet', () => {
  const message = normalizeUpstreamError(
    400,
    JSON.stringify({ request_id: 'req_abc', organization: 'org_private' }),
  );
  assert.equal(message, 'Upstream rejected the request (HTTP 400).');
});
