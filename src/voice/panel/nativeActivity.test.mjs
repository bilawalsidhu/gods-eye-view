import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceInactivity } from './inactivity.js';
import { RealtimeTurns } from '../realtimeTurns.js';
import { observeNativeActivity } from './nativeActivity.js';
// Deliberately small native-shaped fixtures exercise wrapper contracts, not devices.
function gemini(onChange = () => {}) {
  const callbacks = [];
  const input = {
    pushToTalkKeyHeld: false,
    setMicrophoneEnabled() {},
    releasePushToTalkKey() {
      this.pushToTalkKeyHeld = false;
    },
    resetSession() {
      this.pushToTalkKeyHeld = false;
    },
  };
  const c = {
    input,
    captureOwner: { admitted: false },
    createAudio(opts) {
      callbacks.push(opts);
      return {
        pending: 0,
        play() {
          this.pending++;
          return 42;
        },
        clearPlayback() {
          this.pending = 0;
        },
        close() {
          this.pending = 0;
        },
      };
    },
    handleMessage() {},
  };
  const observer = observeNativeActivity({
    adapter: { controller: c },
    nativeProvider: 'gemini',
    onChange,
  });
  const start = () => {
    observer.handle({ type: 'state', state: 'connecting' });
    c.audio = c.createAudio({ pushToTalk: true });
    observer.handle({ type: 'state', state: 'listening' });
    return c.audio;
  };
  return { c, input, observer, callbacks, start };
}
test('custom host never inspected, including hostile controller getter', () => {
  const adapter = {
    get controller() {
      throw Error('must not inspect');
    },
  };
  const o = observeNativeActivity({ adapter, nativeProvider: null });
  assert.equal(o.snapshot().known, false);
  o.handle({ type: 'state', state: 'listening' });
  o.destroy();
});
test('PTT hold is direct before connect; silent automatic stream is not admitted speech', () => {
  const f = gemini();
  f.input.pushToTalkKeyHeld = true;
  assert.equal(f.observer.snapshot().held, true);
  assert.equal(f.observer.snapshot().connected, false);
  f.start();
  f.callbacks[0].onAudioStart({});
  assert.equal(f.observer.snapshot().inputBusy, false);
  f.c.captureOwner.admitted = true;
  f.callbacks[0].onAudioStart({});
  assert.equal(f.observer.snapshot().inputBusy, true);
  f.callbacks[0].onAudioDiscard();
  f.input.releasePushToTalkKey();
  assert.equal(f.observer.snapshot().inputBusy, false);
  assert.equal(f.observer.snapshot().held, false);
});
test('queue-to-drain, clear and close use current instance, without an acoustic claim', () => {
  const f = gemini();
  const a = f.start();
  assert.equal(a.play(), 42);
  assert.equal(f.observer.snapshot().outputBusy, true);
  a.clearPlayback();
  assert.equal(f.observer.snapshot().outputBusy, false);
  a.play();
  a.close();
  assert.equal(f.observer.snapshot().outputBusy, false);
  a.play();
  a.pending = 0;
  f.callbacks[0].onDrain();
  assert.equal(f.observer.snapshot().outputBusy, false);
});
test('same-mount restart old callbacks cannot clear new admitted capture/output', () => {
  const f = gemini();
  f.start();
  const old = f.callbacks[0];
  const b = f.start();
  f.c.captureOwner.admitted = true;
  f.callbacks[1].onAudioStart();
  b.play();
  old.onAudioDiscard();
  old.onDrain();
  assert.equal(f.observer.snapshot().inputBusy, true);
  assert.equal(f.observer.snapshot().outputBusy, true);
});
test('native callbacks original first with receiver, arguments, return and thrown identity; observation failure isolated', () => {
  const f = gemini(() => {
    throw Error('observer');
  });
  const receiver = {};
  const argument = {};
  let seen;
  f.c.audio = f.c.createAudio({
    pushToTalk: true,
    onAudioEnd: function (...args) {
      seen = [this, args];
      return argument;
    },
  });
  const cb = f.callbacks[0];
  assert.equal(cb.onAudioEnd.call(receiver, argument), argument);
  assert.equal(seen[0], receiver);
  assert.equal(seen[1][0], argument);
  const error = Error('same');
  f.c.audio = f.c.createAudio({
    onDrain() {
      throw error;
    },
  });
  assert.throws(
    () => f.callbacks[1].onDrain(),
    (e) => e === error,
  );
});
test('reentrant Stop in original callback suppresses stale post-callback observation; teardown preserves newer replacement', () => {
  let count = 0;
  const f = gemini(() => count++);
  f.c.audio = f.c.createAudio({
    onDrain() {
      f.observer.handle({ type: 'state', state: 'idle' });
    },
  });
  const before = count;
  f.callbacks[0].onDrain();
  assert.equal(count, before + 1);
  assert.equal(f.observer.snapshot().connected, false);
  const newer = () => {};
  f.input.releasePushToTalkKey = newer;
  f.observer.destroy();
  assert.equal(f.input.releasePushToTalkKey, newer);
});
test('OpenAI response.done does not drain output; absent lifecycle remains unknown', () => {
  const turns = {
    assistantAudioPlaying: false,
    responseActive: false,
    observeSpeech(e) {
      if (e.type === 'output_audio_buffer.started')
        this.assistantAudioPlaying = true;
      if (
        e.type === 'output_audio_buffer.stopped' ||
        e.type === 'output_audio_buffer.cleared'
      )
        this.assistantAudioPlaying = false;
    },
  };
  const c = { _turns: turns, _input: { pushToTalkKeyHeld: false } };
  const original = turns.observeSpeech;
  const o = observeNativeActivity({
    adapter: { controller: c },
    nativeProvider: 'openai',
  });
  o.handle({ type: 'state', state: 'listening' });
  assert.equal(o.snapshot().known, false);
  turns.observeSpeech({ type: 'output_audio_buffer.started' });
  assert.equal(o.snapshot().known, true);
  turns.responseActive = false;
  o.handle({ type: 'completion' });
  assert.equal(o.snapshot().outputBusy, true);
  turns.observeSpeech({ type: 'output_audio_buffer.cleared' });
  assert.equal(o.snapshot().outputBusy, false);
  o.destroy();
  assert.equal(turns.observeSpeech, original);
});
test('method receiver/args/result and throw are exact; abort restores wrappers', () => {
  const abort = new AbortController();
  const result = Promise.resolve();
  let seen;
  const error = Error('original');
  const input = {
    setMicrophoneEnabled(...args) {
      seen = [this, args];
      if (args[0] === 'throw') throw error;
      return result;
    },
  };
  const original = input.setMicrophoneEnabled;
  const c = {
    input,
    createAudio() {
      return {};
    },
    handleMessage() {},
  };
  const o = observeNativeActivity({
    adapter: { controller: c },
    nativeProvider: 'gemini',
    signal: abort.signal,
    onChange() {
      throw Error('observe');
    },
  });
  assert.equal(input.setMicrophoneEnabled(1, 2), result);
  assert.equal(seen[0], input);
  assert.deepEqual(seen[1], [1, 2]);
  assert.throws(
    () => input.setMicrophoneEnabled('throw'),
    (e) => e === error,
  );
  abort.abort();
  assert.equal(input.setMicrophoneEnabled, original);
  assert.equal(o.snapshot().known, false);
});

