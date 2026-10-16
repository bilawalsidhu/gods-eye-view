import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiSessionController, geminiSocketUrl } from './geminiSession.js';
import { createNarrationScheduler } from './narration.js';
import { createVoiceSession } from './session.js';
import { createPointerTracker } from './pointerContext.js';
import { readVoiceUserTurnText } from './userTurnIntent.js';
import { withToolCatalog } from './gevRealtime.js';
import { createGevActionRunner } from './gevActions.js';
import { VOICE_TOOL_FAILURE_TEXT_LIMIT } from './toolExecutionPolicy.js';
import { DataLayerManager } from '../data/manager.js';

const endpoint =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
const credential = {
  token: 'auth_tokens/test',
  model: 'gemini-3.8-live',
  websocketUrl: endpoint,
  config: { generationConfig: { responseModalities: ['AUDIO'] } },
};
const manualCredential = {
  ...credential,
  config: {
    ...credential.config,
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
  },
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(overrides = {}) {
  const { autoSetup = true, ...controllerOverrides } = overrides;
  const events = [];
  const sockets = [];
  const media = [];
  const tracks = [];
  const captures = [];
  const calls = [];
  const requests = [];
  const state = { playing: 0, ducked: false, stopped: 0 };
  let clock = 0;
  let nextTimer = 0;
  const timers = new Map();
  const earcon = { playing: false, starts: 0, disposals: 0 };
  const advance = (ms) => {
    const target = clock + ms;
    for (;;) {
      const due = [...timers]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
    }
    clock = target;
  };
  let radioControl;
  const radio = {
    setVoiceDucked(value) {
      state.ducked = value;
    },
    pause() {},
    subscribePlaybackControls(callback) {
      radioControl = callback;
      return () => {
        radioControl = null;
      };
    },
    async playForVoice() {
      state.playing++;
      return true;
    },
    stopPlayback() {
      state.stopped++;
    },
  };
  class Socket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(raw) {
      const value = JSON.parse(raw);
      this.sent.push(value);
      if (value.setup && autoSetup)
        queueMicrotask(() => this.message({ setupComplete: {} }));
    }
    message(value) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
    error() {
      this.onerror?.();
    }
    remoteClose() {
      this.readyState = 3;
      this.onclose?.();
    }
    close() {
      this.readyState = 3;
      this.closed = true;
    }
  }
  const makeStream = () => {
    const track = {
      enabled: true,
      readyState: 'live',
      stop() {
        this.readyState = 'ended';
      },
    };
    tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  const c = new GeminiSessionController({
    emit: (event) => events.push(event),
    runAction: async (name, args, options) => {
      calls.push({ name, args, options });
      return { ok: true, action: name };
    },
    ui: { root: { remove() {} } },
    radioLayer: radio,
    now: () => clock,
    prefixNow: () => clock,
    setTimer: (fn, ms) => {
      const id = ++nextTimer;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    WebSocketClass: Socket,
    fetchImpl: async (_url, init) => {
      requests.push(init);
      return {
        ok: true,
        json: async () =>
          JSON.parse(init.body).inputMode === 'push-to-talk'
            ? manualCredential
            : credential,
      };
    },
    getUserMedia: async () => makeStream(),
    createInput: ({ readStream, operations }) => ({
      ...operations,
      setMicrophoneEnabled(enabled) {
        for (const track of readStream()?.getAudioTracks() || [])
          track.enabled = enabled;
      },
      updateVoiceButtonLabel() {},
      setVoiceSpeaker() {},
      startVoiceVisualizer() {},
      startAssistantVoiceVisualizer() {},
      cancelPushToTalkHold() {},
      stopVoiceVisualizer() {},
      detachBindings() {},
      bindPushToTalkShortcut() {},
      resetSession() {
        this.pushToTalkMode = false;
        this.pushToTalkKeyHeld = false;
        this.spaceKeyHeld = false;
      },
    }),
    createNarration: (options) =>
      createNarrationScheduler({
        ...options,
        now: () => clock,
        setTimer: (fn, ms) => {
          const id = ++nextTimer;
          timers.set(id, { fn, at: clock + ms });
          return id;
        },
        clearTimer: (id) => timers.delete(id),
      }),
    createProgressEarcon: ({ isMicrophoneMuted }) => ({
      available: isMicrophoneMuted,
      start() {
        earcon.playing = true;
        earcon.starts++;
      },
      stop() {
        earcon.playing = false;
      },
      dispose() {
        this.stop();
        earcon.disposals++;
      },
    }),
    createAudio: (callbacks) => {
      const audio = {
        callbacks,
        pending: false,
        closed: false,
        played: [],
        async initialize() {},
        connectMicrophone(stream, enabled, metadata) {
          media.push({ stream, enabled });
          this.connected = true;
          this.setMicrophoneEnabled(enabled, metadata);
        },
        setMicrophoneEnabled(value, metadata) {
          if (!this.connected) return;
          if (value && !this.enabled) {
            this.metadata = metadata;
            callbacks.onAudioStart(metadata);
          }
          if (!value && this.enabled) callbacks.onAudioEnd(this.metadata);
          this.enabled = value;
        },
        play(data, mime) {
          this.pending = true;
          this.played.push({ data, mime });
        },
        drain() {
          this.pending = false;
          callbacks.onDrain();
        },
        clearPlayback() {
          this.pending = false;
          this.cleared = true;
        },
        diagnostics() {
          return { outputChunks: this.played.length };
        },
        close() {
          this.closed = true;
        },
      };
      captures.push(audio);
      return audio;
    },
    ...controllerOverrides,
  });
  return {
    c,
    sockets,
    tracks,
    makeStream,
    events,
    media,
    captures,
    calls,
    requests,
    state,
    advance,
    timers,
    earcon,
    radioControl: (value) => radioControl?.(value),
  };
}

test('ephemeral credentials are sent only to the fixed constrained Google endpoint', () => {
  const url = new URL(geminiSocketUrl(credential));
  assert.equal(url.searchParams.get('access_token'), credential.token);
  for (const websocketUrl of [
    endpoint + '?key=foo',
    endpoint.replace('googleapis.com', 'example.com'),
    endpoint.replace('wss:', 'ws:'),
    endpoint.replace('Constrained', ''),
    endpoint.replace('wss://', 'wss://user@'),
  ])
    assert.throws(
      () => geminiSocketUrl({ ...credential, websocketUrl }),
      /endpoint/,
    );
  assert.throws(
    () =>
      geminiSocketUrl({ ...credential, token: 'AIza-not-an-ephemeral-token' }),
    /ephemeral/,
  );
});

test('PTT locks manual activity and serializes cold and repeated held turns', async () => {
  const h = harness();
  h.c.input.pushToTalkKeyHeld = true;
  h.c.input.spaceKeyHeld = true;
  await h.c.start({ pushToTalk: true });
  assert.equal(h.requests[0].body, '{"inputMode":"push-to-talk"}');
  const ws = h.sockets[0];
  assert.deepEqual(ws.sent[0].setup.realtimeInputConfig, {
    automaticActivityDetection: { disabled: true },
  });
  const audio = h.captures[0];
  const pcm = { data: 'AAABAA==', mimeType: 'audio/pcm;rate=16000' };
  audio.callbacks.onAudioStart(audio.metadata); // A duplicate notification cannot reopen.
  audio.callbacks.onAudio(pcm, audio.metadata);
  h.c.input.setMicrophoneEnabled(false);
  audio.callbacks.onAudioEnd(audio.metadata);
  audio.callbacks.onAudio(pcm, audio.metadata); // Unbracketed/stale PCM is not forwarded.
  assert.equal(h.tracks[0].enabled, false);
  h.c.input.setMicrophoneEnabled(true);
  audio.callbacks.onAudio(pcm, audio.metadata);
  h.c.input.setMicrophoneEnabled(false);
  assert.deepEqual(ws.sent.slice(1), [
    { realtimeInput: { activityStart: {} } },
    { realtimeInput: { audio: pcm } },
    { realtimeInput: { activityEnd: {} } },
    { realtimeInput: { activityStart: {} } },
    { realtimeInput: { audio: pcm } },
    { realtimeInput: { activityEnd: {} } },
  ]);
  assert.equal(h.c.status, 'listening');
  assert.equal(h.c.input.pushToTalkMode, true);
  assert.equal(h.tracks[0].enabled, false);
  h.c.stop();
});

test('ordinary microphone keeps its default setup and automatic stream-end message', async () => {
  const h = harness();
  await h.c.start();
  assert.equal(h.requests[0].body, '{}');
  assert.deepEqual(h.sockets[0].sent, [
    { setup: { ...credential.config, model: 'models/gemini-3.8-live' } },
  ]);
  h.c.input.setMicrophoneEnabled(false);
  assert.deepEqual(h.sockets[0].sent.at(-1), {
    realtimeInput: { audioStreamEnd: true },
  });
  h.c.stop();
});

for (const phase of ['token', 'setup', 'microphone']) {
  test(`PTT release during ${phase} startup stays muted until a later hold`, async () => {
    const pending = deferred();
    const h = harness({
      ...(phase === 'token' ? { fetchImpl: () => pending.promise } : {}),
      ...(phase === 'setup' ? { autoSetup: false } : {}),
      ...(phase === 'microphone'
        ? { getUserMedia: () => pending.promise }
        : {}),
    });
    h.c.input.pushToTalkKeyHeld = true;
    h.c.input.spaceKeyHeld = true;
    const start = h.c.start({ pushToTalk: true });
    await tick();
    assert.equal(h.media.length, 0);
    assert.equal(
      h.sockets[0]?.sent.filter((value) => value.realtimeInput).length || 0,
      0,
    );
    h.c.input.pushToTalkKeyHeld = false;
    h.c.input.spaceKeyHeld = false;
    h.c.input.setMicrophoneEnabled(false);
    if (phase === 'token')
      pending.resolve({ ok: true, json: async () => manualCredential });
    else if (phase === 'setup') h.sockets[0].message({ setupComplete: {} });
    else pending.resolve(h.makeStream());
    await start;
    assert.equal(h.c.status, 'listening');
    assert.equal(h.tracks[0].enabled, false);
    assert.equal(h.media[0].enabled, false);
    assert.equal(
      h.sockets[0].sent.length,
      1,
      'no phantom activity for a released gesture',
    );
    h.c.input.pushToTalkKeyHeld = true;
    h.c.input.setMicrophoneEnabled(true);
    assert.deepEqual(h.sockets[0].sent.at(-1), {
      realtimeInput: { activityStart: {} },
    });
    h.c.input.setMicrophoneEnabled(false);
    assert.deepEqual(h.sockets[0].sent.at(-1), {
      realtimeInput: { activityEnd: {} },
    });
    h.c.stop();
  });
}

test('a token config that disagrees with the gesture fails before socket creation and releases consented microphone', async () => {
  for (const [pushToTalk, supplied] of [
    [true, credential],
    [false, manualCredential],
  ]) {
    const h = harness({
      fetchImpl: async () => ({ ok: true, json: async () => supplied }),
    });
    await h.c.start({ pushToTalk });
    assert.equal(h.c.status, 'error');
    assert.match(h.c.lastError, /input mode/);
    assert.equal(h.sockets.length, 0);
    assert.equal(h.tracks[0].readyState, 'ended');
    assert.equal(h.captures[0].closed, true);
  }
});

test('old PTT callbacks cannot send to a stopped or replacement session', async () => {
  const h = harness();
  h.c.input.pushToTalkKeyHeld = true;
  await h.c.start({ pushToTalk: true });
  const old = h.captures[0].callbacks;
  const socket = h.sockets[0];
  h.c.stop();
  const oldCount = socket.sent.length;
  await h.c.start();
  const replacementCount = h.sockets[1].sent.length;
  old.onAudioStart(h.captures[0].metadata);
  old.onAudio(
    { data: 'AAAA', mimeType: 'audio/pcm;rate=16000' },
    h.captures[0].metadata,
  );
  old.onAudioEnd(h.captures[0].metadata);
  assert.equal(socket.sent.length, oldCount);
  assert.equal(h.sockets[1].sent.length, replacementCount);
  assert.equal(h.c.status, 'listening');
  assert.equal(h.tracks[0].readyState, 'ended');
  assert.equal(h.tracks[1].enabled, true);
  h.c.stop({ removeUi: true });
  const latest = h.captures[1].callbacks;
  latest.onAudioStart(h.captures[1].metadata);
  latest.onAudioEnd(h.captures[1].metadata);
  assert.equal(h.sockets[1].sent.length, replacementCount);
});

test('session waits for setup, captures PCM, plays all parts, emits transcripts and releases every resource', async () => {
  const h = harness();
  await h.c.start();
  assert.equal(h.c.status, 'listening');
  assert.equal(h.media.length, 1);
  const ws = h.sockets[0];
  assert.equal(ws.sent[0].setup.model, 'models/gemini-3.8-live');
  h.captures[0].callbacks.onAudio(
    {
      data: 'AAAA',
      mimeType: 'audio/pcm;rate=16000',
    },
    h.captures[0].metadata,
  );
  assert.equal(ws.sent.at(-1).realtimeInput.audio.data, 'AAAA');
  ws.message({
    serverContent: {
      inputTranscription: { text: 'Hello' },
      outputTranscription: { text: 'Hi' },
      modelTurn: {
        parts: [
          { inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } },
          { inlineData: { data: 'AQAB', mimeType: 'audio/pcm;rate=24000' } },
        ],
      },
      turnComplete: true,
    },
  });
  assert.equal(h.captures[0].played.length, 2);
  assert.equal(
    h.events.some((event) => event.type === 'completion'),
    false,
    'server turn completion waits for queued audio to drain',
  );
  assert.ok(
    h.events.some(
      (event) =>
        event.type === 'transcript' &&
        event.role === 'assistant' &&
        event.final &&
        event.text === 'Hi',
    ),
  );
  assert.equal(h.c.getDiagnostics().completedTurns, 1);
  h.captures[0].drain();
  assert.equal(
    h.events.some(
      (event) => event.type === 'completion' && event.status === 'completed',
    ),
    true,
  );
  h.c.stop();
  assert.equal(h.tracks[0].readyState, 'ended');
  assert.equal(ws.closed, true);
  assert.equal(h.captures[0].closed, true);
  assert.equal(h.state.ducked, false);
  assert.equal(h.c.status, 'idle');
});

test('goAway deadline tears down pending work and an explicit restart creates a fresh conversation', async () => {
  const pending = deferred();
  let issued = 0;
  let pendingOptions;
  const h = harness({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        ...credential,
        token: `auth_tokens/session-${++issued}`,
      }),
    }),
    runAction: async (name, _args, options) => {
      if (name === 'control_radio')
        return {
          ok: true,
          action: 'control_radio',
          radioAction: 'play',
          radioPlaybackRequested: true,
        };
      pendingOptions = options;
      return pending.promise;
    },
  });
  await h.c.start();
  establishToolInput(h);
  const oldSocket = h.sockets[0];
  const oldAudio = h.captures[0];
  const oldCallbacks = oldAudio.callbacks;
  oldSocket.message({
    toolCall: {
      functionCalls: [
        { id: 'radio', name: 'control_radio', args: { action: 'play' } },
        { id: 'pending', name: 'get_current_view_state', args: {} },
      ],
    },
  });
  await tick();
  await tick();
  assert.ok(h.c.radio.pendingRadioPlaybackResult);
  assert.equal(h.c.pendingTools, 1);
  oldSocket.message({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] },
    },
  });
  assert.equal(oldAudio.played.length, 1);
  let sentBeforeExpiry = oldSocket.sent.length;

  oldSocket.message({ goAway: { timeLeft: '5s' } });
  sentBeforeExpiry = oldSocket.sent.length; // Microphone stream-end is a reliable lifecycle marker.
  assert.equal(h.c.status, 'executing');
  assert.equal(pendingOptions.signal.aborted, false);
  assert.equal(h.c.sendTextCommand('Do not admit a new turn'), false);
  h.advance(5000);
  assert.equal(h.c.status, 'error');
  assert.equal(
    h.c.lastError,
    'Gemini Live connection is expiring. Start voice again for a new conversation.',
  );
  assert.equal(
    h.events.at(-1).recovery,
    'Start voice again for a fresh token and a new conversation.',
  );
  assert.equal(oldSocket.closed, true);
  assert.equal(oldAudio.closed, true);
  assert.equal(h.tracks[0].readyState, 'ended');
  assert.equal(h.c.pendingTools, 0);
  assert.equal(h.c.radio.pendingRadioPlaybackResult, null);
  assert.equal(pendingOptions.signal.aborted, true);

  oldCallbacks.onAudioStart(h.captures[0].metadata);
  oldCallbacks.onAudio(
    { data: 'AQAB', mimeType: 'audio/pcm;rate=16000' },
    h.captures[0].metadata,
  );
  oldCallbacks.onAudioEnd(h.captures[0].metadata);
  oldCallbacks.onDrain();
  oldCallbacks.onError(new Error('late retired audio'));
  oldSocket.message({ serverContent: { turnComplete: true } });
  oldSocket.error();
  oldSocket.remoteClose();
  pending.resolve({ ok: true });
  await tick();
  await tick();
  assert.equal(oldSocket.sent.length, sentBeforeExpiry);
  assert.equal(oldAudio.played.length, 1);
  assert.equal(
    oldSocket.sent.filter((entry) => entry.toolResponse).length,
    1,
    'only the completed Radio result was sent before expiry',
  );
  assert.equal(h.state.playing, 0);

  await h.c.start();
  assert.equal(issued, 2);
  assert.equal(h.sockets.length, 2);
  assert.equal(
    new URL(h.sockets[1].url).searchParams.get('access_token'),
    'auth_tokens/session-2',
  );
  assert.equal(h.c.status, 'listening');
  assert.equal(h.c.completedTurns, 0);
  assert.equal(h.captures[1].played.length, 0);
  assert.equal(h.tracks[1].readyState, 'live');
  h.c.stop();
});

test('pre-setup rejection or close releases startup and asks for a fresh session', async () => {
  for (const terminal of ['rejected', 'closed']) {
    const h = harness({ autoSetup: false });
    const start = h.c.start();
    await tick();
    if (terminal === 'rejected')
      h.sockets[0].message({ error: { message: 'credential rejected' } });
    else h.sockets[0].remoteClose();
    await start;
    assert.equal(h.c.status, 'error', terminal);
    assert.equal(h.tracks[0].readyState, 'ended', terminal);
    assert.equal(h.captures[0].closed, true, terminal);
    assert.equal(h.sockets[0].closed, true, terminal);
    assert.match(h.c.lastError, /Start voice again/, terminal);
    assert.match(h.events.at(-1).recovery, /fresh session/, terminal);
    assert.equal(h.sockets.length, 1, 'no automatic retry');
  }
});

test('network close after setup releases media and starts no replacement', async () => {
  const h = harness();
  await h.c.start();
  h.sockets[0].remoteClose();
  assert.equal(h.c.status, 'error');
  assert.equal(
    h.c.lastError,
    'Gemini Live connection ended. Start voice again for a new conversation.',
  );
  assert.equal(h.tracks[0].readyState, 'ended');
  assert.equal(h.captures[0].closed, true);
  assert.equal(h.sockets.length, 1);
  assert.doesNotMatch(h.events.at(-1).recovery, /microphone|API key/i);
});

test('OFF during unresolved setup blocks late setup, error and close callbacks', async () => {
  const h = harness({ autoSetup: false });
  const start = h.c.start();
  await tick();
  const socket = h.sockets[0];
  h.c.stop();
  const eventCount = h.events.length;
  socket.message({ setupComplete: {} });
  socket.message({ error: { message: 'late rejection' } });
  socket.error();
  socket.remoteClose();
  await start;
  assert.equal(h.c.status, 'idle');
  assert.equal(h.tracks[0].readyState, 'ended');
  assert.equal(h.captures[0].closed, true);
  assert.equal(h.events.length, eventCount);
});

test('a disposed pending microphone is stopped and cannot update the replacement UI', async () => {
  const microphone = deferred();
  const h = harness({ getUserMedia: () => microphone.promise });
  const start = h.c.start();
  await tick();
  h.c.stop({ removeUi: true });
  const eventCount = h.events.length;
  microphone.resolve(h.makeStream());
  await start;
  assert.equal(h.tracks[0].readyState, 'ended');
  assert.equal(h.events.length, eventCount);
  assert.equal(h.media.length, 0);
});

test('late token rejection after stop cannot replace a successor state', async () => {
  const response = deferred();
  const h = harness({ fetchImpl: () => response.promise });
  const start = h.c.start();
  h.c.stop({ removeUi: true });
  const count = h.events.length;
  response.resolve({
    ok: false,
    status: 503,
    json: async () => ({ error: 'late rejection' }),
  });
  await start;
  assert.equal(h.events.length, count);
  assert.equal(h.sockets.length, 0);
});

