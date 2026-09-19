import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoicePipeline, composeQuery, STATES, LIMITS } from './pipeline.js';
import { createSilenceDetector } from './audio.js';
import { createTransport, KEY_HEADER } from './transport.js';

const SECRET = 'od-secret-key-XYZ';
const flush = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/** Fake recorder exposing the callbacks the pipeline registered. */
function fakeRecorder({ failStart = null, blob = new Blob([new Uint8Array(8)], { type: 'audio/webm' }) } = {}) {
  const recorder = {
    starts: 0,
    monitors: 0,
    speech: null,
    silence: null,
    monitorSpeech: null,
    stopped: 0,
    cancelled: 0,
    monitorStopped: 0,
    async start({ onSpeech, onSilence }) {
      recorder.starts += 1;
      if (failStart) throw failStart;
      recorder.speech = onSpeech;
      recorder.silence = onSilence;
      return {
        stop: async () => {
          recorder.stopped += 1;
          return blob;
        },
        cancel: async () => {
          recorder.cancelled += 1;
          return null;
        },
      };
    },
    async monitor({ onSpeech }) {
      recorder.monitors += 1;
      recorder.monitorSpeech = onSpeech;
      return {
        stop: () => {
          recorder.monitorStopped += 1;
        },
      };
    },
  };
  return recorder;
}

/** Fake player whose playback is completed by the test (or by abort). */
function fakePlayer() {
  const player = {
    plays: [],
    stops: 0,
    current: null,
    play(source, { signal } = {}) {
      const gate = deferred();
      player.plays.push(source);
      player.current = gate;
      signal?.addEventListener?.('abort', () => gate.resolve({ interrupted: true }), { once: true });
      return gate.promise;
    },
    stop() {
      player.stops += 1;
      player.current?.resolve({ interrupted: true });
      player.current = null;
    },
    finish() {
      player.current?.resolve({ interrupted: false });
      player.current = null;
    },
  };
  return player;
}

/** Fake transport: programmable per-call behaviour, records every call. */
function fakeTransport(overrides = {}) {
  const calls = [];
  const workflowGate = deferred();
  const transport = {
    calls,
    workflowGate,
    workflowSignal: null,
    async createSession(options) {
      calls.push(['createSession', options]);
      return { sessionId: 'sess-1', reused: false };
    },
    async transcribe(blob, options) {
      calls.push(['transcribe', { size: blob?.size, sessionId: options?.sessionId }]);
      return { text: 'show military flights near me', uploadMs: 5, totalMs: 9 };
    },
    async chatStream({ query, onDelta, signal }) {
      calls.push(['chatStream', { query }]);
      onDelta?.('Military', 'Military');
      onDelta?.('Military flights layer is on.', ' flights layer is on.');
      onDelta?.(
        'Military flights layer is on.\nMAPACTIONS: [{"name":"frame_overhead","args":{}}]',
        '\nMAPACTIONS: [{"name":"frame_overhead","args":{}}]',
      );
      if (signal?.aborted) throw abortError();
      return {
        text: 'Military flights layer is on.\nMAPACTIONS: [{"name":"frame_overhead","args":{}}]',
        messageId: 'm1',
        statusLogs: [],
        metrics: null,
        firstDeltaMs: 40,
        totalMs: 90,
        streamed: true,
      };
    },
    runWorkflow({ signal, onLog, onStatus }) {
      calls.push(['runWorkflow']);
      transport.workflowSignal = signal;
      onStatus?.({ executionId: 'exec-1', status: 'executing', elapsedMs: 10, polls: 1 });
      onLog?.({ timestamp: 1, nodeKey: 'session_context', message: 'started' });
      return new Promise((resolve, reject) => {
        signal?.addEventListener?.('abort', () => reject(abortError()), { once: true });
        workflowGate.promise.then(resolve, reject);
      });
    },
    async synthesize(text, { voice }) {
      calls.push(['synthesize', { text, voice }]);
      return { kind: 'blob', blob: new Blob([new Uint8Array(4)], { type: 'audio/mpeg' }), ms: 3 };
    },
    async tools() {
      return [{ id: 'earthquake_search', name: 'Quakes', tools: [{ name: 'earthquake_search', path: '/api/tools/earthquake_search' }] }];
    },
    hasKey: () => false,
    ...overrides,
  };
  return transport;
}

