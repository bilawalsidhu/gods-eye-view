import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiTextChat } from './geminiTextChat.js';
import { boundedToolResult } from './textProtocol.js';
import { createTextChat } from './textChat.js';
import { createVoiceSession } from './session.js';
import { createTestVoiceUi } from '../testSupport/voiceUi.mjs';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const final = () =>
  Response.json({
    content: { role: 'model', parts: [{ text: 'Done' }] },
    finishReason: 'STOP',
  });

test('text chat executes fresh calls and preserves signatures and function results without media', async () => {
  const requests = [],
    calls = [],
    events = [];
  let count = 0;
  const session = createVoiceSession({
    runner: async (name, args) => {
      calls.push({ name, args });
      return { ok: true, say: 'Moved', records: ['界'.repeat(15000)] };
    },
    createAdapter: (hooks) =>
      createGeminiTextChat({
        ...hooks,
        fetchImpl: async (url, options) => {
          requests.push({ url, body: JSON.parse(options.body) });
          return ++count === 1
            ? Response.json({
                content: {
                  role: 'model',
                  parts: [
                    {
                      thoughtSignature: 'opaque',
                      functionCall: {
                        name: 'fly_to',
                        args: { lat: 1, lon: 2 },
                        id: 'call',
                      },
                    },
                  ],
                },
                usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
              })
            : Response.json({
                content: { role: 'model', parts: [{ text: 'Done' }] },
                finishReason: 'STOP',
                usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
              });
        },
      }),
  });
  session.subscribe((event) => events.push(event));
  await session.start({ textOnly: true });
  assert.equal(session.sendText('Go there'), true);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, '/api/gemini/chat');
  assert.equal(calls.length, 1);
  assert.equal(
    requests[1].body.contents[1].parts[0].thoughtSignature,
    'opaque',
  );
  assert.equal(
    requests[1].body.contents[2].parts[0].functionResponse.id,
    'call',
  );
  assert.ok(
    events.some(
      (event) => event.type === 'completion' && event.status === 'completed',
    ),
  );
  const result =
    requests[1].body.contents[2].parts[0].functionResponse.response;
  assert.equal(result.ok, true);
  assert.equal(result.say, 'Moved');
  assert.equal(result.truncated, true);
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).length <= 12000);
  const usage = events.find((event) => event.type === 'completion').usage;
  assert.equal(usage.requests, 2);
  assert.equal(usage.totalTokens, 35);
  assert.equal(usage.unknownRequests, 0);
  session.destroy();
});

test('stop cancels a pending tool and prevents stale follow-up requests or completion', async () => {
  let resolve,
    actionSignal,
    requests = 0;
  const events = [];
  const session = createVoiceSession({
    runner: (_name, _args, options) => {
      actionSignal = options.signal;
      return new Promise((done) => {
        resolve = done;
      });
    },
    createAdapter: (hooks) =>
      createGeminiTextChat({
        ...hooks,
        fetchImpl: async () => {
          requests++;
          return Response.json({
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'fly_to', args: {} } }],
            },
          });
        },
      }),
  });
  session.subscribe((event) => events.push(event));
  await session.start();
  session.sendText('Go');
  for (let i = 0; i < 5 && !resolve; i++) await tick();
  session.stop();
  assert.equal(actionSignal.aborted, true);
  resolve({ ok: true });
  await tick();
  assert.equal(requests, 1);
  assert.ok(!events.some((event) => event.type === 'completion'));
  session.destroy();
});

test('runaway tool responses stop at the bounded turn limit', async () => {
  let requests = 0;
  const events = [];
  const chat = createGeminiTextChat({
    emit: (event) => events.push(event),
    runAction: async () => ({ ok: true }),
    fetchImpl: async () => {
      requests++;
      return Response.json({
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'fly_to', args: {} } }],
        },
      });
    },
  });
  chat.start();
  chat.sendText('Go');
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(requests, 8);
  assert.ok(events.some((event) => event.state === 'error'));
  chat.stop();
});

test('composite chat never starts Live and the next keyboard start resets its mode', async () => {
  const { createGeminiSession } = await import('./geminiSession.js');
  const events = [];
  const adapter = createGeminiSession({
    emit: (event) => events.push(event),
    runAction: async () => ({ ok: true }),
    ui: createTestVoiceUi(),
    fetchImpl: () => {
      throw Error('No startup request');
    },
    getUserMedia: () => {
      throw Error('No microphone');
    },
    createAudio: () => {
      throw Error('No audio');
    },
  });
  await adapter.start({ textOnly: true });
  assert.equal(adapter.getStartOptions().textOnly, true);
  assert.equal(events.at(-1).state, 'listening');
  adapter.stop();
  adapter.controller.start = async () => {};
  adapter.controller.sendTextCommand = () => 'live';
  await adapter.controller.input.start({ pushToTalk: true });
  assert.equal(adapter.getStartOptions().textOnly, undefined);
  assert.equal(adapter.sendText('Hello'), 'live');
  adapter.stop({ removeUi: true });
});

