import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalChatSession } from './localChatSession.js';
import { createVoiceSession } from './session.js';
import { completeLocalModel } from '../../server/providers/local-model.js';

const reply = (content) =>
  Response.json({
    model: 'local/model',
    content,
    toolCalls: [],
    finishReason: 'stop',
  });

test('local text adapter executes a real action, continues with its actual result and emits final text', async () => {
  const requests = [];
  const actions = [];
  const events = [];
  const session = createVoiceSession({
    runner: async (name, args, options) => {
      actions.push({ name, args, options });
      return { ok: true, city: 'London', observed: 'unique-result-token' };
    },
    createAdapter: (hooks) =>
      createLocalChatSession({
        ...hooks,
        fetchImpl: async (url, init) => {
          requests.push({ url, init, body: JSON.parse(init.body) });
          return requests.length === 1
            ? Response.json({
                content: '',
                toolCalls: [
                  { id: 'c1', name: 'get_current_view_state', arguments: {} },
                ],
              })
            : reply('London unique-result-token');
        },
      }),
  });
  session.subscribe((event) => events.push(event));
  await session.start();
  session.sendMapEvent({ country: 'GB', feed: 'synthetic' });
  assert.equal(
    await session.sendText('What is visible?'),
    'London unique-result-token',
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].name, 'get_current_view_state');
  assert.equal(actions[0].options.signal.aborted, false);
  assert.equal(requests[0].url, '/api/local-model/chat');
  assert.equal(requests[0].init.redirect, 'error');
  assert.match(requests[0].body.messages[0].content, /synthetic/);
  assert.equal(
    JSON.parse(requests[1].body.messages.at(-1).content).observed,
    'unique-result-token',
  );
  assert.equal(
    requests[1].body.messages.at(-1).tool_call_id,
    actions[0].options.callId,
  );
  assert.notEqual(actions[0].options.callId, 'c1');
  assert.ok(
    events.some(
      (event) =>
        event.type === 'action-result' && event.result.city === 'London',
    ),
  );
  assert.ok(
    events.some(
      (event) => event.type === 'completion' && event.status === 'completed',
    ),
  );
  assert.equal(
    events.find(
      (event) => event.type === 'transcript' && event.role === 'assistant',
    ).model,
    'local/model',
  );
  session.destroy();
});

test('reused provider IDs stay unique through repeated tool rounds and conversation turns', async () => {
  const histories = [];
  const actionIds = [];
  let providerCalls = 0;
  const tools = [
    {
      name: 'get_current_view_state',
      description: 'Read the current view',
      parameters: { type: 'object', properties: {} },
    },
  ];
  const adapter = createLocalChatSession({
    runAction: async (_name, _args, { callId }) => {
      actionIds.push(callId);
      return { ok: true, city: 'London' };
    },
    fetchImpl: async (_url, init) => {
      const input = JSON.parse(init.body);
      histories.push(input.messages);
      const result = await completeLocalModel(
        { messages: input.messages, tools },
        {
          environment: {
            GEV_LLM_PROVIDER: 'generic',
            GEV_LLM_BASE_URL: 'http://127.0.0.1:4043/v1',
            GEV_LLM_MODEL: 'fixture',
            GEV_LLM_API_KEY: 'test-key',
          },
          fetchImpl: async () => {
            providerCalls++;
            // Two tool rounds, then one answer, repeated on the next user turn.
            const toolTurn = providerCalls % 3 !== 0;
            return Response.json({
              choices: [
                {
                  finish_reason: toolTurn ? 'tool_calls' : 'stop',
                  message: toolTurn
                    ? {
                        content: null,
                        tool_calls: [
                          {
                            id: 'call_0',
                            type: 'function',
                            function: {
                              name: 'get_current_view_state',
                              arguments: '{}',
                            },
                          },
                        ],
                      }
                    : { content: 'London' },
                },
              ],
            });
          },
        },
      );
      return Response.json(result);
    },
  });
  adapter.start();
  assert.equal(await adapter.sendText('Where am I?'), 'London');
  assert.equal(await adapter.sendText('Check again'), 'London');
  assert.equal(providerCalls, 6);
  assert.equal(actionIds.length, 4);
  assert.equal(new Set(actionIds).size, 4);
  const finalHistory = histories.at(-1);
  const announcedIds = finalHistory.flatMap(
    (message) => message.tool_calls?.map((call) => call.id) || [],
  );
  const resultIds = finalHistory
    .filter((message) => message.role === 'tool')
    .map((message) => message.tool_call_id);
  assert.deepEqual(announcedIds, actionIds);
  assert.deepEqual(resultIds, actionIds);
  assert.equal(announcedIds.includes('call_0'), false);
  adapter.stop();
});

