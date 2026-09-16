// Session-lifecycle tests for the voice controller: the WebRTC start() flow,
// epoch-superseded starts, connection-state handling, push-to-talk, the
// error/diagnostics plumbing, and the viewport-screenshot context send.
// Companion to gevRealtime.test.mjs, which owns the pure-logic exports.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Browser global stubs. The controller reads these at RUNTIME (start(),
// setStatus, captureViewportImage), so they are installed on globalThis AFTER
// the dynamic import below — the Cesium/knockout import chain feature-detects
// window/document and explodes on partial stubs, but is clean with none.
// ---------------------------------------------------------------------------

function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: '',
    children: [],
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      _set: new Set(),
      add(...names) { names.forEach((n) => el.classList._set.add(n)); },
      remove(...names) { names.forEach((n) => el.classList._set.delete(n)); },
      toggle(name, force) {
        const next = force === undefined ? !el.classList._set.has(name) : Boolean(force);
        if (next) el.classList._set.add(name); else el.classList._set.delete(name);
        return next;
      },
      contains: (name) => el.classList._set.has(name),
    },
    handlers: {},
    attributes: new Map(),
    textContent: '',
    title: '',
    innerHTML: '',
    removed: false,
    appendChild(child) { el.children.push(child); },
    insertBefore(child) { el.children.unshift(child); },
    remove() { el.removed = true; },
    setAttribute(name, value) { el.attributes.set(name, String(value)); },
    getAttribute: (name) => (el.attributes.has(name) ? el.attributes.get(name) : null),
    addEventListener(type, fn) { (el.handlers[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      el.handlers[type] = (el.handlers[type] || []).filter((f) => f !== fn);
    },
    dispatch(type, event = {}) {
      for (const fn of [...(el.handlers[type] || [])]) fn(event);
    },
  };
  // Stable per-selector descendants so a listener attached via querySelector
  // can be found (and fired) again by the test.
  el._q = {};
  el.querySelectorAll = () => [];
  el.querySelector = (sel) => {
    el._q[sel] ||= makeEl('div');
    return el._q[sel];
  };
  return el;
}

// Default RGBA buffer handed out by canvas stubs: uniform light gray, i.e. a
// healthy capture. Tests that need a dead frame swap `canvasPixels`.
function lightGrayFrame() {
  const pixels = new Uint8ClampedArray(48 * 32 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 200;
    pixels[index + 1] = 200;
    pixels[index + 2] = 200;
    pixels[index + 3] = 255;
  }
  return pixels;
}
let canvasPixels = lightGrayFrame();
let viewportDataUrl = 'data:image/jpeg;base64,QUJDREVG';

function makeCanvasEl() {
  const el = makeEl('canvas');
  el.width = 0;
  el.height = 0;
  el.toDataURL = () => viewportDataUrl;
  let ctx = null;
  el.getContext = () => {
    ctx ||= {
      canvas: el,
      drawImage() {},
      getImageData: () => ({ data: canvasPixels }),
    };
    return ctx;
  };
  return el;
}

const documentStub = {
  hidden: false,
  visibilityState: 'visible',
  location: { href: 'http://localhost:4173/' }, // Cesium's RequestScheduler reads this at import
  body: null,
  _listeners: new Map(),
  getElementById(id) {
    if (id === 'gev-voice-control') {
      return documentStub.body.children.find((child) => child.id === id) || null;
    }
    return null; // no #command-dock in the stub → the control appends to body
  },
  createElement(tag) {
    return String(tag).toLowerCase() === 'canvas' ? makeCanvasEl() : makeEl(tag);
  },
  addEventListener(type, fn) {
    if (!documentStub._listeners.has(type)) documentStub._listeners.set(type, new Set());
    documentStub._listeners.get(type).add(fn);
  },
  removeEventListener(type, fn) { documentStub._listeners.get(type)?.delete(fn); },
  dispatchDocument(type, event = {}) {
    for (const fn of [...(documentStub._listeners.get(type) || [])]) fn(event);
  },
  documentListenerCount(type) { return documentStub._listeners.get(type)?.size || 0; },
  querySelectorAll: () => [],
  querySelector: () => null,
};
documentStub.body = makeEl('body');

const windowListeners = new Map();
const windowStub = {
  RTCPeerConnection: undefined,
  AudioContext: undefined,
  navigator: { userAgent: 'node-test' },
  setTimeout,
  clearTimeout,
  requestIdleCallback: null,
  addEventListener(type, fn) {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type).add(fn);
  },
  removeEventListener(type, fn) { windowListeners.get(type)?.delete(fn); },
  dispatchWindow(type, event = {}) {
    for (const fn of [...(windowListeners.get(type) || [])]) fn(event);
  },
  dispatchEvent() {},
  __godsEyeView: null,
  __gevVoiceCommands: null,
  __GOOGLE_MAPS_API_KEY__: 'test-gev-key',
};

const localStorageMap = new Map();
const localStorageStub = {
  getItem: (key) => (localStorageMap.has(key) ? localStorageMap.get(key) : null),
  setItem: (key, value) => localStorageMap.set(key, String(value)),
  removeItem: (key) => localStorageMap.delete(key),
};

function makeMediaTrack() {
  return {
    kind: 'audio',
    enabled: true,
    stopped: false,
    stop() { this.stopped = true; },
  };
}