test('Gemini composite: chat Stop keeps the conversation and voice start ends chat', async () => {
  const { createGeminiSession } = await import('./geminiSession.js');
  const requests = [];
  const signals = [];
  const adapter = createGeminiSession({
    emit: () => {},
    runAction: (_name, _args, options) => {
      signals.push(options.signal);
      return new Promise(() => {});
    },
    ui: createTestVoiceUi(),
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return requests.length === 1
        ? final()
        : Response.json({
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'fly_to', args: {} } }],
            },
          });
    },
    getUserMedia: () => {
      throw Error('No microphone');
    },
    createAudio: () => {
      throw Error('No audio');
    },
  });
  await adapter.start({ textOnly: true });
  adapter.sendText('First');
  for (let i = 0; i < 5; i++) await tick();
  adapter.sendText('Second');
  for (let i = 0; i < 5 && !signals[0]; i++) await tick();
  assert.equal(adapter.cancelTurn(), true);
  assert.equal(signals[0].aborted, true);
  assert.equal(adapter.sendText('Third'), true);
  for (let i = 0; i < 5 && !signals[1]; i++) await tick();
  assert.deepEqual(
    requests[2].contents
      .filter((item) => item.parts[0].text)
      .map((item) => item.parts[0].text),
    // The stopped turn stays, closed by its note.
    [
      'First',
      'Done',
      'Second',
      'This reply stopped before it finished; the results above are final.',
      'Third',
    ],
  );
  // Starting voice retires the typed turn in progress.
  adapter.controller.start = async () => {};
  await adapter.controller.input.start({ pushToTalk: true });
  assert.equal(signals[1].aborted, true);
  assert.equal(adapter.cancelTurn(), false);
  adapter.stop({ removeUi: true });
});

test('failed Radio startup cancels its stream before releasing the mute', async () => {
  const actions = [];
  let count = 0;
  const chat = createGeminiTextChat({
    emit: () => {},
    runAction: async () => ({ ok: true, radioPlaybackRequested: true }),
    radioLayer: {
      setVoiceDucked: (v) => actions.push(v),
      playForVoice: async () => {
        throw Error('blocked');
      },
      stopPlayback: () => actions.push('stop'),
    },
    fetchImpl: async () =>
      ++count === 1
        ? Response.json({
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'control_radio',
                    args: { action: 'play' },
                  },
                },
              ],
            },
          })
        : final(),
  });
  chat.start();
  chat.sendText('Play radio');
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(actions, [true, 'stop', false]);
  chat.stop();
});

test('retired chat handoff cannot unmute the next voice session', async () => {
  const actions = [];
  let resolve;
  const chat = createGeminiTextChat({
    emit: () => {},
    runAction: async () => ({ ok: true, radioPlaybackRequested: true }),
    radioLayer: {
      setVoiceDucked: (v) => actions.push(v),
      playForVoice: () =>
        new Promise((done) => {
          resolve = done;
        }),
      stopPlayback: () => actions.push('stop'),
    },
    fetchImpl: async () =>
      Response.json({
        content: {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'control_radio', args: { action: 'play' } },
            },
          ],
        },
      }),
  });
  chat.start();
  chat.sendText('Play');
  for (let i = 0; i < 5 && !resolve; i++) await tick();
  chat.stop();
  actions.push('new-voice-muted');
  resolve(true);
  await tick();
  assert.deepEqual(actions, [true, 'stop', false, 'new-voice-muted']);
});

for (const intent of ['pause', 'off'])
  test(`user Radio ${intent} cancels delayed text preparation`, async () => {
    let controls,
      visibility,
      resolve,
      toolSignal,
      plays = 0;
    const chat = createGeminiTextChat({
      emit: () => {},
      runAction: (_name, _args, options) => {
        toolSignal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
      radioLayer: {
        subscribePlaybackControls: (cb) => {
          controls = cb;
          return () => {};
        },
        playForVoice: () => {
          plays++;
          return true;
        },
      },
      dataManager: {
        subscribeVisibilityRequests: (cb) => {
          visibility = cb;
          return () => {};
        },
      },
      fetchImpl: async () =>
        Response.json({
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'control_radio',
                  args: { action: 'play' },
                },
              },
            ],
          },
        }),
    });
    chat.start();
    chat.sendText('Play');
    for (let i = 0; i < 5 && !resolve; i++) await tick();
    if (intent === 'pause') controls({ origin: 'user', action: 'pause' });
    else visibility({ origin: 'user', layerId: 'radio', enabled: false });
    assert.equal(toolSignal.aborted, true);
    resolve({ ok: true, radioPlaybackRequested: true });
    await tick();
    assert.equal(plays, 0);
  });