test('context-only requests omit tools and reject unexpected action calls', async () => {
  const adapter = createLocalChatSession({
    allowTools: false,
    emit() {},
    runAction: () => assert.fail('No controls allowed'),
    fetchImpl: async (_url, init) => {
      assert.equal(JSON.parse(init.body).tools, false);
      return Response.json({
        content: '',
        toolCalls: [{ id: 'c1', name: 'fly_to_location', arguments: {} }],
      });
    },
  });
  adapter.start();
  await assert.rejects(
    adapter.sendText('Summarize this context'),
    /unavailable/,
  );
});

test('stop cancels in-flight actions and prevents stale results or continuations', async () => {
  let resolveAction;
  let markAction;
  const started = new Promise((resolve) => {
    markAction = resolve;
  });
  const events = [];
  let requests = 0;
  const adapter = createLocalChatSession({
    emit: (event) => events.push(event),
    runAction: async (_name, _args, options) => {
      markAction(options);
      return new Promise((resolve) => {
        resolveAction = resolve;
      });
    },
    fetchImpl: async () => {
      requests++;
      return Response.json({
        content: '',
        toolCalls: [
          { id: 'c1', name: 'get_current_view_state', arguments: {} },
        ],
      });
    },
  });
  adapter.start();
  const turn = adapter.sendText('Read state');
  const options = await started;
  adapter.stop();
  assert.equal(options.signal.aborted, true);
  assert.equal(options.isCurrent(), false);
  resolveAction({ ok: true, city: 'Stale' });
  await assert.rejects(turn, { name: 'AbortError' });
  assert.equal(requests, 1);
  assert.equal(
    events.some(
      (event) => event.type === 'transcript' && event.role === 'assistant',
    ),
    false,
  );
  adapter.start();
  assert.equal(events.at(-1).state, 'listening');
});

test('new turns abort old requests without overwriting the newer result', async () => {
  let firstSignal;
  let release;
  let calls = 0;
  const events = [];
  const adapter = createLocalChatSession({
    emit: (event) => events.push(event),
    allowTools: false,
    fetchImpl: async (_url, init) => {
      calls++;
      if (calls === 1) {
        firstSignal = init.signal;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return reply('New answer');
    },
  });
  adapter.start();
  const previous = adapter.sendText('Old request');
  assert.equal(await adapter.sendText('New request'), 'New answer');
  assert.equal(firstSignal.aborted, true);
  release(reply('Stale answer'));
  await assert.rejects(previous, { name: 'AbortError' });
  assert.deepEqual(
    events
      .filter(
        (event) => event.type === 'transcript' && event.role === 'assistant',
      )
      .map((event) => event.text),
    ['New answer'],
  );
});

test('failed actions are returned honestly and loops are bounded', async () => {
  const requests = [];
  const adapter = createLocalChatSession({
    emit() {},
    runAction: async () => {
      throw new Error('implementation detail');
    },
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json({
        content: '',
        toolCalls: [
          {
            id: `c${requests.length}`,
            name: 'get_current_view_state',
            arguments: {},
          },
        ],
      });
    },
  });
  adapter.start();
  await assert.rejects(adapter.sendText('Repeated action'), /tool-call limit/);
  assert.equal(requests.length, 5);
  assert.deepEqual(JSON.parse(requests[1].messages.at(-1).content), {
    ok: false,
    error: 'The requested app action failed.',
  });
});

test('oversized context, malformed results and disposed sessions fail without claiming success', async () => {
  const lifetime = new AbortController();
  const events = [];
  const adapter = createLocalChatSession({
    signal: lifetime.signal,
    emit: (event) => events.push(event),
    fetchImpl: async () =>
      Response.json({
        content: '',
        toolCalls: [{ id: 'bad', name: 'tool', arguments: 'not-an-object' }],
      }),
    runAction: () => assert.fail('Malformed call'),
  });
  assert.throws(
    () => adapter.sendMapEvent({ text: 'X'.repeat(24001) }),
    /too large/,
  );
  adapter.start();
  await assert.rejects(adapter.sendText('Try a tool'), /Invalid tool/);
  lifetime.abort();
  assert.throws(() => adapter.start(), { name: 'AbortError' });
  assert.equal(
    events.some(
      (event) => event.type === 'completion' && event.status === 'completed',
    ),
    false,
  );
});