function makeMediaStream() {
  const track = makeMediaTrack();
  return {
    track,
    getTracks: () => [track],
    getAudioTracks: () => [track],
  };
}

// Node exposes `navigator` as getter-only — define our stub over it.
const navigatorStub = {
  sendBeacon: () => true,
  mediaDevices: {
    getUserMedia: async () => makeMediaStream(),
  },
};

// --- fetch router -----------------------------------------------------------

const fetchCalls = [];
let tokenResponder = null;
let sdpResponder = null;

function tokenResponse({
  ok = true,
  status = 200,
  value = 'TOKEN-123',
  model = 'gpt-realtime-2',
  tier = 'standard',
  body,
} = {}) {
  return {
    ok,
    status,
    headers: {
      get: (name) => {
        if (name === 'X-GEV-Voice-Model') return model;
        if (name === 'X-GEV-Voice-Tier') return tier;
        return null;
      },
    },
    json: async () => (body === undefined ? { value } : body),
    text: async () => JSON.stringify(body === undefined ? { value } : body),
  };
}

function sdpResponse({ ok = true, status = 200, answer = 'ANSWER-SDP-V1', bodyText = '' } = {}) {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => (ok ? answer : bodyText),
  };
}

function resetFetch() {
  fetchCalls.length = 0;
  tokenResponder = () => tokenResponse();
  sdpResponder = () => sdpResponse();
  // Also restore the default mic grant — tests that gate getUserMedia behind
  // a deferred must not leak that gate into later tests.
  navigatorStub.mediaDevices.getUserMedia = async () => makeMediaStream();
}
resetFetch();

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  fetchCalls.push({ url: href, init });
  if (href.includes('/api/realtime/token')) return tokenResponder();
  if (href === 'https://api.openai.com/v1/realtime/calls') return sdpResponder();
  throw new Error(`unexpected fetch: ${href}`);
};

// --- WebRTC stubs -----------------------------------------------------------

class FakeDataChannel {
  constructor() {
    this.readyState = 'open';
    this.sent = [];
    this.handlers = {};
    this.closed = false;
  }

  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }

  send(data) {
    if (this.readyState !== 'open') throw new Error('data channel closed');
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.readyState = 'closed';
    for (const fn of [...(this.handlers.close || [])]) fn({});
  }

  emit(type, event = {}) {
    for (const fn of [...(this.handlers[type] || [])]) fn(event);
  }
}

class FakeRTCPeerConnection {
  constructor() {
    this.tracks = [];
    this.handlers = {};
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.iceGatheringState = 'new';
    this.signalingState = 'stable';
    this.localDescription = null;
    this.remoteDescription = null;
    this.closed = false;
    this.dataChannel = new FakeDataChannel();
  }

  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }

  addTrack(track) { this.tracks.push(track); }

  createDataChannel() { return this.dataChannel; }

  async createOffer() { return { type: 'offer', sdp: 'OFFER-SDP-V1' }; }

  async setLocalDescription(description) {
    this.localDescription = description;
    this.connectionState = 'connecting';
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
    this.connectionState = 'connected';
    this.iceConnectionState = 'connected';
  }

  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }

  emit(type, event = {}) {
    for (const fn of [...(this.handlers[type] || [])]) fn(event);
  }
}

// --- console capture --------------------------------------------------------

const realConsoleError = console.error;
const realConsoleWarn = console.warn;
const errorLog = [];
const warnLog = [];
console.error = (...args) => errorLog.push(args);
console.warn = (...args) => warnLog.push(args);
after(() => {
  console.error = realConsoleError;
  console.warn = realConsoleWarn;
  globalThis.window.__godsEyeView = null;
  documentStub.hidden = false;
  canvasPixels = lightGrayFrame();
  viewportDataUrl = 'data:image/jpeg;base64,QUJDREVG';
});

// --- imports -----------------------------------------------------------------
// Import FIRST, with no browser globals at all: the Cesium/knockout import
// chain feature-detects `window`/`document` and falls back cleanly when they
// are undefined, but explodes on PARTIAL stubs. Everything below is runtime
// state, so installing the stubs after the import is exactly equivalent for
// the code under test — and lets this file run the full WebRTC session flow.

const { GevRealtimeController, initGevVoiceCommands } = await import('./gevRealtime.js');

globalThis.window = windowStub;
globalThis.document = documentStub;
globalThis.localStorage = localStorageStub;
Object.defineProperty(globalThis, 'navigator', {
  value: navigatorStub,
  writable: true,
  configurable: true,
});
globalThis.RTCPeerConnection = FakeRTCPeerConnection;
windowStub.RTCPeerConnection = FakeRTCPeerConnection;

// --- shared harness ---------------------------------------------------------