test('tool cancellation covers queued calls and interrupted results never return to the socket', async () => {
  const first = deferred();
  const names = [];
  const h = harness({
    runAction: async (name) => {
      names.push(name);
      return first.promise;
    },
  });
  await h.c.start();
  establishToolInput(h);
  const ws = h.sockets[0];
  ws.message({
    toolCall: {
      functionCalls: [
        { id: 'a', name: 'one', args: {} },
        { id: 'b', name: 'two', args: {} },
      ],
    },
  });
  await tick();
  ws.message({ toolCallCancellation: { ids: ['b'] } });
  first.resolve({ ok: true });
  await h.c.toolQueue;
  assert.deepEqual(names, ['one']);
  assert.equal(h.c.pendingTools, 0);
  assert.equal(ws.sent.filter((entry) => entry.toolResponse).length, 1);
  const second = deferred();
  h.c.runAction = () => second.promise;
  ws.message({
    toolCall: { functionCalls: [{ id: 'c', name: 'three', args: {} }] },
  });
  await tick();
  ws.message({ serverContent: { interrupted: true } });
  second.resolve({ ok: true });
  await tick();
  assert.equal(ws.sent.filter((entry) => entry.toolResponse).length, 1);
  assert.equal(h.captures[0].cleared, true);
  h.c.stop();
});

test('wire voiceActivity.type start aborts pending work and discards old playback', async () => {
  const pending = deferred();
  let signal;
  const h = harness({
    runAction: (_name, _args, options) => {
      signal = options.signal;
      return pending.promise;
    },
  });
  await h.c.start();
  establishToolInput(h);
  const ws = h.sockets[0];
  ws.message({
    serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } },
  });
  ws.message({
    toolCall: {
      functionCalls: [
        { id: 'old', name: 'fly_to_location', args: { query: 'Austin' } },
      ],
    },
  });
  await tick();
  const turn = h.c.turn;
  assert.equal(signal.aborted, false);
  assert.equal(h.captures[0].pending, true);
  ws.message({
    voiceActivity: { type: 'ACTIVITY_START', audioOffset: '5.240s' },
  });
  assert.equal(signal.aborted, true);
  assert.ok(h.c.turn > turn);
  assert.equal(h.c.pendingTools, 0);
  assert.equal(h.captures[0].cleared, true);
  assert.equal(h.c.status, 'listening');
  pending.resolve({ ok: true });
  await tick();
  assert.equal(
    ws.sent.some((entry) => entry.toolResponse),
    false,
  );
  h.c.stop();
});

test('unknown or malformed voice activity cannot revoke the current turn', async () => {
  const h = harness();
  await h.c.start();
  const turn = h.c.turn;
  for (const voiceActivity of [
    null,
    {},
    { type: 'TYPE_UNSPECIFIED' },
    { type: 'unknown' },
    { type: 1 },
  ]) {
    h.sockets[0].message({ voiceActivity });
    assert.equal(h.c.turn, turn);
    assert.equal(h.c.status, 'listening');
    assert.equal(h.c.narration.state().pendingTimers, 0);
  }
  h.c.stop();
});

for (const pushToTalk of [false, true]) {
  test(`wire voiceActivity.type end respects ${pushToTalk ? 'manual' : 'automatic'} turn ownership`, async () => {
    const h = harness();
    await h.c.start({ pushToTalk });
    if (!pushToTalk)
      h.sockets[0].message({ voiceActivity: { type: 'ACTIVITY_START' } });
    h.c.narration.cancel();
    h.sockets[0].message({
      voiceActivity: { type: 'ACTIVITY_END', audioOffset: '9.080s' },
    });
    assert.equal(h.c.narration.state().pendingTimers, pushToTalk ? 0 : 1);
    assert.equal(h.c.status, 'listening');
    h.c.stop();
    assert.equal(h.timers.size, 0);
  });
}

test('radio handoff waits for a post-tool reply and actual playback drain', async () => {
  const h = harness({
    runAction: async () => ({
      ok: true,
      action: 'control_radio',
      radioAction: 'play',
      radioPlaybackRequested: true,
    }),
  });
  await h.c.start();
  establishToolInput(h);
  const ws = h.sockets[0];
  ws.message({
    toolCall: {
      functionCalls: [
        { id: 'radio', name: 'control_radio', args: { action: 'play' } },
      ],
    },
  });
  await h.c.toolQueue;
  ws.message({ serverContent: { turnComplete: true } });
  assert.equal(
    h.state.playing,
    0,
    'the tool turn alone must not release Radio',
  );
  ws.message({
    serverContent: {
      modelTurn: {
        parts: [
          { inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } },
        ],
      },
      turnComplete: true,
    },
  });
  assert.equal(
    h.state.playing,
    0,
    'queued assistant audio still owns the speaker',
  );
  h.captures[0].drain();
  await tick();
  assert.equal(h.state.playing, 1);
  assert.equal(h.state.ducked, false);
  assert.equal(h.c.status, 'idle');
});

test('explicit Radio stop cancels a handoff while confirmation is playing', async () => {
  const h = harness({
    runAction: async () => ({
      ok: true,
      action: 'control_radio',
      radioPlaybackRequested: true,
    }),
  });
  await h.c.start();
  establishToolInput(h);
  const ws = h.sockets[0];
  ws.message({
    toolCall: {
      functionCalls: [
        { id: 'r', name: 'control_radio', args: { action: 'play' } },
      ],
    },
  });
  await h.c.toolQueue;
  ws.message({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] },
      turnComplete: true,
    },
  });
  h.radioControl({ action: 'stop', origin: 'user' });
  h.captures[0].drain();
  await tick();
  assert.equal(h.state.playing, 0);
  assert.equal(h.c.status, 'listening');
  h.c.stop();
});

test('eligible entity context sends a bounded fresh image before its function result', async () => {
  const h = harness({
    runAction: async () => ({
      ok: true,
      action: 'get_entity_context',
      scene: { basemap: { viewScale: 'local' } },
    }),
    captureViewport: async () => 'data:image/jpeg;base64,aW1hZ2U=',
  });
  await h.c.start();
  establishToolInput(h);
  h.sockets[0].message({
    toolCall: {
      functionCalls: [{ id: 'view', name: 'get_entity_context', args: {} }],
    },
  });
  await h.c.toolQueue;
  const sent = h.sockets[0].sent;
  const imageIndex = sent.findIndex((entry) => entry.realtimeInput?.video);
  assert.ok(imageIndex > 0);
  assert.ok(imageIndex < sent.findIndex((entry) => entry.toolResponse));
  h.c.stop();
});

test('socket pressure drops PCM without failing the active session and delivery recovers', async () => {
  const h = harness();
  await h.c.start();
  const ws = h.sockets[0],
    audio = h.captures[0],
    before = ws.sent.length;
  ws.bufferedAmount = 300000;
  audio.callbacks.onAudio(
    { data: 'AA==', mimeType: 'audio/pcm;rate=16000' },
    audio.metadata,
  );
  assert.equal(ws.sent.length, before);
  assert.equal(h.c.getDiagnostics().droppedAudioChunks, 1);
  assert.equal(h.c.status, 'listening');
  assert.equal(h.tracks[0].readyState, 'live');
  ws.bufferedAmount = 0;
  audio.callbacks.onAudio(
    { data: 'AQ==', mimeType: 'audio/pcm;rate=16000' },
    audio.metadata,
  );
  assert.equal(ws.sent.at(-1).realtimeInput.audio.data, 'AQ==');
  h.c.stop();
});

test('passive map context never interrupts spoken output and is delivered at the next explicit turn', async () => {
  const h = harness();
  await h.c.start();
  const ws = h.sockets[0];
  ws.message({
    serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } },
  });
  const before = ws.sent.length;
  const event = {
    type: 'map_annotation_outline',
    label: 'Austin',
    status: 'resolved',
  };
  assert.equal(h.c.notifyMapEvent(event), true);
  event.label = 'changed after enqueue';
  assert.equal(
    ws.sent.length,
    before,
    'passive context sends no clientContent while speech is active',
  );
  assert.equal(h.captures[0].pending, true);
  h.c.sendTextCommand('What did you outline?');
  const parts = ws.sent.at(-1).clientContent.turns[0].parts;
  assert.equal(JSON.parse(parts[0].text).events[0].label, 'Austin');
  assert.equal(parts[1].text, 'What did you outline?');
  assert.equal(h.c.pendingMapEvents.length, 0);
  for (let i = 0; i < 30; i++) h.c.notifyMapEvent({ index: i });
  assert.equal(h.c.pendingMapEvents.length, 16);
  assert.equal(h.c.notifyMapEvent({ text: 'x'.repeat(16000) }), false);
  h.c.stop();
  assert.equal(h.c.pendingMapEvents.length, 0);
});

test('passive context joins the next tool response and survives a failed explicit send', async () => {
  const h = harness();
  await h.c.start();
  h.c.notifyMapEvent({ type: 'map_annotation_outline', label: 'London' });
  h.sockets[0].readyState = 0;
  assert.equal(h.c.sendTextCommand('Continue'), false);
  assert.equal(h.c.pendingMapEvents.length, 1);
  h.sockets[0].readyState = 1;
  h.sockets[0].message({ voiceActivity: { type: 'ACTIVITY_START' } });
  h.sockets[0].message({ voiceActivity: { type: 'ACTIVITY_END' } });
  h.sockets[0].message({
    serverContent: { inputTranscription: { text: 'Continue' } },
  });
  h.sockets[0].message({
    toolCall: {
      functionCalls: [{ id: 'context', name: 'get_entity_context', args: {} }],
    },
  });
  await h.c.toolQueue;
  assert.equal(
    h.sockets[0].sent.at(-1).toolResponse.functionResponses[0].response
      .mapEvents[0].label,
    'London',
  );
  assert.equal(h.c.pendingMapEvents.length, 0);
  h.c.stop();
});

test('a delayed permission prompt does not mint a token or consume the network deadline', async () => {
  const microphone = deferred();
  const h = harness({
    startupTimeoutMs: 40,
    getUserMedia: () => microphone.promise,
  });
  const start = h.c.start();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(h.c.status, 'connecting');
  assert.equal(h.requests.length, 0);
  assert.equal(h.sockets.length, 0);
  microphone.resolve(h.makeStream());
  await start;
  assert.equal(h.c.status, 'listening');
  assert.equal(h.requests.length, 1);
  h.c.stop();
});

test('Stop during a permission prompt releases a late grant without touching the successor', async () => {
  const microphone = deferred();
  const h = harness({ getUserMedia: () => microphone.promise });
  const start = h.c.start();
  await tick();
  h.c.stop();
  await start;
  const lateStream = h.makeStream();
  h.c.getUserMedia = async () => h.makeStream();
  await h.c.start();
  microphone.resolve(lateStream);
  await tick();
  assert.equal(h.tracks[0].readyState, 'ended');
  assert.equal(h.tracks[1].readyState, 'live');
  assert.equal(h.c.status, 'listening');
  h.c.stop();
});

test('stalled audio initialization also obeys the startup deadline', async () => {
  const initialization = deferred();
  const h = harness({ startupTimeoutMs: 40 });
  const createAudio = h.c.createAudio;
  h.c.createAudio = (callbacks) => {
    const audio = createAudio(callbacks);
    audio.initialize = () => initialization.promise;
    return audio;
  };
  await Promise.all([
    h.c.start(),
    new Promise((resolve) => setTimeout(resolve, 80)),
  ]);
  assert.equal(h.c.status, 'error');
  assert.equal(h.captures[0].closed, true);
  assert.equal(h.sockets.length, 0);
  initialization.resolve();
  await tick();
  assert.equal(h.c.status, 'error');
});

for (const activity of [
  'activity-start',
  'push-to-talk',
  'interrupted',
  'user-text',
]) {
  test(`new ${activity} revokes a pending Radio preflight after the old spoken turn ended`, async () => {
    const ready = deferred();
    const h = harness({
      runAction: async () => ({
        ok: true,
        action: 'control_radio',
        radioPlaybackRequested: true,
      }),
    });
    h.c.radio.radioLayer.playForVoice = () => ready.promise;
    await h.c.start();
    establishToolInput(h);
    const ws = h.sockets[0];
    ws.message({
      toolCall: {
        functionCalls: [
          { id: 'radio', name: 'control_radio', args: { action: 'play' } },
        ],
      },
    });
    await h.c.toolQueue;
    ws.message({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] },
        turnComplete: true,
      },
    });
    h.captures[0].drain();
    assert.equal(h.c.radio.radioHandoffInFlight, true);
    if (activity === 'activity-start')
      ws.message({
        voiceActivity: {
          type: 'ACTIVITY_START',
          audioOffset: '12s',
        },
      });
    else if (activity === 'interrupted')
      ws.message({ serverContent: { interrupted: true } });
    else if (activity === 'user-text') h.c.sendTextCommand('Actually stop');
    else h.c.input.setMicrophoneEnabled(true);
    ready.resolve(true);
    await tick();
    assert.equal(h.c.status, 'listening');
    assert.equal(h.c.stream.getTracks()[0].readyState, 'live');
    assert.equal(h.state.ducked, true);
    assert.ok(h.state.stopped > 0);
    h.c.stop();
  });
}

test('uncorrelated late transcription preserves its own successful Radio action and preflight', async () => {
  const tool = deferred();
  const ready = deferred();
  const h = harness({ runAction: () => tool.promise });
  h.c.radio.radioLayer.playForVoice = () => ready.promise;
  await h.c.start();
  establishToolInput(h);
  const ws = h.sockets[0];
  ws.message({
    toolCall: {
      functionCalls: [
        {
          id: 'radio-late-transcript',
          name: 'control_radio',
          args: { action: 'play' },
        },
      ],
    },
  });
  await tick();
  const handoffEpoch = h.c.radio.radioHandoffEpoch;
  ws.message({
    serverContent: {
      inputTranscription: { text: 'Play the radio' },
      interimInputTranscription: { text: 'Play the radio' },
    },
  });
  assert.equal(h.c.radio.radioHandoffEpoch, handoffEpoch);
  tool.resolve({
    ok: true,
    action: 'control_radio',
    radioPlaybackRequested: true,
  });
  await h.c.toolQueue;
  const response = ws.sent.find((message) => message.toolResponse).toolResponse
    .functionResponses[0].response;
  assert.equal(response.ok, true);
  assert.equal(response.radioPlaybackRequested, true);
  ws.message({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] },
      turnComplete: true,
    },
  });
  h.captures[0].drain();
  assert.equal(h.c.radio.radioHandoffInFlight, true);
  ws.message({ serverContent: { inputTranscription: { text: ' please' } } });
  assert.equal(h.c.radio.radioHandoffInFlight, true);
  ready.resolve(true);
  await tick();
  assert.equal(h.c.status, 'idle');
  assert.equal(h.state.ducked, false);
});

function radioPlaybackResult() {
  return {
    ok: true,
    action: 'control_radio',
    radioAction: 'play',
    radioPlaybackRequested: true,
  };
}

function establishToolInput(h, text = 'Run the requested action') {
  assert.equal(h.c.sendTextCommand(text), true);
}

function requestTool(
  ws,
  id,
  name = 'control_radio',
  args = { action: 'play' },
) {
  ws.message({ toolCall: { functionCalls: [{ id, name, args }] } });
}

function drainRadioReply(h) {
  h.sockets[0].message({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] },
      turnComplete: true,
    },
  });
  h.captures[0].drain();
}

for (const query of [
  { name: 'get_entity_context', args: {} },
  { name: 'control_radio', args: { action: 'status' } },
]) {
  for (const phase of ['active', 'prepared', 'preflight']) {
    test(
      `cancelling ${query.name} ${query.args.action || ''} preserves another Radio owner in ${phase}`,
      {
        skip:
          phase === 'preflight'
            ? 'replace-native: H01, H02; equivalent native regression tests replace caption ownership assumptions'
            : false,
      },
      async () => {
        const tool = deferred();
        const queryWork = deferred();
        const ready = deferred();
        const executions = [];
        const h = harness({
          runAction: (name, args, options) => {
            executions.push({ name, args, options });
            return args.action === 'play' ? tool.promise : queryWork.promise;
          },
        });
        h.c.radio.radioLayer.playForVoice = () => ready.promise;
        await h.c.start();
        establishToolInput(h);
        const ws = h.sockets[0];
        requestTool(ws, 'owner');
        await tick();
        if (phase !== 'active') {
          tool.resolve(radioPlaybackResult());
          await h.c.toolQueue;
          if (phase === 'preflight') drainRadioReply(h);
        }
        requestTool(ws, 'query', query.name, query.args);
        await tick();
        const epoch = h.c.radio.radioHandoffEpoch;
        const pending = h.c.radio.pendingRadioPlaybackResult;
        const attempt = h.c.radio.radioHandoffAttemptId;
        const ownerWasCurrent = executions[0].options.isCurrent();
        ws.message({ toolCallCancellation: { ids: ['unknown', 'query'] } });
        assert.equal(h.c.radio.radioHandoffEpoch, epoch);
        assert.equal(executions[0].options.signal.aborted, false);
        assert.equal(executions[0].options.isCurrent(), ownerWasCurrent);
        assert.equal(h.c.radio.pendingRadioPlaybackResult, pending);
        assert.equal(h.c.radio.radioHandoffAttemptId, attempt);
        assert.equal(h.state.stopped, 0);
        if (phase === 'active') tool.resolve(radioPlaybackResult());
        await h.c.toolQueue;
        assert.equal(
          executions.length,
          phase === 'prepared' ? 2 : 1,
          'cancelled queued and post-completion unowned queries never start',
        );
        assert.equal(h.c.pendingTools, 0);
        const responses = ws.sent.flatMap(
          (message) => message.toolResponse?.functionResponses || [],
        );
        assert.deepEqual(
          responses.map((response) => response.id),
          phase === 'preflight' ? ['owner', 'query'] : ['owner'],
        );
        assert.equal(responses[0].response.ok, true);
        if (phase !== 'preflight') drainRadioReply(h);
        assert.equal(h.c.radio.radioHandoffInFlight, true);
        ready.resolve(true);
        queryWork.resolve({ ok: true });
        await tick();
        assert.equal(h.c.status, 'idle');
        assert.equal(h.state.ducked, false);
      },
    );
  }
}

test('cancelling one queued Radio call preserves active and queued same-feature siblings', async () => {
  const first = deferred();
  const executions = [];
  const h = harness({
    runAction: (name, args, options) => {
      executions.push({ args, options });
      return args.station === 'first' ? first.promise : radioPlaybackResult();
    },
  });
  await h.c.start();
  establishToolInput(h);
  const ws = h.sockets[0];
  for (const station of ['first', 'cancelled', 'last'])
    requestTool(ws, station, 'control_radio', { action: 'select', station });
  await tick();
  const epoch = h.c.radio.radioHandoffEpoch;
  ws.message({ toolCallCancellation: { ids: ['cancelled'] } });
  assert.equal(h.c.radio.radioHandoffEpoch, epoch);
  assert.equal(executions[0].options.isCurrent(), true);
  first.resolve(radioPlaybackResult());
  await h.c.toolQueue;
  assert.deepEqual(
    executions.map((entry) => entry.args.station),
    ['first', 'last'],
  );
  assert.ok(executions.every((entry) => !entry.options.signal.aborted));
  assert.equal(h.c.pendingTools, 0);
  const newer = h.c.radio.pendingRadioPlaybackResult;
  ws.message({ toolCallCancellation: { ids: ['first', 'unknown'] } });
  assert.equal(h.c.radio.pendingRadioPlaybackResult, newer);
  assert.equal(h.c.radio.radioHandoffEpoch, epoch);
  h.c.stop();
});

test('matching active Radio cancellation aborts its work and permits its sibling to finish', async () => {
  const first = deferred();
  const executions = [];
  const h = harness({
    runAction: (name, args, options) => {
      executions.push(options);
      return args.action === 'play' ? first.promise : radioPlaybackResult();
    },
  });
  await h.c.start();
  establishToolInput(h);
  const ws = h.sockets[0];
  requestTool(ws, 'old');
  requestTool(ws, 'new', 'control_radio', { action: 'select' });
  await tick();
  const epoch = h.c.radio.radioHandoffEpoch;
  ws.message({ toolCallCancellation: { ids: ['old'] } });
  assert.equal(executions[0].signal.aborted, true);
  assert.equal(executions[0].isCurrent(), false);
  await h.c.toolQueue;
  const pending = h.c.radio.pendingRadioPlaybackResult;
  assert.ok(pending);
  assert.equal(executions[1].isCurrent(), true);
  assert.equal(h.c.radio.radioHandoffEpoch, epoch);
  first.resolve(radioPlaybackResult());
  await tick();
  assert.equal(h.c.radio.pendingRadioPlaybackResult, pending);
  assert.deepEqual(
    ws.sent
      .flatMap((m) => m.toolResponse?.functionResponses || [])
      .map((r) => r.id),
    ['new'],
  );
  h.c.stop();
});