test('options-method callback receiver maps to original options, explicit receiver is preserved', () => {
  const f = gemini();
  let receiver;
  const options = {
    onDrain() {
      receiver = this;
      return 17;
    },
  };
  f.c.audio = f.c.createAudio(options);
  assert.equal(f.callbacks[0].onDrain(), 17);
  assert.equal(receiver, options);
  const explicit = {};
  f.callbacks[0].onDrain.call(explicit);
  assert.equal(receiver, explicit);
});
test('actual native RealtimeTurns output lifecycle remains busy beyond generation', () => {
  const turns = new RealtimeTurns({});
  const observer = observeNativeActivity({
    adapter: { controller: { _turns: turns, _input: {} } },
    nativeProvider: 'openai',
  });
  observer.handle({ type: 'state', state: 'listening' });
  turns.observeSpeech({ type: 'output_audio_buffer.started' });
  turns.responseActive = false;
  observer.handle({ type: 'completion' });
  assert.equal(observer.snapshot().outputBusy, true);
  turns.observeSpeech({ type: 'output_audio_buffer.stopped' });
  assert.equal(observer.snapshot().outputBusy, false);
  turns.observeSpeech({ type: 'response.created' });
  turns.observeSpeech({ type: 'output_audio_buffer.stopped' });
  assert.equal(observer.snapshot().known, false);
  observer.destroy();
});

