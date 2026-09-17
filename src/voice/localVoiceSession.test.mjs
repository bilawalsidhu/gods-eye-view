import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalVoiceSession } from './localVoiceSession.js';
import { createVoiceSession } from './session.js';

function installGlobals(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
}

class FakeSocket {
  constructor() {
    this.readyState = 0;
    this.handlers = new Map();
    this.closed = null;
  }
  addEventListener(type, handler) {
    const list = this.handlers.get(type) || [];
    list.push(handler);
    this.handlers.set(type, list);
  }
  dispatch(type, event = {}) {
    for (const handler of this.handlers.get(type) || []) handler(event);
  }
  open() {
    this.readyState = 1;
    this.dispatch('open');
  }
  message(data) {
    this.dispatch('message', { data });
  }
  close(code, reason) {
    this.readyState = 3;
    this.closed = { code, reason };
  }
}

function fakeBackend() {
  const sent = [];
  let socket = null;
  return {
    sent,
    get socket() {
      return socket;
    },
    protocol: 'ollama-local-ws',
    connect() {
      socket = new FakeSocket();
      return socket;
    },
    send(value) {
      if (!socket || socket.readyState !== 1) return false;
      sent.push(value);
      return true;
    },
    close(code, reason) {
      socket?.close(code, reason);
    },
  };
}

function fakeUi() {
  return {
    root: {
      dataset: {},
      classList: { remove() {} },
      querySelectorAll: () => [],
      remove() {},
    },
    status: {},
    detail: {},
    helpDetail: {},
    buttonLabel: {},
  };
}

function harness(t, { runner, capture } = {}) {
  installGlobals(t, {
    window: {},
    document: {
      querySelectorAll: () => [],
      body: { appendChild() {} },
      createElement: () => ({ dataset: {}, style: {}, remove() {} }),
    },
    navigator: {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  });
  const backend = fakeBackend();
  const track = { stops: 0, stop() { this.stops++; } };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  };
  const captures = [];
  const playbacks = [];
  const events = [];
  const actions = [];
  const session = createVoiceSession({
    runner:
      runner ||
      (async (name, args) => {
        actions.push({ name, args });
        return { ok: true, name };
      }),
    createAdapter: (hooks) =>
      createLocalVoiceSession({
        ...hooks,
        runner: () => {},
        ui: fakeUi(),
        debugSink: null,
        backend,
        getUserMedia: async () => stream,
        createCapture:
          capture ||
          ((callbacks) => {
            const instance = {
              kind: 'fake',
              callbacks,
              started: null,
              paused: 0,
              resumed: 0,
              destroyed: 0,
              async start(mediaStream) {
                this.started = mediaStream;
              },
              pause() {
                this.paused++;
              },
              resume() {
                this.resumed++;
              },
              stop() {},
              destroy() {
                this.destroyed++;
              },
            };
            captures.push(instance);
            return instance;
          }),
        createPlayback: (callbacks) => {
          const instance = {
            callbacks,
            encoded: [],
            frames: [],
            stopped: 0,
            speaking: false,
            async enqueueEncoded(bytes) {
              this.encoded.push(bytes);
            },
            handle(frame) {
              this.frames.push(frame);
            },
            interrupt() {},
            stop() {
              this.stopped++;
            },
          };
          playbacks.push(instance);
          return instance;
        },
      }),
  });
  session.subscribe((event) => events.push(event));
  return {
    session,
    backend,
    track,
    captures,
    playbacks,
    events,
    actions,
    states: () => events.filter((e) => e.type === 'state').map((e) => e.state),
  };
}

async function started(h) {
  const starting = h.session.start();
  await Promise.resolve();
  h.backend.socket.open();
  await starting;
  return h;
}

test('start connects, takes the microphone and reaches listening', async (t) => {
  const h = await started(harness(t));
  assert.deepEqual(h.states(), ['connecting', 'connecting', 'listening']);
  assert.equal(h.captures.length, 1);
  assert.equal(h.captures[0].started.getTracks().length, 1);
  assert.equal(h.session.adapter.capabilities.costControls, false);
  assert.equal(h.session.adapter.controller.status, 'listening');
});

