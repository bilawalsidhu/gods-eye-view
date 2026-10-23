import { GeminiSessionController } from '../voice/geminiSession.js';
import { createNarrationScheduler } from '../voice/narration.js';

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
    setTimer: (fn, ms) => {
      const id = ++nextTimer;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    WebSocketClass: Socket,
    fetchImpl: async (_url, init) => {
      requests.push(init);
      return Response.json(
        JSON.parse(init.body).inputMode === 'push-to-talk'
          ? manualCredential
          : credential,
      );
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

export { harness, tick, deferred };