test('verified clean native mount can arm initial idle, eventless response invalidates it', () => {
  const turns = new RealtimeTurns({});
  const controller = { status: 'idle', dc: null, _turns: turns, _input: {} };
  const observer = observeNativeActivity({
    adapter: { controller },
    nativeProvider: 'openai',
  });
  let armed = 0,
    cleared = 0;
  const idle = createVoiceInactivity({
    readActivity: observer.snapshot,
    readPending: () => 0,
    setTimer() {
      armed++;
      return 1;
    },
    clearTimer() {
      cleared++;
    },
  });
  assert.equal(observer.snapshot().known, true);
  assert.equal(armed, 0);
  controller.status = 'listening';
  controller.dc = { readyState: 'open' };
  observer.handle({ type: 'state', state: 'listening' });
  idle.update();
  assert.equal(armed, 1);
  turns.observeSpeech({ type: 'response.created' });
  idle.update();
  assert.equal(observer.snapshot().known, false);
  assert.equal(cleared, 1);
  turns.responseActive = false;
  observer.handle({ type: 'completion' });
  idle.update();
  assert.equal(armed, 1);
  assert.equal(observer.snapshot().known, false);
  controller.status = 'idle';
  controller.dc = null;
  turns.reset();
  observer.handle({ type: 'state', state: 'idle' });
  assert.equal(observer.snapshot().known, true);
  idle.destroy();
  observer.destroy();
});
test('attaching to already active native transport never assumes empty playback', () => {
  const turns = new RealtimeTurns({});
  for (const controller of [
    { status: 'listening', dc: {}, _turns: turns, _input: {} },
    { status: 'idle', dc: {}, _turns: turns, _input: {} },
  ]) {
    const observer = observeNativeActivity({
      adapter: { controller },
      nativeProvider: 'openai',
    });
    assert.equal(observer.snapshot().known, false);
    observer.destroy();
  }
  turns.responseActive = true;
  const observer = observeNativeActivity({
    adapter: {
      controller: { status: 'idle', dc: null, _turns: turns, _input: {} },
    },
    nativeProvider: 'openai',
  });
  assert.equal(observer.snapshot().known, false);
  observer.destroy();
});

test('Gemini queue-only work blocks idle, queue drain rearms, expiry rereads delayed queue', () => {
  const f = gemini();
  f.start();
  f.c.controlQueue = [];
  let callback,
    arms = 0,
    clears = 0,
    expired = 0;
  const idle = createVoiceInactivity({
    readActivity: f.observer.snapshot,
    readPending: () => 0,
    onExpire() {
      expired++;
    },
    setTimer(fn) {
      callback = fn;
      return ++arms;
    },
    clearTimer() {
      clears++;
    },
  });
  assert.equal(arms, 1);
  f.c.controlQueue.push({});
  assert.equal(f.observer.snapshot().generationBusy, true);
  idle.update();
  assert.equal(clears, 1);
  f.c.controlQueue.shift();
  assert.equal(f.observer.snapshot().generationBusy, false);
  idle.update();
  assert.equal(arms, 2);
  // A queue may change after the last event-driven snapshot and before the deadline.
  f.c.controlQueue.push({});
  callback();
  assert.equal(expired, 0);
  f.c.controlQueue = [];
  idle.update();
  assert.equal(arms, 3);
  callback();
  assert.equal(expired, 1);
  idle.destroy();
  f.observer.destroy();
});

