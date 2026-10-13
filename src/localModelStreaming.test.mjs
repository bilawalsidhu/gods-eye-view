import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  completeLocalModel,
  localModelProxy,
} from '../server/providers/local-model.js';

const environment = {
  GEV_LLM_PROVIDER: 'generic',
  GEV_LLM_BASE_URL: 'http://127.0.0.1:49380/v1',
  GEV_LLM_MODEL: 'fixture/route',
  GEV_LLM_API_KEY: 'synthetic',
};
const messages = [{ role: 'user', content: 'Synthetic stream test' }];
const tools = [
  {
    name: 'get_current_view_state',
    parameters: { type: 'object', properties: {} },
  },
];
const frame = (delta, finish_reason = null, rest = {}) =>
  `data: ${JSON.stringify({ model: 'fixture/served', choices: [{ index: 0, delta, finish_reason }], ...rest })}\r\n\r\n`;
const finish = frame({}, 'stop') + 'data: [DONE]\r\n\r\n';
function response(text, chunkSize = 7) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize)
          controller.enqueue(bytes.slice(i, i + chunkSize));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
const complete = (text, overrides = {}) =>
  completeLocalModel(
    { messages, tools, onDelta: () => {}, ...overrides },
    {
      environment,
      fetchImpl: async (_, init) => {
        assert.equal(JSON.parse(init.body).stream, true);
        return response(text);
      },
    },
  );

test('fragmented UTF-8, SSE comments, CRLF and accounting frames preserve incremental text and served model', async () => {
  const deltas = [];
  const result = await complete(
    ': OPENROUTER PROCESSING\r\n\r\n' +
      frame({ content: 'Hi 🌍' }) +
      frame({ content: '!' }) +
      frame({}, 'stop') +
      frame({ content: '' }, 'stop', { usage: { total_tokens: 3 } }) +
      'data: [DONE]\r\n\r\n',
    { onDelta: (delta) => deltas.push(delta) },
  );
  assert.equal(result.content, 'Hi 🌍!');
  assert.equal(result.model, 'fixture/served');
  assert.deepEqual(deltas, [
    { content: 'Hi 🌍', model: 'fixture/served' },
    { content: '!', model: 'fixture/served' },
  ]);
});

test('interleaved tool fragments assemble and validate before returning calls', async () => {
  const tool = (index, id, name, args) => ({
    index,
    ...(id ? { id, type: 'function' } : {}),
    function: { ...(name ? { name } : {}), arguments: args },
  });
  const result = await complete(
    frame({
      tool_calls: [
        tool(0, 'call-a', 'get_current_', '{'),
        tool(1, 'call-b', 'get_current_view_state', '{}'),
      ],
    }) +
      frame({ tool_calls: [tool(0, null, 'view_state', '}')] }, 'tool_calls') +
      'data: [DONE]\n\n',
  );
  assert.deepEqual(result.toolCalls, [
    { id: 'call-a', name: 'get_current_view_state', arguments: {} },
    { id: 'call-b', name: 'get_current_view_state', arguments: {} },
  ]);
});

for (const [name, text] of [
  ['missing terminal', frame({ content: 'Partial' })],
  ['missing DONE', frame({ content: 'Partial' }, 'stop')],
  ['missing finish', frame({ content: 'Partial' }) + 'data: [DONE]\n\n'],
  [
    'length limit',
    frame({ content: 'Partial' }, 'length') + 'data: [DONE]\n\n',
  ],
  [
    'midstream upstream error',
    frame({ content: 'Partial' }) +
      frame({}, 'error', { error: { message: 'private gateway internals' } }),
  ],
  ['malformed JSON', 'data: {broken}\n\n'],
  [
    'unvalidated tool',
    frame(
      {
        tool_calls: [
          {
            index: 0,
            id: 'a',
            function: { name: 'not_allowed', arguments: '{}' },
          },
        ],
      },
      'tool_calls',
    ) + 'data: [DONE]\n\n',
  ],
  [
    'invalid tool arguments',
    frame(
      {
        tool_calls: [
          {
            index: 0,
            id: 'a',
            function: { name: 'get_current_view_state', arguments: '{' },
          },
        ],
      },
      'tool_calls',
    ) + 'data: [DONE]\n\n',
  ],
  [
    'data after finish',
    frame({ content: 'hello' }, 'stop') +
      frame({ content: 'late' }) +
      'data: [DONE]\n\n',
  ],
  ['oversized input', ':'.repeat(1024 * 1024 + 1)],
])
  test(`rejects ${name} with a safe error`, async () => {
    await assert.rejects(complete(text), {
      status: 502,
      message: 'Model gateway request failed or returned an invalid response.',
    });
  });