const flushStream = () => new Promise((resolve) => setImmediate(resolve));
const encodeEvent = (event) =>
  new TextEncoder().encode(JSON.stringify(event) + '\n');
const terminal = (content = 'A complete answer', toolCalls = []) => ({
  type: 'complete',
  content,
  model: 'fixture/actual-model',
  toolCalls,
  finishReason: toolCalls.length ? 'tool_calls' : 'stop',
});
function streamFixture() {
  let controller;
  let cancelled = 0;
  const response = new Response(
    new ReadableStream({
      start(value) {
        controller = value;
      },
      cancel() {
        cancelled++;
      },
    }),
    { headers: { 'Content-Type': 'application/x-ndjson' } },
  );
  return {
    response,
    event: (value) => controller.enqueue(encodeEvent(value)),
    bytes: (value) => controller.enqueue(value),
    close: () => controller.close(),
    get cancelled() {
      return cancelled;
    },
  };
}

test('streaming emits UTF-8 text before completion, preserves IDs and waits for EOF to confirm', async () => {
  const stream = streamFixture();
  const events = [];
  const session = createLocalChatSession({
    emit: (event) => events.push(event),
    allowTools: false,
    fetchImpl: async (_url, init) => {
      assert.equal(JSON.parse(init.body).stream, true);
      return stream.response;
    },
  });
  session.start();
  const pending = session.sendText('Fixture');
  const bytes = encodeEvent({
    type: 'delta',
    content: '東京 🌍',
    model: 'fixture/first-model',
  });
  for (const byte of bytes) stream.bytes(Uint8Array.of(byte));
  await flushStream();
  let assistant = events.filter(
    (event) => event.type === 'transcript' && event.role === 'assistant',
  );
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].text, '東京 🌍');
  assert.equal(assistant[0].final, false);
  stream.event({
    type: 'delta',
    content: ' live',
    model: 'fixture/actual-model',
  });
  stream.event(terminal('東京 🌍 live'));
  await flushStream();
  assert.equal(
    events.some((event) => event.type === 'completion'),
    false,
  );
  stream.close();
  assert.equal(await pending, '東京 🌍 live');
  assistant = events.filter(
    (event) => event.type === 'transcript' && event.role === 'assistant',
  );
  assert.equal(new Set(assistant.map((event) => event.itemId)).size, 1);
  assert.equal(assistant.at(-1).text, '東京 🌍 live');
  assert.equal(assistant.at(-1).model, 'fixture/actual-model');
  assert.equal(assistant.at(-1).final, true);
  session.stop();
});

test('streamed tool prefaces are discarded and tools wait for the terminal event and EOF', async () => {
  const stream = streamFixture();
  const events = [];
  const actions = [];
  const requests = [];
  const session = createLocalChatSession({
    emit: (event) => events.push(event),
    runAction: async (name) => {
      actions.push(name);
      return { ok: true, observed: 'fixture-result' };
    },
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return requests.length === 1
        ? stream.response
        : reply('Confirmed fixture-result');
    },
  });
  session.start();
  const pending = session.sendText('Read view');
  stream.event({ type: 'delta', content: 'Reading the view…' });
  await flushStream();
  assert.deepEqual(actions, []);
  stream.event(
    terminal('Reading the view…', [
      { id: 't1', name: 'get_current_view_state', arguments: {} },
    ]),
  );
  await flushStream();
  assert.deepEqual(actions, []);
  stream.close();
  assert.equal(await pending, 'Confirmed fixture-result');
  assert.deepEqual(actions, ['get_current_view_state']);
  assert.equal(
    JSON.parse(requests[1].messages.at(-1).content).observed,
    'fixture-result',
  );
  const assistant = events.filter((event) => event.role === 'assistant');
  assert.equal(assistant[1].discard, true);
  assert.equal(assistant[1].itemId, assistant[0].itemId);
  assert.notEqual(assistant.at(-1).itemId, assistant[0].itemId);
  session.stop();
});