test('Gemini presentation-only pending does not block idle; retired/deferred work still does', () => {
  const f = gemini();
  f.start();
  f.c.userTurnPending = true;
  assert.equal(f.observer.snapshot().generationBusy, false);
  f.c.retiredReplyPending = true;
  assert.equal(f.observer.snapshot().generationBusy, true);
  f.c.retiredReplyPending = false;
  f.c.deferredInput = {};
  assert.equal(f.observer.snapshot().generationBusy, true);
  f.c.deferredInput = null;
  assert.equal(f.observer.snapshot().generationBusy, false);
  f.observer.destroy();
});

test('actual Gemini startup phases keep playback observation and permit quiet open-mic expiry', async () => {
  const { harness } = await import('../../testSupport/geminiNativeHarness.mjs');
  let observer,
    idle,
    deadline,
    expiries = 0;
  const h = harness({ emit: (event) => observer?.handle(event) });
  observer = observeNativeActivity({
    adapter: { controller: h.c },
    nativeProvider: 'gemini',
    onChange: () => idle?.update(),
  });
  idle = createVoiceInactivity({
    readActivity: observer.snapshot,
    readPending: () => 0,
    setTimer(fn) {
      deadline = fn;
      return fn;
    },
    clearTimer() {},
    onExpire() {
      expiries++;
    },
  });
  try {
    await h.c.start();
    assert.equal(h.c.userTurnPending, true);
    assert.equal(idle.snapshot().eligible, true);
    const beforeOutput = deadline;
    h.sockets[0].message({
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: { data: 'output', mimeType: 'audio/pcm;rate=24000' },
            },
          ],
        },
        turnComplete: true,
      },
    });
    assert.equal(observer.snapshot().outputBusy, true);
    assert.equal(idle.snapshot().eligible, false);
    beforeOutput();
    assert.equal(expiries, 0);
    h.captures[0].drain();
    assert.equal(observer.snapshot().outputBusy, false);
    assert.equal(idle.snapshot().eligible, true);
    deadline();
    assert.equal(expiries, 1);
  } finally {
    idle.destroy();
    observer.destroy();
    h.c.stop({ removeUi: true });
  }
});

test('native typed input observation preserves receiver/result, refuses failed submissions and retires old wrapper', () => {
  let inputs = 0;
  const controller = {
    input: {},
    handleMessage() {},
    createAudio() {},
    sendTextCommand(text) {
      assert.equal(this, controller);
      if (text === 'throw') throw new Error('rejected');
      return text === 'reject' ? false : undefined;
    },
  };
  const original = controller.sendTextCommand;
  const observer = observeNativeActivity({
    adapter: { controller },
    nativeProvider: 'gemini',
    onInput: () => inputs++,
  });
  const old = controller.sendTextCommand;
  assert.equal(controller.sendTextCommand('typed request'), undefined);
  controller.sendTextCommand('reject');
  controller.sendTextCommand('');
  assert.throws(() => controller.sendTextCommand('throw'), /rejected/);
  assert.equal(inputs, 1);
  observer.destroy();
  assert.equal(controller.sendTextCommand, original);
  old.call(controller, 'late');
  assert.equal(inputs, 1);
});

test('explicit silent OpenAI completion rearms expiry, including cancelled and failed responses', () => {
  for (const status of ['completed', 'cancelled', 'failed', 'incomplete']) {
    const turns = new RealtimeTurns({});
    const controller = { status: 'idle', dc: null, _turns: turns, _input: {} };
    let idle;
    let timer;
    let expired = 0;
    const observer = observeNativeActivity({
      adapter: { controller },
      nativeProvider: 'openai',
      onChange: () => idle?.update(),
    });
    idle = createVoiceInactivity({
      readActivity: observer.snapshot,
      readPending: () => false,
      setTimer(callback) {
        timer = callback;
        return 1;
      },
      clearTimer() {
        timer = null;
      },
      onExpire: () => expired++,
    });
    controller.status = 'listening';
    controller.dc = {};
    observer.handle({ type: 'state', state: 'listening' });
    assert.equal(typeof timer, 'function');
    turns.responseActive = true;
    turns.observeSpeech({
      type: 'response.created',
      response: { id: 'silent' },
    });
    assert.equal(timer, null);
    turns.observeSpeech({
      type: 'response.done',
      response: {
        id: 'silent',
        status,
        output:
          status === 'completed'
            ? [{ type: 'function_call', name: 'set_panel_open' }]
            : [],
      },
    });
    // The provider updates generation state after forwarding the raw event.
    assert.equal(timer, null);
    turns.responseActive = false;
    observer.handle({ type: 'completion' });
    assert.equal(observer.snapshot().known, true);
    assert.equal(typeof timer, 'function');
    timer();
    assert.equal(expired, 1);
    idle.destroy();
    observer.destroy();
  }
});