test('matching prepared cancellation preserves a stronger sibling reservation and signal', async () => {
  const stronger = deferred();
  let strongerOptions;
  const h = harness({
    runAction: (name, args, options) => {
      if (args.action === 'stop') {
        strongerOptions = options;
        return stronger.promise;
      }
      return radioPlaybackResult();
    },
  });
  await h.c.start();
  establishToolInput(h);
  const ws = h.sockets[0];
  requestTool(ws, 'play');
  await h.c.toolQueue;
  requestTool(ws, 'stop', 'control_radio', { action: 'stop' });
  await tick();
  const reservations = [...h.c.radio.radioToolHandoffReservations.keys()];
  assert.equal(reservations.length, 1);
  const epoch = h.c.radio.radioHandoffEpoch;
  ws.message({ toolCallCancellation: { ids: ['play', 'unknown'] } });
  assert.equal(h.c.radio.pendingRadioPlaybackResult, null);
  assert.equal(strongerOptions.signal.aborted, false);
  assert.deepEqual(
    [...h.c.radio.radioToolHandoffReservations.keys()],
    reservations,
  );
  assert.equal(h.c.radio.radioHandoffEpoch, epoch);
  stronger.resolve({ ok: false, error: 'Refused fixture stop' });
  await h.c.toolQueue;
  assert.equal(h.c.radio.radioToolHandoffReservations.size, 0);
  drainRadioReply(h);
  await tick();
  assert.equal(h.state.playing, 0);
  assert.equal(h.c.status, 'listening');
  h.c.stop();
});

test('cancelled stronger call releases only its reservation and retains prepared playback', async () => {
  const stronger = deferred();
  const h = harness({
    runAction: (name, args) =>
      args.action === 'stop' ? stronger.promise : radioPlaybackResult(),
  });
  await h.c.start();
  establishToolInput(h);
  const ws = h.sockets[0];
  requestTool(ws, 'play');
  await h.c.toolQueue;
  const prepared = h.c.radio.pendingRadioPlaybackResult;
  requestTool(ws, 'stop', 'control_radio', { action: 'stop' });
  await tick();
  const separateReservation = h.c.radio.reserveRadioToolHandoff();
  ws.message({ toolCallCancellation: { ids: ['stop'] } });
  await h.c.toolQueue;
  assert.equal(h.c.radio.pendingRadioPlaybackResult, prepared);
  assert.deepEqual(
    [...h.c.radio.radioToolHandoffReservations.keys()],
    [separateReservation],
  );
  stronger.resolve({ ok: true, action: 'control_radio' });
  await tick();
  assert.equal(h.c.radio.pendingRadioPlaybackResult, prepared);
  h.c.radio.settleRadioToolHandoffReservation(separateReservation);
  drainRadioReply(h);
  await tick();
  assert.equal(h.state.playing, 1);
  assert.equal(h.c.status, 'idle');
});

test('matching preflight cancellation and late completion cannot revoke a newer reused-result handoff', async () => {
  const sharedResult = radioPlaybackResult();
  const starts = [];
  const stops = [];
  let playingAttempt = null;
  const h = harness({ runAction: () => sharedResult });
  h.c.radio.radioLayer.playForVoice = ({ attemptId }) => {
    const ready = deferred();
    starts.push({ attemptId, ready });
    playingAttempt = attemptId;
    return ready.promise;
  };
  h.c.radio.radioLayer.stopPlayback = ({ attemptId }) => {
    stops.push(attemptId);
    if (playingAttempt === attemptId) playingAttempt = null;
  };
  await h.c.start();
  establishToolInput(h);
  const ws = h.sockets[0];
  requestTool(ws, 'old');
  await h.c.toolQueue;
  drainRadioReply(h);
  const oldResult = h.c.radio.radioHandoffInFlightResult;
  establishToolInput(h, 'Play the radio again');
  requestTool(ws, 'new');
  await h.c.toolQueue;
  const newerResult = h.c.radio.pendingRadioPlaybackResult;
  assert.notEqual(oldResult, newerResult);
  assert.notEqual(newerResult, sharedResult);
  const epoch = h.c.radio.radioHandoffEpoch;
  ws.message({ toolCallCancellation: { ids: ['old'] } });
  assert.equal(h.c.radio.radioHandoffEpoch, epoch);
  assert.equal(h.c.radio.pendingRadioPlaybackResult, newerResult);
  assert.equal(h.c.radio.radioHandoffInFlight, false);
  assert.deepEqual(stops, [starts[0].attemptId]);
  drainRadioReply(h);
  assert.equal(starts.length, 2);
  const newerAttempt = starts[1].attemptId;
  starts[0].ready.resolve(true);
  await tick();
  assert.equal(h.c.status, 'listening');
  assert.equal(h.c.radio.radioHandoffAttemptId, newerAttempt);
  assert.equal(playingAttempt, newerAttempt);
  assert.ok(stops.every((id) => id === starts[0].attemptId));
  ws.message({ toolCallCancellation: { ids: ['old', 'unknown'] } });
  assert.equal(h.c.radio.radioHandoffAttemptId, newerAttempt);
  starts[1].ready.resolve(true);
  await tick();
  assert.equal(h.c.status, 'idle');
  assert.equal(playingAttempt, newerAttempt);
});

test('cancelled preflight rejection cannot emit a stale Radio failure correction', async () => {
  let rejectReady;
  const ready = new Promise((_, reject) => {
    rejectReady = reject;
  });
  const corrections = [];
  const h = harness({ runAction: () => radioPlaybackResult() });
  h.c.radio.radioLayer.playForVoice = () => ready;
  h.c.radio.queueResponseCreate = (text) => corrections.push(text);
  await h.c.start();
  establishToolInput(h);
  const ws = h.sockets[0];
  requestTool(ws, 'old');
  await h.c.toolQueue;
  drainRadioReply(h);
  ws.message({ toolCallCancellation: { ids: ['old'] } });
  rejectReady(new Error('late obsolete stream rejection'));
  await tick();
  assert.deepEqual(corrections, []);
  assert.equal(h.c.status, 'listening');
  h.c.stop();
});

test('completed query and unknown cancellation IDs are inert and cannot poison future calls', async () => {
  const executions = [];
  const h = harness({
    runAction: (name, args) => {
      executions.push(args.action);
      return args.action === 'status'
        ? { ok: true, action: name }
        : radioPlaybackResult();
    },
  });
  await h.c.start();
  establishToolInput(h);
  const ws = h.sockets[0];
  requestTool(ws, 'query', 'control_radio', { action: 'status' });
  await h.c.toolQueue;
  requestTool(ws, 'owner');
  await h.c.toolQueue;
  const prepared = h.c.radio.pendingRadioPlaybackResult;
  const epoch = h.c.radio.radioHandoffEpoch;
  ws.message({ toolCallCancellation: { ids: ['query', 'future'] } });
  assert.equal(h.c.radio.pendingRadioPlaybackResult, prepared);
  assert.equal(h.c.radio.radioHandoffEpoch, epoch);
  requestTool(ws, 'future', 'control_radio', { action: 'select' });
  await h.c.toolQueue;
  assert.deepEqual(executions, ['status', 'play', 'select']);
  h.c.stop();
});

for (const replacement of ['user-activity', 'stop']) {
  test(`${replacement} still revokes all prepared and preflight Radio ownership`, async () => {
    const ready = deferred();
    const h = harness({ runAction: () => radioPlaybackResult() });
    h.c.radio.radioLayer.playForVoice = () => ready.promise;
    await h.c.start();
    establishToolInput(h);
    const ws = h.sockets[0];
    requestTool(ws, 'old');
    await h.c.toolQueue;
    drainRadioReply(h);
    h.c.radio.setPendingPlayback(radioPlaybackResult());
    assert.ok(h.c.radio.pendingRadioPlaybackResult);
    assert.equal(h.c.radio.radioHandoffInFlight, true);
    if (replacement === 'user-activity') h.c.noteUserActivity();
    else h.c.stop();
    assert.equal(h.c.radio.pendingRadioPlaybackResult, null);
    assert.equal(h.c.radio.radioHandoffInFlight, false);
    assert.equal(h.c.radio.radioToolHandoffReservations.size, 0);
    assert.ok(h.state.stopped > 0);
    ready.resolve(true);
    await tick();
    assert.equal(h.c.status, replacement === 'stop' ? 'idle' : 'listening');
    if (replacement === 'user-activity') {
      assert.equal(h.c.stream.getTracks()[0].readyState, 'live');
      h.c.stop();
    }
  });
}

test('successful stronger Radio stop still invalidates the prepared group', async () => {
  const h = harness({
    runAction: (name, args) =>
      args.action === 'stop'
        ? { ok: true, action: name, radioAction: 'stop' }
        : radioPlaybackResult(),
  });
  await h.c.start();
  establishToolInput(h);
  const ws = h.sockets[0];
  requestTool(ws, 'play');
  await h.c.toolQueue;
  const epoch = h.c.radio.radioHandoffEpoch;
  requestTool(ws, 'stop', 'control_radio', { action: 'stop' });
  await h.c.toolQueue;
  assert.equal(h.c.radio.pendingRadioPlaybackResult, null);
  assert.ok(h.c.radio.radioHandoffEpoch > epoch);
  drainRadioReply(h);
  await tick();
  assert.equal(h.state.playing, 0);
  assert.equal(h.c.status, 'listening');
  h.c.stop();
});

test('slow Gemini tools reuse shared progress timing without injecting a conversation turn', async () => {
  const pending = deferred();
  let options;
  const h = harness({
    runAction: (_name, _args, next) => {
      options = next;
      next.progress({ step: 'search', label: 'Austin' });
      return pending.promise;
    },
  });
  await h.c.start({ pushToTalk: true });
  h.c.sendTextCommand('Fly to Austin');
  const ws = h.sockets[0];
  requestTool(ws, 'flight', 'fly_to_location', { query: 'Austin' });
  await tick();
  assert.equal(
    options.callId,
    'flight',
    'shared card and narration use one call identity',
  );
  assert.equal(h.c.narration.state().tools, 1);
  h.advance(699);
  assert.equal(h.earcon.playing, false);
  h.advance(1);
  assert.equal(h.earcon.playing, true);
  h.advance(7500);
  assert.equal(
    ws.sent.length,
    2,
    'progress never sends clientContent or an early tool response',
  );
  assert.equal(h.c.narration.state().stepLines, 0);
  assert.equal(h.c.narration.state().stillSpoken, false);
  pending.resolve({ ok: true, action: 'fly_to_location' });
  await h.c.toolQueue;
  assert.equal(ws.sent.at(-1).toolResponse.functionResponses[0].id, 'flight');
  assert.equal(h.c.narration.state().tools, 0);
  h.advance(3000);
  assert.equal(h.earcon.playing, false, 'reply grace bounds the final earcon');
  assert.equal(h.timers.size, 0);
  h.c.stop();
});

test('fast Gemini tools retract pending progress and Radio tools do not schedule lines', async () => {
  for (const name of ['fly_to_location', 'control_radio']) {
    const h = harness();
    await h.c.start({ pushToTalk: true });
    h.c.sendTextCommand('Run command');
    requestTool(
      h.sockets[0],
      'fast',
      name,
      name === 'control_radio' ? { action: 'status' } : {},
    );
    await h.c.toolQueue;
    h.advance(20000);
    assert.equal(h.earcon.starts, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(
      h.sockets[0].sent.filter((message) => message.clientContent).length,
      1,
    );
    h.c.stop();
  }
});

test('Gemini model preamble and playback take priority over the working earcon', async () => {
  const pending = deferred();
  const h = harness({ runAction: () => pending.promise });
  await h.c.start({ pushToTalk: true });
  h.c.sendTextCommand('Fly to Austin');
  const ws = h.sockets[0];
  ws.message({
    serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } },
  });
  requestTool(ws, 'slow', 'fly_to_location', { query: 'Austin' });
  await tick();
  assert.equal(h.c.narration.state().preambleSpoken, true);
  h.advance(1500);
  assert.equal(h.earcon.starts, 0, 'queued model audio owns the speaker');
  h.captures[0].drain();
  h.advance(700);
  assert.equal(h.earcon.playing, true);
  ws.message({
    serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } },
  });
  assert.equal(
    h.earcon.playing,
    false,
    'new model audio immediately stops the tone',
  );
  h.c.stop();
  pending.resolve({ ok: true });
  await tick();
});

test('PTT release starts shared progress timing and a new hold cancels it', async () => {
  const pending = deferred();
  let options;
  const h = harness({
    runAction: (_name, _args, next) => {
      options = next;
      return pending.promise;
    },
  });
  h.c.input.pushToTalkKeyHeld = true;
  await h.c.start({ pushToTalk: true });
  assert.equal(h.timers.size, 0);
  h.c.input.pushToTalkKeyHeld = false;
  h.c.input.setMicrophoneEnabled(false);
  h.sockets[0].message({
    serverContent: { inputTranscription: { text: 'fly to Austin' } },
  });
  requestTool(h.sockets[0], 'held', 'fly_to_location', { query: 'Austin' });
  await tick();
  h.advance(700);
  assert.equal(h.earcon.playing, true);
  h.c.input.pushToTalkKeyHeld = true;
  assert.equal(h.c.input.mayClaimSpeaker(), true);
  assert.equal(h.c.input.bargeIn(), true);
  h.c.input.setMicrophoneEnabled(true);
  assert.equal(h.earcon.playing, false);
  assert.ok(h.c.retiredBoundaryWait, 'interruption retains its recovery bound');
  assert.deepEqual([...h.timers.keys()], [h.c.retiredBoundaryWait.timer]);
  assert.equal(options.signal.aborted, true);
  assert.equal(h.captures[0].cleared, true);
  assert.equal(h.c.narration.state().preambleSpoken, false);
  pending.resolve({ ok: true });
  await tick();
  assert.equal(
    h.sockets[0].sent.some((message) => message.toolResponse),
    false,
  );
  h.c.stop();
});

test('open microphone and Radio speaker ownership suppress Gemini earcons', async () => {
  for (const mode of ['open-mic', 'held-ptt', 'radio']) {
    const pending = deferred();
    const h = harness({ runAction: () => pending.promise });
    await h.c.start({ pushToTalk: mode !== 'open-mic' });
    h.c.sendTextCommand('Fly to Austin');
    requestTool(h.sockets[0], 'slow', 'fly_to_location', { query: 'Austin' });
    await tick();
    if (mode === 'held-ptt') h.c.input.pushToTalkKeyHeld = true;
    if (mode === 'radio') {
      h.c.radio.setPendingPlayback(radioPlaybackResult());
      assert.equal(h.c.input.mayClaimSpeaker(), false);
      assert.equal(
        h.c.input.bargeIn(),
        false,
        'a hold cannot steal a Radio handoff',
      );
      assert.equal(h.c.pendingTools, 1);
    }
    h.advance(20000);
    assert.equal(h.earcon.starts, 0, mode);
    h.c.stop();
    pending.resolve({ ok: true });
    await tick();
  }
});

test('Gemini progress is bounded and all terminal paths release narration ownership', async () => {
  for (const end of ['stop', 'goAway', 'destroy', 'interruption']) {
    const pending = deferred();
    const h = harness({ runAction: () => pending.promise });
    await h.c.start({ pushToTalk: true });
    h.c.sendTextCommand('Fly to Austin');
    const ws = h.sockets[0];
    requestTool(ws, 'slow', 'fly_to_location', { query: 'Austin' });
    await tick();
    h.advance(700);
    assert.equal(h.earcon.playing, true);
    h.advance(15000);
    assert.equal(
      h.earcon.playing,
      false,
      'working tone never runs beyond the shared limit',
    );
    const disposals = h.earcon.disposals;
    if (end === 'goAway') ws.message({ goAway: { timeLeft: '0s' } });
    else if (end === 'interruption')
      ws.message({ serverContent: { interrupted: true } });
    else h.c.stop({ removeUi: end === 'destroy' });
    assert.equal(h.c.narration.state().tools, 0, end);
    const retirementTimer = h.c.retiredBoundaryWait?.timer;
    assert.deepEqual(
      [...h.timers.keys()],
      end === 'interruption' ? [retirementTimer] : [],
      'only the interrupted reply recovery timer may remain',
    );
    if (end === 'interruption') assert.ok(h.c.retiredBoundaryWait);
    assert.equal(h.earcon.playing, false, end);
    if (end !== 'interruption')
      assert.equal(h.earcon.disposals, disposals + 1, end);
    pending.resolve({ ok: true });
    await tick();
    h.advance(20000);
    assert.equal(
      ws.sent.some((message) => message.toolResponse),
      false,
      end,
    );
    assert.equal(h.timers.size, 0, end);
    h.c.stop();
  }
});

test('late tool and audio callbacks cannot change a successor Gemini narrator', async () => {
  const first = deferred();
  const second = deferred();
  const options = [];
  const h = harness({
    runAction: (_name, _args, next) => {
      options.push(next);
      return options.length === 1 ? first.promise : second.promise;
    },
  });
  await h.c.start({ pushToTalk: true });
  h.c.sendTextCommand('Fly to Austin');
  requestTool(h.sockets[0], 'reused', 'fly_to_location', { query: 'Austin' });
  await tick();
  const oldAudio = h.captures[0].callbacks;
  h.c.stop();
  await h.c.start({ pushToTalk: true });
  h.c.sendTextCommand('Fly to Tokyo');
  requestTool(h.sockets[1], 'reused', 'fly_to_location', { query: 'Tokyo' });
  await tick();
  const before = h.c.narration.state();
  options[0].progress({ step: 'fly', label: 'Austin' });
  oldAudio.onAudioEnd(h.captures[0].metadata);
  oldAudio.onDrain();
  first.resolve({ ok: true });
  await tick();
  assert.deepEqual(h.c.narration.state(), before);
  assert.equal(h.c.pendingTools, 1);
  h.advance(700);
  assert.equal(h.earcon.playing, true);
  second.resolve({ ok: true });
  await h.c.toolQueue;
  assert.equal(h.c.narration.state().tools, 0);
  h.c.stop();
  assert.equal(h.timers.size, 0);
});

test('Gemini tool progress reaches the shared card event contract with its call id', async () => {
  const pending = deferred();
  const events = [];
  let options;
  let h;
  const session = createVoiceSession({
    runner: (_name, _args, next) => {
      options = next;
      next.progress({ step: 'search', label: 'Austin' });
      return pending.promise;
    },
    createAdapter: (shared) => {
      h = harness(shared);
      return {
        start: (settings) => h.c.start(settings),
        stop: (settings) => h.c.stop(settings),
        sendText: (text) => h.c.sendTextCommand(text),
        sendMapEvent: (event) => h.c.notifyMapEvent(event),
      };
    },
  });
  session.subscribe((event) => events.push(event));
  await session.start({ pushToTalk: true });
  establishToolInput(h);
  requestTool(h.sockets[0], 'shared-call', 'fly_to_location', {
    query: 'Austin',
  });
  await tick();
  assert.equal(
    events.find((event) => event.type === 'action-call').callId,
    'shared-call',
  );
  assert.deepEqual(
    events.find((event) => event.type === 'progress'),
    {
      type: 'progress',
      name: 'fly_to_location',
      callId: 'shared-call',
      step: 'search',
      label: 'Austin',
    },
  );
  pending.resolve({ ok: true, action: 'fly_to_location' });
  await h.c.toolQueue;
  assert.equal(
    events.find((event) => event.type === 'action-result').callId,
    'shared-call',
  );
  session.stop();
  const progressCount = events.filter(
    (event) => event.type === 'progress',
  ).length;
  options.progress({ step: 'fly', label: 'Stale Austin' });
  assert.equal(
    events.filter((event) => event.type === 'progress').length,
    progressCount,
  );
  assert.equal(h.timers.size, 0);
  session.destroy();
});

function pointerHarness() {
  let clock = 1000;
  const pointer = createPointerTracker({
    element: {
      clientWidth: 1000,
      clientHeight: 500,
      addEventListener() {},
    },
    now: () => clock,
    setTimer: () => 1,
    clearTimer() {},
    pick: (x) => ({
      entity: {
        layerId: 'flights',
        id: String(x),
        label: `Aircraft ${x}`,
        kind: 'aircraft',
        lat: 30,
        lon: -97,
      },
    }),
  });
  return {
    pointer,
    advance: (ms) => {
      clock += ms;
    },
  };
}

const replyAudio = (data) => ({
  modelTurn: {
    parts: [{ inlineData: { data, mimeType: 'audio/pcm;rate=24000' } }],
  },
});