test('utterances are sent as binary plus audio_end and tool calls round-trip', async (t) => {
  const h = await started(harness(t));
  const wav = new Uint8Array([82, 73, 70, 70]).buffer;
  h.captures[0].callbacks.onUtterance(wav, { format: 'wav', durationMs: 1200 });
  assert.equal(h.backend.sent[0], wav);
  assert.deepEqual(h.backend.sent[1], {
    type: 'audio_end',
    format: 'wav',
    durationMs: 1200,
  });
  assert.equal(h.session.state, 'executing');
  h.backend.socket.message(
    JSON.stringify({ type: 'transcript', text: 'Fly to Tokyo.' }),
  );
  assert.deepEqual(
    h.events.filter((e) => e.type === 'transcript').at(-1),
    { type: 'transcript', role: 'user', text: 'Fly to Tokyo.', final: true },
  );
  h.backend.socket.message(
    JSON.stringify({
      type: 'tool_call',
      callId: 'c1',
      name: 'fly_to_location',
      arguments: { query: 'Tokyo' },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.actions, [
    { name: 'fly_to_location', args: { query: 'Tokyo' } },
  ]);
  const result = h.backend.sent.find((m) => m.type === 'tool_result');
  assert.deepEqual(result, {
    type: 'tool_result',
    callId: 'c1',
    result: { ok: true, name: 'fly_to_location' },
  });
  assert.ok(h.events.some((e) => e.type === 'action-call'));
  assert.ok(h.events.some((e) => e.type === 'action-result'));
  h.backend.socket.message(JSON.stringify({ type: 'text', text: 'Flying.' }));
  assert.ok(h.events.some((e) => e.type === 'completion'));
  assert.equal(h.session.state, 'listening');
});

test('binary frames and audio chunks reach playback; speech pauses capture', async (t) => {
  const h = await started(harness(t));
  h.backend.socket.message(new Uint8Array([1, 2]).buffer);
  await Promise.resolve();
  assert.equal(h.playbacks[0].encoded.length, 1);
  h.backend.socket.message(
    JSON.stringify({ type: 'audio_chunk', turnId: 't', seq: 0, pcm16: 'AA==' }),
  );
  assert.equal(h.playbacks[0].frames.length, 1);
  h.playbacks[0].callbacks.onSpeaking();
  assert.equal(h.captures[0].paused, 1);
  assert.equal(h.session.state, 'executing');
  h.playbacks[0].callbacks.onIdle();
  assert.equal(h.captures[0].resumed, 1);
  assert.equal(h.session.state, 'listening');
});

test('a failing tool reports ok:false instead of stalling the turn', async (t) => {
  const h = await started(
    harness(t, {
      runner: async () => {
        throw new Error('boom');
      },
    }),
  );
  h.backend.socket.message(
    JSON.stringify({ type: 'tool_call', callId: 'c2', name: 'zoom_to_globe' }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const result = h.backend.sent.find((m) => m.type === 'tool_result');
  assert.equal(result.result.ok, false);
  assert.equal(result.result.error, 'boom');
});

test('stop releases the microphone, closes the socket and ignores late frames', async (t) => {
  const h = await started(harness(t));
  const socket = h.backend.socket;
  h.session.stop();
  assert.equal(h.session.state, 'idle');
  assert.equal(h.track.stops, 1);
  assert.equal(h.captures[0].destroyed, 1);
  assert.equal(h.playbacks[0].stopped, 1);
  assert.equal(socket.closed.code, 1000);
  const before = h.events.length;
  socket.message(
    JSON.stringify({ type: 'tool_call', callId: 'late', name: 'stop_tracking' }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.events.length, before);
  assert.equal(h.actions.length, 0);
});

test('a terminal server error and an unexpected close both end in the error state', async (t) => {
  const first = await started(harness(t));
  first.backend.socket.message(
    JSON.stringify({ type: 'error', error: 'Audio worker unavailable' }),
  );
  assert.equal(first.session.state, 'error');
  assert.equal(first.track.stops, 1);
  const soft = await started(harness(t));
  soft.backend.socket.message(
    JSON.stringify({ type: 'error', error: 'timed out', terminal: false }),
  );
  assert.equal(soft.session.state, 'listening');
  soft.backend.socket.dispatch('close', { code: 1006 });
  assert.equal(soft.session.state, 'error');
});

test('a refused connection surfaces as an error without leaking a stream', async (t) => {
  const h = harness(t);
  const starting = h.session.start();
  await Promise.resolve();
  h.backend.socket.dispatch('error');
  await starting;
  assert.equal(h.session.state, 'error');
  assert.equal(h.track.stops, 0);
  assert.equal(h.captures.length, 0);
});

test('sendText requires a connection and sendMapEvent is best effort', async (t) => {
  const idle = harness(t);
  assert.throws(() => idle.session.adapter.sendText('hello'), /not connected/);
  assert.equal(idle.session.sendMapEvent({ type: 'x' }), false);
  const h = await started(harness(t));
  h.session.sendText('show flights');
  assert.deepEqual(h.backend.sent.at(-1), {
    type: 'text',
    text: 'show flights',
  });
  assert.equal(h.session.state, 'executing');
  assert.equal(h.session.sendMapEvent({ type: 'map_annotation_outline' }), true);
});