test('a tool deadline reports one error, aborts work and admits a successor', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  let actionSignal,
    requests = 0;
  const chat = createGeminiTextChat({
    emit: (e) => events.push(e),
    timeoutMs: 30,
    runAction: (_n, _a, o) => {
      actionSignal = o.signal;
      return new Promise(() => {});
    },
    fetchImpl: async () =>
      ++requests === 1
        ? Response.json({
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'fly_to', args: {} } }],
            },
            usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
          })
        : final(),
  });
  chat.start();
  chat.sendText('Go');
  for (let i = 0; i < 5 && !actionSignal; i++) await tick();
  assert.equal(actionSignal.aborted, false);
  t.mock.timers.tick(30);
  assert.equal(actionSignal.aborted, true);
  assert.equal(events.filter((e) => e.state === 'error').length, 1);
  assert.equal(requests, 1);
  assert.equal(events.find((e) => e.state === 'error').usage.totalTokens, 6);
  assert.ok(!events.some((e) => e.type === 'completion'));
  chat.start();
  assert.equal(chat.sendText('Hello'), true);
  for (let i = 0; i < 5; i++) await tick();
  assert.ok(events.some((e) => e.type === 'completion'));
  chat.stop();
});

test('usage survives a later failed request and explicitly marks its unknown tokens', async () => {
  const events = [];
  let count = 0;
  const chat = createGeminiTextChat({
    emit: (e) => events.push(e),
    runAction: async () => ({ ok: true }),
    fetchImpl: async () =>
      ++count === 1
        ? Response.json({
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'fly_to', args: {} } }],
            },
            usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
          })
        : Response.json({ error: 'unavailable' }, { status: 503 }),
  });
  chat.start();
  chat.sendText('Go');
  for (let i = 0; i < 6; i++) await tick();
  const usage = events.find((e) => e.state === 'error').usage;
  assert.equal(usage.totalTokens, 6);
  assert.equal(usage.requests, 2);
  assert.equal(usage.unknownRequests, 1);
  chat.stop();
});

test('invalid mixed batches preserve every pair and a corrected reset can execute', async () => {
  const requests = [],
    executed = [];
  let count = 0;
  const call = (name, id) => ({ functionCall: { name, id, args: {} } });
  const chat = createGeminiTextChat({
    emit: () => {},
    runAction: async (name) => {
      executed.push(name);
      return { ok: true };
    },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      count++;
      return count === 1
        ? Response.json({
            content: {
              role: 'model',
              parts: [
                { text: 'Planning' },
                call('zoom_to_globe', 'bad'),
                call('fly_to', 'sibling'),
              ],
            },
            invalidCalls: [{ index: 0, error: 'Invalid arguments' }],
          })
        : count === 2
          ? Response.json({
              content: {
                role: 'model',
                parts: [call('zoom_to_globe', 'corrected')],
              },
            })
          : final();
    },
  });
  chat.start();
  chat.sendText('Reset');
  for (let i = 0; i < 8; i++) await tick();
  assert.deepEqual(executed, ['zoom_to_globe']);
  const parts = requests[1].contents[2].parts;
  assert.deepEqual(
    parts.map((p) => p.functionResponse.id),
    ['bad', 'sibling'],
  );
  assert.ok(parts.every((p) => p.functionResponse.response.ok === false));
  assert.equal(
    requests[2].contents[4].parts[0].functionResponse.response.ok,
    true,
  );
  chat.stop();
});

test('result reduction stays bounded JSON when essential details or serialization fail', () => {
  const result = boundedToolResult({ ok: false, error: '界'.repeat(20000) });
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).length <= 12000);
  assert.equal(result.ok, false);
  const cycle = { ok: true };
  cycle.self = cycle;
  assert.equal(boundedToolResult(cycle).ok, false);
});

test('OpenAI native tool pairs round-trip malformed arguments and incomplete usage', async () => {
  const requests = [],
    events = [],
    actions = [];
  let count = 0;
  const chat = createTextChat({
    provider: 'openai',
    emit: (e) => events.push(e),
    runAction: async (name) => {
      actions.push(name);
      return { ok: true };
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, '/api/openai/chat');
      requests.push(JSON.parse(options.body));
      count++;
      return Response.json(
        count === 1
          ? {
              content: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'a',
                    type: 'function',
                    function: { name: 'fly_to', arguments: '{' },
                  },
                  {
                    id: 'b',
                    type: 'function',
                    function: { name: 'fly_to', arguments: '{}' },
                  },
                ],
              },
              invalidCalls: [{ index: 0, error: 'JSON invalid' }],
              usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
            }
          : {
              content: { role: 'assistant', content: 'Partial' },
              finishReason: 'length',
              usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
            },
      );
    },
  });
  chat.start();
  chat.sendText('Go');
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(actions, []);
  assert.deepEqual(
    requests[1].messages.slice(2).map((m) => m.tool_call_id),
    ['a', 'b'],
  );
  assert.equal(events.find((e) => e.state === 'error').usage.totalTokens, 8);
  chat.stop();
});