test('B48 pointer: a cold held PTT turn freezes keydown and sends quiet context before activity', async () => {
  const { pointer } = pointerHarness();
  const h = harness({ pointer });
  pointer.moveTo(300, 200);
  h.c.input.holdPointer();
  pointer.moveTo(700, 200);
  h.c.input.pushToTalkKeyHeld = true;
  h.c.input.spaceKeyHeld = true;
  await h.c.start({ pushToTalk: true });
  assert.equal(pointer.activeSnapshot().entity.id, '300');
  assert.deepEqual(
    h.events.filter((event) => event.type === 'pointer').at(-1).pointer,
    {
      kind: 'this',
      label: 'Aircraft 300',
      screenPx: { x: 300, y: 200 },
    },
  );
  const start = h.sockets[0].sent.find(
    (value) => value.realtimeInput?.activityStart,
  );
  const context = h.sockets[0].sent.find((value) => value.clientContent);
  assert.equal(
    JSON.parse(context.clientContent.turns[0].parts[0].text).target.label,
    'Aircraft 300',
  );
  assert.equal(context.clientContent.turns[0].role, 'user');
  assert.equal(context.clientContent.turnComplete, false);
  assert.deepEqual(start, { realtimeInput: { activityStart: {} } });
  assert.equal(
    h.sockets[0].sent.indexOf(context) < h.sockets[0].sent.indexOf(start),
    true,
  );
  assert.equal(
    h.c.replyPending,
    false,
    'context and an empty hold request no reply',
  );
  assert.equal(
    h.sockets[0].sent.some(
      (value) => value.clientContent?.turnComplete === true,
    ),
    false,
  );
  h.c.input.releasePointerHold();
  h.c.input.setMicrophoneEnabled(false);
  // A delayed server onset must not replace the released gesture's referent.
  h.sockets[0].message({ voiceActivity: { type: 'ACTIVITY_START' } });
  assert.equal(pointer.activeSnapshot().entity.id, '300');
  h.sockets[0].message({
    serverContent: { inputTranscription: { text: 'what is this' } },
  });
  h.sockets[0].message({
    toolCall: {
      functionCalls: [
        {
          id: 'pointed',
          name: 'get_entity_context',
          args: { scope: 'pointer' },
        },
      ],
    },
  });
  await h.c.toolQueue;
  assert.equal(h.calls[0].args.scope, 'pointer');
  assert.equal(pointer.activeSnapshot().entity.id, '300');
  h.c.stop();
  assert.equal(pointer.activeSnapshot(), null);
  pointer.destroy();
});

test('B48 pointer: text uses recent availability, clears stale context and sends one turn', async () => {
  const { pointer, advance } = pointerHarness();
  const h = harness({ pointer });
  await h.c.start();
  pointer.moveTo(400, 200);
  h.c.sendTextCommand('what is this?');
  assert.equal(pointer.activeSnapshot().entity.id, '400');
  let parts = h.sockets[0].sent.at(-1).clientContent.turns[0].parts;
  assert.deepEqual(JSON.parse(parts[0].text), {
    type: 'pointer_context',
    at: 'text',
    pointing: 'aircraft',
  });
  assert.equal(parts.at(-1).text, 'what is this?');
  assert.equal(
    h.sockets[0].sent.filter((value) => value.clientContent).length,
    1,
  );
  assert.equal(
    h.events.filter((event) => event.type === 'pointer').at(-1).pointer,
    null,
  );
  h.c.runAction = async () => {
    assert.equal(pointer.activeSnapshot().entity.id, '400');
    assert.equal(h.c.announcePointer(), true);
    assert.equal(h.c.announcePointer(), false);
    return { ok: true };
  };
  h.sockets[0].message({
    toolCall: {
      functionCalls: [
        {
          id: 'implicit-pointer',
          name: 'get_entity_context',
          args: { scope: 'pointer' },
        },
      ],
    },
  });
  await h.c.toolQueue;
  assert.equal(
    h.events.filter((event) => event.type === 'pointer').at(-1).pointer.label,
    'Aircraft 400',
  );
  h.sockets[0].message({ serverContent: { turnComplete: true } });
  advance(5001);
  h.c.sendTextCommand('what is here?');
  assert.equal(pointer.activeSnapshot(), null);
  parts = h.sockets[0].sent.at(-1).clientContent.turns[0].parts;
  assert.deepEqual(JSON.parse(parts[0].text), {
    type: 'pointer_context',
    at: 'text',
    target: 'none',
  });
  assert.equal(parts.at(-1).text, 'what is here?');
  h.c.stop();
  pointer.destroy();
});

test('B48 pointer: automatic speech snapshots once per onset and late input transcript keeps it', async () => {
  const { pointer } = pointerHarness();
  const h = harness({ pointer });
  await h.c.start();
  pointer.moveTo(450, 200);
  const ws = h.sockets[0];
  ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
  const turn = h.c.turn;
  assert.equal(pointer.activeSnapshot().entity.id, '450');
  assert.deepEqual(JSON.parse(ws.sent.at(-1).realtimeInput.text), {
    type: 'pointer_context',
    at: 'speech_start',
    pointing: 'aircraft',
  });
  pointer.moveTo(750, 200);
  ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
  ws.message({
    serverContent: { inputTranscription: { text: 'what is this?' } },
  });
  assert.equal(
    h.c.turn,
    turn,
    'duplicate onset does not revoke the current turn',
  );
  assert.equal(pointer.activeSnapshot().entity.id, '450');
  assert.equal(
    ws.sent.some((value) => value.clientContent),
    false,
  );
  ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
  ws.message({ serverContent: { turnComplete: true } });
  ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
  assert.equal(pointer.activeSnapshot().entity.id, '750');
  h.c.stop();
  pointer.destroy();
});

for (const route of ['push-to-talk', 'user-text']) {
  for (const prior of ['playing', 'before-first-output']) {
    test(
      `B48 fence: ${route} retires ${prior} output through the server boundary`,
      {
        skip:
          route === 'push-to-talk'
            ? 'replace-native: H03, H04; equivalent native regression tests replace caption ownership assumptions'
            : false,
      },
      async () => {
        const h = harness();
        await h.c.start({ pushToTalk: route === 'push-to-talk' });
        const ws = h.sockets[0];
        const audio = h.captures[0];
        if (prior === 'playing')
          ws.message({ serverContent: replyAudio('old') });
        else if (route === 'user-text') h.c.sendTextCommand('first request');
        else {
          h.c.input.setMicrophoneEnabled(true);
          audio.callbacks.onAudio(
            {
              data: 'AAAB',
              mimeType: 'audio/pcm;rate=16000',
            },
            audio.metadata,
          );
          h.c.input.setMicrophoneEnabled(false);
        }
        if (route === 'user-text') h.c.sendTextCommand('new request');
        else {
          h.c.input.pushToTalkKeyHeld = true;
          assert.equal(h.c.input.bargeIn(), true);
          h.c.input.setMicrophoneEnabled(true);
          h.c.input.setMicrophoneEnabled(false);
        }
        const turn = h.c.turn;
        const played = audio.played.length;
        const eventCount = h.events.length;
        ws.message({
          serverContent: {
            ...replyAudio('late-old'),
            outputTranscription: { text: 'retired output' },
            inputTranscription: { text: 'new request' },
          },
        });
        ws.message({
          toolCall: {
            functionCalls: [
              {
                id: 'retired-call',
                name: 'fly_to_location',
                args: { query: 'old target' },
              },
            ],
          },
        });
        await tick();
        assert.equal(
          audio.played.length,
          played,
          'late old audio cannot requeue after the local interruption',
        );
        assert.equal(audio.pending, false);
        assert.equal(
          h.calls.length,
          0,
          'late old call cannot acquire the newer local turn',
        );
        assert.equal(
          h.events
            .slice(eventCount)
            .some((event) => event.role === 'assistant'),
          false,
        );
        assert.equal(
          h.events
            .slice(eventCount)
            .some(
              (event) => event.role === 'user' && event.text === 'new request',
            ),
          true,
        );
        ws.message({ serverContent: { interrupted: true } });
        assert.equal(
          h.c.turn,
          turn,
          'the acknowledgment cannot cancel successor ownership',
        );
        ws.message({ serverContent: replyAudio('after-interrupted') });
        assert.equal(
          audio.played.length,
          played,
          'interrupted alone is not the completed boundary',
        );
        ws.message({
          serverContent: {
            ...replyAudio('boundary-old'),
            outputTranscription: { text: 'still retired' },
            turnComplete: true,
          },
        });
        assert.equal(
          audio.played.length,
          played,
          'coalesced retired boundary content is also discarded',
        );
        assert.equal(
          h.events
            .slice(eventCount)
            .some((event) => event.type === 'completion'),
          false,
        );
        if (route === 'push-to-talk')
          ws.message({
            serverContent: {
              inputTranscription: { text: 'fly to new target' },
            },
          });
        ws.message({
          toolCall: {
            functionCalls: [
              {
                id: 'retired-call',
                name: 'fly_to_location',
                args: { query: 'replayed old target' },
              },
              {
                id: 'new-call',
                name: 'fly_to_location',
                args: { query: 'new target' },
              },
            ],
          },
        });
        if (route === 'push-to-talk') {
          await tick();
          h.advance(5_000);
        }
        await h.c.toolQueue;
        assert.deepEqual(
          h.calls.map((call) => call.args.query),
          route === 'user-text' ? ['new target'] : [],
        );
        ws.message({
          serverContent: {
            ...replyAudio('new'),
            outputTranscription: { text: 'new reply' },
            turnComplete: true,
          },
        });
        assert.equal(audio.played.at(-1).data, 'new');
        audio.drain();
        assert.equal(
          h.events.filter((event) => event.type === 'completion').at(-1).status,
          'completed',
        );
        h.c.stop();
      },
    );
  }
}

for (const route of ['push-to-talk', 'user-text']) {
  for (const idle of ['first', 'completed']) {
    test(`B48 fence: ${route} permits the ${idle} idle reply without an interruption marker`, async () => {
      const h = harness();
      await h.c.start({ pushToTalk: route === 'push-to-talk' });
      const ws = h.sockets[0];
      const audio = h.captures[0];
      if (idle === 'completed') {
        ws.message({
          serverContent: { ...replyAudio('previous'), turnComplete: true },
        });
        audio.drain();
      }
      if (route === 'user-text') h.c.sendTextCommand('first live request');
      else {
        h.c.input.bargeIn();
        h.c.input.setMicrophoneEnabled(true);
        h.c.input.setMicrophoneEnabled(false);
        ws.message({
          serverContent: { inputTranscription: { text: 'what is in view' } },
        });
      }
      ws.message({
        toolCall: {
          functionCalls: [
            { id: 'valid-first-call', name: 'get_entity_context', args: {} },
          ],
        },
      });
      await h.c.toolQueue;
      ws.message({
        serverContent: { ...replyAudio('legitimate'), turnComplete: true },
      });
      assert.equal(h.calls.length, 1);
      assert.equal(audio.played.at(-1).data, 'legitimate');
      h.c.stop();
    });
  }
}

test('B48 fence: an empty PTT hold creates no retired boundary for the next command', async () => {
  const h = harness();
  await h.c.start({ pushToTalk: true });
  h.c.input.bargeIn();
  h.c.input.setMicrophoneEnabled(true);
  h.c.input.setMicrophoneEnabled(false);
  h.c.input.bargeIn();
  h.c.input.setMicrophoneEnabled(true);
  h.captures[0].callbacks.onAudio(
    {
      data: 'AAAA',
      mimeType: 'audio/pcm;rate=16000',
    },
    h.captures[0].metadata,
  );
  h.c.input.setMicrophoneEnabled(false);
  h.sockets[0].message({
    serverContent: { ...replyAudio('first-real'), turnComplete: true },
  });
  assert.equal(h.captures[0].played.at(-1).data, 'first-real');
  h.c.stop();
});

test('B48 fence: a coalesced interrupted boundary keeps successor speech and its pointer', async () => {
  const { pointer } = pointerHarness();
  const h = harness({ pointer });
  await h.c.start();
  const ws = h.sockets[0];
  ws.message({ serverContent: replyAudio('old') });
  pointer.moveTo(600, 200);
  ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
  const turn = h.c.turn;
  ws.message({
    voiceActivity: { type: 'ACTIVITY_START' },
    serverContent: {
      ...replyAudio('boundary-old'),
      interrupted: true,
      turnComplete: true,
      inputTranscription: { text: 'new pointed question' },
      outputTranscription: { text: 'old answer' },
    },
  });
  assert.equal(h.c.turn, turn);
  assert.equal(pointer.activeSnapshot().entity.id, '600');
  assert.equal(h.captures[0].played.length, 1);
  assert.equal(
    h.events.some((event) => event.type === 'completion'),
    false,
  );
  assert.equal(
    h.events.some(
      (event) => event.role === 'user' && event.text === 'new pointed question',
    ),
    true,
  );
  ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
  ws.message({
    serverContent: { ...replyAudio('successor'), turnComplete: true },
  });
  assert.equal(h.captures[0].played.at(-1).data, 'successor');
  h.c.stop();
  pointer.destroy();
});

for (const route of ['push-to-talk', 'user-text']) {
  test(`B48 queue: rapid ${route} keeps only the latest pointer/input and serializes reply boundaries`, async () => {
    const { pointer } = pointerHarness();
    const h = harness({ pointer });
    await h.c.start({ pushToTalk: true });
    const ws = h.sockets[0];
    const audio = h.captures[0];
    ws.message({ serverContent: replyAudio('old') });
    const submit = (x) => {
      pointer.moveTo(x, 200);
      if (route === 'user-text') return h.c.sendTextCommand(`request ${x}`);
      h.c.input.holdPointer();
      h.c.input.bargeIn();
      h.c.input.beginPointerTurn('keydown');
      h.c.input.setMicrophoneEnabled(true);
      audio.callbacks.onAudio(
        {
          data: String(x),
          mimeType: 'audio/pcm;rate=16000',
        },
        audio.metadata,
      );
      h.c.input.releasePointerHold();
      h.c.input.setMicrophoneEnabled(false);
    };
    submit(300); // This start/command must reach the provider to cause interruption.
    const sentFirst = ws.sent.length;
    submit(500);
    submit(700); // Newer intent replaces the still-unsent second turn.
    assert.equal(
      ws.sent.length,
      sentFirst,
      'later input waits without opening another server generation',
    );
    assert.equal(pointer.activeSnapshot().entity.id, '700');
    const latestTurn = h.c.turn;
    ws.message({ serverContent: { interrupted: true, turnComplete: true } });
    const flushed = ws.sent.slice(sentFirst);
    if (route === 'user-text') {
      assert.equal(flushed.length, 1);
      assert.equal(
        flushed[0].clientContent.turns[0].parts.at(-1).text,
        'request 700',
      );
    } else {
      assert.deepEqual(
        flushed.map((value) =>
          value.clientContent ? ['context'] : Object.keys(value.realtimeInput),
        ),
        [['context'], ['activityStart'], ['audio'], ['activityEnd']],
      );
      assert.equal(
        JSON.parse(flushed[0].clientContent.turns[0].parts[0].text).target
          .label,
        'Aircraft 700',
      );
      assert.equal(flushed[0].clientContent.turnComplete, false);
      assert.equal(flushed[2].realtimeInput.audio.data, '700');
    }
    ws.message({
      serverContent: {
        ...replyAudio('first-successor-retired'),
        outputTranscription: { text: 'stale second answer' },
      },
    });
    ws.message({
      toolCall: {
        functionCalls: [
          {
            id: 'queued-old-call',
            name: 'fly_to_location',
            args: { query: 'stale' },
          },
        ],
      },
    });
    assert.equal(audio.played.length, 1);
    ws.message({ serverContent: { interrupted: true, turnComplete: true } });
    assert.equal(h.c.turn, latestTurn);
    ws.message({
      serverContent: { inputTranscription: { text: 'what is this' } },
    });
    ws.message({
      toolCall: {
        functionCalls: [
          {
            id: 'latest-call',
            name: 'get_entity_context',
            args: { scope: 'pointer' },
          },
        ],
      },
    });
    if (route === 'push-to-talk') {
      await tick();
      h.advance(5_000);
    }
    await h.c.toolQueue;
    assert.equal(h.calls.length, 1);
    assert.equal(pointer.activeSnapshot().entity.id, '700');
    ws.message({
      serverContent: { ...replyAudio('latest'), turnComplete: true },
    });
    assert.equal(audio.played.at(-1).data, 'latest');
    h.c.stop();
    pointer.destroy();
  });
}

test('B48 queue: wait timeout fails closed and Stop releases queued input without replay', async () => {
  for (const exit of ['timeout', 'stop']) {
    const h = harness({ inputBoundaryTimeoutMs: 10 });
    await h.c.start();
    const ws = h.sockets[0];
    ws.message({ serverContent: replyAudio('old') });
    h.c.sendTextCommand('sent successor');
    h.c.sendTextCommand('queued latest');
    const sent = ws.sent.length;
    if (exit === 'stop') h.c.stop();
    else h.advance(25);
    assert.equal(ws.closed, true);
    assert.equal(h.tracks[0].readyState, 'ended');
    assert.equal(h.c.status, exit === 'stop' ? 'idle' : 'error');
    assert.equal(h.c.deferredInput, null);
    ws.message({ serverContent: { interrupted: true, turnComplete: true } });
    assert.equal(
      ws.sent.length,
      sent,
      'released queue cannot replay on a late boundary',
    );
    h.c.stop();
  }
});

test('B48 queue: 256 KiB input bound fails closed without flushing partial queued speech', async () => {
  const h = harness();
  await h.c.start({ pushToTalk: true });
  const ws = h.sockets[0];
  ws.message({ serverContent: replyAudio('old') });
  h.c.input.bargeIn();
  h.c.input.setMicrophoneEnabled(true);
  h.captures[0].callbacks.onAudio(
    {
      data: 'first',
      mimeType: 'audio/pcm;rate=16000',
    },
    h.captures[0].metadata,
  );
  h.c.input.setMicrophoneEnabled(false);
  h.c.input.bargeIn();
  h.c.input.setMicrophoneEnabled(true);
  const sent = ws.sent.length;
  h.captures[0].callbacks.onAudio(
    {
      data: 'A'.repeat(256 * 1024),
      mimeType: 'audio/pcm;rate=16000',
    },
    h.captures[0].metadata,
  );
  assert.equal(h.c.status, 'error');
  assert.equal(h.tracks[0].readyState, 'ended');
  assert.equal(ws.closed, true);
  assert.equal(h.c.deferredInput, null);
  assert.equal(ws.sent.length, sent);
  h.c.stop();
});

test('B48 fence: duplicate automatic activity end cannot retire an idle next command', async () => {
  const h = harness();
  await h.c.start();
  const ws = h.sockets[0];
  ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
  ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
  ws.message({
    serverContent: { ...replyAudio('finished'), turnComplete: true },
  });
  h.captures[0].drain();
  ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
  h.c.sendTextCommand('new idle turn');
  ws.message({
    serverContent: { ...replyAudio('new idle answer'), turnComplete: true },
  });
  assert.equal(h.captures[0].played.at(-1).data, 'new idle answer');
  h.c.stop();
});

test('B48 queue: a boundary before deferred PTT worklet start still fences the submitted successor', async () => {
  const h = harness();
  await h.c.start({ pushToTalk: true });
  const ws = h.sockets[0];
  ws.message({ serverContent: replyAudio('old') });
  h.c.sendTextCommand('first successor');
  h.c.input.bargeIn(); // Audio-start callback is deliberately delayed.
  ws.message({ serverContent: { interrupted: true, turnComplete: true } });
  ws.message({ serverContent: replyAudio('first-successor-stale') });
  assert.equal(h.captures[0].played.length, 1);
  h.c.input.setMicrophoneEnabled(true);
  h.captures[0].callbacks.onAudio(
    {
      data: 'latest',
      mimeType: 'audio/pcm;rate=16000',
    },
    h.captures[0].metadata,
  );
  h.c.input.setMicrophoneEnabled(false);
  ws.message({ serverContent: { interrupted: true, turnComplete: true } });
  ws.message({
    serverContent: { ...replyAudio('latest'), turnComplete: true },
  });
  assert.equal(h.captures[0].played.at(-1).data, 'latest');
  h.c.stop();
});

for (const latest of ['push-to-talk', 'user-text']) {
  test(`B48 queue: ${latest} can replace the other unsent input mode without stale pointer context`, async () => {
    const { pointer, advance } = pointerHarness();
    const h = harness({ pointer });
    await h.c.start({ pushToTalk: true });
    const ws = h.sockets[0];
    const audio = h.captures[0];
    ws.message({ serverContent: replyAudio('old') });
    pointer.moveTo(300, 200);
    h.c.sendTextCommand('first successor');
    const speak = (x) => {
      pointer.moveTo(x, 200);
      h.c.input.holdPointer();
      h.c.input.bargeIn();
      h.c.input.beginPointerTurn('keydown');
      h.c.input.setMicrophoneEnabled(true);
      audio.callbacks.onAudio(
        {
          data: String(x),
          mimeType: 'audio/pcm;rate=16000',
        },
        audio.metadata,
      );
      h.c.input.releasePointerHold();
      h.c.input.setMicrophoneEnabled(false);
    };
    if (latest === 'push-to-talk') {
      pointer.moveTo(500, 200);
      h.c.sendTextCommand('discard queued text');
      speak(700);
    } else {
      speak(500);
      advance(5001);
      h.c.sendTextCommand('latest text without pointer');
    }
    const sent = ws.sent.length;
    ws.message({ serverContent: { turnComplete: true } }); // Natural completion races the claim.
    const frames = ws.sent.slice(sent);
    if (latest === 'push-to-talk') {
      assert.equal(
        frames.some((message) => message.clientContent?.turnComplete === true),
        false,
      );
      assert.equal(frames[0].clientContent.turnComplete, false);
      assert.deepEqual(frames[1], { realtimeInput: { activityStart: {} } });
      assert.equal(
        JSON.parse(frames[0].clientContent.turns[0].parts[0].text).target.label,
        'Aircraft 700',
      );
    } else {
      assert.equal(frames.length, 1);
      assert.deepEqual(
        JSON.parse(frames[0].clientContent.turns[0].parts[0].text),
        { type: 'pointer_context', at: 'text', target: 'none' },
      );
      assert.equal(pointer.activeSnapshot(), null);
    }
    ws.message({ serverContent: { interrupted: true, turnComplete: true } });
    ws.message({
      serverContent: { ...replyAudio('latest'), turnComplete: true },
    });
    assert.equal(audio.played.at(-1).data, 'latest');
    h.c.stop();
    pointer.destroy();
  });
}

