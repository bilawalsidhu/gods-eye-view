import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceSession } from './session.js';
import { realtimeSessionEvent } from './realtimeEvents.js';
import { createVoiceCommands } from './sessionCommands.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  runner = async (name, args) => ({ ok: true, name, ...args }),
  signal,
) {
  let hooks;
  const sent = [];
  let stops = 0;
  const session = createVoiceSession({
    runner,
    signal,
    createAdapter(options) {
      hooks = options;
      return {
        start() {
          hooks.emit({ type: 'state', state: 'listening' });
        },
        stop() {
          stops++;
          hooks.emit({ type: 'state', state: 'idle' });
        },
        sendText(text) {
          sent.push(['text', text]);
          return true;
        },
        sendMapEvent(event) {
          sent.push(['map', event]);
          return true;
        },
      };
    },
  });
  return {
    session,
    hooks,
    sent,
    get stops() {
      return stops;
    },
  };
}

test('alternate protocol shares session events and action execution without Realtime', async () => {
  const f = fixture();
  const events = [];
  f.session.subscribe(() => {
    throw new Error('observer');
  });
  const unsubscribe = f.session.subscribe((event) => events.push(event));
  await f.session.start();
  assert.equal(f.session.isActive(), true);
  f.hooks.emit({
    type: 'transcript',
    role: 'user',
    text: 'London',
    final: true,
  });
  assert.deepEqual(
    await f.hooks.runAction('fly_to_location', { query: 'London' }),
    { ok: true, name: 'fly_to_location', query: 'London' },
  );
  f.hooks.emit({ type: 'completion', status: 'completed' });
  f.session.sendText('Next');
  f.session.sendMapEvent({
    type: 'map_annotation_outline',
    status: 'resolved',
  });
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'state',
      'state',
      'transcript',
      'action-call',
      'action-result',
      'completion',
    ],
  );
  assert.equal(f.sent.length, 2);
  unsubscribe();
  f.session.stop();
  assert.equal(f.session.state, 'idle');
  await f.session.start();
  assert.equal(f.session.state, 'listening');
  f.session.destroy();
  assert.equal(f.session.disposed, true);
  assert.equal(f.session.sendText('stale'), false);
});

test('stop, interruption and lifetime abort cancel actions and suppress stale results', async () => {
  for (const cancel of ['stop', 'interruption', 'lifetime']) {
    const result = deferred();
    const lifetime = new AbortController();
    let observed;
    const f = fixture(async (_name, _args, options) => {
      observed = options;
      return result.promise;
    }, lifetime.signal);
    const events = [];
    f.session.subscribe((event) => events.push(event));
    await f.session.start();
    const pending = f.hooks.runAction('fly_to_location', {});
    if (cancel === 'stop') f.session.stop();
    if (cancel === 'interruption')
      f.hooks.emit({ type: 'interruption', reason: 'user-speech' });
    if (cancel === 'lifetime') lifetime.abort();
    assert.equal(observed.signal.aborted, true);
    assert.equal(observed.isCurrent(), false);
    result.resolve({ ok: true });
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(
      events.some((event) => event.type === 'action-result'),
      false,
    );
    f.session.destroy();
  }
});

test('caller cancellation and sibling actions preserve independent ownership', async () => {
  const first = deferred();
  const f = fixture(async (name) =>
    name === 'first' ? first.promise : { ok: true },
  );
  await f.session.start();
  const signal = new AbortController();
  const pending = f.hooks.runAction('first', {}, { signal: signal.signal });
  signal.abort();
  assert.deepEqual(await f.hooks.runAction('second', {}), { ok: true });
  first.resolve({ ok: true });
  await assert.rejects(pending, { name: 'AbortError' });
  f.session.destroy();
});

test('stale connect failure cannot stop a replacement session', async () => {
  let reject;
  let calls = 0;
  let hooks;
  const session = createVoiceSession({
    runner: async () => {},
    createAdapter(options) {
      hooks = options;
      return {
        start() {
          if (++calls === 1)
            return new Promise((_resolve, fail) => {
              reject = fail;
            });
          hooks.emit({ type: 'state', state: 'listening' });
        },
        stop() {},
        sendText() {},
        sendMapEvent() {},
      };
    },
  });
  const old = session.start();
  session.stop();
  await session.start();
  reject(new Error('old connection failed'));
  await old;
  assert.equal(session.state, 'listening');
  session.destroy();
});

