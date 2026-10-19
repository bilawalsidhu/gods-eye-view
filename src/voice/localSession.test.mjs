import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalSession } from './localSession.js';
import { createConfiguredSession } from './configuredSession.js';

function ui() {
  return {
    root: { dataset: {} },
    detail: {},
    tierButton: {},
    costValue: {},
    helpDetail: {},
  };
}

test('stopping while microphone permission is pending closes the late stream', async (t) => {
  const originals = Object.fromEntries(
    ['fetch', 'MediaRecorder', 'navigator'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  t.after(() => {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  let acceptMicrophone,
    requested = false,
    stopped = 0;
  globalThis.fetch = async () => Response.json({ ready: true });
  globalThis.MediaRecorder = class {};
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () => {
          requested = true;
          return new Promise((resolve) => {
            acceptMicrophone = resolve;
          });
        },
      },
    },
  });
  const events = [];
  const session = createLocalSession({
    ui: ui(),
    emit: (event) => events.push(event),
    runAction() {},
    config: { profile: 'low' },
    runtime: { prepare: async () => {}, stop() {} },
  });
  const starting = session.start();
  while (!requested) await new Promise((resolve) => setImmediate(resolve));
  session.stop();
  acceptMicrophone({ getTracks: () => [{ stop: () => stopped++ }] });
  await starting;
  assert.equal(stopped, 1);
  assert.equal(events.at(-1).state, 'idle');
  assert.equal(
    events.some((event) => event.state === 'listening'),
    false,
  );
});

test('repeated Space while connecting cannot start recording before a microphone exists', async (t) => {
  const originalFetch = globalThis.fetch,
    originalWindow = globalThis.window;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  const listeners = new Map();
  globalThis.window = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
  };
  globalThis.fetch = (_url, { signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      }),
    );
  const session = createLocalSession({
    ui: ui(),
    emit() {},
    runAction() {},
    config: { profile: 'low', model: 'Bonsai' },
    runtime: {
      prepare: (signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        ),
      stop() {},
    },
  });
  session.bindControls();
  const event = { code: 'Space', preventDefault() {} };
  listeners.get('keydown')(event);
  listeners.get('keyup')(event);
  assert.doesNotThrow(() => listeners.get('keydown')(event));
  session.stop({ removeUi: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listeners.size, 0);
});

test('stopping during provider resolution prevents a late Local startup and cloud fallback', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let resolveConfig;
  const requests = [];
  globalThis.fetch = (url) => {
    requests.push(url);
    return new Promise((resolve) => {
      resolveConfig = resolve;
    });
  };
  const lifetime = new AbortController();
  const adapter = createConfiguredSession({
    ui: ui(),
    signal: lifetime.signal,
    emit() {},
    runAction() {},
  });
  const starting = adapter.start();
  adapter.stop();
  resolveConfig(
    Response.json({
      provider: 'local',
      profile: 'low',
      model: 'Ternary-Bonsai-1.7B',
    }),
  );
  await starting;
  assert.deepEqual(requests, ['/api/ai/config']);
  assert.equal(adapter.getController(), undefined);
});

test('a provider configuration failure does not activate OpenAI', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return Response.json({ error: 'invalid configuration' }, { status: 503 });
  };
  const adapter = createConfiguredSession({
    ui: ui(),
    emit() {},
    runAction() {},
  });
  await assert.rejects(adapter.start(), /provider settings/);
  assert.deepEqual(requests, ['/api/ai/config']);
});