for (const kind of [
  'truncated',
  'error',
  'duplicate terminal',
  'delta after terminal',
  'malformed terminal',
]) {
  test(`a ${kind} stream cannot execute tools or claim a complete answer`, async () => {
    const stream = streamFixture();
    const events = [];
    const session = createLocalChatSession({
      emit: (event) => events.push(event),
      runAction: () => assert.fail('No unverified tool execution'),
      fetchImpl: async () => stream.response,
    });
    session.start();
    const pending = session.sendText('Fixture');
    const rejection = assert.rejects(
      pending,
      kind === 'error' ? /rate limited/ : /stream/,
    );
    stream.event({ type: 'delta', content: 'Partial evidence' });
    if (kind === 'error')
      stream.event({
        type: 'error',
        error: 'Model route is rate limited.',
        retryAfterSeconds: 60,
      });
    if (['duplicate terminal', 'delta after terminal'].includes(kind))
      stream.event(
        terminal('', [
          { id: 't1', name: 'get_current_view_state', arguments: {} },
        ]),
      );
    if (kind === 'duplicate terminal') stream.event(terminal());
    if (kind === 'delta after terminal')
      stream.event({ type: 'delta', content: 'late' });
    if (kind === 'malformed terminal')
      stream.bytes(new TextEncoder().encode('{"type":"complete"'));
    stream.close();
    await rejection;
    assert.equal(
      events.filter((event) => event.type === 'transcript').at(-1).incomplete,
      true,
    );
    assert.equal(
      events.some(
        (event) => event.type === 'completion' && event.status === 'completed',
      ),
      false,
    );
    session.stop();
  });
}

test('stop cancels a streaming reader and marks the existing partial incomplete without late actions', async () => {
  const stream = streamFixture();
  const events = [];
  const session = createLocalChatSession({
    emit: (event) => events.push(event),
    runAction: () => assert.fail('No action after cancellation'),
    fetchImpl: async () => stream.response,
  });
  session.start();
  const pending = session.sendText('Fixture');
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  stream.event({ type: 'delta', content: 'Unfinished response' });
  await flushStream();
  session.stop();
  await rejection;
  assert.equal(stream.cancelled, 1);
  const assistant = events.filter((event) => event.role === 'assistant');
  assert.equal(assistant.length, 2);
  assert.equal(assistant[1].incomplete, true);
  assert.equal(assistant[1].itemId, assistant[0].itemId);
});

test('stream byte caps and invalid UTF-8 fail closed and cancel the response', async () => {
  for (const bytes of [new Uint8Array(1024 * 1024 + 1), Uint8Array.of(0xff)]) {
    const stream = streamFixture();
    const session = createLocalChatSession({
      fetchImpl: async () => stream.response,
    });
    session.start();
    const rejection = assert.rejects(session.sendText('Fixture'));
    stream.bytes(bytes);
    await rejection;
    assert.equal(stream.cancelled, 1);
    session.stop();
  }
});

test('a late streaming response after Stop is cancelled before any delta is emitted', async () => {
  const stream = streamFixture();
  const events = [];
  let release;
  const session = createLocalChatSession({
    emit: (event) => events.push(event),
    fetchImpl: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  session.start();
  const rejection = assert.rejects(session.sendText('Fixture'), {
    name: 'AbortError',
  });
  session.stop();
  stream.event({ type: 'delta', content: 'Late untrusted output' });
  release(stream.response);
  await rejection;
  assert.equal(stream.cancelled, 1);
  assert.equal(
    events.some((event) => event.role === 'assistant'),
    false,
  );
});

test('a declared oversized stream is cancelled without reading its body', async () => {
  let cancelled = 0;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled++;
      },
    }),
    {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Content-Length': String(1024 * 1024 + 1),
      },
    },
  );
  const session = createLocalChatSession({ fetchImpl: async () => response });
  session.start();
  await assert.rejects(session.sendText('Fixture'), /stream/);
  assert.equal(cancelled, 1);
  session.stop();
});

test('abort wins even if a nonconforming reader does not settle its pending read on cancellation', async () => {
  let started;
  const reading = new Promise((resolve) => {
    started = resolve;
  });
  let cancelled = 0;
  let released = 0;
  const response = {
    ok: true,
    headers: new Headers({ 'Content-Type': 'application/x-ndjson' }),
    body: {
      getReader: () => ({
        read() {
          started();
          return new Promise(() => {});
        },
        async cancel() {
          cancelled++;
        },
        releaseLock() {
          released++;
        },
      }),
    },
  };
  const session = createLocalChatSession({ fetchImpl: async () => response });
  session.start();
  const rejection = assert.rejects(session.sendText('Fixture'), {
    name: 'AbortError',
  });
  await reading;
  session.stop();
  await rejection;
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
});