test('R51: typed override closes forwarded PTT before its queued text and suppresses the old flush', async () => {
  const h = harness();
  await h.c.start({ pushToTalk: true });
  const ws = h.sockets[0];
  const audio = h.captures[0];
  ws.message({ serverContent: replyAudio('retired A') });
  h.c.input.bargeIn();
  h.c.input.setMicrophoneEnabled(true);
  audio.callbacks.onAudio(
    {
      data: 'spoken B',
      mimeType: 'audio/pcm;rate=16000',
    },
    audio.metadata,
  );
  const before = ws.sent.length;
  h.c.sendTextCommand('latest typed C');
  assert.equal(
    ws.sent.at(-1).realtimeInput?.activityEnd !== undefined,
    true,
    'the forwarded speech must end when typed intent supersedes it',
  );
  assert.equal(ws.sent.length, before + 1);
  audio.callbacks.onAudio(
    {
      data: 'retired buffered B',
      mimeType: 'audio/pcm;rate=16000',
    },
    audio.metadata,
  );
  h.c.input.setMicrophoneEnabled(false);
  assert.equal(
    ws.sent.length,
    before + 1,
    'late old PCM/end cannot extend or duplicate closed activity',
  );
  ws.message({ serverContent: { interrupted: true, turnComplete: true } });
  const flushed = ws.sent.slice(before);
  assert.equal(flushed.length, 2);
  assert.equal(flushed[0].realtimeInput?.activityEnd !== undefined, true);
  assert.equal(
    flushed[1].clientContent.turns[0].parts.at(-1).text,
    'latest typed C',
  );
  h.c.stop();
});

test('R51: a delayed old worklet start cannot reclaim a typed turn; a fresh hold still works', async () => {
  const h = harness();
  await h.c.start({ pushToTalk: true });
  const ws = h.sockets[0];
  const audio = h.captures[0];
  h.c.sendTextCommand('current text');
  const before = ws.sent.length;
  // This is the prior gesture's callback, delayed until after typed intent.
  audio.callbacks.onAudioStart(audio.metadata);
  audio.callbacks.onAudio(
    {
      data: 'old gesture',
      mimeType: 'audio/pcm;rate=16000',
    },
    audio.metadata,
  );
  audio.callbacks.onAudioEnd(audio.metadata);
  assert.equal(ws.sent.length, before);
  ws.message({
    serverContent: { ...replyAudio('text completed'), turnComplete: true },
  });
  audio.drain();
  h.c.input.bargeIn();
  h.c.input.setMicrophoneEnabled(true);
  audio.callbacks.onAudio(
    {
      data: 'fresh hold',
      mimeType: 'audio/pcm;rate=16000',
    },
    audio.metadata,
  );
  h.c.input.setMicrophoneEnabled(false);
  const frames = ws.sent.slice(before);
  assert.equal(frames[0].realtimeInput.activityStart !== undefined, true);
  assert.equal(frames[1].realtimeInput.audio.data, 'fresh hold');
  assert.equal(frames[2].realtimeInput.activityEnd !== undefined, true);
  h.c.stop();
});

test('R51: replaced unsent PTT contributes no unmatched end to the forwarded stream', async () => {
  const h = harness();
  await h.c.start({ pushToTalk: true });
  const ws = h.sockets[0];
  const audio = h.captures[0];
  ws.message({ serverContent: replyAudio('retired A') });
  h.c.sendTextCommand('submitted B');
  h.c.input.bargeIn();
  h.c.input.setMicrophoneEnabled(true);
  audio.callbacks.onAudio(
    {
      data: 'unsent C',
      mimeType: 'audio/pcm;rate=16000',
    },
    audio.metadata,
  );
  h.c.sendTextCommand('newest typed D');
  const before = ws.sent.length;
  h.c.input.setMicrophoneEnabled(false);
  assert.equal(ws.sent.length, before);
  ws.message({ serverContent: { interrupted: true, turnComplete: true } });
  const flushed = ws.sent.slice(before);
  assert.equal(flushed.length, 1);
  assert.equal(
    flushed[0].clientContent.turns[0].parts.at(-1).text,
    'newest typed D',
  );
  h.c.stop();
});

test('R51-2: FIFO old capture messages stay retired after typed replacement and a fresh claim', async () => {
  const { pointer } = pointerHarness();
  const h = harness({ pointer });
  await h.c.start({ pushToTalk: true });
  const ws = h.sockets[0];
  const audio = h.captures[0];
  // Delay only the worklet message port; gate/gesture callbacks still run now.
  const port = [];
  const callbacks = audio.callbacks;
  const enable = audio.setMicrophoneEnabled.bind(audio);
  audio.setMicrophoneEnabled = (value, metadata) => {
    if (value && !audio.enabled)
      port.push(() => callbacks.onAudioStart(metadata));
    if (!value && audio.enabled) {
      const ending = audio.metadata;
      port.push(() => callbacks.onAudioEnd(ending));
    }
    audio.enabled = value;
    if (value) audio.metadata = metadata;
  };
  ws.message({ serverContent: replyAudio('outstanding A') });
  const claim = (x) => {
    pointer.moveTo(x, 200);
    h.c.input.holdPointer();
    h.c.input.bargeIn();
    h.c.input.beginPointerTurn('keydown');
    h.c.input.setMicrophoneEnabled(true);
    return audio.metadata;
  };
  const b = claim(300);
  port.push(() =>
    callbacks.onAudio(
      { data: 'retired B', mimeType: 'audio/pcm;rate=16000' },
      b,
    ),
  );
  h.c.sendTextCommand('typed C');
  h.c.input.releasePointerHold();
  h.c.input.setMicrophoneEnabled(false);
  const d = claim(700);
  port.push(() =>
    callbacks.onAudio(
      { data: 'current D', mimeType: 'audio/pcm;rate=16000' },
      d,
    ),
  );
  h.c.input.releasePointerHold();
  h.c.input.setMicrophoneEnabled(false);
  const before = ws.sent.length;
  // Allowed port FIFO: start B / PCM B / end B / start D / PCM D / end D.
  for (const deliver of port) deliver();
  assert.equal(ws.sent.length, before);
  const queued = h.c.deferredInput.messages;
  assert.deepEqual(
    queued.map((message) =>
      message.clientContent
        ? 'context'
        : message.realtimeInput.audio?.data ||
          (message.realtimeInput.activityStart ? 'start' : 'end'),
    ),
    ['context', 'start', 'current D', 'end'],
  );
  assert.equal(
    JSON.parse(queued[0].clientContent.turns[0].parts[0].text).target.label,
    'Aircraft 700',
  );
  ws.message({ serverContent: { interrupted: true, turnComplete: true } });
  assert.deepEqual(ws.sent.slice(before), queued);
  assert.equal(JSON.stringify(ws.sent).includes('captureId'), false);
  audio.setMicrophoneEnabled = enable;
  h.c.stop();
});

test('R51-2: a normal release keeps its delayed final PCM and end, without relabelling duplicate gates or tool aborts', async () => {
  const h = harness();
  h.c.input.pushToTalkKeyHeld = true;
  await h.c.start({ pushToTalk: true });
  const audio = h.captures[0];
  const metadata = audio.metadata;
  const ws = h.sockets[0];
  h.c.input.setMicrophoneEnabled(true);
  assert.equal(audio.metadata.captureId, metadata.captureId);
  h.c.abortTools(); // Radio cleanup is not a new physical capture.
  const end = audio.callbacks.onAudioEnd;
  let released;
  audio.callbacks.onAudioEnd = (identity) => {
    released = identity;
  };
  h.c.input.setMicrophoneEnabled(false);
  assert.equal(released.captureId, metadata.captureId);
  const before = ws.sent.length;
  audio.callbacks.onAudio(
    { data: 'released tail', mimeType: 'audio/pcm;rate=16000' },
    metadata,
  );
  end(released);
  assert.deepEqual(ws.sent.slice(before), [
    {
      realtimeInput: {
        audio: { data: 'released tail', mimeType: 'audio/pcm;rate=16000' },
      },
    },
    { realtimeInput: { activityEnd: {} } },
  ]);
  audio.callbacks.onAudioEnd = end;
  h.c.stop();
});

test('R51-2: a forwarded old capture closes once before fresh FIFO start and cannot close the new activity', async () => {
  const h = harness();
  await h.c.start({ pushToTalk: true });
  const audio = h.captures[0];
  const ws = h.sockets[0];
  h.c.input.bargeIn();
  h.c.input.setMicrophoneEnabled(true);
  const b = audio.metadata;
  audio.callbacks.onAudio(
    { data: 'forwarded B', mimeType: 'audio/pcm;rate=16000' },
    b,
  );
  const start = audio.callbacks.onAudioStart;
  const end = audio.callbacks.onAudioEnd;
  const port = [];
  audio.callbacks.onAudioStart = (identity) => port.push(() => start(identity));
  audio.callbacks.onAudioEnd = (identity) => port.push(() => end(identity));
  h.c.input.setMicrophoneEnabled(false);
  h.c.input.bargeIn();
  h.c.input.setMicrophoneEnabled(true);
  const d = audio.metadata;
  const before = ws.sent.length;
  for (const deliver of port) deliver(); // end B, start D in port FIFO.
  assert.deepEqual(ws.sent.slice(before), [
    { realtimeInput: { activityEnd: {} } },
    { realtimeInput: { activityStart: {} } },
  ]);
  assert.equal(h.c.forwardedCaptureId, d.captureId);
  end(b); // A duplicate old end cannot close D.
  assert.equal(ws.sent.length, before + 2);
  assert.equal(h.c.forwardedActivityOpen, true);
  audio.callbacks.onAudio(
    { data: 'current D', mimeType: 'audio/pcm;rate=16000' },
    d,
  );
  audio.callbacks.onAudioStart = start;
  audio.callbacks.onAudioEnd = end;
  h.c.input.setMicrophoneEnabled(false);
  assert.equal(ws.sent.at(-1).realtimeInput.activityEnd !== undefined, true);
  assert.equal(h.c.forwardedActivityOpen, false);
  h.c.stop();
});

test('R51-2: absent metadata fails closed and Stop/error restart never reuse capture identity', async () => {
  const h = harness();
  let previous = 0;
  let old;
  let oldMetadata;
  for (const terminate of ['stop', 'error', 'stop']) {
    h.c.input.pushToTalkKeyHeld = true;
    await h.c.start({ pushToTalk: true });
    const audio = h.captures.at(-1);
    const ws = h.sockets.at(-1);
    assert.ok(audio.metadata.captureId > previous);
    previous = audio.metadata.captureId;
    const before = ws.sent.length;
    for (const captureId of [undefined, null, 0, -1, 1.5, '1', Infinity]) {
      const metadata = captureId === undefined ? undefined : { captureId };
      audio.callbacks.onAudioStart(metadata);
      audio.callbacks.onAudio(
        { data: 'must reject', mimeType: 'audio/pcm;rate=16000' },
        metadata,
      );
      audio.callbacks.onAudioEnd(metadata);
    }
    if (old) {
      old.onAudioStart(oldMetadata);
      old.onAudio(
        { data: 'old epoch', mimeType: 'audio/pcm;rate=16000' },
        oldMetadata,
      );
      old.onAudioEnd(oldMetadata);
    }
    assert.equal(ws.sent.length, before);
    assert.equal(h.c.forwardedActivityOpen, true);
    old = audio.callbacks;
    oldMetadata = audio.metadata;
    if (terminate === 'error') h.c.fail(new Error('capture failed'));
    else h.c.stop();
    assert.equal(h.c.captureOwner, null);
    assert.equal(h.c.captureEnabled, false);
    assert.equal(h.c.forwardedCaptureId, null);
  }
});

for (const queued of ['empty', 'text']) {
  test(`R52: ${queued} flush keeps the original retirement wait bound`, async () => {
    const h = harness({ inputBoundaryTimeoutMs: 40 });
    await h.c.start({ pushToTalk: true });
    const ws = h.sockets[0];
    ws.message({ serverContent: replyAudio('old') });
    h.c.sendTextCommand('first submitted successor');
    if (queued === 'empty') h.c.input.bargeIn();
    else h.c.sendTextCommand('newest queued text');
    // A physical empty hold no longer submits/retires a successor. The first
    // submitted text still owns the reply when the old native boundary arrives.
    if (queued === 'empty') {
      assert.equal(h.c.deferredInput, null);
      ws.message({ serverContent: { interrupted: true, turnComplete: true } });
      assert.equal(h.c.retiredReplyPending, false);
      assert.equal(h.c.replyPending, true);
      h.advance(60);
      assert.equal(h.c.status, 'listening');
      assert.equal(ws.closed, undefined);
      h.c.stop();
      return;
    }
    const deadline = h.c.deferredInput.deadline;
    ws.message({ serverContent: { interrupted: true, turnComplete: true } });
    assert.equal(h.c.deferredInput, null);
    assert.equal(h.c.retiredReplyPending, true);
    h.advance(deadline + 20);
    assert.equal(
      h.c.status,
      'error',
      'missing genuine boundary cannot leave voice waiting indefinitely',
    );
    assert.equal(ws.closed, true);
    assert.equal(h.tracks[0].readyState, 'ended');
    h.c.stop();
  });
}

test('R52: replacement cannot extend a flushed retirement deadline and Stop cancels it', async () => {
  for (const exit of ['timeout', 'stop', 'boundary']) {
    const h = harness({ inputBoundaryTimeoutMs: 60 });
    await h.c.start();
    const ws = h.sockets[0];
    ws.message({ serverContent: replyAudio('old') });
    h.c.sendTextCommand('first successor');
    h.c.sendTextCommand('queued successor');
    const deadline = h.c.deferredInput.deadline;
    ws.message({ serverContent: { interrupted: true, turnComplete: true } });
    h.advance(15);
    h.c.sendTextCommand('replacement while successor retired');
    assert.equal(h.c.deferredInput.deadline, deadline);
    if (exit === 'stop') h.c.stop();
    if (exit === 'boundary') {
      ws.message({ serverContent: { interrupted: true, turnComplete: true } });
      ws.message({ serverContent: { interrupted: true, turnComplete: true } });
      ws.message({
        serverContent: { ...replyAudio('latest'), turnComplete: true },
      });
      h.captures[0].drain();
    }
    h.advance(deadline + 20);
    assert.equal(
      h.c.status,
      exit === 'timeout' ? 'error' : exit === 'stop' ? 'idle' : 'listening',
    );
    assert.equal(Boolean(ws.closed), exit !== 'boundary');
    h.c.stop();
  }
});

test('PTT pointer context is quiet, ordered once, and only PCM creates a pending reply', async () => {
  const { pointer } = pointerHarness();
  const h = harness({ pointer });
  pointer.moveTo(300, 200);
  h.c.input.holdPointer();
  h.c.input.pushToTalkKeyHeld = true;
  h.c.input.spaceKeyHeld = true;
  await h.c.start({ pushToTalk: true });
  const ws = h.sockets[0],
    audio = h.captures[0];
  const [context, start] = ws.sent.slice(1);
  assert.deepEqual(Object.keys(context), ['clientContent']);
  assert.equal(context.clientContent.turnComplete, false);
  assert.equal(context.clientContent.turns.length, 1);
  assert.equal(context.clientContent.turns[0].role, 'user');
  assert.equal(
    JSON.parse(context.clientContent.turns[0].parts[0].text).target.label,
    'Aircraft 300',
  );
  assert.deepEqual(start, { realtimeInput: { activityStart: {} } });
  assert.equal(h.c.replyPending, false);
  assert.equal(audio.played.length, 0);
  assert.equal(h.calls.length, 0);
  audio.callbacks.onAudioStart(audio.metadata);
  assert.equal(
    ws.sent.length,
    3,
    'duplicate start does not resend quiet context',
  );
  audio.callbacks.onAudio(
    { data: 'AAABAA==', mimeType: 'audio/pcm;rate=16000' },
    audio.metadata,
  );
  assert.equal(h.c.replyPending, true);
  assert.equal(
    ws.sent.some((message) => message.realtimeInput?.text),
    false,
  );
  h.c.stop();
  pointer.destroy();
});

test('PTT pointer context rejected by the channel fails closed without opening activity', async () => {
  const { pointer } = pointerHarness();
  const h = harness({ pointer });
  await h.c.start({ pushToTalk: true });
  pointer.moveTo(300, 200);
  h.c.input.holdPointer();
  const ws = h.sockets[0],
    before = ws.sent.length;
  h.c.channel.readyState = 'connecting';
  // The adapter emits one admitted start, not a retryable channel-open event.
  h.c.input.setMicrophoneEnabled(true);
  assert.equal(ws.sent.length, before);
  assert.equal(h.c.forwardedActivityOpen, false);
  assert.equal(h.c.pointerSentKey, null);
  assert.equal(h.c.captureOwner, null);
  assert.equal(h.c.userTurnPending, false);
  assert.equal(h.c.status, 'error');
  assert.equal(ws.closed, true);
  assert.equal(h.tracks[0].readyState, 'ended');
  h.c.stop();
  pointer.destroy();
});

test('quiet pointer context rejects stale or absent capture metadata without touching the new pointer', async () => {
  const { pointer } = pointerHarness();
  const h = harness({ pointer });
  await h.c.start({ pushToTalk: true });
  pointer.moveTo(300, 200);
  h.c.input.holdPointer();
  h.c.input.setMicrophoneEnabled(true);
  const old = h.captures[0].metadata,
    context = h.c.captureOwner.context;
  h.c.input.setMicrophoneEnabled(false);
  pointer.moveTo(700, 200);
  h.c.input.holdPointer();
  h.c.input.setMicrophoneEnabled(true);
  const before = h.sockets[0].sent.length,
    key = h.c.pointerSentKey;
  assert.equal(h.c.sendPointerContext(context, old), false);
  assert.equal(h.c.sendPointerContext(context), false);
  assert.equal(h.c.sendPointerContext(context, { captureId: 0 }), false);
  assert.equal(h.sockets[0].sent.length, before);
  assert.equal(h.c.pointerSentKey, key);
  assert.equal(pointer.activeSnapshot().entity.id, '700');
  h.c.stop();
  pointer.destroy();
});

test('replacing a deferred quiet PTT context preserves its deadline and only flushes the latest owner', async () => {
  const { pointer } = pointerHarness();
  const h = harness({ pointer });
  await h.c.start({ pushToTalk: true });
  const ws = h.sockets[0],
    audio = h.captures[0];
  ws.message({ serverContent: replyAudio('old A') });
  const claim = (x, pcm) => {
    pointer.moveTo(x, 200);
    h.c.input.holdPointer();
    h.c.input.bargeIn();
    h.c.input.beginPointerTurn('keydown');
    h.c.input.setMicrophoneEnabled(true);
    if (pcm)
      audio.callbacks.onAudio(
        { data: pcm, mimeType: 'audio/pcm;rate=16000' },
        audio.metadata,
      );
    h.c.input.releasePointerHold();
    h.c.input.setMicrophoneEnabled(false);
  };
  claim(300, 'submitted B');
  claim(500);
  const deadline = h.c.deferredInput.deadline;
  const sent = ws.sent.length;
  claim(700);
  assert.equal(h.c.deferredInput.deadline, deadline);
  assert.equal(h.c.deferredInput.kind, 'push-to-talk');
  assert.equal(h.c.deferredInput.captureId, h.c.captureOwner.captureId);
  assert.equal(h.c.deferredInput.messages.length, 3);
  assert.equal(
    JSON.parse(
      h.c.deferredInput.messages[0].clientContent.turns[0].parts[0].text,
    ).target.label,
    'Aircraft 700',
  );
  assert.equal(
    JSON.stringify(h.c.deferredInput.messages).includes('Aircraft 500'),
    false,
  );
  assert.equal(ws.sent.length, sent);
  // The genuine retired boundary may coalesce content; it must discard it
  // while releasing only the latest quiet context and its activity markers.
  ws.message({
    serverContent: {
      ...replyAudio('retired coalesced A'),
      interrupted: true,
      turnComplete: true,
    },
  });
  const flushed = ws.sent.slice(sent);
  assert.equal(flushed.length, 3);
  assert.equal(flushed[0].clientContent.turnComplete, false);
  assert.deepEqual(flushed[1], { realtimeInput: { activityStart: {} } });
  assert.deepEqual(flushed[2], { realtimeInput: { activityEnd: {} } });
  assert.equal(audio.played.at(-1).data, 'old A');
  assert.equal(
    h.c.replyPending,
    false,
    'flushed context without PCM asks for no reply',
  );
  assert.equal(h.c.retiredBoundaryWait.deadline, deadline);
  assert.equal(h.c.retiredReplyPending, true);
  assert.equal(h.c.pointerSentKey, h.c.captureOwner.context.key);
  h.c.stop();
  pointer.destroy();
});