function manualTimers() {
  const timers = new Map();
  let id = 0;
  return {
    timers,
    setTimeout(fn, ms) {
      id += 1;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
    fire(ms) {
      for (const [key, timer] of [...timers]) {
        if (timer.ms === ms) {
          timers.delete(key);
          timer.fn();
        }
      }
    },
  };
}

function harness(options = {}) {
  const transport = options.transport || fakeTransport(options.transportOverrides);
  const recorder = options.recorder || fakeRecorder(options.recorderOptions);
  const player = options.player || fakePlayer();
  const timers = manualTimers();
  const layerCalls = [];
  const actionCalls = [];
  const events = [];
  let clock = 0;
  const pipeline = createVoicePipeline({
    transport,
    recorder,
    player,
    now: () => (clock += 10),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setLayerEnabled: options.setLayerEnabled ?? (async (id, enabled) => {
      layerCalls.push([id, enabled]);
      return true;
    }),
    runMapAction: async (name, args) => {
      actionCalls.push([name, args]);
      return { ok: true };
    },
    sceneContext: () => ({
      camera: { lat: 37.7749, lon: -122.4194, heightM: 1200 },
      scene: 'San Francisco',
      layers: [{ id: 'flights', enabled: true, state: 'nominal' }, { id: 'military', enabled: false, state: 'unavailable', reason: 'keyless' }],
    }),
    userId: 'ondemand-spatial-voice-2026-09-18',
    ...(options.pipeline || {}),
  });
  pipeline.subscribe((event) => events.push(event));
  const states = () => events.filter((e) => e.type === 'state').map((e) => e.state);
  return { pipeline, transport, recorder, player, timers, layerCalls, actionCalls, events, states };
}

test('STATES / LIMITS are the documented ones', () => {
  assert.deepEqual(STATES, ['idle', 'listening', 'transcribing', 'thinking', 'speaking', 'error']);
  assert.equal(LIMITS.maxUtteranceMs, 12_000);
  assert.equal(LIMITS.silenceMs, 1_200);
  assert.equal(LIMITS.workflowTimeoutMs, 90_000);
});

test('full turn: press → listening → silence → transcribing → thinking → speaking → idle; local intent before network; workflow triggered; MapActions dispatched', async () => {
  const h = harness();
  assert.equal(h.pipeline.getState(), 'idle');
  const action = await h.pipeline.press();
  assert.equal(action, 'listen');
  assert.equal(h.pipeline.getState(), 'listening');
  assert.equal(h.recorder.starts, 1);
  assert.ok([...h.timers.timers.values()].some((t) => t.ms === 12_000), '12 s utterance cap armed');

  h.recorder.speech();
  h.recorder.silence(); // ≈1.2 s of quiet after speech → send
  await flush(12);
  // the answer is now being spoken; finish playback
  assert.equal(h.pipeline.getState(), 'speaking');
  h.player.finish();
  await flush(6);
  assert.equal(h.pipeline.getState(), 'idle');
  assert.deepEqual(h.states(), [
    'listening',
    'listening',
    'transcribing',
    'thinking', // local fast path
    'thinking', // route
    'speaking',
    'idle',
  ]);

  // local fast path ran BEFORE any network call and mapped to the military layer
  assert.deepEqual(h.layerCalls, [['military', true]]);
  const order = h.transport.calls.map((c) => c[0]);
  assert.deepEqual(order.slice(0, 2), ['createSession', 'transcribe']);
  const intentIndex = h.events.findIndex((e) => e.type === 'intents');
  const chatIndex = h.transport.calls.findIndex((c) => c[0] === 'chatStream');
  assert.ok(intentIndex >= 0 && chatIndex >= 0);
  assert.ok(order.includes('runWorkflow'), 'spatial task → workflow route triggers execute');
  assert.equal(h.events.find((e) => e.type === 'route').route, 'workflow');

  // the chat query carries the transcript + scene context + local actions
  const query = h.transport.calls.find((c) => c[0] === 'chatStream')[1].query;
  assert.ok(query.startsWith('show military flights near me'));
  assert.match(query, /"scene":"San Francisco"/);
  assert.match(query, /"lat":37\.7749/);
  assert.match(query, /"localActionsApplied":\[\{"layerId":"military","enabled":true,"ok":true\}\]/);
  assert.match(query, /"tools":\[\{"id":"earthquake_search","tools":\["earthquake_search"\]\}\]/);
  assert.match(query, /MAPACTIONS/);

  // transcript + streamed answer events, MAPACTIONS line stripped from the spoken text
  assert.equal(h.events.find((e) => e.type === 'transcript').text, 'show military flights near me');
  const partials = h.events.filter((e) => e.type === 'answer' && e.partial).map((e) => e.text);
  assert.deepEqual(partials, ['Military', 'Military flights layer is on.', 'Military flights layer is on.']);
  const finalAnswer = h.events.find((e) => e.type === 'answer' && !e.partial);
  assert.equal(finalAnswer.text, 'Military flights layer is on.');
  assert.equal(finalAnswer.source, 'chat');
  assert.deepEqual(h.actionCalls, [['frame_overhead', {}]]);
  assert.deepEqual(h.transport.calls.find((c) => c[0] === 'synthesize')[1], {
    text: 'Military flights layer is on.',
    voice: 'alloy',
  });
  assert.equal(h.player.plays.length, 1);
  assert.equal(h.recorder.monitors, 1, 'barge-in monitor armed while speaking');
  assert.equal(h.recorder.monitorStopped, 1);

  // the workflow poll is still pending after the spoken answer — let it finish
  const wfEvents = () => h.events.filter((e) => e.type === 'workflow').map((e) => e.phase);
  assert.deepEqual(wfEvents(), ['executing', 'status', 'log']);
  h.transport.workflowGate.resolve({
    ok: true,
    status: 'success',
    executionId: 'exec-1',
    timeToFirstLogMs: 1400,
    totalMs: 8000,
    polls: 4,
    logs: [{}, {}],
    message: 'One track verified.',
    mapActions: [{ name: 'set_layer_visibility', args: { layerId: 'military', enabled: true } }],
    error: null,
  });
  await flush(6);
  assert.deepEqual(wfEvents(), ['executing', 'status', 'log', 'done']);
  const done = h.events.find((e) => e.type === 'workflow' && e.phase === 'done');
  assert.equal(done.timeToFirstLogMs, 1400);
  assert.equal(done.executionId, 'exec-1');
  assert.deepEqual(h.actionCalls[1], ['set_layer_visibility', { layerId: 'military', enabled: true }]);
  const metrics = h.events.find((e) => e.type === 'metrics').metrics;
  assert.equal(typeof metrics.sttMs, 'number');
  assert.equal(metrics.chatFirstDeltaMs, 40);
  assert.equal(metrics.stopReason, 'silence');
});

test('barge-in: press while speaking stops playback, abandons the pending workflow poll (AbortController) and starts a new listening turn', async () => {
  const h = harness();
  await h.pipeline.press();
  h.recorder.silence();
  await flush(12);
  assert.equal(h.pipeline.getState(), 'speaking');
  assert.equal(h.transport.workflowSignal.aborted, false);

  const action = await h.pipeline.press();
  assert.equal(action, 'barge-in');
  assert.equal(h.player.stops >= 1, true);
  assert.equal(h.transport.workflowSignal.aborted, true, 'pending poll abandoned');
  assert.equal(h.pipeline.getState(), 'listening');
  assert.equal(h.recorder.starts, 2);
  await flush(4);
  assert.ok(h.events.some((e) => e.type === 'barge-in' && e.origin === 'button'));
  assert.ok(h.events.some((e) => e.type === 'workflow' && e.phase === 'abandoned'));

  // the monitor hearing speech during playback is the other barge-in trigger
  h.recorder.silence();
  await flush(12);
  assert.equal(h.pipeline.getState(), 'speaking');
  h.recorder.monitorSpeech();
  await flush(4);
  assert.equal(h.pipeline.getState(), 'listening');
  assert.equal(h.recorder.starts, 3);
  assert.ok(h.events.some((e) => e.type === 'barge-in' && e.origin === 'voice'));
});

test('12 s utterance cap: without a silence verdict the pipeline stops listening itself (stopReason "max")', async () => {
  const h = harness();
  await h.pipeline.press();
  h.timers.fire(12_000);
  await flush(12);
  assert.equal(h.recorder.stopped, 1);
  h.player.finish();
  await flush(4);
  const metrics = h.events.find((e) => e.type === 'metrics').metrics;
  assert.equal(metrics.stopReason, 'max');
});

test('silence detector: "speech" once after sustained energy, "stop" once ≈1.2 s after the speaker goes quiet, never before speech', () => {
  const detector = createSilenceDetector({ silenceMs: 1200, threshold: 0.02, minSpeechMs: 100 });
  // quiet room: nothing fires, no matter how long
  for (let t = 0; t <= 5000; t += 50) assert.equal(detector.feed(0.001, t), null);
  assert.equal(detector.spoke, false);
  // speech onset: sustained 100 ms before the verdict
  assert.equal(detector.feed(0.1, 6000), null);
  assert.equal(detector.feed(0.1, 6050), null);
  assert.equal(detector.feed(0.1, 6100), 'speech');
  assert.equal(detector.feed(0.1, 6150), null);
  // quiet again: stop exactly when 1200 ms have elapsed since the last loud frame
  let verdicts = [];
  for (let t = 6200; t <= 7300; t += 50) verdicts.push(detector.feed(0.001, t));
  assert.ok(verdicts.every((v) => v === null));
  assert.equal(detector.feed(0.001, 7350), 'stop');
  assert.equal(detector.feed(0.001, 7400), null, 'stop fires once');
  // a brief blip below minSpeechMs never counts as speech
  detector.reset();
  assert.equal(detector.feed(0.1, 0), null);
  assert.equal(detector.feed(0.001, 50), null);
  assert.equal(detector.feed(0.001, 2000), null);
});

test('error states: microphone denied → error; transcription 503 → error with the proxy reason; a later press recovers', async () => {
  const denied = harness({ recorderOptions: { failStart: new Error('Permission denied') } });
  await denied.pipeline.press();
  assert.equal(denied.pipeline.getState(), 'error');
  assert.match(denied.pipeline.getDetail(), /Microphone unavailable: Permission denied/);

  const h = harness({
    transportOverrides: {
      async transcribe() {
        const error = new Error('OnDemand is not configured on this deployment');
        error.status = 503;
        throw error;
      },
    },
  });
  await h.pipeline.press();
  h.recorder.silence();
  await flush(8);
  assert.equal(h.pipeline.getState(), 'error');
  assert.equal(h.pipeline.getDetail(), 'Transcription failed: OnDemand is not configured on this deployment');
  assert.equal(await h.pipeline.press(), 'listen');
  assert.equal(h.pipeline.getState(), 'listening');
});

test('OnDemand chat unavailable (503): the local fast path still flips the layer and a short local confirmation is spoken with the reason shown', async () => {
  const h = harness({
    transportOverrides: {
      async chatStream() {
        const error = new Error('OnDemand is not configured on this deployment');
        error.status = 503;
        throw error;
      },
      runWorkflow() {
        const error = new Error('OnDemand is not configured on this deployment');
        error.status = 503;
        return Promise.reject(error);
      },
    },
  });
  const turn = h.pipeline.submitText('show military flights near me');
  await flush(12);
  assert.deepEqual(h.layerCalls, [['military', true]]);
  const answer = h.events.find((e) => e.type === 'answer' && !e.partial);
  assert.equal(answer.text, 'Military flights layer on.');
  assert.equal(answer.source, 'local');
  assert.equal(answer.reason, 'OnDemand is not configured on this deployment');
  assert.equal(h.pipeline.getState(), 'speaking');
  assert.match(h.pipeline.getDetail(), /Speaking \(local\) — OnDemand is not configured/);
  h.player.finish();
  await turn;
  await flush(4);
  assert.equal(h.pipeline.getState(), 'idle');
  assert.match(h.pipeline.getDetail(), /Answered locally — OnDemand is not configured/);
  assert.ok(h.events.some((e) => e.type === 'workflow' && e.phase === 'failed'));

  // no local intent to fall back on → error state with the reason
  const bare = harness({
    transportOverrides: {
      async chatStream() {
        const error = new Error('OnDemand proxy route not found (dev server?)');
        error.status = 404;
        throw error;
      },
    },
  });
  await bare.pipeline.submitText('tell me a joke');
  assert.equal(bare.pipeline.getState(), 'error');
  assert.equal(bare.pipeline.getDetail(), 'OnDemand proxy route not found (dev server?)');
  assert.equal(bare.transport.calls.some((c) => c[0] === 'runWorkflow'), false, 'chat route: no workflow');
});

test('TTS unavailable: the answer is still shown, playback skipped, turn ends idle with the tts-unavailable event', async () => {
  const h = harness({
    transportOverrides: {
      async synthesize() {
        const error = new Error('OnDemand proxy does not support this call (not_documented)');
        error.status = 501;
        throw error;
      },
    },
  });
  await h.pipeline.submitText('tell me a joke', { mode: 'chat' });
  await flush(4);
  assert.equal(h.pipeline.getState(), 'idle');
  assert.equal(h.player.plays.length, 0);
  assert.ok(h.events.some((e) => e.type === 'tts-unavailable' && e.status === 501));
  assert.equal(h.events.find((e) => e.type === 'route').route, 'chat');
});

test('press during thinking cancels the turn (idle); submitText with mode "chat" never triggers the workflow; setMode is honoured', async () => {
  const gate = deferred();
  const h = harness({
    transportOverrides: {
      chatStream: ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
          gate.promise.then(resolve);
        }),
    },
  });
  const turnPromise = h.pipeline.submitText('what is flying overhead', { mode: 'chat' });
  await flush(4);
  assert.equal(h.pipeline.getState(), 'thinking');
  assert.equal(await h.pipeline.press(), 'cancel');
  assert.equal(h.pipeline.getState(), 'idle');
  await turnPromise;
  assert.equal(h.transport.calls.some((c) => c[0] === 'runWorkflow'), false);
  assert.equal(h.pipeline.setMode('chat'), 'chat');
  assert.equal(h.pipeline.getMode(), 'chat');
  assert.equal(h.pipeline.setMode('bogus'), 'chat');
});

