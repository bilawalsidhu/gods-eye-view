import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
  responsesBody,
  readCompletedResponse,
  normalizeResponse,
  fetchChatGptModels,
  requestChatGptCompletion,
} from './responses.js';
import {
  createAgentCommandHandler,
  createAgentConfigHandler,
} from '../routes.js';
import { createAgentSession } from '../../../../src/agent/agentLoop.js';
import { buildRequestMessages } from '../../../../src/agent/conversation.js';
import { requestChatCompletion } from '../upstream.js';

const tool = {
  type: 'function',
  function: {
    name: 'zoom_to_globe',
    description: 'Zoom out.',
    parameters: { type: 'object', properties: {} },
  },
};
const reasoning = {
  type: 'reasoning',
  id: 'rs_1',
  encrypted_content: 'opaque-fixture',
  summary: [],
};
const call = {
  type: 'function_call',
  namespace: 'gev',
  id: 'fc_1',
  call_id: 'call_1',
  name: 'zoom_to_globe',
  arguments: '{}',
  status: 'completed',
};
const answer = {
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'Done.' }],
};
function complete(output = [reasoning, call], overrides = {}) {
  return {
    type: 'response.completed',
    response: {
      status: 'completed',
      model: 'account-model',
      output,
      usage: { input_tokens: 15, output_tokens: 4, total_tokens: 19 },
      ...overrides,
    },
  };
}
function stream(
  events,
  { chunkBytes = 17, close = true, onCancel = () => {} } = {},
) {
  const bytes = new TextEncoder().encode(
    events
      .map((e) => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`)
      .join(''),
  );
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += chunkBytes)
          c.enqueue(bytes.slice(i, i + chunkBytes));
        if (close) c.close();
      },
      cancel() {
        onCancel();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
function authentication() {
  const controller = new AbortController();
  return {
    controller,
    status: () => ({ binding: 'binding', configured: true }),
    assertBinding(binding) {
      assert.equal(binding, 'binding');
    },
    async lease(binding) {
      this.assertBinding(binding);
      return { token: 'private-oauth-token', signal: controller.signal };
    },
  };
}

function request(body, host = 'localhost:4173', remoteAddress = '127.0.0.1') {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST',
    headers: { host },
    socket: { remoteAddress },
    url: '/',
  });
}
function response() {
  const res = new EventEmitter();
  return Object.assign(res, {
    statusCode: 200,
    writableEnded: false,
    setHeader() {},
    end(body) {
      this.body = body;
      this.writableEnded = true;
    },
    getJson() {
      return JSON.parse(this.body);
    },
  });
}

const options = () => ({
  auth: authentication(),
  binding: 'binding',
  model: 'account-model',
  messages: [
    { role: 'system', content: 'server manual' },
    { role: 'user', content: 'zoom out' },
  ],
  tools: [tool],
});

test('Responses body uses only supported fields, namespaces, manual and full paired history', () => {
  const message = normalizeResponse(
    complete().response,
    'account-model',
  ).message;
  const messages = buildRequestMessages({
    instructions: 'server manual',
    messages: [
      { role: 'system', content: 'client injection' },
      { role: 'user', content: 'zoom' },
      message,
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    ],
  });
  const body = responsesBody({
    model: 'account-model',
    messages,
    tools: [tool],
  });
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, 'server manual');
  assert.equal(body.tools[0].type, 'namespace');
  assert.equal(body.tools[0].name, 'gev');
  assert.equal(body.tools[0].tools[0].strict, false);
  assert.deepEqual(body.input, [
    { role: 'user', content: 'zoom' },
    reasoning,
    {
      type: 'function_call',
      call_id: 'call_1',
      namespace: 'gev',
      name: 'zoom_to_globe',
      arguments: '{}',
    },
    { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
  ]);
  for (const key of [
    'previous_response_id',
    'temperature',
    'max_output_tokens',
    'conversation',
    'background',
    'metadata',
  ])
    assert.equal(key in body, false);
});

test('catalog uses OAuth models envelope, visible entries and server order with unknown price', async () => {
  const auth = authentication();
  const result = await fetchChatGptModels({
    auth,
    binding: 'binding',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/models');
      assert.equal(init.headers.Authorization, 'Bearer private-oauth-token');
      return Response.json({
        models: [
          { visibility: 'list', slug: 'z-model', display_name: 'Z' },
          { visibility: 'hidden', slug: 'hidden' },
          { visibility: 'list', slug: 'a-model', display_name: 'A' },
        ],
      });
    },
  });
  assert.deepEqual(
    result.models.map((m) => [m.id, m.label, m.pricing]),
    [
      ['z-model', 'Z', null],
      ['a-model', 'A', null],
    ],
  );
});

test('completed SSE is parsed across arbitrary byte boundaries and maps usage', async () => {
  const result = await requestChatGptCompletion({
    ...options(),
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer private-oauth-token');
      return stream(
        [
          { type: 'response.output_item.done', item: reasoning },
          complete([
            { ...reasoning, encrypted_content: null },
            call,
            {
              ...answer,
              content: [{ type: 'output_text', text: 'Asunción 🌎' }],
            },
          ]),
        ],
        { chunkBytes: 1 },
      );
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.message.content, 'Asunción 🌎');
  assert.equal(result.message.tool_calls[0].id, 'call_1');
  assert.deepEqual(result.message.response_reasoning, [reasoning]);
  assert.deepEqual(result.usage, {
    prompt_tokens: 15,
    completion_tokens: 4,
    total_tokens: 19,
  });
});

for (const [label, events, status] of [
  [
    'quota after delta',
    [
      { type: 'response.function_call_arguments.delta', delta: '{}' },
      {
        type: 'response.failed',
        response: {
          error: {
            code: 'subscription_sharing_usage_limit_exceeded',
            message: 'private-oauth-token',
          },
        },
      },
    ],
    429,
  ],
  [
    'unavailable plan',
    [
      {
        type: 'response.failed',
        response: { error: { code: 'subscription_sharing_usage_unavailable' } },
      },
    ],
    403,
  ],
  ['incomplete', [{ type: 'response.incomplete' }], 502],
  [
    'explicit error',
    [{ type: 'error', code: 'unknown', message: 'private-oauth-token' }],
    502,
  ],
  [
    'truncated stream',
    [{ type: 'response.output_item.done', item: call }],
    502,
  ],
])
  test(`${label} fails closed with no tool dispatch or API-key fallback`, async () => {
    let requests = 0;
    const result = await requestChatGptCompletion({
      ...options(),
      fetchImpl: async () => {
        requests += 1;
        return stream(events);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.equal(result.message, undefined);
    assert.equal(requests, 1);
    assert.doesNotMatch(result.error, /private-oauth-token/);
  });

test('stream body cap and abort cancel readers that never close', async () => {
  let cancelled = 0;
  const c = new AbortController();
  await assert.rejects(
    readCompletedResponse(
      stream([complete()], { close: false, onCancel: () => cancelled++ }),
      c.signal,
      5,
    ),
    /size limit/,
  );
  const pending = readCompletedResponse(
    stream([], { close: false, onCancel: () => cancelled++ }),
    c.signal,
  );
  c.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(cancelled, 2);
});

test('terminal reply rejects foreign namespaces, duplicate IDs and hosted tools', () => {
  for (const output of [
    [{ ...call, namespace: 'shell' }],
    [call, call],
    [{ type: 'web_search_call' }],
    [{ ...reasoning, encrypted_content: '' }, call],
  ]) {
    assert.throws(() => normalizeResponse(complete(output).response, 'm'));
  }
});

test('validated GEV action round trip preserves opaque reasoning; provider/account pinned for all rounds', async () => {
  const auth = authentication();
  const upstream = [];
  const handler = createAgentCommandHandler({
    chatgpt: auth,
    env: {},
    limiter: () => null,
    fetchImpl: async (url, init) => {
      upstream.push(JSON.parse(init.body));
      return stream([
        complete(upstream.length === 1 ? [reasoning, call] : [answer]),
      ]);
    },
  });
  const actions = [];
  const session = createAgentSession({
    runAction: async (name, args) => {
      actions.push({ name, args });
      return { ok: true };
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.binding, 'binding');
      assert.equal(body.provider, 'chatgpt');
      const res = response();
      await handler(request(body), res);
      return Response.json(res.getJson(), { status: res.statusCode });
    },
  });
  const result = await session.send('zoom out', {
    provider: 'chatgpt',
    model: 'account-model',
    binding: 'binding',
  });
  assert.equal(result.ok, true);
  assert.equal(result.content, 'Done.');
  assert.deepEqual(actions, [{ name: 'zoom_to_globe', args: {} }]);
  assert.ok(
    upstream[1].input.some(
      (item) => item.encrypted_content === 'opaque-fixture',
    ),
  );
  assert.ok(
    upstream[1].input.some(
      (item) =>
        item.type === 'function_call_output' && item.call_id === 'call_1',
    ),
  );
  assert.equal(session.usage.promptTokens, 30);
});

test('server rejects arbitrary tool names before browser execution', async () => {
  const handler = createAgentCommandHandler({
    chatgpt: authentication(),
    env: {},
    limiter: () => null,
    fetchImpl: async () => stream([complete([{ ...call, name: 'run_shell' }])]),
  });
  const res = response();
  await handler(
    request({
      provider: 'chatgpt',
      model: 'account-model',
      binding: 'binding',
      messages: [{ role: 'user', content: 'run shell' }],
    }),
    res,
  );
  assert.deepEqual(res.getJson().toolCalls, []);
  assert.equal(res.getJson().toolCallFailed, true);
});

test('disconnect cancels the upstream body and cannot send tool calls afterward', async () => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  let cancelled = false;
  const handler = createAgentCommandHandler({
    chatgpt: authentication(),
    env: {},
    limiter: () => null,
    fetchImpl: async () => {
      started();
      return stream([], {
        close: false,
        onCancel: () => {
          cancelled = true;
        },
      });
    },
  });
  const req = request({
    provider: 'chatgpt',
    model: 'account-model',
    binding: 'binding',
    messages: [{ role: 'user', content: 'zoom' }],
  });
  const res = response();
  const task = handler(req, res);
  await ready;
  res.emit('close');
  await task;
  assert.equal(cancelled, true);
  assert.equal(res.body, undefined);
});

test('ChatGPT catalog/config is hidden from LAN and commands refuse before credential access', async () => {
  let touched = false;
  const chatgpt = {
    status() {
      touched = true;
      return {};
    },
    lease() {
      touched = true;
      throw new Error();
    },
  };
  const config = createAgentConfigHandler({
    chatgpt,
    env: {},
    limiter: () => null,
  });
  const req = request({}, '192.168.1.1:4173', '192.168.1.2');
  req.method = 'GET';
  const res = response();
  config(req, res);
  assert.equal(
    res.getJson().providers.some((p) => p.id === 'chatgpt'),
    false,
  );
  const command = createAgentCommandHandler({
    chatgpt,
    env: {},
    limiter: () => null,
  });
  const denied = response();
  await command(
    request({ provider: 'chatgpt' }, 'localhost:4173', '192.168.1.2'),
    denied,
  );
  assert.equal(denied.statusCode, 403);
  assert.equal(touched, false);
});

test('legacy chat completions never receive opaque Responses state and honor cancellation', async () => {
  const controller = new AbortController();
  const result = requestChatCompletion({
    provider: { id: 'openai' },
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'fixture-api-key',
    model: 'model',
    tools: [tool],
    messages: [
      { role: 'assistant', content: 'ok', response_reasoning: [reasoning] },
    ],
    signal: controller.signal,
    fetchImpl: async (_url, init) => {
      assert.equal(
        JSON.parse(init.body).messages[0].response_reasoning,
        undefined,
      );
      await delay(60_000, undefined, { signal: init.signal });
    },
  });
  controller.abort();
  assert.equal((await result).ok, false);
});