// The production grace window is 6000ms; tests tick almost-all then the rest.
const GRACE_ALMOST = 5999;
const GRACE_REST = 1;

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Waits for a fire-and-forget start() to reach an expected state. Unlike
// awaiting the start() promise directly, these flows hand control back to the
// caller before the handshake chain finishes.
async function waitFor(predicate, { timeoutMs = 2000, what = 'condition' } = {}) {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor timed out: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function makeUi() {
  return {
    root: makeEl('div'),
    status: makeEl('div'),
    detail: makeEl('div'),
    errorDetail: makeEl('div'),
    button: makeEl('button'),
    buttonLabel: makeEl('span'),
    helpDetail: makeEl('span'),
    tierButton: makeEl('button'),
    costValue: makeEl('span'),
  };
}

function makeRadioLayer() {
  return {
    stopPlayback: () => {},
    pause: () => {},
    setVoiceDucked: () => {},
    playForVoice: async () => true,
    subscribePlaybackControls: () => () => {},
  };
}

function makeController({ radioLayer, dataManager, runner } = {}) {
  localStorageMap.clear(); // controllers must not inherit a previous test's error log
  const controller = new GevRealtimeController({
    runner: runner || (async () => ({ ok: true })),
    ui: makeUi(),
    radioLayer: radioLayer || makeRadioLayer(),
    dataManager: dataManager || null,
  });
  controller.debugLog = () => {};
  return controller;
}

function spaceEvent(overrides = {}) {
  return {
    code: 'Space',
    key: ' ',
    repeat: false,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: {},
    prevented: false,
    preventDefault() { this.prevented = true; },
    ...overrides,
  };
}

function makeCaptureViewer({ width = 1600, height = 1200 } = {}) {
  const canvas = makeCanvasEl();
  canvas.width = width;
  canvas.height = height;
  return {
    scene: {
      canvas,
      requestRender() {},
      postRender: {
        // Fire asynchronously: the production callback closes over the remove()
        // return value, which does not exist yet during a synchronous dispatch.
        addEventListener: (cb) => {
          queueMicrotask(cb);
          return () => {};
        },
      },
    },
  };
}

function localContextResult(viewScale = 'local') {
  return {
    action: 'get_entity_context',
    ok: true,
    scene: { basemap: { viewScale } },
  };
}

// ---------------------------------------------------------------------------
// start(): WebRTC handshake
// ---------------------------------------------------------------------------

test('start() runs token → mic → peer → SDP and lands in listening on channel open', async () => {
  resetFetch();
  const controller = makeController();
  const constraintsSeen = [];
  globalThis.navigator.mediaDevices.getUserMedia = async (constraints) => {
    constraintsSeen.push(constraints);
    return makeMediaStream();
  };

  await controller.start({ pushToTalk: false });

  // Token: POST (CORS hardening) with the requested tier, bearer on the SDP call.
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].init.method, 'POST');
  assert.ok(fetchCalls[0].url.includes('tier=standard'), fetchCalls[0].url);
  assert.equal(fetchCalls[1].init.headers.Authorization, 'Bearer TOKEN-123');
  assert.equal(fetchCalls[1].init.headers['Content-Type'], 'application/sdp');
  assert.equal(fetchCalls[1].init.body, 'OFFER-SDP-V1');

  const pc = controller.pc;
  assert.ok(pc instanceof FakeRTCPeerConnection);
  assert.equal(pc.tracks.length, 1, 'the mic track is attached to the peer connection');
  assert.equal(pc.remoteDescription.sdp, 'ANSWER-SDP-V1', 'the answer was applied');

  assert.equal(controller.status, 'connecting');
  assert.equal(controller.ui.status.textContent, 'CONNECTING');
  assert.equal(controller.dc, pc.dataChannel, 'the oai-events channel is wired');
  assert.equal(controller.stream.track.enabled, true, 'open-mic starts unmuted');
  assert.equal(controller.ui.root.dataset.microphone, 'active');
  assert.ok(controller.audioEl, 'the assistant audio element was created');
  assert.ok(documentStub.body.children.includes(controller.audioEl));
  assert.deepEqual(constraintsSeen, [{
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  }]);

  // The session meter binds to the model the server SERVED, not the tier asked.
  assert.equal(controller.costTracker.state().modelId, 'gpt-realtime-2');
  assert.equal(controller.costTracker.state().ratesRecognized, true);

  controller.dc.emit('open');
  assert.equal(controller.status, 'listening');
  assert.equal(controller.ui.detail.textContent, 'Ask or command');
  assert.equal(controller.ui.status.textContent, 'LISTENING');

  controller.stop();
  assert.equal(controller.dc, null);
  assert.equal(controller.pc, null);
  assert.equal(controller.audioEl, null);
});

test('stop() removes the assistant audio element', async () => {
  resetFetch();
  const controller = makeController();
  await controller.start();
  const audioEl = controller.audioEl;
  assert.ok(documentStub.body.children.includes(audioEl));
  controller.stop();
  assert.equal(audioEl.removed, true);
});

test('start() without WebRTC support reports an error before any network call', async () => {
  resetFetch();
  const realPc = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = undefined;
  globalThis.window.RTCPeerConnection = undefined;
  try {
    const controller = makeController();
    await controller.start();
    assert.equal(fetchCalls.length, 0, 'no token is minted when WebRTC is absent');
    assert.equal(controller.status, 'error');
    assert.equal(controller.ui.detail.textContent, 'VOICE UNAVAILABLE');
    assert.equal(controller.ui.errorDetail.textContent, 'WebRTC microphone support unavailable');
  } finally {
    globalThis.RTCPeerConnection = realPc;
    globalThis.window.RTCPeerConnection = realPc;
  }
});

test('token failure surfaces the server message and acquires nothing', async () => {
  resetFetch();
  tokenResponder = () => tokenResponse({ ok: false, status: 500, body: { error: 'quota blown' } });
  const controller = makeController();
  await controller.start();
  assert.equal(controller.status, 'error');
  assert.equal(controller.errors[0].source, 'Realtime connection');
  assert.equal(controller.errors[0].message, 'quota blown');
  assert.equal(controller.ui.errorDetail.textContent, 'Realtime connection: quota blown');
  assert.equal(controller.stream, null);
});