test('silent OpenAI replies cannot clear unresolved older audio or incomplete output metadata', () => {
  const turns = new RealtimeTurns({});
  const observer = observeNativeActivity({
    adapter: {
      controller: { status: 'idle', dc: null, _turns: turns, _input: {} },
    },
    nativeProvider: 'openai',
  });
  const created = (id) =>
    turns.observeSpeech({ type: 'response.created', response: { id } });
  const done = (id, output) =>
    turns.observeSpeech({
      type: 'response.done',
      response: { id, status: 'completed', output },
    });
  created('audio');
  turns.observeSpeech({
    type: 'response.output_audio.delta',
    response_id: 'audio',
  });
  created('silent');
  done('silent', []);
  assert.equal(observer.snapshot().known, false);
  done('audio', []); // Even contradictory completion metadata cannot erase audio evidence.
  assert.equal(observer.snapshot().known, false);
  turns.observeSpeech({
    type: 'output_audio_buffer.started',
    response_id: 'audio',
  });
  assert.equal(observer.snapshot().outputBusy, true);
  done('silent', []);
  assert.equal(observer.snapshot().outputBusy, true);
  turns.observeSpeech({
    type: 'output_audio_buffer.stopped',
    response_id: 'audio',
  });
  assert.equal(observer.snapshot().outputBusy, false);
  created('unknown');
  done('unknown', undefined);
  assert.equal(observer.snapshot().known, false);
  done('unobserved', []);
  assert.equal(observer.snapshot().known, false);
  observer.destroy();
});

test('overlapping silent replies resolve independently and audio output items remain unknown until playback', () => {
  const turns = new RealtimeTurns({});
  const observer = observeNativeActivity({
    adapter: {
      controller: { status: 'idle', dc: null, _turns: turns, _input: {} },
    },
    nativeProvider: 'openai',
  });
  for (const id of ['a', 'b'])
    turns.observeSpeech({ type: 'response.created', response: { id } });
  for (const id of ['a', 'b']) {
    turns.observeSpeech({
      type: 'response.done',
      response: {
        id,
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'text', text: 'Done' }] },
        ],
      },
    });
    assert.equal(observer.snapshot().known, id === 'b');
  }
  turns.observeSpeech({ type: 'response.created', response: { id: 'audio' } });
  turns.observeSpeech({
    type: 'response.done',
    response: {
      id: 'audio',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'audio' }] }],
    },
  });
  assert.equal(observer.snapshot().known, false);
  observer.destroy();
});

test('silent completion cannot establish output knowledge when observer attached mid-session', () => {
  const turns = new RealtimeTurns({});
  const observer = observeNativeActivity({
    adapter: {
      controller: { status: 'listening', dc: {}, _turns: turns, _input: {} },
    },
    nativeProvider: 'openai',
  });
  turns.observeSpeech({ type: 'response.created', response: { id: 'new' } });
  turns.observeSpeech({
    type: 'response.done',
    response: { id: 'new', status: 'completed', output: [] },
  });
  assert.equal(observer.snapshot().known, false);
  observer.destroy();
});

