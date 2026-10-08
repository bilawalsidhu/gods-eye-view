import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_COMMAND_ENDPOINT,
  AGENT_EVENTS,
  MAX_REQUEST_HISTORY_BYTES,
  MAX_TOOL_ROUNDS,
  createAgentSession,
  emptyUsage,
} from './agentLoop.js';
import { AGENT_REQUEST_MAX_BYTES } from '../../server/providers/agent/routes.js';

/** A relay stand-in that replays scripted turns and records what was posted. */
function stubRelay(turns) {
  const posts = [];
  const impl = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body), signal: init.signal });
    const turn = turns[posts.length - 1];
    if (turn instanceof Error) throw turn;
    const { status = 200, payload } = turn ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  };
  impl.posts = posts;
  return impl;
}

/** One scripted relay turn asking for tool calls. */
function toolTurn(calls, { content = '', usage = null } = {}) {
  return {
    payload: {
      message: {
        role: 'assistant',
        content,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.args ?? {}),
          },
        })),
      },
      toolCalls: calls.map((call) => ({
        id: call.id,
        name: call.name,
        args: call.args ?? {},
      })),
      usage,
      warnings: [],
    },
  };
}

/** One scripted relay turn answering in prose. */
function answerTurn(content, extra = {}) {
  return {
    payload: {
      message: { role: 'assistant', content },
      toolCalls: [],
      usage: null,
      warnings: [],
      ...extra,
    },
  };
}

function collect() {
  const events = [];
  return { events, onEvent: (event) => events.push(event) };
}

test('a session requires a runner, because it cannot execute a tool itself', () => {
  assert.throws(() => createAgentSession({}), TypeError);
  assert.throws(() => createAgentSession({ runAction: 'nope' }), TypeError);
});

test('one command runs every tool the model asked for, then returns the answer', async () => {
  const ran = [];
  const session = createAgentSession({
    runAction: async (name, args) => {
      ran.push([name, args]);
      return { ok: true, action: name };
    },
    fetchImpl: stubRelay([
      toolTurn([
        {
          id: 'c1',
          name: 'set_layer_visibility',
          args: { layerId: 'flights' },
        },
        { id: 'c2', name: 'zoom_to_globe' },
      ]),
      answerTurn('Flights on, globe view.'),
    ]),
  });
  const { events, onEvent } = collect();
  const result = await session.send('flights on and zoom out', { onEvent });

  assert.deepEqual(result, {
    ok: true,
    content: 'Flights on, globe view.',
    rounds: 2,
  });
  assert.deepEqual(ran, [
    ['set_layer_visibility', { layerId: 'flights' }],
    ['zoom_to_globe', {}],
  ]);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      AGENT_EVENTS.MESSAGE,
      AGENT_EVENTS.REQUEST,
      AGENT_EVENTS.TOOL_START,
      AGENT_EVENTS.TOOL_RESULT,
      AGENT_EVENTS.TOOL_START,
      AGENT_EVENTS.TOOL_RESULT,
      AGENT_EVENTS.REQUEST,
      AGENT_EVENTS.MESSAGE,
      AGENT_EVENTS.DONE,
    ],
  );
});

test('the transcript keeps complete tool-call pairs for the next turn', async () => {
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: stubRelay([
      toolTurn([{ id: 'c1', name: 'zoom_to_globe' }]),
      answerTurn('Globe view.'),
    ]),
  });
  await session.send('zoom out');
  assert.deepEqual(
    session.transcript.map((message) => message.role),
    ['user', 'assistant', 'tool', 'assistant'],
  );
  assert.equal(session.transcript[1].tool_calls[0].id, 'c1');
  assert.equal(session.transcript[2].tool_call_id, 'c1');
  assert.equal(JSON.parse(session.transcript[2].content).ok, true);
});

test('the provider, model and transcript are posted to the relay endpoint', async () => {
  const fetchImpl = stubRelay([answerTurn('Hi.')]);
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl,
  });
  await session.send('hello', { provider: 'ollama', model: 'qwen3:4b' });
  assert.equal(fetchImpl.posts[0].url, AGENT_COMMAND_ENDPOINT);
  assert.equal(fetchImpl.posts[0].body.provider, 'ollama');
  assert.equal(fetchImpl.posts[0].body.model, 'qwen3:4b');
  assert.deepEqual(fetchImpl.posts[0].body.messages, [
    { role: 'user', content: 'hello' },
  ]);
});