test('object-shaped error bodies and missing secrets produce honest messages', async () => {
  resetFetch();
  tokenResponder = () => tokenResponse({
    ok: false,
    status: 429,
    body: { error: { message: 'slow down', type: 'rate_limit' } },
  });
  const controller = makeController();
  await controller.start();
  assert.equal(controller.errors[0].message, 'slow down');

  resetFetch();
  tokenResponder = () => tokenResponse({ body: {} });
  const second = makeController();
  await second.start();
  assert.equal(second.errors[0].message, 'Realtime token response did not include a client secret');
});

test('an unrecognised served model is billed at worst-case rates with a warning', async () => {
  resetFetch();
  tokenResponder = () => tokenResponse({ model: 'gpt-obsolete-9' });
  const controller = makeController();
  await controller.start();
  const state = controller.costTracker.state();
  assert.equal(state.modelId, 'gpt-obsolete-9');
  assert.equal(state.ratesRecognized, false);
  assert.ok(
    warnLog.some(([line]) => String(line).includes('unrecognised Realtime model "gpt-obsolete-9"')),
    'the rate-table warning names the model',
  );
  controller.stop();
});

test('SDP negotiation failure tears the hot mic down and reports the HTTP status', async () => {
  resetFetch();
  sdpResponder = () => sdpResponse({ ok: false, status: 429, bodyText: 'too many calls' });
  const controller = makeController();
  await controller.start();
  assert.equal(controller.status, 'error');
  assert.equal(controller.errors[0].source, 'Realtime connection');
  assert.equal(controller.errors[0].message, 'Realtime SDP failed: HTTP 429 - too many calls');
  assert.equal(controller.pc, null);
  assert.equal(controller.dc, null);
  assert.equal(controller.stream, null);
  assert.equal(controller.ui.detail.textContent, 'VOICE UNAVAILABLE');
});

// ---------------------------------------------------------------------------
// Epoch supersession (H7): a superseded start must never leak its resources
// ---------------------------------------------------------------------------

test('abandonStart releases the attempt’s own resources and spares a successor’s', () => {
  const controller = makeController();
  assert.equal(controller.abandonStart(controller.startEpoch, {}), false, 'current epoch is live');

  controller.startEpoch += 1; // simulate supersession
  const stream = makeMediaStream();
  const pc = new FakeRTCPeerConnection();
  controller.stream = stream;
  controller.pc = pc;
  controller.dc = pc.dataChannel;

  assert.equal(controller.abandonStart(controller.startEpoch - 1, { localStream: stream, localPc: pc }), true);
  assert.equal(controller.stream, null);
  assert.equal(controller.pc, null);
  assert.equal(controller.dc, null);
  assert.equal(stream.track.stopped, true, 'the abandoned mic track is stopped');
  assert.equal(pc.closed, true, 'the abandoned peer connection is closed');

  // A successor already owns this.stream/this.pc — the stale attempt must not
  // null them, only release its own locals.
  const successorStream = makeMediaStream();
  const successorPc = new FakeRTCPeerConnection();
  controller.stream = successorStream;
  controller.pc = successorPc;
  assert.equal(controller.abandonStart(controller.startEpoch - 2, { localStream: stream, localPc: pc }), true);
  assert.equal(controller.stream, successorStream);
  assert.equal(controller.pc, successorPc);
  assert.equal(successorStream.track.stopped, false);
  assert.equal(successorPc.closed, false);
});

test('stop() supersedes an in-flight start so no resources are promoted', async () => {
  resetFetch();
  let releaseToken;
  const tokenGate = new Promise((resolve) => { releaseToken = resolve; });
  tokenResponder = () => tokenGate.then(() => tokenResponse());

  const controller = makeController();
  const startPromise = controller.start();
  controller.stop(); // bumps the epoch while start() awaits the token
  releaseToken();
  await startPromise;

  assert.equal(controller.status, 'idle');
  assert.equal(controller.stream, null);
  assert.equal(controller.pc, null);
  assert.equal(controller.dc, null);
  assert.equal(fetchCalls.length, 1, 'the SDP exchange never happened');
});

test('stop() while the mic is still being acquired releases that stream on arrival', async () => {
  resetFetch();
  let resolveMic;
  globalThis.navigator.mediaDevices.getUserMedia = async () => new Promise((resolve) => {
    resolveMic = resolve;
  });

  const controller = makeController();
  const startPromise = controller.start();
  await flush(); // let the attempt park inside getUserMedia
  controller.stop();
  resolveMic(makeMediaStream()); // the mic grant arrives after the stop
  await startPromise;

  assert.equal(controller.status, 'idle');
  assert.equal(controller.stream, null, 'the late stream is released, not promoted');
  assert.equal(controller.pc, null);
});

// ---------------------------------------------------------------------------
// Connection-state handling (H8)
// ---------------------------------------------------------------------------

