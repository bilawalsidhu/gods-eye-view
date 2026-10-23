import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialVoiceCardState,
  reduceVoiceCard,
  voiceCardView,
} from './voiceCardPresentation.js';
import { createVoiceSession } from './session.js';
import { createRealtimeSession } from './realtimeSession.js';
import { realtimeSessionEvent } from './realtimeEvents.js';
import { createVoiceCommands } from './sessionCommands.js';
import { describeUnsavedWork } from '../i18n/index.js';

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
    // Switching language (a reload) asks first during a session.
    assert.deepEqual(describeUnsavedWork(), ['the active voice session']);
    subscribed({ status: 'resolved' });
    assert.deepEqual(events, [
      { type: 'map_annotation_outline', status: 'resolved' },
    ]);
    button.dispatchEvent(new Event('click'));
    assert.equal(controls.state, 'idle');
    assert.deepEqual(describeUnsavedWork(), []);
    button.dispatchEvent(new Event('click'));
    await new Promise((done) => setTimeout(done, 0));
    assert.deepEqual(describeUnsavedWork(), ['the active voice session']);
    lifetime.abort();
    assert.deepEqual(describeUnsavedWork(), [], 'disposal unregisters');
    assert.equal(subscribed, null);
    assert.equal(removed, 1);
    button.dispatchEvent(new Event('click'));
    assert.equal(calls, 2);
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

test('action events carry the call id; progress after cancellation is dropped', async () => {
  let report;
  const f = fixture(async (name, args, options) => {
    options.progress({ step: 'resolve', label: 'Zilker' });
    report = options.progress;
    return { ok: true };
  });
  const events = [];
  f.session.subscribe((event) => events.push(event));
  await f.session.start();
  await f.hooks.runAction('annotate_map', {}, { callId: 'call_7' });
  const actionEvents = events.filter(
    (e) => e.type.startsWith('action-') || e.type === 'progress',
  );
  assert.deepEqual(
    actionEvents.map((e) => [e.type, e.callId]),
    [
      ['action-call', 'call_7'],
      ['progress', 'call_7'],
      ['action-result', 'call_7'],
    ],
  );
  f.hooks.emit({ type: 'interruption' });
  report({ step: 'outline' });
  assert.equal(events.filter((e) => e.type === 'progress').length, 1);
});

test('a rejected current action settles its card and preserves the rejection', async () => {
  const failure = new Error('Unknown panel');
  const f = fixture(async () => {
    throw failure;
  });
  let card = initialVoiceCardState();
  const events = [];
  f.session.subscribe((event) => {
    events.push(event);
    card = reduceVoiceCard(card, event);
  });
  await f.session.start();
  await assert.rejects(
    f.hooks.runAction(
      'set_panel_open',
      { panelId: 'missing' },
      { callId: 'failed-call' },
    ),
    (error) => error === failure,
  );
  f.hooks.emit({ type: 'completion', status: 'completed' });
  assert.equal(voiceCardView(card).busy, false);
  assert.equal(card.steps[0].status, 'failed');
  const result = events.find((event) => event.type === 'action-result');
  assert.equal(result.callId, 'failed-call');
  assert.equal(result.result.ok, false);
  f.session.destroy();
});