test('key handling: the x-ondemand-key header goes out only when a key is stored, and the key never appears in any emitted event or state text', async () => {
  const storage = { getItem: (k) => (k === 'ondemand.apiKey' ? SECRET : null) };
  const bodies = [];
  const encoder = new TextEncoder();
  const fetch = async (url, init = {}) => {
    bodies.push({ url: String(url), headers: { ...(init.headers || {}) } });
    const path = String(url);
    const jsonRes = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/ondemand/sessions') return jsonRes(201, { sessionId: 'sess-k', reused: false });
    if (path === '/api/ondemand/media') return jsonRes(201, { data: { url: 'https://cdn.example/a.webm' } });
    if (path === '/api/ondemand/stt') return jsonRes(200, { data: { text: 'hide satellites' } });
    if (path === '/api/ondemand/chat') {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event:message\ndata:{"eventType":"fulfillment","eventIndex":1,"answer":"Satellites off."}\n\nevent:message\ndata:[DONE]\n\n',
              ),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    if (path.startsWith('/api/ondemand/tts'))
      return new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    if (path === '/api/tools') return jsonRes(200, { tools: [] });
    return jsonRes(404, { error: 'Unknown API route' });
  };
  const withKey = harness({ transport: createTransport({ fetch, storage, now: () => 0 }) });
  await withKey.pipeline.press();
  withKey.recorder.silence();
  await flush(16);
  withKey.player.finish();
  await flush(6);
  assert.equal(withKey.pipeline.getState(), 'idle');
  assert.ok(bodies.length >= 4);
  assert.ok(bodies.every((b) => b.headers[KEY_HEADER] === SECRET), 'every proxy call carries the key');
  assert.deepEqual(withKey.layerCalls, [['satellites', false]]);
  const serialized = JSON.stringify(withKey.events) + withKey.pipeline.getDetail();
  assert.equal(serialized.includes(SECRET), false, 'key never leaks into events/state');

  bodies.length = 0;
  const withoutKey = harness({ transport: createTransport({ fetch, storage: null, now: () => 0 }) });
  const turn = withoutKey.pipeline.submitText('hide satellites', { mode: 'chat' });
  await flush(16);
  withoutKey.player.finish();
  await turn;
  assert.ok(bodies.length >= 2);
  assert.ok(bodies.every((b) => !(KEY_HEADER in b.headers)), 'no key → no header');
});

test('composeQuery keeps the context bounded and never drops the utterance', () => {
  const layers = Array.from({ length: 80 }, (_, i) => ({ id: `layer-${i}`, enabled: true, state: 'degraded', reason: 'x'.repeat(200) }));
  const tools = Array.from({ length: 40 }, (_, i) => ({ id: `tool-${i}`, tools: Array.from({ length: 20 }, (_, j) => ({ name: `t${i}-${j}` })) }));
  const query = composeQuery('what is nearby', { layers, tools });
  assert.ok(query.startsWith('what is nearby'));
  const contextJson = query.slice(query.indexOf('Scene context (JSON): ') + 'Scene context (JSON): '.length);
  assert.ok(contextJson.length <= LIMITS.maxContextChars + 100);
  const parsed = JSON.parse(contextJson);
  assert.ok(parsed.layers.length <= LIMITS.maxLayersInContext);
});