test('a failed peer connection is fatal: stop first, then report', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  resetFetch();
  const controller = makeController();
  await controller.start();
  const pc = controller.pc;
  pc.connectionState = 'failed';
  controller.handleConnectionStateChange();

  assert.equal(controller.status, 'error');
  assert.equal(controller.errors[0].source, 'WebRTC connection');
  assert.equal(pc.closed, true, 'stop() closed the peer connection');
  assert.equal(controller.dc, null);
  assert.equal(controller.stream, null);
});

test('disconnected gets a grace window and recovery cancels the escalation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  resetFetch();
  const controller = makeController();
  await controller.start();
  const pc = controller.pc;
  const fatalCount = () => controller.errors.filter((e) => e.source.startsWith('WebRTC')).length;

  pc.connectionState = 'disconnected';
  controller.handleConnectionStateChange();
  assert.equal(fatalCount(), 0, 'no immediate fatal on disconnected');

  t.mock.timers.tick(GRACE_ALMOST);
  pc.connectionState = 'connected';
  controller.handleConnectionStateChange(); // recovery cancels the timer
  t.mock.timers.tick(GRACE_REST);
  assert.equal(fatalCount(), 0, 'recovery inside the grace window survives');
  assert.equal(controller.status, 'connecting');

  // A second disconnected that is never recovered DOES escalate.
  pc.connectionState = 'disconnected';
  controller.handleConnectionStateChange();
  t.mock.timers.tick(GRACE_ALMOST + GRACE_REST);
  assert.equal(fatalCount(), 1);
  assert.equal(controller.errors[0].source, 'WebRTC connection lost');
  assert.equal(controller.status, 'error');
});

test('a repeated disconnected event does not stack escalation timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  resetFetch();
  const controller = makeController();
  await controller.start();
  const pc = controller.pc;
  pc.connectionState = 'disconnected';
  controller.handleConnectionStateChange();
  controller.handleConnectionStateChange(); // second blip while the grace is pending
  t.mock.timers.tick(GRACE_ALMOST + GRACE_REST);
  assert.equal(controller.errors.length, 1, 'exactly one fatal for the drop');
});

test('ICE failure is fatal; an ICE candidate error is reported but distinct', async () => {
  resetFetch();
  const controller = makeController();
  await controller.start();
  const pc = controller.pc;

  pc.iceConnectionState = 'failed';
  pc.oniceconnectionstatechange();
  assert.equal(controller.status, 'error');
  assert.equal(controller.errors[0].source, 'ICE connection');

  resetFetch();
  const second = makeController();
  await second.start();
  second.pc.onicecandidateerror({
    errorCode: 70,
    errorText: 'stun unreachable',
    address: '10.0.0.1',
    port: 3478,
    url: 'stun:stun.l.google.com:19302',
  });
  assert.equal(second.status, 'error');
  assert.equal(second.errors[0].source, 'ICE candidate');
  assert.equal(second.errors[0].errorCode, 70);
  assert.equal(second.errors[0].address, '10.0.0.1');
});

// ---------------------------------------------------------------------------
// Push-to-talk
// ---------------------------------------------------------------------------

test('hold-Space starts a push-to-talk session and release mutes but keeps it', async () => {
  resetFetch();
  const controller = makeController();
  controller.bindPushToTalkShortcut();
  assert.equal(documentStub.documentListenerCount('keydown'), 1);

  // Typing targets and modified shortcuts never trigger the shortcut.
  const editable = spaceEvent({ target: { isContentEditable: true } });
  documentStub.dispatchDocument('keydown', editable);
  assert.equal(editable.prevented, false);
  assert.equal(controller.spaceKeyHeld, false);

  const modified = spaceEvent({ ctrlKey: true });
  documentStub.dispatchDocument('keydown', modified);
  assert.equal(modified.prevented, false);

  const down = spaceEvent();
  documentStub.dispatchDocument('keydown', down);
  assert.equal(down.prevented, true, 'Space never clicks the focused mic button');
  assert.equal(controller.spaceKeyHeld, true);
  assert.equal(controller.pushToTalkKeyHeld, true);
  assert.equal(controller.ui.root.dataset.pushToTalk, 'held');

  await flush();
  // The stub channel only opens when the test says so — like a real ICE answer.
  await waitFor(() => controller.dc, { what: 'push-to-talk data channel' });
  controller.dc.emit('open');
  await waitFor(() => controller.status === 'listening', { what: 'push-to-talk session listening' });
  assert.equal(controller.status, 'listening');
  assert.equal(controller.ui.detail.textContent, 'Release Space to send');
  assert.equal(controller.stream.track.enabled, true);

  const repeat = spaceEvent({ repeat: true });
  documentStub.dispatchDocument('keydown', repeat);
  assert.equal(repeat.prevented, true, 'auto-repeat keeps the browser from scrolling');
  assert.equal(controller.pushToTalkMode, true);

  const up = spaceEvent();
  documentStub.dispatchDocument('keyup', up);
  assert.equal(up.prevented, true);
  assert.equal(controller.pushToTalkKeyHeld, false);
  assert.equal(controller.ui.root.dataset.pushToTalk, undefined);
  assert.equal(controller.stream.track.enabled, false, 'release mutes the mic');
  assert.equal(controller.ui.root.dataset.microphone, 'muted');
  assert.equal(controller.ui.detail.textContent, 'Hold Space to talk');
  assert.ok(controller.dc, 'the session stays alive for the reply');

  controller.stop({ removeUi: true });
  assert.equal(documentStub.documentListenerCount('keydown'), 0);
  assert.equal(documentStub.documentListenerCount('keyup'), 0);
  assert.equal(documentStub.documentListenerCount('visibilitychange'), 0);
});