test('projected PCM bytes and optional viewport frames drop while reliable tool results wait', async () => {
  const h = harness({
    captureViewport: async () => 'data:image/jpeg;base64,aW1hZ2U=',
  });
  await h.c.start();
  establishToolInput(h);
  const ws = h.sockets[0],
    audio = h.captures[0],
    before = ws.sent.length;
  ws.bufferedAmount = 262140;
  audio.callbacks.onAudio(
    { data: 'AA==', mimeType: 'audio/pcm;rate=16000' },
    audio.metadata,
  );
  ws.message({
    toolCall: {
      functionCalls: [
        { id: 'image-pressure', name: 'get_entity_context', args: {} },
      ],
    },
  });
  h.c.runAction = async () => ({
    ok: true,
    action: 'get_entity_context',
    scene: { basemap: { viewScale: 'local' } },
  });
  await h.c.toolQueue;
  assert.equal(h.c.status, 'listening');
  assert.equal(h.c.getDiagnostics().droppedAudioChunks, 1);
  assert.equal(h.c.getDiagnostics().droppedImages, 1);
  assert.equal(ws.sent.length, before);
  assert.equal(h.c.controlQueue.length, 1);
  ws.bufferedAmount = 0;
  h.advance(25);
  assert.equal(
    ws.sent.at(-1).toolResponse.functionResponses[0].id,
    'image-pressure',
  );
  assert.match(
    ws.sent.at(-1).toolResponse.functionResponses[0].response.responseGuidance,
    /briefly|request|read|view/i,
  );
  assert.equal(h.c.controlQueue.length, 0);
  h.c.stop();
});

test('congested PTT markers remain ordered and forwarding flags commit only at wire delivery', async () => {
  const h = harness();
  await h.c.start({ pushToTalk: true });
  const ws = h.sockets[0],
    audio = h.captures[0],
    before = ws.sent.length;
  ws.bufferedAmount = 300000;
  h.c.input.setMicrophoneEnabled(true);
  const capture = audio.metadata;
  audio.callbacks.onAudio(
    { data: 'discarded PCM', mimeType: 'audio/pcm;rate=16000' },
    capture,
  );
  h.c.input.setMicrophoneEnabled(false);
  assert.equal(h.c.forwardedActivityOpen, false);
  assert.equal(h.c.controlQueue.length, 2);
  assert.equal(ws.sent.length, before);
  assert.equal(h.c.replyPending, false);
  ws.bufferedAmount = 0;
  h.advance(25);
  assert.deepEqual(ws.sent.slice(before), [
    { realtimeInput: { activityStart: {} } },
    { realtimeInput: { activityEnd: {} } },
  ]);
  assert.equal(h.c.forwardedActivityOpen, false);
  h.c.stop();
});

test('saturation then typed override and a fresh hold cannot flush retired pointer or capture markers', async () => {
  const { pointer } = pointerHarness();
  const h = harness({ pointer });
  await h.c.start({ pushToTalk: true });
  const ws = h.sockets[0],
    audio = h.captures[0],
    before = ws.sent.length;
  ws.bufferedAmount = 300000;
  pointer.moveTo(300, 200);
  h.c.input.holdPointer();
  h.c.input.bargeIn();
  h.c.input.setMicrophoneEnabled(true);
  const old = audio.metadata;
  h.c.input.setMicrophoneEnabled(false);
  h.c.sendTextCommand('unsent typed override');
  assert.equal(
    h.c.replyPending,
    false,
    'queued text creates no phantom retired reply',
  );
  pointer.moveTo(700, 200);
  h.c.input.holdPointer();
  h.c.input.bargeIn();
  h.c.input.setMicrophoneEnabled(true);
  h.c.input.setMicrophoneEnabled(false);
  audio.callbacks.onAudioStart(old);
  audio.callbacks.onAudioEnd(old);
  assert.equal(
    h.c.pointerSentKey,
    null,
    'queued context is not consumed before wire delivery',
  );
  ws.bufferedAmount = 0;
  h.advance(25);
  const frames = ws.sent.slice(before);
  assert.equal(JSON.stringify(frames).includes('Aircraft 300'), false);
  assert.equal(JSON.stringify(frames).includes('unsent typed override'), false);
  assert.equal(
    JSON.parse(frames[0].clientContent.turns[0].parts[0].text).target.label,
    'Aircraft 700',
  );
  assert.deepEqual(frames.slice(1), [
    { realtimeInput: { activityStart: {} } },
    { realtimeInput: { activityEnd: {} } },
  ]);
  assert.equal(h.c.forwardedActivityOpen, false);
  h.c.stop();
  pointer.destroy();
});

for (const cancellation of ['new-turn', 'server-call']) {
  test(`a queued tool response is revoked by ${cancellation} before pressure clears`, async () => {
    const h = harness();
    await h.c.start();
    const ws = h.sockets[0],
      before = ws.sent.length;
    ws.bufferedAmount = 300000;
    ws.message({
      toolCall: {
        functionCalls: [
          { id: 'queued-old', name: 'get_current_view_state', args: {} },
        ],
      },
    });
    await h.c.toolQueue;
    assert.equal(h.c.controlQueue.length, 1);
    if (cancellation === 'new-turn') h.c.sendTextCommand('new owned input');
    else ws.message({ toolCallCancellation: { ids: ['queued-old'] } });
    ws.bufferedAmount = 0;
    h.advance(25);
    assert.equal(
      ws.sent.slice(before).some((frame) => frame.toolResponse),
      false,
    );
    h.c.stop();
  });
}

test('reliable pressure has an absolute deadline and Stop releases its poll without successor effects', async () => {
  for (const mode of ['deadline', 'stop']) {
    const h = harness();
    await h.c.start();
    const ws = h.sockets[0];
    ws.bufferedAmount = 300000;
    h.c.send({ realtimeInput: { text: 'reliable authored context' } });
    h.advance(4975);
    assert.equal(h.c.status, 'listening');
    if (mode === 'stop') {
      h.c.stop();
      await h.c.start();
    }
    h.advance(25);
    assert.equal(h.c.status, mode === 'deadline' ? 'error' : 'listening');
    assert.equal(h.c.controlQueue.length, 0);
    assert.equal(h.timers.size, 0);
    h.c.stop();
  }
});

test('reliable queue is byte and message bounded without partially sending oversized frames', async () => {
  for (const kind of ['bytes', 'messages']) {
    const h = harness();
    await h.c.start();
    const ws = h.sockets[0],
      before = ws.sent.length;
    ws.bufferedAmount = 300000;
    if (kind === 'bytes') {
      assert.throws(
        () => h.c.send({ realtimeInput: { text: 'x'.repeat(1024 * 1024) } }),
        /queue limit/,
      );
    } else {
      for (let i = 0; i < 64; i++)
        assert.equal(h.c.send({ realtimeInput: { text: String(i) } }), true);
      assert.throws(
        () => h.c.send({ realtimeInput: { text: 'overflow' } }),
        /queue limit/,
      );
    }
    assert.equal(ws.sent.length, before);
    h.c.stop();
    assert.equal(h.timers.size, 0);
  }
});

test('goAway permits the current tool/reply/audio drain and denies successor input', async () => {
  const tool = deferred();
  const h = harness({ runAction: () => tool.promise });
  await h.c.start();
  const ws = h.sockets[0],
    audio = h.captures[0];
  h.c.sendTextCommand('read the view');
  ws.message({
    toolCall: {
      functionCalls: [{ id: 'current', name: 'get_entity_context', args: {} }],
    },
  });
  await tick();
  ws.message({ goAway: { timeLeft: '5s' } });
  assert.equal(h.c.goAway.deadline, 5000);
  assert.equal(h.tracks[0].enabled, false);
  assert.equal(h.c.sendTextCommand('successor is disallowed'), false);
  assert.equal(h.c.bargeIn(), false);
  h.c.input.setMicrophoneEnabled(true);
  assert.equal(h.tracks[0].enabled, false);
  tool.resolve({ ok: true, action: 'get_entity_context' });
  await h.c.toolQueue;
  assert.equal(ws.sent.at(-1).toolResponse.functionResponses[0].id, 'current');
  ws.message({
    serverContent: {
      ...replyAudio('accepted reply'),
      outputTranscription: { text: 'Current result' },
      turnComplete: true,
    },
  });
  assert.equal(h.c.isActive(), true);
  assert.equal(audio.pending, true);
  audio.drain();
  assert.equal(h.c.status, 'error');
  assert.equal(ws.closed, true);
  assert.equal(h.timers.size, 0);
  assert.equal(
    h.events.findLast((event) => event.type === 'completion').audioDrained,
    true,
  );
  h.c.stop();
});

test('goAway chooses the earliest bounded deadline and Stop cancels it for a fresh epoch', async () => {
  const h = harness();
  await h.c.start();
  const ws = h.sockets[0];
  ws.message({ serverContent: replyAudio('playing') });
  ws.message({ goAway: { timeLeft: '1.250s' } });
  h.advance(250);
  ws.message({ goAway: { timeLeft: '500s' } });
  assert.equal(h.c.goAway.deadline, 1250);
  ws.message({ goAway: { timeLeft: '0.5s' } });
  assert.equal(h.c.goAway.deadline, 750);
  h.c.stop();
  await h.c.start();
  h.advance(1000);
  assert.equal(h.c.status, 'listening');
  assert.equal(h.sockets.length, 2);
  assert.equal(h.c.goAway, null);
  h.c.stop();
});

for (const duration of ['bad', '-1s', 'Infinitys', '10000000s', null]) {
  test(`malformed goAway timeLeft ${duration} closes safely without an unbounded timer`, async () => {
    const h = harness();
    await h.c.start();
    h.sockets[0].message({ serverContent: replyAudio('playing') });
    h.sockets[0].message({ goAway: { timeLeft: duration } });
    assert.equal(h.c.status, 'error');
    assert.equal(h.timers.size, 0);
  });
}

test('close diagnostics preserve bounded code/category but never provider reason or credential text', async () => {
  const h = harness();
  await h.c.start();
  h.sockets[0].onclose({
    code: 1008,
    reason: 'auth_tokens/private-secret user-private-text',
  });
  assert.deepEqual(h.c.getDiagnostics().close, {
    code: 1008,
    category: 'policy',
  });
  assert.doesNotMatch(
    JSON.stringify(h.c.getDiagnostics()),
    /private-secret|user-private-text/,
  );
  await h.c.start();
  h.sockets[1].onclose({ code: Infinity, reason: 'private' });
  assert.deepEqual(h.c.getDiagnostics().close, {
    code: null,
    category: 'connection',
  });
  h.c.stop();
});

test(
  'typed input grants an authentic correlated user turn and only audio drain completes spoken confirmation',
  {
    skip: 'replace-native: H05; equivalent native regression tests replace caption ownership assumptions',
  },
  async () => {
    const h = harness();
    await h.c.start();
    const ws = h.sockets[0],
      audio = h.captures[0];
    h.c.sendTextCommand('Show the current view');
    const response = h.events.findLast(
      (event) => event.type === 'response-start',
    );
    assert.equal(
      readVoiceUserTurnText(response.userTurn),
      'Show the current view',
    );
    ws.message({
      toolCall: {
        functionCalls: [
          {
            id: 'provider',
            name: 'get_current_view_state',
            args: {},
          },
        ],
      },
    });
    await h.c.toolQueue;
    assert.equal(h.calls[0].options.userTurn, response.userTurn);
    assert.equal(h.calls[0].options.responseId, response.responseId);
    ws.message({
      serverContent: {
        ...replyAudio('confirmation'),
        outputTranscription: { text: 'Here is the current view' },
        turnComplete: true,
      },
    });
    assert.equal(
      h.events.some((event) => event.type === 'completion'),
      false,
    );
    assert.equal(
      h.events.findLast((event) => event.role === 'assistant').responseId,
      response.responseId,
    );
    audio.drain();
    const completion = h.events.findLast(
      (event) => event.type === 'completion',
    );
    assert.equal(completion.responseId, response.responseId);
    assert.equal(completion.spoken, true);
    assert.equal(completion.audioDrained, true);
    assert.equal(readVoiceUserTurnText(response.userTurn), undefined);
    h.c.stop();
  },
);

test(
  'one native finalized speech segment authorizes its known current item',
  {
    skip: 'retired-by-decision: H06; captions no longer authorize or quarantine native calls (2026-10-15 contract)',
  },
  async () => {
    const h = harness();
    await h.c.start();
    const ws = h.sockets[0];
    ws.message({
      serverContent: {
        inputTranscription: { text: 'uncorrelated earlier speech' },
      },
    });
    ws.message({
      toolCall: {
        functionCalls: [
          { id: 'unowned', name: 'get_current_view_state', args: {} },
        ],
      },
    });
    await h.c.toolQueue;
    assert.deepEqual(h.calls, []);
    assert.equal(
      ws.sent.at(-1).toolResponse.functionResponses[0].response
        .voiceIntentUnverified,
      true,
    );
    ws.message({ serverContent: { turnComplete: true } });
    ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
    ws.message({
      serverContent: {
        interimInputTranscription: { text: 'partial untrusted' },
      },
    });
    ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
    ws.message({
      serverContent: { inputTranscription: { text: 'Show the current view' } },
    });
    const response = h.events.findLast(
      (event) => event.type === 'response-start',
    );
    assert.equal(
      readVoiceUserTurnText(response.userTurn),
      'Show the current view',
    );
    ws.message({
      toolCall: {
        functionCalls: [
          { id: 'authorized', name: 'get_current_view_state', args: {} },
        ],
      },
    });
    await h.c.toolQueue;
    assert.equal(h.calls.at(-1).options.userTurn, response.userTurn);
    h.c.stop();
    assert.equal(readVoiceUserTurnText(response.userTurn), undefined);
  },
);

test(
  'a Gemini speech tool waits for the correlated final transcript',
  {
    skip: 'retired-by-decision: H07; captions no longer authorize or quarantine native calls (2026-10-15 contract)',
  },
  async () => {
    const h = harness();
    await h.c.start();
    const ws = h.sockets[0];
    ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
    ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
    ws.message({
      toolCall: {
        functionCalls: [
          { id: 'deferred-provider', name: 'get_current_view_state', args: {} },
        ],
      },
    });
    await tick();
    assert.deepEqual(h.calls, []);
    ws.message({
      serverContent: {
        inputTranscription: { text: 'Show the current view' },
      },
    });
    await h.c.toolQueue;
    assert.equal(
      readVoiceUserTurnText(h.calls[0].options.userTurn),
      'Show the current view',
    );
    h.c.stop();
  },
);

test(
  'a newer Gemini turn cannot underflow a transcript-waiting tool count',
  {
    skip: 'replace-native: H08; equivalent native regression tests replace caption ownership assumptions',
  },
  async () => {
    const h = harness();
    await h.c.start();
    const ws = h.sockets[0];
    ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
    ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
    ws.message({
      toolCall: {
        functionCalls: [
          { id: 'retired-waiter', name: 'get_current_view_state', args: {} },
        ],
      },
    });
    await tick();
    const retiredTool = h.c.toolQueue;
    assert.equal(h.c.pendingTools, 1);

    ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
    assert.equal(h.c.pendingTools, 0);
    await retiredTool;
    assert.equal(h.c.pendingTools, 0);
    assert.deepEqual(h.calls, []);

    ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
    ws.message({ serverContent: { interrupted: true, turnComplete: true } });
    ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
    ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
    ws.message({
      serverContent: { inputTranscription: { text: 'what is in view' } },
    });
    ws.message({
      toolCall: {
        functionCalls: [
          { id: 'fresh-action', name: 'get_current_view_state', args: {} },
        ],
      },
    });
    await h.c.toolQueue;
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].name, 'get_current_view_state');
    assert.equal(h.c.pendingTools, 0);
    ws.message({
      serverContent: { ...replyAudio('fresh reply'), turnComplete: true },
    });
    h.captures[0].drain();
    assert.equal(
      h.events.findLast((event) => event.type === 'completion').status,
      'completed',
    );
    h.c.stop();
  },
);

test(
  'overlapping native speech with uncorrelated late transcripts cannot authorize a read tool',
  {
    skip: 'retired-by-decision: H09; captions no longer authorize or quarantine native calls (2026-10-15 contract)',
  },
  async () => {
    const h = harness();
    await h.c.start();
    const ws = h.sockets[0];
    ws.message({ serverContent: replyAudio('previous reply') });
    ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
    ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
    ws.message({
      serverContent: { inputTranscription: { text: 'switch to OpenAI' } },
    });
    ws.message({ serverContent: { interrupted: true, turnComplete: true } });
    ws.message({
      toolCall: {
        functionCalls: [
          {
            id: 'ambiguous-setting',
            name: 'get_current_view_state',
            args: { provider: 'openai' },
          },
        ],
      },
    });
    await tick();
    h.advance(5000);
    await h.c.toolQueue;
    assert.deepEqual(h.calls, []);
    assert.equal(
      ws.sent.some(
        (message) =>
          message.toolResponse?.functionResponses?.[0]?.response
            ?.voiceIntentUnverified === true,
      ),
      true,
    );
    h.c.stop();
  },
);

test('goAway never flushes an unsent successor at the retired response boundary', async () => {
  const h = harness();
  await h.c.start();
  const ws = h.sockets[0];
  ws.message({ serverContent: replyAudio('retired previous') });
  h.c.sendTextCommand('already forwarded successor');
  h.c.sendTextCommand('unsent newest successor');
  assert.ok(h.c.deferredInput);
  const before = ws.sent.length;
  ws.message({ goAway: { timeLeft: '5s' } });
  ws.message({ serverContent: { interrupted: true, turnComplete: true } });
  assert.equal(
    ws.sent.slice(before).some((message) => message.clientContent),
    false,
  );
  assert.equal(h.c.status, 'error');
  assert.equal(h.c.deferredInput, null);
  assert.equal(h.timers.size, 0);
  h.c.stop();
});

test('permission rejection opens no token/socket and initialized audio is released', async () => {
  const h = harness({
    getUserMedia: async () => {
      throw new DOMException('not allowed', 'NotAllowedError');
    },
  });
  await h.c.start();
  assert.equal(h.c.status, 'error');
  assert.equal(h.requests.length, 0);
  assert.equal(h.sockets.length, 0);
  assert.equal(h.captures[0].closed, true);
  assert.match(h.c.lastError, /permission was denied/);
});

test('consented microphone stays muted through the network phase and its deadline releases tracks', async () => {
  const pending = deferred();
  const h = harness({ startupTimeoutMs: 20, fetchImpl: () => pending.promise });
  const start = h.c.start();
  await tick();
  assert.equal(h.tracks[0].enabled, false);
  await Promise.all([start, new Promise((resolve) => setTimeout(resolve, 40))]);
  assert.equal(h.c.status, 'error');
  assert.equal(h.tracks[0].readyState, 'ended');
  assert.equal(h.captures[0].closed, true);
  pending.resolve({ ok: true, json: async () => credential });
  await tick();
  assert.equal(h.sockets.length, 0);
  h.c.stop();
});

test('valid huge goAway duration is clamped to a bounded timer', async () => {
  const h = harness();
  await h.c.start();
  h.sockets[0].message({ serverContent: replyAudio('playing') });
  h.sockets[0].message({ goAway: { timeLeft: '999999s' } });
  assert.equal(h.c.goAway.deadline, 600000);
  h.c.stop();
  assert.equal(h.timers.size, 0);
});

test(
  'held speech passes authentic first final input and invalidation revokes it',
  {
    skip: 'replace-native: H10; equivalent native regression tests replace caption ownership assumptions',
  },
  async () => {
    const h = harness();
    await h.c.start({ pushToTalk: true });
    const ws = h.sockets[0],
      audio = h.captures[0];
    h.c.input.bargeIn();
    h.c.input.setMicrophoneEnabled(true);
    audio.callbacks.onAudio(
      { data: 'AA==', mimeType: 'audio/pcm;rate=16000' },
      audio.metadata,
    );
    h.c.input.setMicrophoneEnabled(false);
    ws.message({
      serverContent: { inputTranscription: { text: 'Show the current view' } },
    });
    const response = h.events.findLast(
      (event) => event.type === 'response-start',
    );
    assert.equal(
      readVoiceUserTurnText(response.userTurn),
      'Show the current view',
    );
    ws.message({
      toolCall: {
        functionCalls: [
          {
            id: 'held-setting',
            name: 'get_current_view_state',
            args: {},
          },
        ],
      },
    });
    await h.c.toolQueue;
    assert.equal(h.calls[0].options.userTurn, response.userTurn);
    h.c.sendTextCommand('new intent');
    assert.equal(readVoiceUserTurnText(response.userTurn), undefined);
    h.c.stop();
  },
);

test('cancelling a pressure-queued response retains passive map context for the next owned text', async () => {
  const h = harness();
  await h.c.start();
  const ws = h.sockets[0];
  h.c.notifyMapEvent({ type: 'map_annotation_outline', label: 'Austin' });
  ws.bufferedAmount = 300000;
  ws.message({
    toolCall: {
      functionCalls: [
        { id: 'old-map-envelope', name: 'get_current_view_state', args: {} },
      ],
    },
  });
  await h.c.toolQueue;
  assert.equal(
    h.c.pendingMapEvents.length,
    1,
    'unsent data remains owned by the context queue',
  );
  ws.message({ toolCallCancellation: { ids: ['old-map-envelope'] } });
  h.c.sendTextCommand('use the map context');
  ws.bufferedAmount = 0;
  h.advance(25);
  const frame = ws.sent.at(-1);
  assert.equal(
    JSON.parse(frame.clientContent.turns[0].parts[0].text).events[0].label,
    'Austin',
  );
  assert.equal(h.c.pendingMapEvents.length, 0);
  h.c.stop();
});