test('a late rejection cannot settle a newer turn card', async () => {
  let reject;
  const f = fixture(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const events = [];
  f.session.subscribe((event) => events.push(event));
  await f.session.start();
  const pending = f.hooks.runAction(
    'set_panel_open',
    {},
    { callId: 'old-call' },
  );
  f.hooks.emit({ type: 'interruption', reason: 'user-speech' });
  reject(new Error('late failure'));
  await assert.rejects(pending, /late failure/);
  assert.equal(
    events.some((event) => event.type === 'action-result'),
    false,
  );
  f.session.destroy();
});

function startReentrancyFixture() {
  let starts = 0;
  let stops = 0;
  const settings = [];
  const session = createVoiceSession({
    runner: async () => ({ ok: true }),
    createAdapter: ({ emit }) => ({
      async start(options) {
        starts++;
        settings.push(options);
        emit({ type: 'state', state: 'listening' });
      },
      stop() {
        stops++;
      },
      sendText() {},
      sendMapEvent() {},
    }),
  });
  return { session, settings, starts: () => starts, stops: () => stops };
}

for (const action of ['stop', 'destroy']) {
  test(`initial connecting observer ${action} prevents adapter acquisition`, async () => {
    const f = startReentrancyFixture();
    const unsubscribe = f.session.subscribe((event) => {
      if (event.type === 'state' && event.state === 'connecting') {
        unsubscribe();
        f.session[action]();
      }
    });
    await f.session.start();
    assert.equal(
      f.starts(),
      0,
      'cancelled attempt must not call adapter.start',
    );
    assert.equal(f.stops(), 1);
    assert.equal(f.session.state, 'idle');
    if (action === 'stop') {
      await f.session.start();
      assert.equal(f.starts(), 1, 'later explicit Start remains usable');
      assert.equal(f.session.state, 'listening');
    }
    f.session.destroy();
  });
}

test('preserveStatus Stop still prevents adapter acquisition', async () => {
  const f = startReentrancyFixture();
  const unsubscribe = f.session.subscribe((event) => {
    if (event.type === 'state' && event.state === 'connecting') {
      unsubscribe();
      f.session.stop({ preserveStatus: true });
    }
  });
  await f.session.start();
  assert.equal(f.starts(), 0);
  assert.equal(
    f.session.state,
    'connecting',
    'preserved state is not ownership',
  );
  f.session.stop();
  await f.session.start();
  assert.equal(f.starts(), 1);
  f.session.destroy();
});

test('Stop and explicit reentrant successor start acquire only for the successor', async () => {
  const f = startReentrancyFixture();
  let successor;
  const unsubscribe = f.session.subscribe((event) => {
    if (event.type === 'state' && event.state === 'connecting') {
      unsubscribe();
      f.session.stop();
      successor = f.session.start();
    }
  });
  await f.session.start();
  await successor;
  assert.equal(f.starts(), 1);
  assert.equal(f.session.state, 'listening');
  f.session.destroy();
});

test('ordinary start forwards caller settings once and remains stoppable', async () => {
  const f = startReentrancyFixture();
  const settings = { pushToTalk: true };
  await f.session.start(settings);
  assert.equal(f.settings.length, 1);
  assert.equal(f.settings[0], settings);
  assert.equal(f.starts(), 1);
  assert.equal(f.session.state, 'listening');
  f.session.stop();
  assert.equal(f.session.state, 'idle');
  f.session.destroy();
});

for (const emitsIdle of [false, true]) {
  for (const outcome of ['normal', 'preserveStatus', 'throw']) {
    test(`stop preserves custom adapter contract: emitsIdle=${emitsIdle}, ${outcome}`, async (t) => {
      let adapter;
      const calls = [];
      const events = [];
      const failure = new Error('Controlled stop failure');
      const session = createVoiceSession({
        runner: async () => ({}),
        createAdapter: ({ emit }) =>
          (adapter = {
            async start() {
              emit({ type: 'state', state: 'listening' });
            },
            stop(settings = {}) {
              calls.push({ receiver: this, settings });
              if (settings.removeUi) return;
              if (emitsIdle && !settings.preserveStatus)
                emit({ type: 'state', state: 'idle' });
              if (outcome === 'throw') throw failure;
              return 'adapter-only return';
            },
            sendText() {},
            sendMapEvent() {},
          }),
      });
      t.after(() => session.destroy());
      session.subscribe((event) => events.push(event));
      await session.start();
      events.length = 0;
      const settings =
        outcome === 'preserveStatus' ? { preserveStatus: true } : {};
      if (outcome === 'throw')
        assert.throws(
          () => session.stop(settings),
          (error) => error === failure,
        );
      else assert.equal(session.stop(settings), undefined);
      assert.equal(calls[0].receiver, adapter);
      assert.equal(calls[0].settings, settings);
      assert.equal(
        session.state,
        outcome === 'preserveStatus' ? 'listening' : 'idle',
      );
      assert.equal(
        events.filter(
          (event) => event.type === 'state' && event.state === 'idle',
        ).length,
        outcome === 'preserveStatus' ? 0 : 1,
      );
    });
  }
}

test('actual default OpenAI adapter stop publishes one common idle', (t) => {
  const events = [];
  const ui = {
    root: {
      dataset: {},
      querySelectorAll: () => [],
      classList: { remove() {} },
      remove() {},
    },
    status: {},
    detail: {},
  };
  const runner = async () => ({});
  const session = createVoiceSession({
    runner,
    createAdapter: (hooks) =>
      createRealtimeSession({ ...hooks, runner, ui, debugSink() {} }),
  });
  t.after(() => session.destroy());
  session.subscribe((event) => events.push(event));
  // Exercise the real stop path without acquiring microphone/WebRTC resources.
  session.adapter.controller.setStatus('listening', 'Controlled active state');
  events.length = 0;
  session.stop();
  assert.equal(
    events.filter((event) => event.type === 'state' && event.state === 'idle')
      .length,
    1,
  );
  assert.equal(session.state, 'idle');
  assert.equal(session.adapter.controller.status, 'idle');
});