test('Space never mutes or claims a click-started open-mic session', async () => {
  resetFetch();
  const controller = makeController();
  controller.bindPushToTalkShortcut();
  await controller.start({ pushToTalk: false });
  assert.equal(controller.pushToTalkMode, false);

  const down = spaceEvent();
  documentStub.dispatchDocument('keydown', down);
  assert.equal(controller.spaceKeyHeld, true, 'Space is still observed');
  assert.equal(controller.pushToTalkKeyHeld, false, 'but the open-mic session is untouched');
  assert.equal(controller.ui.root.dataset.pushToTalk, undefined);
  assert.equal(controller.stream.track.enabled, true);

  const up = spaceEvent();
  documentStub.dispatchDocument('keyup', up);
  assert.equal(controller.stream.track.enabled, true, 'keyup does not mute an open-mic session');
  controller.stop();
});

test('window blur and tab-hidden release a held push-to-talk key', async () => {
  resetFetch();
  const controller = makeController();
  controller.bindPushToTalkShortcut();

  documentStub.dispatchDocument('keydown', spaceEvent());
  assert.equal(controller.pushToTalkKeyHeld, true);
  await flush();
  await flush();
  assert.equal(controller.stream.track.enabled, true);

  globalThis.window.dispatchWindow('blur');
  assert.equal(controller.spaceKeyHeld, false);
  assert.equal(controller.pushToTalkKeyHeld, false);
  assert.equal(controller.stream.track.enabled, false);

  // A hidden tab routes through the same release path.
  documentStub.dispatchDocument('keydown', spaceEvent());
  assert.equal(controller.pushToTalkKeyHeld, true);
  documentStub.visibilityState = 'hidden';
  documentStub.dispatchDocument('visibilitychange', {});
  assert.equal(controller.pushToTalkKeyHeld, false);
  documentStub.visibilityState = 'visible';
  controller.stop({ removeUi: true });
});

test('setMicrophoneEnabled flips only the outbound audio tracks', () => {
  const controller = makeController();
  controller.ui.root.dataset.microphone = 'active';
  const stream = makeMediaStream();
  controller.stream = stream;
  controller.setMicrophoneEnabled(false);
  assert.equal(stream.track.enabled, false);
  assert.equal(controller.ui.root.dataset.microphone, 'muted');
  controller.setMicrophoneEnabled(true);
  assert.equal(stream.track.enabled, true);
  assert.equal(controller.ui.root.dataset.microphone, 'active');

  controller.stream = null; // no live stream: UI state still updates
  controller.setMicrophoneEnabled(false);
  assert.equal(controller.ui.root.dataset.microphone, 'muted');
});

// ---------------------------------------------------------------------------
// Errors, diagnostics, cost controls
// ---------------------------------------------------------------------------

test('reportError stores a capped, persisted, formatted record', () => {
  localStorageMap.clear();
  const controller = makeController();
  for (let index = 0; index < 35; index++) {
    controller.reportError(`source-${index}`, new Error(`boom-${index}`), {
      connectionState: index === 0 ? 'failed' : null,
      empty: '',
      dropped: null,
      kept: index,
    });
  }
  assert.equal(controller.errors.length, 30, 'ERROR_LOG_LIMIT caps the in-memory log');
  assert.equal(controller.errors[0].message, 'boom-34');
  assert.equal(controller.errors[0].kept, 34, 'non-empty extras survive');
  assert.equal('empty' in controller.errors[0], false, 'empty extras are dropped');
  assert.equal('dropped' in controller.errors[0], false, 'null extras are dropped');
  assert.equal(controller.status, 'error');
  const persisted = JSON.parse(localStorageMap.get('gev-realtime-errors'));
  assert.equal(persisted.length, 30);
});

test('fatalError tears the session down before reporting (never an ERROR + hot mic)', () => {
  const order = [];
  const controller = makeController();
  const dc = new FakeDataChannel();
  dc.close = () => { order.push('dc-close'); dc.readyState = 'closed'; };
  const stream = makeMediaStream();
  stream.track.stop = () => { order.push('track-stop'); stream.track.stopped = true; };
  controller.dc = dc;
  controller.pc = new FakeRTCPeerConnection();
  controller.stream = stream;
  controller.status = 'listening';

  controller.fatalError('Realtime data channel', new Error('sctp died'), { dataChannelState: 'closed' });

  assert.deepEqual(order, ['dc-close', 'track-stop'], 'teardown happens before the report');
  assert.equal(controller.dc, null);
  assert.equal(controller.stream, null);
  assert.equal(controller.status, 'error');
  assert.equal(controller.errors[0].source, 'Realtime data channel');
  assert.equal(controller.errors[0].message, 'sctp died');
  assert.equal(controller.errors[0].dataChannelState, 'closed');
});

test('error formatting keeps the browser detail line for SCTP alerts', () => {
  const controller = makeController();
  const rtcError = Object.assign(new Error('transport closed'), {
    errorDetail: 'TLS handshake failed',
    sctpCauseCode: 12,
  });
  controller.reportError('Realtime data channel', rtcError);
  assert.equal(controller.errors[0].errorDetail, 'TLS handshake failed');
  assert.equal(controller.errors[0].sctpCauseCode, 12);
  assert.match(
    controller.ui.errorDetail.textContent,
    /Realtime data channel: transport closed\n.*sctp=12/,
  );
});