test('an expired goAway deadline rejects late output before the timer callback can run', async () => {
  let now = 0;
  const h = harness({ now: () => now });
  await h.c.start();
  const ws = h.sockets[0];
  h.c.sendTextCommand('current request');
  ws.message({ serverContent: replyAudio('initial output') });
  ws.message({ goAway: { timeLeft: '1s' } });
  now = 1000;
  ws.message({
    serverContent: { ...replyAudio('too late'), turnComplete: true },
  });
  assert.equal(h.c.status, 'error');
  assert.equal(h.captures[0].played.length, 1);
  assert.equal(
    h.events.some((event) => event.type === 'completion'),
    false,
  );
  assert.equal(h.timers.size, 0);
});

for (const restart of [false, true]) {
  test(
    `a transcript-waiting tool cannot revive voice after Stop${restart ? '/restart' : ''}`,
    {
      skip: 'replace-native: H11, H12; equivalent native regression tests replace caption ownership assumptions',
    },
    async () => {
      const h = harness();
      await h.c.start();
      const ws = h.sockets[0];
      ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
      ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
      ws.message({
        toolCall: {
          functionCalls: [
            { id: 'stopped-waiter', name: 'get_current_view_state', args: {} },
          ],
        },
      });
      await tick();
      const pending = h.c.toolQueue;
      assert.equal(h.c.pendingTools, 1);
      h.c.stop();
      const boundary = h.events.length;
      const successor = restart ? h.c.start() : null;
      await pending;
      assert.equal(
        h.events
          .slice(boundary)
          .some(
            (event) => event.type === 'state' && event.state === 'listening',
          ),
        false,
      );
      assert.deepEqual(h.calls, []);
      assert.equal(h.c.pendingTools, 0);
      if (successor) await successor;
      h.c.stop();
    },
  );
}

// Sameh runtime regressions exercise the socket adapter and the production
// provider-intent guard before an action runner can mutate camera state.
function samehPolicyHarness(overrides = {}) {
  const mutations = [];
  const observed = [];
  const guarded = withToolCatalog(
    async (name, args, options) => {
      mutations.push({ name, args, options });
      return { ok: true, action: name };
    },
    async () => null,
  );
  const h = harness({
    ...overrides,
    runAction: async (name, args, options) => {
      observed.push({ name, args, options });
      return guarded(name, args, options);
    },
  });
  return { ...h, mutations, observed };
}

test(
  'punctuated finalized provider segments block actual synchronous app actions after the target arrives',
  {
    skip: 'retired-by-decision: H13; captions no longer authorize or quarantine native calls (2026-10-15 contract)',
  },
  async () => {
    const mutations = [];
    const viewer = {
      clock: { onTick: { addEventListener: () => () => {} } },
      camera: { moveEnd: { addEventListener() {} } },
      scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    };
    const runner = createGevActionRunner({
      viewer,
      styleManager: {
        setStyle: (...args) => mutations.push(['style', ...args]),
        setPanelCollapsed: (...args) => mutations.push(['panel', ...args]),
      },
    });
    const h = harness({ runAction: runner });
    try {
      await h.c.start();
      const ws = h.sockets[0];
      ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
      ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
      ws.message({
        serverContent: { inputTranscription: { text: 'Switch to.' } },
      });
      ws.message({
        serverContent: { inputTranscription: { text: 'Gemini.' } },
      });
      ws.message({
        toolCall: {
          functionCalls: [
            {
              id: 'punctuated-style',
              name: 'set_visual_style',
              args: { style: 'night vision' },
            },
            {
              id: 'punctuated-panel',
              name: 'set_panel_open',
              args: { panelId: 'radio-panel', open: true },
            },
          ],
        },
      });
      await tick();
      await h.c.toolQueue;
      assert.deepEqual(mutations, []);
      const outputs = ws.sent.flatMap(
        (frame) => frame.toolResponse?.functionResponses || [],
      );
      assert.equal(outputs.length, 2);
      assert.equal(
        outputs.every((call) => call.response.providerRequestBlocked === true),
        true,
      );
    } finally {
      h.c.stop();
      runner.dispose();
    }
    assert.equal(h.timers.size, 0);
  },
);

for (const boundary of ['interrupted', 'natural']) {
  test(
    `Sameh P0-1: spoken zoom after ${boundary} retired reply boundary executes promptly`,
    {
      skip: 'replace-native: H14, H15; equivalent native regression tests replace caption ownership assumptions',
    },
    async () => {
      const h = samehPolicyHarness();
      try {
        await h.c.start();
        const ws = h.sockets[0];
        ws.message({ serverContent: replyAudio('old reply') });
        ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
        ws.message({
          serverContent: {
            ...(boundary === 'interrupted' ? { interrupted: true } : {}),
            turnComplete: true,
          },
        });
        ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
        ws.message({
          serverContent: { inputTranscription: { text: 'zoom in' } },
        });
        requestTool(ws, 'current-zoom', 'adjust_camera_zoom', {
          direction: 'in',
        });
        await tick();
        assert.equal(
          h.mutations.length,
          1,
          'a current command must not await a missing transcript for five seconds',
        );
        assert.equal(
          readVoiceUserTurnText(h.observed[0].options.userTurn),
          'zoom in',
        );
        assert.equal(h.c.pendingTools, 0);
        assert.equal(
          ws.sent.some(
            (m) =>
              m.toolResponse?.functionResponses?.[0]?.response
                ?.voiceIntentUnverified,
          ),
          false,
        );
      } finally {
        h.c.stop();
      }
      assert.equal(h.timers.size, 0);
    },
  );
}

test(
  'Sameh P1-1: finalized provider fragments quarantine every sibling camera call',
  {
    skip: 'retired-by-decision: H16; captions no longer authorize or quarantine native calls (2026-10-15 contract)',
  },
  async () => {
    const h = samehPolicyHarness();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
      ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
      ws.message({
        serverContent: {
          inputTranscription: { text: 'switch voice provider' },
        },
      });
      const response = h.events.findLast(
        (event) => event.type === 'response-start',
      );
      requestTool(ws, 'first-camera', 'adjust_camera_zoom', {
        direction: 'in',
      });
      await tick();
      ws.message({
        serverContent: { inputTranscription: { text: 'to Gemini' } },
      });
      requestTool(ws, 'sibling-camera', 'adjust_camera_zoom', {
        direction: 'out',
      });
      await tick();
      h.advance(5000);
      await h.c.toolQueue;
      assert.deepEqual(
        h.mutations,
        [],
        'native segments must not remove provider-intent policy from a sibling',
      );
      assert.equal(
        readVoiceUserTurnText(response.userTurn),
        'switch voice provider to Gemini',
      );
      assert.equal(
        h.c.userTurns.forResponse(response.responseId),
        response.userTurn,
      );
      assert.deepEqual(
        h.observed,
        [],
        'provider requests refuse before action preparation',
      );
      assert.equal(
        ws.sent.filter(
          (m) =>
            m.toolResponse?.functionResponses?.[0]?.response
              ?.providerRequestBlocked,
        ).length,
        2,
      );
    } finally {
      h.c.stop();
    }
    assert.equal(h.timers.size, 0);
  },
);

for (const stage of ['deferred', 'flushed']) {
  test(`Sameh P3-1: ${stage} retirement deadline uses the injected clock and releases timers`, async () => {
    const h = harness({ inputBoundaryTimeoutMs: 60 });
    try {
      await h.c.start();
      const ws = h.sockets[0];
      ws.message({ serverContent: replyAudio('old') });
      h.c.sendTextCommand('first successor');
      h.c.sendTextCommand('queued successor');
      assert.equal(h.c.deferredInput.deadline, 60);
      h.advance(15);
      h.c.sendTextCommand('replacement');
      assert.equal(h.c.deferredInput.deadline, 60);
      if (stage === 'flushed') {
        ws.message({
          serverContent: { interrupted: true, turnComplete: true },
        });
        assert.equal(h.c.retiredBoundaryWait.deadline, 60);
      }
      h.advance(44);
      assert.notEqual(h.c.status, 'error');
      h.advance(1);
      assert.equal(h.c.status, 'error');
      assert.equal(ws.closed, true);
      assert.equal(h.timers.size, 0);
    } finally {
      h.c.stop();
    }
  });
}

for (const exit of ['stop', 'boundary']) {
  test(`Sameh P3-1: ${exit} clears an injected retirement deadline before replacement`, async () => {
    const h = harness({ inputBoundaryTimeoutMs: 60 });
    try {
      await h.c.start();
      const ws = h.sockets[0];
      ws.message({ serverContent: replyAudio('old') });
      h.c.sendTextCommand('first successor');
      h.c.sendTextCommand('queued successor');
      const deadline = h.c.deferredInput.deadline;
      h.advance(15);
      h.c.sendTextCommand('newest successor');
      assert.equal(h.c.deferredInput.deadline, deadline);
      ws.message({ serverContent: { interrupted: true, turnComplete: true } });
      assert.equal(h.c.retiredBoundaryWait.deadline, deadline);
      assert.equal(
        [...h.timers.values()].some((timer) => timer.at === 60),
        true,
        'retirement wait must belong to the injected timer registry',
      );
      if (exit === 'stop') h.c.stop();
      else {
        ws.message({
          serverContent: { interrupted: true, turnComplete: true },
        });
        ws.message({ serverContent: { turnComplete: true } });
      }
      assert.equal(
        [...h.timers.values()].some((timer) => timer.at === 60),
        false,
      );
      h.advance(100);
      assert.equal(h.c.status, exit === 'stop' ? 'idle' : 'listening');
      assert.equal(Boolean(ws.closed), exit === 'stop');
    } finally {
      h.c.stop();
    }
  });
}

test(
  'Sameh P1-1: a late finalized segment updates both queued siblings before dispatch',
  {
    skip: 'retired-by-decision: H17; captions no longer authorize or quarantine native calls (2026-10-15 contract)',
  },
  async () => {
    const h = samehPolicyHarness();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
      ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
      ws.message({
        serverContent: { inputTranscription: { text: 'switch voice' } },
      });
      const response = h.events.findLast(
        (event) => event.type === 'response-start',
      );
      ws.message({
        toolCall: {
          functionCalls: [
            {
              id: 'queued-zoom-one',
              name: 'adjust_camera_zoom',
              args: { direction: 'in' },
            },
            { id: 'queued-zoom-two', name: 'zoom_to_globe', args: {} },
          ],
        },
      });
      // Both calls already exist; this provider segment arrives before their
      // serialized action dispatch and must update the authentic current token.
      ws.message({
        serverContent: { inputTranscription: { text: 'provider to Gemini' } },
      });
      await h.c.toolQueue;
      assert.deepEqual(h.mutations, []);
      assert.deepEqual(
        h.observed,
        [],
        'provider requests refuse before action preparation',
      );
      assert.equal(
        h.c.userTurns.forResponse(response.responseId),
        response.userTurn,
      );
      assert.equal(
        readVoiceUserTurnText(response.userTurn),
        'switch voice provider to Gemini',
      );
      assert.equal(
        ws.sent.filter(
          (m) =>
            m.toolResponse?.functionResponses?.[0]?.response
              ?.providerRequestBlocked,
        ).length,
        2,
      );
    } finally {
      h.c.stop();
    }
    assert.equal(h.timers.size, 0);
  },
);

for (const exit of ['stop', 'replacement']) {
  test(
    `Sameh P1-1: ${exit} prevents queued fragments from reviving the old command`,
    {
      skip: 'replace-native: H18, H19; equivalent native regression tests replace caption ownership assumptions',
    },
    async () => {
      const h = samehPolicyHarness();
      try {
        await h.c.start();
        const ws = h.sockets[0];
        ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
        ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
        requestTool(ws, 'old-waiting-camera', 'adjust_camera_zoom', {
          direction: 'in',
        });
        await tick();
        const oldWork = h.c.toolQueue;
        if (exit === 'stop') h.c.stop();
        else h.c.sendTextCommand('switch voice provider to Gemini');
        ws.message({
          serverContent: { inputTranscription: { text: 'zoom in' } },
        });
        await oldWork;
        assert.deepEqual(h.mutations, []);
        assert.deepEqual(h.observed, []);
        assert.equal(h.c.pendingTools, 0);
        if (exit === 'replacement') {
          ws.message({
            serverContent: { interrupted: true, turnComplete: true },
          });
          requestTool(ws, 'current-provider-camera', 'zoom_to_globe', {});
          await h.c.toolQueue;
          assert.deepEqual(h.mutations, []);
          assert.equal(
            ws.sent.at(-1).toolResponse.functionResponses[0].response
              .providerRequestBlocked,
            true,
          );
        }
      } finally {
        h.c.stop();
      }
      assert.equal(h.timers.size, 0);
    },
  );
}

for (const toolOrder of ['before-boundary', 'after-boundary']) {
  test(
    `Sameh P0-1 ordering: unattributed early caption and tool ${toolOrder} fail closed and a new onset recovers`,
    {
      skip: 'replace-native: H20, H21; equivalent native regression tests replace caption ownership assumptions',
    },
    async () => {
      const h = samehPolicyHarness();
      try {
        await h.c.start();
        const ws = h.sockets[0];
        ws.message({ serverContent: replyAudio('old assistant reply') });
        ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
        ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
        ws.message({
          serverContent: { inputTranscription: { text: 'zoom in' } },
        });
        if (toolOrder === 'before-boundary')
          requestTool(
            ws,
            'current-before-old-completion',
            'adjust_camera_zoom',
            {
              direction: 'in',
            },
          );
        ws.message({
          serverContent: { interrupted: true, turnComplete: true },
        });
        if (toolOrder === 'after-boundary')
          requestTool(
            ws,
            'current-after-old-completion',
            'adjust_camera_zoom',
            {
              direction: 'in',
            },
          );
        await tick();
        // Input captions and tool calls have no turn ID. This ambiguous early
        // ordering cannot safely recover the original command from the wire.
        assert.deepEqual(h.mutations, []);
        assert.deepEqual(h.observed, []);
        assert.equal(h.c.pendingTools, 0);
        if (toolOrder === 'after-boundary')
          assert.equal(
            ws.sent.at(-1).toolResponse.functionResponses[0].response
              .voiceIntentUnverified,
            true,
          );
        ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
        if (h.c.retiredReplyPending)
          ws.message({
            serverContent: { interrupted: true, turnComplete: true },
          });
        ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
        ws.message({
          serverContent: { inputTranscription: { text: 'zoom in' } },
        });
        requestTool(ws, 'fresh-clean-onset', 'adjust_camera_zoom', {
          direction: 'in',
        });
        await h.c.toolQueue;
        assert.equal(h.mutations.length, 1);
        assert.equal(
          readVoiceUserTurnText(h.observed[0].options.userTurn),
          'zoom in',
        );
      } finally {
        h.c.stop();
      }
      assert.equal(h.timers.size, 0);
    },
  );
}

for (const firstSegment of ['switch voice provider', 'switch voice']) {
  test(
    `Sameh P1-1 ordering: provider fragment ${firstSegment} before old completion cannot authorize a suffix camera call`,
    {
      skip: 'retired-by-decision: H22, H23; captions no longer authorize or quarantine native calls (2026-10-15 contract)',
    },
    async () => {
      const h = samehPolicyHarness();
      try {
        await h.c.start();
        const ws = h.sockets[0];
        ws.message({ serverContent: replyAudio('old assistant reply') });
        ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
        ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
        ws.message({
          serverContent: { inputTranscription: { text: firstSegment } },
        });
        requestTool(ws, 'ambiguous-before-boundary', 'adjust_camera_zoom', {
          direction: 'in',
        });
        ws.message({
          serverContent: { interrupted: true, turnComplete: true },
        });
        ws.message({
          serverContent: {
            inputTranscription: {
              text:
                firstSegment === 'switch voice'
                  ? 'provider to Gemini'
                  : 'to Gemini',
            },
          },
        });
        requestTool(ws, 'suffix-camera-one', 'adjust_camera_zoom', {
          direction: 'in',
        });
        requestTool(ws, 'suffix-camera-two', 'zoom_to_globe', {});
        await tick();
        h.advance(5000);
        await h.c.toolQueue;
        assert.deepEqual(
          h.mutations,
          [],
          'discarding the prefix must not turn the suffix into an unrelated camera request',
        );
        assert.equal(h.c.pendingTools, 0);
      } finally {
        h.c.stop();
      }
      assert.equal(h.timers.size, 0);
    },
  );
}

test('Sameh projection: Gemini sends useful bounded failure prose as data without altering the local result', async () => {
  const failure = Object.freeze({
    ok: false,
    action: 'get_current_view_state',
    error:
      'Map search failed: no matching place. token=private-test-secret. Retry with a city name.',
    say: 'Map search failed. ' + 'Choose a more specific city. '.repeat(80),
    retryable: true,
    changed: false,
  });
  const h = harness({ runAction: async () => failure });
  try {
    await h.c.start();
    establishToolInput(h, 'What is in view?');
    const ws = h.sockets[0];
    requestTool(ws, 'failed-place-query', 'get_current_view_state', {});
    await h.c.toolQueue;
    const output = ws.sent.at(-1).toolResponse.functionResponses[0].response;
    assert.equal(output.ok, false);
    assert.equal(output.changed, false);
    assert.equal(output.retryable, true);
    assert.match(output.error, /Map search failed: no matching place/);
    assert.match(output.error, /Retry with a city name/);
    assert.doesNotMatch(output.error, /private-test-secret/);
    assert.ok(output.say.length <= VOICE_TOOL_FAILURE_TEXT_LIMIT);
    assert.match(output.say, /Map search failed/);
    assert.match(failure.error, /private-test-secret/);
    assert.ok(failure.say.length > VOICE_TOOL_FAILURE_TEXT_LIMIT);
    assert.equal(h.c.status, 'listening');
  } finally {
    h.c.stop();
  }
  assert.equal(h.timers.size, 0);
});

// Selective C3 port: a clean current onset is essential here. An early caption
// behind an old response boundary would pass by P0 quarantine alone.
for (const segments of [
  ['use', 'foo', 'bar', 'baz', 'as', 'my', 'voice', 'provider'],
  ['use', 'Foo', 'as', 'my', 'voi', 'ce provider'],
  ['please', ', use foo', 'as my voice provider'],
  ['use', 'x'.repeat(41), 'as', 'my', 'voi', 'ce provider'],
  ['use', 'Claude'],
  ['use', ' '.repeat(10000) + 'foo', 'as my voice provider'],
]) {
  test(
    `selective C3: attributed ${JSON.stringify(segments)} refuses sibling actions with manual guidance`,
    {
      skip: 'retired-by-decision: H24, H25, H26, H27, H28, H29; captions no longer authorize or quarantine native calls (2026-10-15 contract)',
    },
    async () => {
      const h = samehPolicyHarness();
      try {
        await h.c.start();
        const ws = h.sockets[0];
        ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
        ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
        assert.equal(h.c.intentAmbiguous, false);
        for (const text of segments)
          ws.message({ serverContent: { inputTranscription: { text } } });
        requestTool(ws, 'joined-one', 'adjust_camera_zoom', {
          direction: 'in',
        });
        requestTool(ws, 'joined-two', 'zoom_to_globe', {});
        await h.c.toolQueue;
        assert.deepEqual(h.mutations, []);
        const outputs = ws.sent.flatMap(
          (m) => m.toolResponse?.functionResponses || [],
        );
        assert.equal(outputs.length, 2);
        for (const output of outputs) {
          assert.equal(output.response.providerRequestBlocked, true);
          assert.match(output.response.say, /switch voice providers directly/);
          assert.equal(output.response.voiceIntentUnverified, undefined);
        }
      } finally {
        h.c.stop();
      }
      assert.equal(h.timers.size, 0);
    },
  );
}

for (const segments of [
  ['set', 'voice', 'volume', 'to', '50'],
  ['set', 'voice', 'speed', 'to', 'fast'],
  ['set', 'provider', 'to', 'bing maps'],
  ['"use foo', 'as my voice provider"'],
  ['use foo as my voice provider', 'and zoom out'],
  ['do not', 'use foo as my voice provider'],
  ['use', 'foo'],
]) {
  test(`selective C3: attributed ordinary ${JSON.stringify(segments)} releases tools`, async () => {
    const h = samehPolicyHarness();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
      ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
      for (const text of segments)
        ws.message({ serverContent: { inputTranscription: { text } } });
      requestTool(ws, 'ordinary-port', 'zoom_to_globe', {});
      await h.c.toolQueue;
      assert.equal(h.mutations.length, 1);
    } finally {
      h.c.stop();
    }
    assert.equal(h.timers.size, 0);
  });
}

