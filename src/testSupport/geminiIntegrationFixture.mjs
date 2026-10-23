import assert from 'node:assert/strict';
import { createVoiceSession } from '../voice/session.js';
import { createGevActionRunner } from '../voice/gevActions.js';
import { createGeminiSession } from '../voice/geminiSession.js';
import { createNarrationScheduler } from '../voice/narration.js';

export const turnOfEventLoop = () =>
  new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ownedClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    timers,
    now: () => now,
    setTimer(fn, delay = 0) {
      const id = ++nextId;
      timers.set(id, { fn, at: now + Math.max(0, delay) });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const until = now + ms;
      let callbacks = 0;
      for (;;) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        assert.ok(
          ++callbacks <= 1000,
          'fixture timer queue must remain bounded',
        );
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
  };
}

/**
 * Real common session -> real Gemini adapter -> real action runner.
 * Only devices, transport, passive UI and wall-clock facilities are fakes.
 * The optional result gate delays return AFTER the actual action commits.
 */
export function nativeIntegrationFixture(t) {
  const clock = ownedClock();
  const events = [];
  const sockets = [];
  const tracks = [];
  const audios = [];
  const requests = [];
  const runnerCalls = [];
  const runnerJobs = [];
  const resultGates = new Map();
  const acquisitions = { microphone: 0, audio: 0, token: 0, socket: 0 };
  const state = { height: 1000, renders: 0, zooms: [], earconStarts: 0 };
  const position = { x: 6379137, y: 0, z: 0 };
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    camera: {
      positionWC: position,
      positionCartographic: { height: state.height },
      moveEnd: { addEventListener() {} },
      cancelFlight() {},
      zoomIn(metres) {
        position.x -= metres;
        state.height -= metres;
        this.positionCartographic.height = state.height;
        state.zooms.push({ direction: 'in', metres });
      },
      zoomOut(metres) {
        position.x += metres;
        state.height += metres;
        this.positionCartographic.height = state.height;
        state.zooms.push({ direction: 'out', metres });
      },
    },
    scene: {
      canvas: {
        clientWidth: 800,
        clientHeight: 600,
        addEventListener() {},
        removeEventListener() {},
      },
      requestRender() {
        state.renders++;
      },
    },
  };
  const dataManager = { layers: new Map() };
  const actualRunner = createGevActionRunner({
    viewer,
    dataManager,
    styleManager: {},
  });
  const runner = (name, args, options) => {
    runnerCalls.push({ name, args, options });
    const job = (async () => {
      // No fake action result: the camera and envelope come from production.
      const result = await actualRunner(name, args, options);
      const gate = resultGates.get(options.callId);
      if (gate) {
        gate.entered.resolve(result);
        await gate.release.promise;
      }
      return result;
    })();
    runnerJobs.push(job);
    return job;
  };
  class Socket {
    constructor(url) {
      acquisitions.socket++;
      this.url = url;
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => {
        if (this.closed) return;
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(raw) {
      assert.equal(
        this.readyState,
        1,
        'sending requires the owned open socket',
      );
      const message = JSON.parse(raw);
      this.sent.push(message);
      if (message.setup)
        queueMicrotask(() => this.message({ setupComplete: {} }));
    }
    message(message) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
    close() {
      this.closed = true;
      this.readyState = 3;
    }
  }
  const session = createVoiceSession({
    runner,
    createAdapter: (hooks) =>
      createGeminiSession({
        ...hooks,
        ui: { root: { remove() {} } },
        dataManager,
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        WebSocketClass: Socket,
        getUserMedia: async () => {
          acquisitions.microphone++;
          const track = {
            enabled: true,
            readyState: 'live',
            stopCalls: 0,
            stop() {
              this.stopCalls++;
              this.readyState = 'ended';
            },
          };
          tracks.push(track);
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        },
        fetchImpl: async (url, init) => {
          acquisitions.token++;
          requests.push({ url, init });
          const manual = JSON.parse(init.body).inputMode === 'push-to-talk';
          return Response.json({
            token: 'auth_tokens/fixture-not-a-credential',
            model: 'gemini-3.8-live',
            websocketUrl:
              'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained',
            config: {
              generationConfig: { responseModalities: ['AUDIO'] },
              ...(manual
                ? {
                    realtimeInputConfig: {
                      automaticActivityDetection: { disabled: true },
                    },
                  }
                : {}),
            },
          });
        },
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
            this.pushToTalkMode =
              this.pushToTalkKeyHeld =
              this.spaceKeyHeld =
                false;
          },
        }),
        createAudio: (callbacks) => {
          acquisitions.audio++;
          const audio = {
            pending: false,
            closed: false,
            outputStream: {},
            async initialize() {},
            connectMicrophone(stream, enabled, metadata) {
              this.stream = stream;
              this.setMicrophoneEnabled(enabled, metadata);
            },
            setMicrophoneEnabled(enabled, metadata) {
              this.enabled = enabled;
              this.metadata = metadata;
            },
            play() {
              this.pending = true;
            },
            clearPlayback() {
              this.pending = false;
            },
            drain() {
              this.pending = false;
              callbacks.onDrain();
            },
            diagnostics: () => ({ outputChunks: 0 }),
            async close() {
              this.closed = true;
              this.pending = false;
              return true;
            },
          };
          audios.push(audio);
          return audio;
        },
        createNarration: (options) =>
          createNarrationScheduler({
            ...options,
            now: clock.now,
            setTimer: clock.setTimer,
            clearTimer: clock.clearTimer,
          }),
        createProgressEarcon: () => ({
          available: () => true,
          start() {
            state.earconStarts++;
          },
          stop() {},
          dispose() {},
        }),
        captureViewport: async () => null,
      }),
  });
  session.subscribe((event) => events.push(event));
  const controller = session.adapter.controller;
  t.after(async () => {
    session.destroy();
    for (const gate of resultGates.values()) gate.release.resolve();
    await Promise.allSettled(runnerJobs);
    actualRunner.dispose();
    assert.equal(clock.timers.size, 0, 'fixture must leave no owned timer');
    assert.ok(audios.every((audio) => audio.closed));
    assert.ok(tracks.every((track) => track.readyState === 'ended'));
    assert.ok(sockets.every((socket) => socket.closed));
  });
  return {
    session,
    controller,
    state,
    events,
    sockets,
    tracks,
    audios,
    requests,
    acquisitions,
    runnerCalls,
    clock,
    holdResult(callId) {
      const gate = { entered: deferred(), release: deferred() };
      resultGates.set(callId, gate);
      return { ready: gate.entered.promise, release: gate.release.resolve };
    },
    async start() {
      await session.start();
      assert.equal(session.state, 'listening');
      assert.equal(controller.getDiagnostics().connected, true);
      return sockets.at(-1);
    },
    activity(socket = sockets.at(-1)) {
      socket.message({ voiceActivity: { type: 'ACTIVITY_START' } });
      socket.message({ voiceActivity: { type: 'ACTIVITY_END' } });
    },
    tool(callId, socket = sockets.at(-1)) {
      socket.message({
        toolCall: {
          functionCalls: [
            {
              id: callId,
              name: 'adjust_camera_zoom',
              args: { direction: 'in', amount: 'little' },
            },
          ],
        },
      });
      // A deterministic settlement boundary, not a fake action dispatcher.
      return controller.toolQueue;
    },
    outputs(socket = sockets.at(-1)) {
      return socket.sent.flatMap(
        (message) => message.toolResponse?.functionResponses || [],
      );
    },
    complete(socket = sockets.at(-1)) {
      socket.message({ serverContent: { turnComplete: true } });
    },
  };
}

export function assertSuccessfulZoom(h, socket, callId, beforeHeight) {
  assert.equal(h.state.height, beforeHeight * 0.75);
  assert.ok(h.state.renders > 0);
  const calls = h.events.filter(
    (event) => event.type === 'action-call' && event.callId === callId,
  );
  const results = h.events.filter(
    (event) => event.type === 'action-result' && event.callId === callId,
  );
  assert.equal(calls.length, 1);
  assert.equal(results.length, 1);
  assert.equal(calls[0].name, 'adjust_camera_zoom');
  assert.deepEqual(calls[0].arguments, { direction: 'in', amount: 'little' });
  assert.equal(results[0].result.ok, true);
  assert.equal(results[0].result.action, 'adjust_camera_zoom');
  assert.equal(results[0].result.beforeHeightM, Math.round(beforeHeight));
  assert.equal(results[0].result.afterHeightM, Math.round(h.state.height));
  const outputs = h.outputs(socket).filter((output) => output.id === callId);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].name, 'adjust_camera_zoom');
  assert.equal(outputs[0].response.ok, true);
  assert.equal(outputs[0].response.action, 'adjust_camera_zoom');
  assert.equal(outputs[0].response.afterHeightM, Math.round(h.state.height));
}