test('Gemini restores each retired audio immediately across repeated same-mount restarts', () => {
  const originals = new Map();
  const controller = {
    input: {},
    createAudio() {
      const audio = { pending: 0, play() {}, clearPlayback() {}, close() {} };
      originals.set(audio, { ...audio });
      return audio;
    },
    handleMessage() {},
  };
  const observer = observeNativeActivity({
    adapter: { controller },
    nativeProvider: 'gemini',
  });
  const assertRestored = (audio) => {
    for (const key of ['play', 'clearPlayback', 'close'])
      assert.equal(audio[key], originals.get(audio)[key]);
  };
  for (let i = 0; i < 5; i++) {
    observer.handle({ type: 'state', state: 'connecting' });
    controller.audio = controller.createAudio({});
    const audio = controller.audio;
    observer.handle({ type: 'state', state: 'listening' });
    assert.notEqual(audio.close, originals.get(audio).close);
    audio.close();
    assertRestored(audio);
    controller.audio = null;
    observer.handle({ type: 'state', state: 'idle' });
  }
  controller.audio = controller.createAudio({});
  const replaced = controller.audio;
  controller.audio = controller.createAudio({});
  assertRestored(replaced);
  const current = controller.audio;
  const replacement = () => {};
  current.play = replacement;
  observer.handle({ type: 'state', state: 'error' });
  assert.equal(current.play, replacement);
  assert.equal(current.close, originals.get(current).close);
  observer.destroy();
});

test('actual OpenAI failed-response error/listening recovery preserves only proven no-audio knowledge', async (t) => {
  const { GevRealtimeController } = await import('../realtimeController.js');
  t.mock.method(console, 'error', () => {});
  for (const [output, known] of [
    [[], true],
    [[{ type: 'message', content: [{ type: 'audio' }] }], false],
    [undefined, false],
  ]) {
    let observer, idle, timer;
    const states = [];
    let expired = 0;
    const controller = new GevRealtimeController({
      runner: async () => ({ ok: true }),
      backend: {},
      debugSink: null,
      ui: {
        root: {
          dataset: {},
          classList: { remove() {} },
          querySelectorAll: () => [],
        },
        status: {},
        detail: {},
      },
      onSessionEvent(event) {
        if (event.type === 'state') states.push(event.state);
        observer?.handle(event);
      },
    });
    observer = observeNativeActivity({
      adapter: { controller },
      nativeProvider: 'openai',
      onChange: () => idle?.update(),
    });
    idle = createVoiceInactivity({
      readActivity: observer.snapshot,
      readPending: () => false,
      setTimer(callback) {
        timer = callback;
        return 1;
      },
      clearTimer() {
        timer = null;
      },
      onExpire() {
        expired++;
      },
    });
    try {
      controller.dc = {
        readyState: 'open',
        send() {},
        close() {
          this.readyState = 'closed';
        },
      };
      controller.setStatus('listening', 'Ready');
      const event = (payload) =>
        controller.handleRealtimeEvent({ data: JSON.stringify(payload) });
      await event({
        type: 'response.created',
        response: { id: 'failed-reply' },
      });
      await event({
        type: 'response.done',
        response: {
          id: 'failed-reply',
          status: 'failed',
          output,
          status_details: { error: { message: 'Synthetic failed reply' } },
        },
      });
      assert.deepEqual(states.slice(-2), ['error', 'listening']);
      assert.equal(controller.dc.readyState, 'open');
      assert.equal(observer.snapshot().known, known);
      assert.equal(idle.snapshot().eligible, known);
      if (known) {
        timer();
        assert.equal(expired, 1);
      } else assert.equal(timer, null);
      // Fatal teardown can preserve the error status; the next connection must
      // still retire the old generation rather than inherit unresolved output.
      controller.setStatus('error', 'Transport failed');
      controller.stop({ preserveStatus: true });
      controller.setStatus('connecting', 'Reconnecting');
      assert.equal(observer.snapshot().connected, false);
      assert.equal(observer.snapshot().known, true);
      controller.stop();
      assert.equal(observer.snapshot().connected, false);
      assert.equal(observer.snapshot().known, true);
    } finally {
      idle.destroy();
      observer.destroy();
      controller.stop();
    }
  }
});