test('getDiagnostics exposes status, connection, errors, debug sink and cost', async () => {
  resetFetch();
  const controller = makeController();
  await controller.start();
  const diagnostics = controller.getDiagnostics();
  assert.equal(diagnostics.status, 'connecting');
  assert.equal(diagnostics.connection.connectionState, 'connected');
  assert.ok(Array.isArray(diagnostics.recentErrors));
  assert.ok(diagnostics.debugLog.endpoint.endsWith('/api/realtime/debug-log'));
  assert.ok(diagnostics.debugLog.sessionId.startsWith('gev-'), diagnostics.debugLog.sessionId);
  assert.equal(diagnostics.debugLog.file, '.gev-logs/realtime-conversations.jsonl');
  assert.equal(diagnostics.cost.modelId, 'gpt-realtime-2');
  controller.stop();
});

test('tier and limit changes persist now but only rebuild a SETTLED tracker', () => {
  localStorageMap.clear();
  const controller = makeController();

  assert.equal(controller.setVoiceTier('mini'), 'mini');
  assert.equal(controller.ui.tierButton.textContent, 'MINI');
  assert.equal(localStorageMap.get('godsEyeView.voiceCost.tier'), 'mini');

  // A live (unsettled) session keeps its meter: preference only.
  controller.dc = new FakeDataChannel();
  const liveTracker = controller.costTracker;
  controller.setVoiceTier('standard');
  assert.equal(controller.costTracker, liveTracker, 'live meter is immutable');
  assert.equal(localStorageMap.get('godsEyeView.voiceCost.tier'), 'standard');

  // Settled again (no dc, no pc): the preview tracker refreshes to the new tier.
  controller.dc = null;
  controller.setVoiceTier('mini');
  assert.notEqual(controller.costTracker, liveTracker);
  assert.equal(controller.ui.tierButton.textContent, 'MINI');

  const limits = controller.setVoiceCostLimits({ warnUsd: 0.5, capUsd: 1.25 });
  assert.equal(limits.warnUsd, 0.5);
  assert.equal(limits.capUsd, 1.25);
  const persisted = JSON.parse(localStorageMap.get('godsEyeView.voiceCost.limits'));
  assert.equal(persisted.capUsd, 1.25);
});

// ---------------------------------------------------------------------------
// Viewport screenshot context (sendVisualContextIfUseful → captureViewportImage)
// ---------------------------------------------------------------------------

function makeViewportController() {
  const controller = makeController();
  controller.dc = new FakeDataChannel();
  return controller;
}

test('a local-scale entity query with no structured identity sends the screenshot', async () => {
  resetFetch();
  documentStub.hidden = false;
  canvasPixels = lightGrayFrame();
  globalThis.window.__godsEyeView = { viewer: makeCaptureViewer() };
  const controller = makeViewportController();

  assert.equal(await controller.sendVisualContextIfUseful(localContextResult()), true);
  assert.equal(controller.dc.sent.length, 1);
  const event = controller.dc.sent[0];
  assert.equal(event.type, 'conversation.item.create');
  assert.match(event.item.id, /^msg_/);
  assert.equal(event.item.role, 'user');
  const image = event.item.content.find((part) => part.type === 'input_image');
  assert.equal(image.image_url, viewportDataUrl);
  assert.equal(image.detail, 'high');
  assert.ok(event.item.content.some((part) => part.type === 'input_text'));
  assert.equal(controller.lastViewportItemId, event.item.id);

  // A second capture replaces the previous image: delete old, then add new.
  assert.equal(await controller.sendVisualContextIfUseful(localContextResult()), true);
  assert.equal(controller.dc.sent.length, 3);
  const deletion = controller.dc.sent[1];
  assert.equal(deletion.type, 'conversation.item.delete');
  assert.equal(deletion.item_id, event.item.id);
  assert.ok(controller.pendingViewportDeletes.has(deletion.event_id), 'the delete id is tracked for benign races');
  assert.notEqual(controller.lastViewportItemId, event.item.id);

  globalThis.window.__godsEyeView = null;
});

test('viewport context is skipped for non-local scales, structured results, and closed channels', async () => {
  const controller = makeViewportController();
  assert.equal(await controller.sendVisualContextIfUseful({ action: 'zoom_to_globe' }), false);
  assert.equal(await controller.sendVisualContextIfUseful(localContextResult('global')), false);
  assert.equal(
    await controller.sendVisualContextIfUseful({
      ...localContextResult(),
      selected: { layerId: 'flights' },
    }),
    false,
    'named entities already identify the view; no image needed',
  );
  assert.equal(
    await controller.sendVisualContextIfUseful({
      ...localContextResult(),
      scene: { basemap: { viewScale: 'local', nearbyPlaces: [{ name: 'Capitol' }] } },
    }),
    false,
  );
  controller.dc.readyState = 'closed';
  assert.equal(await controller.sendVisualContextIfUseful(localContextResult()), false);
});