test('an action that throws becomes a tool result, so the turn can report it', async () => {
  const fetchImpl = stubRelay([
    toolTurn([
      { id: 'c1', name: 'fly_to_location', args: { query: 'Atlantis' } },
    ]),
    answerTurn('I could not fly there.'),
  ]);
  const session = createAgentSession({
    runAction: async () => {
      throw new Error('No such place');
    },
    fetchImpl,
  });
  const { events, onEvent } = collect();
  const result = await session.send('fly to Atlantis', { onEvent });
  assert.equal(result.ok, true);
  const toolResult = events.find(
    (event) => event.type === AGENT_EVENTS.TOOL_RESULT,
  );
  assert.deepEqual(toolResult.result, {
    ok: false,
    action: 'fly_to_location',
    error: 'No such place',
  });
  // The failure reached the model as a result, not as a dead session.
  assert.match(
    fetchImpl.posts[1].body.messages.at(-1).content,
    /No such place/,
  );
});

test('an action returning nothing still reports that it ran', async () => {
  const fetchImpl = stubRelay([
    toolTurn([{ id: 'c1', name: 'zoom_to_globe' }]),
    answerTurn('Globe view.'),
  ]);
  const session = createAgentSession({
    runAction: async () => undefined,
    fetchImpl,
  });
  await session.send('zoom out');
  assert.deepEqual(JSON.parse(session.transcript[2].content), {
    ok: true,
    action: 'zoom_to_globe',
  });
});

test('narration alongside a tool call is surfaced so the console is not silent', async () => {
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: stubRelay([
      toolTurn([{ id: 'c1', name: 'annotate_map' }], {
        content: 'Outlining the grounds.',
      }),
      answerTurn('Done.'),
    ]),
  });
  const { events, onEvent } = collect();
  await session.send('describe the Capitol', { onEvent });
  const spoken = events
    .filter((event) => event.type === AGENT_EVENTS.MESSAGE)
    .map((event) => event.message.content);
  assert.deepEqual(spoken, [
    'describe the Capitol',
    'Outlining the grounds.',
    'Done.',
  ]);
});

test('server warnings reach the console before the answer does', async () => {
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: stubRelay([
      {
        payload: {
          message: { role: 'assistant', content: 'Done.' },
          toolCalls: [],
          warnings: [
            {
              code: 'prefix-truncated',
              message: 'Truncated.',
              remedy: 'Raise it.',
            },
          ],
        },
      },
    ]),
  });
  const { events, onEvent } = collect();
  await session.send('go', { onEvent });
  const types = events.map((event) => event.type);
  assert.ok(
    types.indexOf(AGENT_EVENTS.WARNING) <
      types.lastIndexOf(AGENT_EVENTS.MESSAGE),
  );
  assert.equal(
    events.find((event) => event.type === AGENT_EVENTS.WARNING).warning.code,
    'prefix-truncated',
  );
});

test('a server-reported tool-call failure answers but is not reported as ok', async () => {
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: stubRelay([
      answerTurn('I could not form a valid command.', { toolCallFailed: true }),
    ]),
  });
  const result = await session.send('do the thing');
  assert.equal(result.ok, false);
  assert.match(result.content, /could not form a valid command/);
});

test('token usage accumulates across the round trips of one command', async () => {
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: stubRelay([
      toolTurn([{ id: 'c1', name: 'zoom_to_globe' }], {
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
      {
        payload: {
          message: { role: 'assistant', content: 'Done.' },
          toolCalls: [],
          usage: { prompt_tokens: 120, completion_tokens: 5 },
        },
      },
    ]),
  });
  assert.deepEqual(session.usage, emptyUsage());
  await session.send('zoom out');
  assert.deepEqual(session.usage, {
    promptTokens: 220,
    completionTokens: 15,
    requests: 2,
  });
  session.reset();
  assert.deepEqual(session.usage, emptyUsage());
  assert.deepEqual(session.transcript, []);
});

test('a provider that counts nothing leaves the counters alone', async () => {
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: stubRelay([answerTurn('Done.')]),
  });
  await session.send('go');
  assert.deepEqual(session.usage, emptyUsage());
});

