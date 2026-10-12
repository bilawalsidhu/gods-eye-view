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