test('a hidden document yields no fresh frame, so no image is claimed current', async () => {
  resetFetch();
  documentStub.hidden = true;
  globalThis.window.__godsEyeView = { viewer: makeCaptureViewer() };
  const controller = makeViewportController();
  assert.equal(await controller.sendVisualContextIfUseful(localContextResult()), false);
  assert.equal(controller.dc.sent.length, 0);
  assert.equal(controller.lastViewportItemId, undefined);
  documentStub.hidden = false;
  globalThis.window.__godsEyeView = null;
});

test('a black or oversized capture is dropped instead of fed to the model', async () => {
  resetFetch();
  documentStub.hidden = false;
  const viewer = makeCaptureViewer();
  globalThis.window.__godsEyeView = { viewer };
  const controller = makeViewportController();

  // Nearly-black frame: every sampled pixel transparent/black.
  canvasPixels = new Uint8ClampedArray(48 * 32 * 4);
  assert.equal(await controller.sendVisualContextIfUseful(localContextResult()), false);
  assert.ok(warnLog.some((args) => String(args[0]).includes('black Cesium viewport')));

  // Encoded payload over the 200KB data-channel ceiling.
  canvasPixels = lightGrayFrame();
  viewportDataUrl = `data:image/jpeg;base64,${'A'.repeat(300000)}`;
  assert.equal(await controller.sendVisualContextIfUseful(localContextResult()), false);
  assert.ok(warnLog.some((args) => String(args[0]).includes('oversized viewport capture')));
  assert.equal(controller.lastViewportItemId, undefined);

  viewportDataUrl = 'data:image/jpeg;base64,QUJDREVG';
  globalThis.window.__godsEyeView = null;
});

test('a data-channel send failure leaves the turn un-stranded and the id unclaimed', async () => {
  resetFetch();
  documentStub.hidden = false;
  globalThis.window.__godsEyeView = { viewer: makeCaptureViewer() };
  const controller = makeViewportController();
  controller.dc.send = () => { throw new Error('SCTP overflow'); };

  assert.equal(await controller.sendVisualContextIfUseful(localContextResult()), false);
  assert.equal(controller.lastViewportItemId, null, 'an unsent image must not be deleted later');
  globalThis.window.__godsEyeView = null;
});

// ---------------------------------------------------------------------------
// initGevVoiceCommands: the DOM control + wiring + full teardown
// ---------------------------------------------------------------------------

test('initGevVoiceCommands builds the dock control, wires it, and removes it on teardown', async () => {
  resetFetch();
  localStorageMap.clear();
  const radioLayer = makeRadioLayer();
  const dataManager = {
    isEnabled: () => true,
    getAll: () => [],
    layers: new Map([['radio', { module: radioLayer }]]),
    subscribeVisibilityRequests: () => () => {},
  };
  let outlineListener = null;
  const annotations = {
    onOutlineEvent: (fn) => {
      outlineListener = fn;
      return () => { outlineListener = null; };
    },
  };
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600, addEventListener() {}, removeEventListener() {} },
      requestRender() {},
      postRender: { addEventListener: () => () => {} },
    },
    camera: { moveEnd: { addEventListener: () => () => {} } },
  };

  const keydownBaseline = documentStub.documentListenerCount('keydown');
  const controller = initGevVoiceCommands({ viewer, styleManager: {}, dataManager, annotations });
  assert.equal(globalThis.window.__gevVoiceCommands, controller);
  assert.ok(controller.ui.root, 'the control DOM was created');
  assert.ok(documentStub.body.children.includes(controller.ui.root));
  assert.equal(controller.ui.root.id, 'gev-voice-control');
  assert.ok(typeof outlineListener === 'function', 'annotation outlines are subscribed');

  // Mic button toggles a session on.
  controller.ui.button.dispatch('click');
  await waitFor(() => controller.dc, { what: 'click-started data channel' });
  controller.dc.emit('open');
  await waitFor(() => controller.status === 'listening', { what: 'click-started session listening' });
  assert.equal(controller.status, 'listening');
  assert.equal(controller.ui.button.getAttribute('aria-pressed'), 'true');

  // A second click stops it.
  controller.ui.button.dispatch('click');
  assert.equal(controller.status, 'idle');
  assert.equal(controller.ui.button.getAttribute('aria-pressed'), 'false');

  // Tier button flips the persisted preference.
  controller.ui.tierButton.dispatch('click');
  assert.equal(controller.voiceTier, 'mini');

  // Deferred annotation outlines reach the conversation as map events.
  controller.dc = new FakeDataChannel();
  outlineListener({ status: 'resolved', label: 'Austin' });
  assert.equal(controller.dc.sent.length, 1);
  assert.equal(controller.dc.sent[0].item.content[0].type, 'input_text');
  assert.ok(controller.dc.sent[0].item.content[0].text.includes('map_annotation_outline'));

  // The dismiss button hides the error tray without touching the session.
  controller.ui.root._q['.gev-voice-error-dismiss'].dispatch('click');
  assert.ok(controller.ui.root.classList.contains('error-dismissed'));

  controller.stop({ removeUi: true });
  assert.equal(controller.ui.root.removed, true);
  assert.equal(outlineListener, null, 'the annotation subscription is released');
  assert.equal(documentStub.documentListenerCount('keydown'), keydownBaseline, 'the shortcut listener is released');

  // Re-init after teardown must not throw (the stale-root reset path).
  const second = initGevVoiceCommands({ viewer, styleManager: {}, dataManager, annotations: null });
  assert.notEqual(second, controller);
  second.stop({ removeUi: true });
});
