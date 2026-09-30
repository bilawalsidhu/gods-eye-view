import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiSessionController, geminiSocketUrl } from './geminiSession.js';

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
    createInput: ({ readStream }) => ({
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
    createAudio: (callbacks) => {
      const audio = {
        callbacks,
        pending: false,
        closed: false,
        played: [],
        async initialize() {},
        connectMicrophone(stream, enabled) {
          media.push({ stream, enabled });
          this.connected = true;
          this.setMicrophoneEnabled(enabled);
        },
        setMicrophoneEnabled(value) {
          if (!this.connected) return;
          if (value && !this.enabled) callbacks.onAudioStart();
          if (!value && this.enabled) callbacks.onAudioEnd();
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
  audio.callbacks.onAudioStart(); // A duplicate notification cannot reopen.
  audio.callbacks.onAudio(pcm);
  h.c.input.setMicrophoneEnabled(false);
  audio.callbacks.onAudioEnd();
  audio.callbacks.onAudio(pcm); // Unbracketed/stale PCM is not forwarded.
  assert.equal(h.tracks[0].enabled, false);
  h.c.input.setMicrophoneEnabled(true);
  audio.callbacks.onAudio(pcm);
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

test('a token config that disagrees with the gesture fails before socket or microphone creation', async () => {
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
    assert.equal(h.tracks.length, 0);
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
  old.onAudioStart();
  old.onAudio({ data: 'AAAA', mimeType: 'audio/pcm;rate=16000' });
  old.onAudioEnd();
  assert.equal(socket.sent.length, oldCount);
  assert.equal(h.sockets[1].sent.length, replacementCount);
  assert.equal(h.c.status, 'listening');
  assert.equal(h.tracks[0].readyState, 'ended');
  assert.equal(h.tracks[1].enabled, true);
  h.c.stop({ removeUi: true });
  const latest = h.captures[1].callbacks;
  latest.onAudioStart();
  latest.onAudioEnd();
  assert.equal(h.sockets[1].sent.length, replacementCount);
});

test('session waits for setup, captures PCM, plays all parts, emits transcripts and releases every resource', async () => {
  const h = harness();
  await h.c.start();
  assert.equal(h.c.status, 'listening');
  assert.equal(h.media.length, 1);
  const ws = h.sockets[0];
  assert.equal(ws.sent[0].setup.model, 'models/gemini-3.8-live');
  h.captures[0].callbacks.onAudio({
    data: 'AAAA',
    mimeType: 'audio/pcm;rate=16000',
  });
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
      (event) =>
        event.type === 'completion' && event.status === 'completed',
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

test('a congested microphone transport fails closed and releases the mic', async () => {
  const h = harness();
  await h.c.start();
  h.sockets[0].bufferedAmount = 300000;
  assert.throws(
    () =>
      h.captures[0].callbacks.onAudio({
        data: 'AA==',
        mimeType: 'audio/pcm;rate=16000',
      }),
    /keep up/,
  );
  // The audio owner's onmessage boundary catches the throw and reports it.
  h.captures[0].callbacks.onError(new Error('transport congested'));
  assert.equal(h.c.status, 'error');
  assert.equal(h.tracks[0].readyState, 'ended');
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

test('microphone permission deadline closes transport and a late grant releases only its own tracks', async () => {
  const microphone = deferred();
  const h = harness({
    startupTimeoutMs: 40,
    getUserMedia: () => microphone.promise,
  });
  await Promise.all([
    h.c.start(),
    new Promise((resolve) => setTimeout(resolve, 80)),
  ]);
  assert.equal(h.c.status, 'error');
  assert.match(h.c.lastError, /timed out/);
  assert.equal(h.sockets[0].closed, true);
  assert.equal(h.captures[0].closed, true);
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
          voiceActivityType: 'ACTIVITY_START',
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
    test(`cancelling ${query.name} ${query.args.action || ''} preserves another Radio owner in ${phase}`, async () => {
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
        phase === 'active' ? 1 : 2,
        'a cancelled queued query never starts',
      );
      assert.equal(h.c.pendingTools, 0);
      const responses = ws.sent.flatMap(
        (message) => message.toolResponse?.functionResponses || [],
      );
      assert.deepEqual(
        responses.map((response) => response.id),
        ['owner'],
      );
      assert.equal(responses[0].response.ok, true);
      if (phase !== 'preflight') drainRadioReply(h);
      assert.equal(h.c.radio.radioHandoffInFlight, true);
      ready.resolve(true);
      queryWork.resolve({ ok: true });
      await tick();
      assert.equal(h.c.status, 'idle');
      assert.equal(h.state.ducked, false);
    });
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
  const ws = h.sockets[0];
  requestTool(ws, 'old');
  await h.c.toolQueue;
  drainRadioReply(h);
  const oldResult = h.c.radio.radioHandoffInFlightResult;
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
    const ws = h.sockets[0];
    requestTool(ws, 'old');
    await h.c.toolQueue;
    drainRadioReply(h);
    requestTool(ws, 'prepared');
    await h.c.toolQueue;
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
