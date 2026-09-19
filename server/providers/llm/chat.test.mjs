import assert from 'node:assert/strict';
import test from 'node:test';
import { extractChatCompletionText, requestLlmChatText } from './chat.js';
import { llmRuntimeConfig } from './config.js';

const OLLAMA = llmRuntimeConfig({
  GEV_LLM_PROVIDER: 'ollama',
  GEV_LLM_MODEL: 'llama3.1:8b',
});

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

test('reads the assistant text out of every shape a local server returns', () => {
  assert.equal(
    extractChatCompletionText({
      choices: [{ message: { content: '  Sunset over Lisbon docks  ' } }],
    }),
    'Sunset over Lisbon docks',
  );
  assert.equal(
    extractChatCompletionText({
      choices: [{ message: { content: [{ text: 'Port' }, { text: 'view' }] } }],
    }),
    'Port view',
  );
  assert.equal(
    extractChatCompletionText({ choices: [{ text: 'legacy completion' }] }),
    'legacy completion',
  );
  assert.equal(extractChatCompletionText({}), '');
  assert.equal(extractChatCompletionText(null), '');
  assert.equal(
    extractChatCompletionText({ choices: [{ message: { content: '   ' } }] }),
    '',
  );
});

test('posts an OpenAI-compatible chat completion to the local server', async () => {
  const fetchImpl = stubFetch(
    json({ choices: [{ message: { content: 'Five words right here' } }] }),
  );
  const result = await requestLlmChatText({
    config: OLLAMA,
    instructions: 'be brief',
    input: '{"place":"Lisbon"}',
    maxTokens: 64,
    fetchImpl,
  });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.headers.Authorization, undefined);
  assert.equal(call.body.model, 'llama3.1:8b');
  assert.equal(call.body.stream, false);
  assert.equal(call.body.max_tokens, 64);
  assert.deepEqual(call.body.messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: '{"place":"Lisbon"}' },
  ]);
  assert.deepEqual(result, {
    ok: true,
    text: 'Five words right here',
    error: null,
    status: 200,
  });
});

test('a missing model id is refused before any request is made', async () => {
  const fetchImpl = stubFetch(json({}));
  const result = await requestLlmChatText({
    config: llmRuntimeConfig({ GEV_LLM_PROVIDER: 'llamacpp' }),
    instructions: 'x',
    input: 'y',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /GEV_LLM_MODEL/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('every failure resolves; nothing throws into the request handler', async () => {
  const refused = await requestLlmChatText({
    config: OLLAMA,
    instructions: 'x',
    input: 'y',
    fetchImpl: stubFetch(new Error('connect ECONNREFUSED 127.0.0.1:11434')),
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /ECONNREFUSED/);

  const errored = await requestLlmChatText({
    config: OLLAMA,
    instructions: 'x',
    input: 'y',
    fetchImpl: stubFetch(json({ error: 'model not found' }, 500)),
  });
  assert.equal(errored.ok, false);
  assert.match(errored.error, /answered 500/);

  const silent = await requestLlmChatText({
    config: OLLAMA,
    instructions: 'x',
    input: 'y',
    fetchImpl: stubFetch(json({ choices: [] })),
  });
  assert.equal(silent.ok, false);
  assert.match(silent.error, /returned no text/);

  const timedOut = await requestLlmChatText({
    config: OLLAMA,
    instructions: 'x',
    input: 'y',
    fetchImpl: stubFetch(
      Object.assign(new Error('aborted'), { name: 'TimeoutError' }),
    ),
  });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error, /did not answer in time/);
});