test('short Space taps are ignored and subsequent PCM speech reaches Whisper without decoding', async (t) => {
  const originals = Object.fromEntries(
    [
      'window',
      'navigator',
      'AudioContext',
      'AudioWorkletNode',
      'MediaRecorder',
    ].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const listeners = new Map(),
    events = [],
    transcribed = [];
  let node,
    trackStops = 0;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => trackStops++ }],
        }),
      },
    },
  });
  globalThis.window = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
  };
  globalThis.MediaRecorder = class {
    constructor() {
      assert.fail('Encoded capture must not be used');
    }
  };
  globalThis.AudioContext = class {
    audioWorklet = { addModule: async () => {} };
    destination = {};
    async resume() {}
    async close() {}
    decodeAudioData() {
      assert.fail('Encoded audio must not be decoded');
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createAnalyser() {
      return { getFloatTimeDomainData() {} };
    }
  };
  globalThis.AudioWorkletNode = class {
    constructor() {
      node = this;
    }
    port = {
      postMessage: (message) => {
        if (message.type === 'start') node.recording = message.id;
      },
      close() {},
    };
    connect() {}
    disconnect() {}
  };
  const session = createLocalSession({
    ui: ui(),
    emit: (event) => events.push(event),
    runAction() {},
    config: { profile: 'low', model: 'Bonsai' },
    runtime: {
      prepare: async () => {},
      stop() {},
      transcribe: async (samples) => {
        transcribed.push(samples);
        return { text: '' };
      },
    },
  });
  t.after(() => {
    session.stop({ removeUi: true });
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  session.bindControls();
  await session.start({ pushToTalk: true });
  const key = { code: 'Space', preventDefault() {} };
  for (const samples of [new Float32Array(), new Float32Array(320).fill(0.1)]) {
    listeners.get('keydown')(key);
    listeners.get('keyup')(key);
    node.port.onmessage({
      data: { id: node.recording, samples, sampleRate: 16000 },
    });
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(transcribed.length, 0);
  const spoken = new Float32Array(8000).fill(0.1);
  listeners.get('keydown')(key);
  listeners.get('keyup')(key);
  node.port.onmessage({
    data: { id: node.recording, samples: spoken, sampleRate: 16000 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(transcribed, [spoken]);
  assert.equal(
    events.some((event) => event.state === 'error'),
    false,
  );
  assert.equal(events.at(-1).state, 'listening');
  session.stop();
  assert.equal(trackStops, 1);
});

test('a new text command cancels generation without stopping the microphone or speaking a stale answer', async (t) => {
  const originals = Object.fromEntries(
    ['navigator', 'AudioContext', 'AudioWorkletNode', 'Audio'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  let trackStops = 0,
    chatSignal,
    chatResolve;
  const spoken = [],
    events = [],
    actions = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => trackStops++ }],
        }),
      },
    },
  });
  globalThis.AudioContext = class {
    audioWorklet = { addModule: async () => {} };
    destination = {};
    async resume() {}
    async close() {}
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createAnalyser() {
      return { getFloatTimeDomainData() {} };
    }
  };
  globalThis.AudioWorkletNode = class {
    port = { postMessage() {}, close() {} };
    connect() {}
    disconnect() {}
  };
  globalThis.Audio = class {
    pause() {}
    async play() {
      queueMicrotask(() => this.onended?.());
    }
  };
  const session = createLocalSession({
    ui: ui(),
    emit: (event) => events.push(event),
    config: { profile: 'max', language: 'ru' },
    runAction: async (name) => {
      actions.push(name);
      return { ok: true };
    },
    runtime: {
      prepare: async () => {},
      stop() {},
      chat: async (_messages, signal) => {
        chatSignal = signal;
        return new Promise((resolve) => {
          chatResolve = resolve;
        });
      },
      speech: async (text) => {
        spoken.push(text);
        return new Blob(['wav']);
      },
    },
  });
  t.after(() => {
    session.stop();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await session.start({ pushToTalk: true });
  const first = session.sendText('Расскажи что-нибудь');
  while (!chatResolve) await new Promise((resolve) => setImmediate(resolve));
  const second = session.sendText('Приблизь немного');
  assert.equal(chatSignal.aborted, true);
  chatResolve({ message: { content: 'Stale answer' } });
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.deepEqual(actions, ['adjust_camera_zoom']);
  assert.deepEqual(spoken, ['Приближаю.']);
  assert.equal(trackStops, 0);
  assert.equal(
    events.some((event) => event.state === 'error'),
    false,
  );
  assert.equal(events.at(-1).state, 'listening');
});

test('stopping while local speech is pending prevents late playback', async (t) => {
  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    'navigator',
  );
  const originalContext = globalThis.AudioContext,
    originalWorklet = globalThis.AudioWorkletNode;
  let speechResolve, speechSignal;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
      },
    },
  });
  globalThis.AudioContext = class {
    audioWorklet = { addModule: async () => {} };
    destination = {};
    async resume() {}
    async close() {}
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createAnalyser() {
      return { getFloatTimeDomainData() {} };
    }
  };
  globalThis.AudioWorkletNode = class {
    port = { postMessage() {}, close() {} };
    connect() {}
    disconnect() {}
  };
  const events = [];
  const session = createLocalSession({
    ui: ui(),
    config: { profile: 'low', language: 'ru' },
    emit: (e) => events.push(e),
    runAction: async () => ({ ok: true }),
    runtime: {
      prepare: async () => {},
      stop() {},
      speech: (_text, signal) => {
        speechSignal = signal;
        return new Promise((resolve) => {
          speechResolve = resolve;
        });
      },
    },
  });
  t.after(() => {
    session.stop();
    Object.defineProperty(globalThis, 'navigator', originalNavigator);
    globalThis.AudioContext = originalContext;
    globalThis.AudioWorkletNode = originalWorklet;
  });
  await session.start({ pushToTalk: true });
  const pending = session.sendText('Приблизь');
  while (!speechResolve) await new Promise((resolve) => setImmediate(resolve));
  session.stop();
  assert.equal(speechSignal.aborted, true);
  speechResolve(new Blob(['wav']));
  assert.equal(await pending, false);
  assert.equal(events.at(-1).state, 'idle');
});