test(
  'selective C3: ordinary resolution before expiry releases later siblings without a stale timeout',
  {
    skip: 'replace-native: H30; equivalent native regression tests replace caption ownership assumptions',
  },
  async () => {
    const h = samehPolicyHarness();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
      ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
      ws.message({
        serverContent: { inputTranscription: { text: 'switch to' } },
      });
      requestTool(ws, 'held-ordinary', 'zoom_to_globe', {});
      await tick();
      assert.equal(h.c.pendingTools, 1);
      h.advance(1499);
      ws.message({ serverContent: { inputTranscription: { text: 'Austin' } } });
      await h.c.toolQueue;
      assert.equal(h.mutations.length, 1);
      h.advance(5000);
      requestTool(ws, 'released-sibling', 'zoom_to_globe', {});
      await h.c.toolQueue;
      assert.equal(h.mutations.length, 2);
    } finally {
      h.c.stop();
    }
    assert.equal(h.timers.size, 0);
  },
);

test(
  'selective C3: exact 1500ms expiry refuses late completed fragments and every sibling',
  {
    skip: 'retired-by-decision: H31; captions no longer authorize or quarantine native calls (2026-10-15 contract)',
  },
  async () => {
    const h = samehPolicyHarness();
    try {
      await h.c.start();
      const ws = h.sockets[0];
      ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
      ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
      ws.message({
        serverContent: { inputTranscription: { text: 'switch to' } },
      });
      requestTool(ws, 'expiry-one', 'zoom_to_globe', {});
      await tick();
      h.advance(1499);
      assert.equal(h.c.pendingTools, 1);
      h.advance(1);
      ws.message({ serverContent: { inputTranscription: { text: 'Gemini' } } });
      requestTool(ws, 'expiry-two', 'zoom_to_globe', {});
      await h.c.toolQueue;
      assert.deepEqual(h.mutations, []);
      const outputs = ws.sent.flatMap(
        (m) => m.toolResponse?.functionResponses || [],
      );
      assert.equal(outputs.length, 2);
      for (const output of outputs) {
        assert.equal(output.response.voiceIntentUnverified, true);
        assert.match(output.response.error, /incomplete/);
      }
    } finally {
      h.c.stop();
    }
    assert.equal(h.timers.size, 0);
  },
);

for (const exit of ['stop', 'restart', 'new-input']) {
  test(
    `selective C3: ${exit} retires joined fragment state and late callbacks`,
    {
      skip: 'replace-native: H32, H33, H34; equivalent native regression tests replace caption ownership assumptions',
    },
    async () => {
      const h = samehPolicyHarness();
      try {
        await h.c.start();
        let ws = h.sockets[0];
        ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
        ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
        ws.message({
          serverContent: { inputTranscription: { text: 'switch to' } },
        });
        requestTool(ws, 'old-port-hold', 'zoom_to_globe', {});
        await tick();
        const oldWork = h.c.toolQueue;
        if (exit === 'new-input') h.c.sendTextCommand('zoom out');
        else h.c.stop();
        ws.message({
          serverContent: { inputTranscription: { text: 'Gemini' } },
        });
        h.advance(1500);
        await oldWork;
        assert.deepEqual(h.mutations, []);
        if (exit === 'restart') {
          await h.c.start();
          ws = h.sockets.at(-1);
          h.c.sendTextCommand('zoom out');
        } else if (exit === 'new-input') {
          ws.message({
            serverContent: { interrupted: true, turnComplete: true },
          });
        }
        if (exit !== 'stop') {
          requestTool(ws, 'fresh-after-port', 'zoom_to_globe', {});
          await h.c.toolQueue;
          assert.equal(h.mutations.length, 1);
        }
      } finally {
        h.c.stop();
      }
      assert.equal(h.timers.size, 0);
    },
  );
}

for (const providerDropdown of [false, true]) {
  for (const segments of [
    ['use', 'Foo', 'as', 'my', 'voi', 'ce provider'],
    ['use Claude'],
    ['switch to Gemini'],
  ]) {
    for (const tool of [
      { name: 'control_radio', args: { action: 'stop' } },
      { name: 'control_radio', args: { action: 'disable' } },
      {
        name: 'set_layer_visibility',
        args: { layerId: 'radio', enabled: false },
      },
    ]) {
      test(
        `C3 Radio refusal: chooser=${providerDropdown} ${JSON.stringify(segments)} ${tool.name}/${tool.args.action || 'off'} leaves no setter preparation`,
        {
          skip: 'replace-native: H35, H36, H37, H38, H39, H40, H41, H42, H43, H44, H45, H46, H47, H48, H49, H50, H51, H52; equivalent native regression tests replace caption ownership assumptions',
        },
        async () => {
          const mutations = [];
          const viewer = {
            clock: { onTick: { addEventListener: () => () => {} } },
            camera: { moveEnd: { addEventListener() {} } },
            scene: {
              canvas: { addEventListener() {}, removeEventListener() {} },
            },
          };
          const runner = createGevActionRunner({
            viewer,
            styleManager: {
              setStyle: (...args) => mutations.push(['style', ...args]),
            },
            dataManager: {
              isEnabled: () => true,
              setEnabled: (...args) => mutations.push(['visibility', ...args]),
            },
            radioLayer: {
              stopPlayback: (...args) => mutations.push(['stop', ...args]),
            },
          });
          let runnerCalls = 0;
          const h = harness({
            providerDropdown: () => providerDropdown,
            runAction: (...args) => {
              runnerCalls++;
              return runner(...args);
            },
          });
          const trace = {
            reservations: 0,
            registered: 0,
            toolStarted: 0,
            pauses: 0,
          };
          const playbackReady = deferred();
          let preflight;
          try {
            const pause = h.c.radio.pauseRadioForVoice.bind(h.c.radio);
            h.c.radio.pauseRadioForVoice = (...args) => {
              trace.pauses++;
              return pause(...args);
            };
            await h.c.start();
            const ws = h.sockets[0];
            ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
            ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
            for (const text of segments)
              ws.message({ serverContent: { inputTranscription: { text } } });
            assert.equal(h.c.intentAmbiguous, false);
            assert.equal(
              trace.pauses,
              1,
              'normal voice startup already paused Radio',
            );
            h.c.radio.radioLayer.playForVoice = () => playbackReady.promise;
            const prepared = radioPlaybackResult();
            h.c.radio.setPendingPlayback(prepared);
            preflight = h.c.radio.startPendingRadioHandoff();
            const handoffEpoch = h.c.radio.radioHandoffEpoch;
            const attemptId = h.c.radio.radioHandoffAttemptId;
            assert.equal(h.c.radio.radioHandoffInFlight, true);
            const reserve = h.c.radio.reserveRadioToolHandoff.bind(h.c.radio);
            h.c.radio.reserveRadioToolHandoff = (...args) => {
              trace.reservations++;
              return reserve(...args);
            };
            const register = h.c.radio.registerTool.bind(h.c.radio);
            h.c.radio.registerTool = (...args) => {
              trace.registered++;
              return register(...args);
            };
            const started = h.c.narration.toolStarted.bind(h.c.narration);
            h.c.narration.toolStarted = (...args) => {
              trace.toolStarted++;
              return started(...args);
            };
            requestTool(ws, 'refused-radio', tool.name, tool.args);
            await h.c.toolQueue;
            const response =
              ws.sent.at(-1).toolResponse.functionResponses[0].response;
            console.log(
              'C3 Radio trace',
              JSON.stringify({
                providerDropdown,
                segments,
                tool,
                trace,
                runnerCalls,
                reservationsLeft: h.c.radio.radioToolHandoffReservations.size,
                activeToolsLeft: h.c.radio.activeRadioToolControllers.size,
                response,
              }),
            );
            assert.equal(response.providerRequestBlocked, true);
            assert.equal(response.providerDropdown, providerDropdown);
            assert.match(
              response.say,
              providerDropdown ? /dropdown/ : /switch voice providers directly/,
            );
            assert.deepEqual(trace, {
              reservations: 0,
              registered: 0,
              toolStarted: 0,
              pauses: 1,
            });
            assert.equal(h.c.radio.radioToolHandoffReservations.size, 0);
            assert.equal(h.c.radio.activeRadioToolControllers.size, 0);
            assert.equal(h.c.pendingTools, 0);
            assert.equal(h.c.tools.size, 0);
            assert.equal(runnerCalls, 0);
            assert.deepEqual(mutations, []);
            assert.equal(h.c.radio.pendingRadioPlaybackResult, null);
            assert.equal(h.c.radio.radioHandoffInFlight, true);
            assert.equal(h.c.radio.radioHandoffInFlightResult, prepared);
            assert.equal(h.c.radio.radioHandoffEpoch, handoffEpoch);
            assert.equal(h.c.radio.radioHandoffAttemptId, attemptId);
            assert.equal(
              h.state.stopped,
              0,
              'a refused setter must not freeze the existing preflight',
            );
            assert.equal(h.c.stopAfterReply, false);
            h.c.sendTextCommand('Set visual style to night vision');
            ws.message({
              serverContent: { interrupted: true, turnComplete: true },
            });
            requestTool(ws, 'next-ordinary-style', 'set_visual_style', {
              style: 'night vision',
            });
            await h.c.toolQueue;
            assert.equal(runnerCalls, 1);
            assert.equal(mutations.length, 1);
            assert.equal(h.c.pendingTools, 0);
          } finally {
            h.c.stop();
            playbackReady.resolve(false);
            await preflight;
            runner.dispose();
          }
          assert.equal(h.timers.size, 0);
        },
      );
    }
  }
}

for (const phase of ['initializing', 'committed']) {
  test(
    `C3 joined policy: a late fused provider request during ${phase} preserves actual manager commit truth`,
    {
      skip: 'replace-native: H53, H54; equivalent native regression tests replace caption ownership assumptions',
    },
    async () => {
      const viewer = {
        clock: { onTick: { addEventListener: () => () => {} } },
        camera: { moveEnd: { addEventListener() {} } },
        scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
      };
      const manager = new DataLayerManager(viewer);
      const initEntered = deferred();
      const initReleased = deferred();
      const committed = deferred();
      const settlement = deferred();
      const calls = [];
      const events = [];
      manager.register({
        id: 'rocket-launches',
        name: 'Missions',
        updateInterval: -1,
        async init() {
          calls.push('init');
          initEntered.resolve();
          if (phase === 'initializing') await initReleased.promise;
        },
        async enable() {
          calls.push('enable');
        },
        async disable() {
          calls.push('disable');
        },
        async update() {},
        getStats: () => ({ count: 0 }),
      });
      const unsubscribe = manager.subscribe((event) => {
        events.push(event);
        if (event.type === 'visibility' && event.enabled) committed.resolve();
      });
      const runner = createGevActionRunner({
        viewer,
        dataManager: manager,
        styleManager: {
          _waitForContextLayerSettlement: () => settlement.promise,
        },
      });
      let options;
      let h;
      const sharedEvents = [];
      const session = createVoiceSession({
        runner: (name, args, context) => {
          options = context;
          return runner(name, args, context);
        },
        createAdapter: (shared) => {
          h = harness({ ...shared, dataManager: manager });
          return {
            start: (settings) => h.c.start(settings),
            stop: (settings) => h.c.stop(settings),
            sendText: (text) => h.c.sendTextCommand(text),
            sendMapEvent: (event) => h.c.notifyMapEvent(event),
          };
        },
      });
      session.subscribe((event) => sharedEvents.push(event));
      try {
        await session.start();
        const ws = h.sockets[0];
        ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
        ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
        ws.message({
          serverContent: { inputTranscription: { text: 'use foo as my voi' } },
        });
        const response = sharedEvents.findLast(
          (event) => event.type === 'response-start',
        );
        requestTool(ws, 'inflight-layer', 'set_layer_visibility', {
          layerId: 'rocket-launches',
          enabled: true,
        });
        await initEntered.promise;
        if (phase === 'committed') await committed.promise;
        assert.equal(options.signal.aborted, false);
        ws.message({
          serverContent: { inputTranscription: { text: 'ce provider' } },
        });
        assert.equal(
          readVoiceUserTurnText(response.userTurn),
          'use foo as my voi ce provider',
        );
        const policySignalAborted = options.signal.aborted;
        initReleased.resolve();
        settlement.resolve();
        await h.c.toolQueue;
        const result =
          ws.sent.at(-1).toolResponse.functionResponses[0].response;
        console.log(
          'C3 late joined trace',
          JSON.stringify({
            phase,
            policySignalAborted,
            enabled: manager.isEnabled('rocket-launches'),
            calls,
            result,
          }),
        );
        assert.equal(
          policySignalAborted,
          true,
          'joined restrictions must revoke the cooperative runner signal',
        );
        if (phase === 'initializing') {
          assert.equal(result.providerRequestBlocked, true);
          assert.equal(result.ok, false);
          assert.equal(manager.isEnabled('rocket-launches'), false);
          assert.equal(calls.includes('enable'), false);
          assert.equal(
            events.some(
              (event) => event.type === 'visibility' && event.enabled,
            ),
            false,
          );
        } else {
          assert.equal(result.ok, true);
          assert.equal(result.providerRequestBlocked, undefined);
          assert.equal(result.enabled, true);
          assert.equal(manager.isEnabled('rocket-launches'), true);
        }
        requestTool(ws, 'denied-sibling', 'set_layer_visibility', {
          layerId: 'rocket-launches',
          enabled: false,
        });
        await h.c.toolQueue;
        assert.equal(
          ws.sent.at(-1).toolResponse.functionResponses[0].response
            .providerRequestBlocked,
          true,
        );
        assert.equal(
          manager.isEnabled('rocket-launches'),
          phase === 'committed',
        );
        h.c.sendTextCommand('Show missions');
        ws.message({
          serverContent: { interrupted: true, turnComplete: true },
        });
        requestTool(ws, 'fresh-missions', 'set_layer_visibility', {
          layerId: 'rocket-launches',
          enabled: true,
        });
        await h.c.toolQueue;
        assert.equal(
          ws.sent.at(-1).toolResponse.functionResponses[0].response.ok,
          true,
        );
        assert.equal(manager.isEnabled('rocket-launches'), true);
        assert.equal(h.c.tools.size, 0);
        assert.equal(h.c.pendingTools, 0);
      } finally {
        initReleased.resolve();
        settlement.resolve();
        session.destroy();
        runner.dispose();
        unsubscribe();
        await manager.setEnabled('rocket-launches', false);
      }
      assert.equal(h.timers.size, 0);
    },
  );
}

for (const providerDropdown of [false, true]) {
  for (const phase of ['prepared', 'preflight', 'settling']) {
    test(
      `C3 deferred Radio policy: late same-token fused request cancels ${phase} speaker transfer chooser=${providerDropdown} without erasing preparation`,
      {
        skip: 'replace-native: H55, H56, H57, H58, H59, H60; equivalent native regression tests replace caption ownership assumptions',
      },
      async () => {
        const viewer = {
          clock: { onTick: { addEventListener: () => () => {} } },
          camera: { moveEnd: { addEventListener() {} } },
          scene: {
            canvas: { addEventListener() {}, removeEventListener() {} },
          },
        };
        const manager = new DataLayerManager(viewer);
        const prepared = deferred();
        const settleResult = deferred();
        const playbackReady = deferred();
        let playCalls = 0;
        let stopCalls = 0;
        let selections = 0;
        const state = {
          stationCount: 2,
          selected: null,
          audioState: 'stopped',
          voiceDucked: false,
        };
        const radio = {
          async init() {},
          async enable() {},
          async disable() {},
          async update() {},
          getStats: () => ({ count: 2 }),
          getUIState: () => ({ ...state }),
          setVoiceDucked(value) {
            state.voiceDucked = value;
          },
          pause() {
            state.audioState = 'paused';
          },
          subscribePlaybackControls() {
            return () => {};
          },
          selectRequestedStation(_criteria, options) {
            assert.equal(options.autoplay, false);
            selections++;
            state.selected = { id: 'station-1', name: 'Station One' };
            return state.selected;
          },
          playForVoice() {
            playCalls++;
            return playbackReady.promise;
          },
          stopPlayback() {
            stopCalls++;
            state.audioState = 'stopped';
          },
        };
        manager.register({
          id: 'radio',
          name: 'Radio',
          updateInterval: -1,
          ...radio,
        });
        const runner = createGevActionRunner({ viewer, dataManager: manager });
        let h;
        let preflight;
        const session = createVoiceSession({
          providerDropdown: () => providerDropdown,
          runner: async (...args) => {
            const result = await runner(...args);
            prepared.resolve(result);
            if (phase === 'settling') await settleResult.promise;
            return result;
          },
          createAdapter: (shared) => {
            h = harness({ ...shared, dataManager: manager, radioLayer: radio });
            return {
              start: (settings) => h.c.start(settings),
              stop: (settings) => h.c.stop(settings),
              sendText: (text) => h.c.sendTextCommand(text),
              sendMapEvent: (event) => h.c.notifyMapEvent(event),
            };
          },
        });
        try {
          await session.start();
          const ws = h.sockets[0];
          ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
          ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
          ws.message({
            serverContent: {
              inputTranscription: { text: 'use foo as my voi' },
            },
          });
          requestTool(ws, 'prepared-radio-policy', 'control_radio', {
            action: 'select',
            stationQuery: 'Station One',
          });
          const actual = await prepared.promise;
          assert.equal(actual.ok, true);
          assert.equal(actual.radioPlaybackRequested, true);
          assert.equal(actual.stationId, 'station-1');
          assert.equal(manager.isEnabled('radio'), true);
          if (phase !== 'settling') {
            await h.c.toolQueue;
            assert.ok(h.c.radio.pendingRadioPlaybackResult);
          }
          if (phase === 'preflight') {
            preflight = h.c.radio.startPendingRadioHandoff();
            assert.equal(h.c.radio.radioHandoffInFlight, true);
            assert.equal(playCalls, 1);
          }
          ws.message({
            serverContent: { inputTranscription: { text: 'ce provider' } },
          });
          settleResult.resolve();
          await h.c.toolQueue;
          const result = ws.sent.findLast((frame) => frame.toolResponse)
            ?.toolResponse.functionResponses[0].response;
          console.log(
            'C3 deferred Radio trace',
            JSON.stringify({
              phase,
              playCalls,
              stopCalls,
              pending: Boolean(h.c.radio.pendingRadioPlaybackResult),
              inFlight: h.c.radio.radioHandoffInFlight,
              enabled: manager.isEnabled('radio'),
              stationId: state.selected?.id,
              result,
            }),
          );
          const pendingAfterRestriction = h.c.radio.pendingRadioPlaybackResult;
          const inFlightAfterRestriction = h.c.radio.radioHandoffInFlight;
          const stopsAfterRestriction = stopCalls;
          drainRadioReply(h);
          playbackReady.resolve(true);
          await preflight;
          await tick();
          console.log(
            'C3 deferred Radio drain',
            JSON.stringify({
              phase,
              playCalls,
              stopCalls,
              active: h.c.isActive(),
            }),
          );
          assert.equal(
            pendingAfterRestriction,
            null,
            'provider request cancels only its deferred playback',
          );
          assert.equal(inFlightAfterRestriction, false);
          assert.equal(
            result.ok,
            true,
            'station selection and layer initialization really completed',
          );
          assert.equal(result.stationId, 'station-1');
          if (phase === 'settling') {
            assert.equal(result.radioPlaybackRequested, false);
            assert.equal(result.radioPlaybackSuppressed, true);
            assert.equal(result.radioPlaybackPolicyBlocked, true);
            assert.equal(result.providerDropdown, providerDropdown);
            assert.match(
              result.responseGuidance,
              providerDropdown ? /dropdown/ : /managed by this app/,
            );
            assert.match(result.responseGuidance, /provider/);
            assert.doesNotMatch(
              result.responseGuidance,
              /stopped as requested/,
            );
            assert.notEqual(result.changed, false);
          }
          assert.equal(manager.isEnabled('radio'), true);
          assert.equal(selections, 1);
          assert.equal(stopsAfterRestriction, phase === 'preflight' ? 1 : 0);
          assert.equal(
            playCalls,
            phase === 'preflight' ? 1 : 0,
            'confirmation/drain cannot revive policy-cancelled playback',
          );
          assert.equal(
            h.c.isActive(),
            true,
            'cancelled handoff cannot end voice after late readiness',
          );
          assert.equal(h.c.radio.radioHandoffInFlight, false);
          assert.equal(h.c.pendingTools, 0);
          assert.equal(h.c.tools.size, 0);
          assert.equal(session.sendText('Play radio'), true);
          requestTool(ws, 'fresh-radio-policy', 'control_radio', {
            action: 'play',
          });
          await h.c.toolQueue;
          assert.ok(
            h.c.radio.pendingRadioPlaybackResult,
            'a new authentic turn may prepare Radio again',
          );
          drainRadioReply(h);
          await tick();
          assert.equal(playCalls, phase === 'preflight' ? 2 : 1);
          assert.equal(
            h.c.isActive(),
            false,
            'only the fresh authorized Radio handoff ends voice',
          );
        } finally {
          settleResult.resolve();
          playbackReady.resolve(false);
          session.destroy();
          await preflight;
          runner.dispose();
          await manager.setEnabled('radio', false);
        }
        assert.equal(h.timers.size, 0);
      },
    );
  }
}