test('aborting a held stream cancels its reader and releases the completion slot', async () => {
  let controller;
  let cancelled = false;
  const abort = new AbortController();
  const deltaReady = Promise.withResolvers();
  const promise = completeLocalModel(
    { messages, signal: abort.signal, onDelta: () => deltaReady.resolve() },
    {
      environment,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(value) {
              controller = value;
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.enqueue(new TextEncoder().encode(frame({ content: 'visible' })));
  await deltaReady.promise;
  abort.abort();
  await assert.rejects(promise, { status: 504 });
  assert.equal(cancelled, true);
  assert.equal(
    (await complete(frame({ content: 'next' }) + finish)).content,
    'next',
  );
});

async function proxy(t, fetchImpl) {
  const routes = new Map();
  localModelProxy({ environment, tools, fetchImpl }).configureServer({
    middlewares: {
      use(path, handler) {
        routes.set(path, handler);
      },
    },
  });
  const server = http.createServer((req, res) => routes.get(req.url)(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/api/local-model/chat`;
}
const post = (url) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, stream: true }),
  });

test('HTTP proxy delivers a delta before the upstream completes, followed by a single validated terminal event', async (t) => {
  let stream;
  const url = await proxy(
    t,
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
            controller.enqueue(
              new TextEncoder().encode(frame({ content: 'First' })),
            );
          },
        }),
      ),
  );
  const res = await post(url);
  assert.match(res.headers.get('content-type'), /application\/x-ndjson/);
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.deepEqual(JSON.parse(first), {
    type: 'delta',
    content: 'First',
    model: 'fixture/served',
  });
  stream.enqueue(
    new TextEncoder().encode(frame({ content: ' last' }) + finish),
  );
  let tail = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    tail += new TextDecoder().decode(chunk.value);
  }
  const events = tail.trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'complete');
  assert.equal(events.at(-1).content, 'First last');
});

test('HTTP proxy emits sanitized terminal failure after partial text without writing headers twice', async (t) => {
  const url = await proxy(t, async () =>
    response(
      frame({ content: 'Partial' }) +
        frame({}, 'error', { error: { message: 'secret-token' } }),
    ),
  );
  const res = await post(url);
  const body = await res.text();
  const events = body.trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    events.map((event) => event.type),
    ['delta', 'error'],
  );
  assert.doesNotMatch(body, /secret-token/);
});

test('HTTP proxy retains actionable status and Retry-After before any deltas', async (t) => {
  const url = await proxy(
    t,
    async () =>
      new Response('secret-token', {
        status: 429,
        headers: { 'Retry-After': '15' },
      }),
  );
  const res = await post(url);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '15');
  assert.equal(
    (await res.json()).error,
    'Model route is rate limited. Try again later.',
  );
});

test('tool continuation permits null identity placeholders but validates final call', async () => {
  const result = await complete(
    frame({
      tool_calls: [
        {
          index: 0,
          id: 'null-fragment',
          type: 'function',
          function: { name: 'get_current_view_state', arguments: '{' },
        },
      ],
    }) +
      frame(
        {
          tool_calls: [
            {
              index: 0,
              id: null,
              type: null,
              function: { name: null, arguments: '}' },
            },
          ],
        },
        'tool_calls',
      ) +
      'data: [DONE]\n\n',
  );
  assert.deepEqual(result.toolCalls, [
    { id: 'null-fragment', name: 'get_current_view_state', arguments: {} },
  ]);
});