test('wire events project only normalized transcript, interruption and completion fields', () => {
  assert.deepEqual(
    realtimeSessionEvent({
      type: 'response.output_audio_transcript.delta',
      delta: 'Hello',
      item_id: 'i',
      response_id: 'r',
      extra: 'ignored',
    }),
    {
      type: 'transcript',
      role: 'assistant',
      text: 'Hello',
      final: false,
      itemId: 'i',
      responseId: 'r',
    },
  );
  assert.deepEqual(
    realtimeSessionEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Go',
    }),
    {
      type: 'transcript',
      role: 'user',
      text: 'Go',
      final: true,
      itemId: null,
    },
  );
  assert.equal(
    realtimeSessionEvent({ type: 'response.output_text.done', text: 'Done' })
      .final,
    true,
  );
  assert.equal(
    realtimeSessionEvent({ type: 'input_audio_buffer.speech_started' }).type,
    'interruption',
  );
  assert.equal(
    realtimeSessionEvent({
      type: 'response.done',
      response: { id: 'r', status: 'cancelled' },
    }).status,
    'cancelled',
  );
  assert.equal(
    realtimeSessionEvent({
      type: 'session.created',
      session: { secret: 'excluded' },
    }),
    null,
  );
});

test('common button and annotation bindings work with an alternate adapter and clean up', async () => {
  const previous = globalThis.window;
  globalThis.window = {};
  try {
    const button = new EventTarget();
    button.setAttribute = () => {};
    let removed = 0;
    let subscribed = null;
    let calls = 0;
    const events = [];
    const ui = {
      button,
      root: {
        dataset: {},
        remove() {
          removed++;
        },
      },
      status: {},
      detail: {},
      tierButton: {},
      costValue: {},
      helpDetail: {},
    };
    const lifetime = new AbortController();
    const controls = createVoiceCommands({
      runner: async () => {
        calls++;
        return { ok: true };
      },
      signal: lifetime.signal,
      createControl: () => ui,
      annotations: {
        onOutlineEvent(listener) {
          subscribed = listener;
          return () => {
            subscribed = null;
          };
        },
      },
      createSession({ emit, runAction }) {
        return {
          async start() {
            emit({ type: 'state', state: 'listening', detail: 'Ready' });
            await runAction('fly_to_location', { query: 'London' });
          },
          stop() {
            emit({ type: 'state', state: 'idle' });
          },
          sendText() {},
          sendMapEvent(event) {
            events.push(event);
          },
        };
      },
    });
    button.dispatchEvent(new Event('click'));
    await new Promise((done) => setTimeout(done, 0));
    assert.equal(calls, 1);
    assert.equal(ui.tierButton.hidden, true);
    assert.equal(ui.costValue.hidden, true);
    assert.equal(ui.helpDetail.textContent, 'Activate to toggle voice');
    assert.equal(ui.status.textContent, 'LISTENING');
    assert.equal(ui.detail.textContent, 'Ready');
    subscribed({ status: 'resolved' });
    assert.deepEqual(events, [
      { type: 'map_annotation_outline', status: 'resolved' },
    ]);
    button.dispatchEvent(new Event('click'));
    assert.equal(controls.state, 'idle');
    lifetime.abort();
    assert.equal(subscribed, null);
    assert.equal(removed, 1);
    button.dispatchEvent(new Event('click'));
    assert.equal(calls, 1);
  } finally {
    globalThis.window = previous;
  }
});

test('late actions cannot run after stop and failed startup closes the adapter', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
  });
  await f.session.start();
  f.session.stop();
  await assert.rejects(f.hooks.runAction('fly_to_location', {}), {
    name: 'AbortError',
  });
  assert.equal(calls, 0);
  f.session.destroy();
  let stopped = 0;
  const session = createVoiceSession({
    runner: async () => {},
    createAdapter({ emit }) {
      return {
        start() {
          emit({ type: 'state', state: 'connecting' });
          throw new Error('Connection refused');
        },
        stop() {
          stopped++;
          emit({ type: 'state', state: 'idle' });
        },
        sendText() {},
        sendMapEvent() {},
      };
    },
  });
  await session.start();
  assert.equal(session.state, 'error');
  assert.equal(stopped, 1);
  session.destroy();
});