test('a model that only ever calls tools is stopped rather than left running', async () => {
  let calls = 0;
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: stubRelay(
      Array.from({ length: MAX_TOOL_ROUNDS }, () => {
        calls += 1;
        return toolTurn([{ id: `c${calls}`, name: 'zoom_to_globe' }]);
      }),
    ),
  });
  const { events, onEvent } = collect();
  const result = await session.send('loop forever', { onEvent });
  assert.equal(result.ok, false);
  assert.equal(result.rounds, MAX_TOOL_ROUNDS);
  assert.match(
    result.error,
    new RegExp(`after ${MAX_TOOL_ROUNDS} tool rounds`),
  );
  assert.equal(events.at(-1).type, AGENT_EVENTS.ERROR);
});

test('a relay error reaches the console as one message, not a stack', async () => {
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: stubRelay([
      { status: 503, payload: { error: 'OpenAI is not configured.' } },
    ]),
  });
  const { events, onEvent } = collect();
  const result = await session.send('go', { onEvent });
  assert.deepEqual(result, {
    ok: false,
    content: '',
    rounds: 0,
    error: 'OpenAI is not configured.',
  });
  assert.equal(events.at(-1).error, 'OpenAI is not configured.');
});

test('a relay failure with no body still names the status', async () => {
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: stubRelay([{ status: 500, payload: null }]),
  });
  const result = await session.send('go');
  assert.match(result.error, /HTTP 500/);
});

test('an aborted command reports cancellation rather than a transport fault', async () => {
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: stubRelay([
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    ]),
  });
  const result = await session.send('go');
  assert.equal(result.error, 'Command cancelled.');
  assert.equal(session.busy, false);
});

test('a second command while one runs is refused instead of interleaved', async () => {
  let release;
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl: async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return {
        ok: true,
        status: 200,
        json: async () => answerTurn('Done.').payload,
      };
    },
  });
  const first = session.send('one');
  assert.equal(session.busy, true);
  const second = await session.send('two');
  assert.deepEqual(second, {
    ok: false,
    content: '',
    rounds: 0,
    error: 'A command is already running',
  });
  release();
  assert.equal((await first).ok, true);
  assert.equal(session.busy, false);
});

test('an empty command never reaches the relay', async () => {
  const fetchImpl = stubRelay([]);
  const session = createAgentSession({
    runAction: async () => ({ ok: true }),
    fetchImpl,
  });
  assert.deepEqual(await session.send('   '), {
    ok: false,
    content: '',
    rounds: 0,
    error: 'Empty command',
  });
  assert.deepEqual(await session.send(null), {
    ok: false,
    content: '',
    rounds: 0,
    error: 'Empty command',
  });
  assert.equal(fetchImpl.posts.length, 0);
});

test('a long session trims its own transcript instead of failing on the body cap', async () => {
  assert.ok(MAX_REQUEST_HISTORY_BYTES < AGENT_REQUEST_MAX_BYTES);
  const turns = [];
  for (let index = 0; index < 4; index += 1) {
    turns.push(
      toolTurn([{ id: `c${index}`, name: 'analyst_query' }]),
      answerTurn(`Done ${index}.`),
    );
  }
  const fetchImpl = stubRelay(turns);
  const session = createAgentSession({
    runAction: async () => ({ ok: true, records: 'x'.repeat(300) }),
    fetchImpl,
    maxRequestBytes: 1600,
  });
  const { events, onEvent } = collect();
  for (let index = 0; index < 4; index += 1) {
    await session.send(`how many flights ${index}`, { onEvent });
  }

  const posted = JSON.stringify(fetchImpl.posts.at(-1).body.messages);
  assert.ok(posted.length <= 1600, `posted ${posted.length} bytes`);
  const trimmed = events.filter(
    (event) =>
      event.type === AGENT_EVENTS.WARNING &&
      event.warning.code === 'history-trimmed',
  );
  assert.ok(trimmed.length, 'the trim was silent');
  assert.match(trimmed[0].warning.message, /older messages/);
  // The newest exchange survives, and no tool result lost its call.
  assert.equal(session.transcript.at(-1).content, 'Done 3.');
  const answered = new Set(
    session.transcript.flatMap((message) =>
      (message.tool_calls || []).map((call) => call.id),
    ),
  );
  for (const message of session.transcript) {
    if (message.role === 'tool') assert.ok(answered.has(message.tool_call_id));
  }
});
