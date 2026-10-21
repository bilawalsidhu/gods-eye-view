// Native ownership replacements for historical Radio regression cases.
// Real Gemini controller, action runner, DataLayerManager and RealtimeRadio consumers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  harness,
  tick,
  deferred,
} from '../testSupport/geminiNativeHarness.mjs';
import { createGevActionRunner } from './gevActions.js';
import { createVoiceSession } from './session.js';
import { DataLayerManager } from '../data/manager.js';

const viewerFixture = () => ({
  clock: { onTick: { addEventListener: () => () => {} } },
  camera: { moveEnd: { addEventListener() {} } },
  scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
});
const request = (ws, id, name, args = {}) =>
  ws.message({ toolCall: { functionCalls: [{ id, name, args }] } });
const responses = (ws) =>
  ws.sent.flatMap((frame) => frame.toolResponse?.functionResponses || []);
const responseFor = (ws, id) =>
  responses(ws).findLast((response) => response.id === id)?.response;
const speechTurn = (ws) => {
  ws.message({ voiceActivity: { type: 'ACTIVITY_START' } });
  ws.message({ voiceActivity: { type: 'ACTIVITY_END' } });
};
function drainRadioReply(h) {
  h.sockets.at(-1).message({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] },
      turnComplete: true,
    },
  });
  h.captures.at(-1).drain();
}

function radioSiblingFixture() {
  const viewer = viewerFixture();
  const manager = new DataLayerManager(viewer);
  const lookupEntered = deferred();
  const lookupReleased = deferred();
  const state = {
    stationCount: 2,
    selected: { id: 'existing-station', name: 'Existing Station' },
    audioState: 'stopped',
  };
  const trace = { stops: 0, pauses: 0, selections: 0, options: new Map() };
  const radio = {
    async init() {},
    async enable() {},
    async disable() {},
    async update() {},
    getStats: () => ({ count: 2 }),
    getUIState: () => ({ ...state }),
    setVoiceDucked() {},
    pause({ origin } = {}) {
      if (origin === 'voice') trace.pauses++;
      state.audioState = 'paused';
      return true;
    },
    stopPlayback() {
      trace.stops++;
      state.audioState = 'stopped';
      return true;
    },
    selectRequestedStation() {
      trace.selections++;
      state.selected = { id: 'late-station', name: 'Late Station' };
      return state.selected;
    },
    subscribePlaybackControls: () => () => {},
  };
  manager.register(
    Object.assign(radio, {
      id: 'radio',
      name: 'Radio',
      updateInterval: -1,
    }),
  );
  const runner = createGevActionRunner({
    viewer,
    dataManager: manager,
    placeSearch: {
      async geocode(_query, { signal }) {
        trace.lookupSignal = signal;
        lookupEntered.resolve();
        // Deliberately ignore abort: production currentness must still prevent
        // this late service completion from committing a station selection.
        await lookupReleased.promise;
        return { place: { lat: 10, lng: 20, label: 'Deferred Place' } };
      },
    },
  });
  const h = harness({
    dataManager: manager,
    radioLayer: radio,
    runAction(name, args, options) {
      trace.options.set(options.callId, options);
      return runner(name, args, options);
    },
  });
  return {
    h,
    manager,
    runner,
    radio,
    trace,
    state,
    lookupEntered,
    lookupReleased,
  };
}

for (const action of ['select', 'play']) {
  for (const stronger of ['stop', 'pause', 'disable', 'off']) {
    test(`native same-turn Radio ${stronger} preempts deferred ${action} without cancelling a query sibling`, async () => {
      const f = radioSiblingFixture();
      const { h, trace, state } = f;
      try {
        await f.manager.setEnabled('radio', true);
        await h.c.start();
        const ws = h.sockets[0];
        speechTurn(ws);
        const turn = h.c.turn;
        request(ws, 'slow-selection', 'control_radio', {
          action,
          locationQuery: 'Deferred Place',
        });
        await f.lookupEntered.promise;
        request(ws, 'query-sibling', 'control_radio', { action: 'status' });
        request(
          ws,
          'stronger-radio',
          stronger === 'off' ? 'set_layer_visibility' : 'control_radio',
          stronger === 'off'
            ? { layerId: 'radio', enabled: false }
            : { action: stronger },
        );
        await tick();
        assert.equal(
          responseFor(ws, 'stronger-radio')?.ok,
          true,
          'stronger control must finish before lookup release',
        );
        assert.equal(trace.lookupSignal.aborted, true);
        await h.c.toolQueue;
        assert.equal(
          h.c.turn,
          turn,
          'sibling control cannot invent a new turn',
        );
        assert.equal(trace.selections, 0);
        assert.equal(state.selected.id, 'existing-station');
        assert.equal(responseFor(ws, 'slow-selection').ok, false);
        assert.match(responseFor(ws, 'slow-selection').error, /cancelled/);
        assert.equal(
          responseFor(ws, 'slow-selection').enabled,
          !['disable', 'off'].includes(stronger),
        );
        assert.equal(responseFor(ws, 'query-sibling').ok, true);
        assert.equal(trace.options.get('query-sibling').signal.aborted, false);
        assert.equal(
          responseFor(ws, 'stronger-radio').enabled,
          !['disable', 'off'].includes(stronger),
        );
        assert.equal(trace.stops, stronger === 'stop' ? 1 : 0);
        assert.equal(trace.pauses, stronger === 'pause' ? 1 : 0);
        f.lookupReleased.resolve();
        await tick();
        assert.equal(trace.selections, 0, 'late lookup cannot commit');
        assert.equal(h.c.pendingTools, 0);
        assert.equal(h.c.tools.size, 0);
        assert.equal(h.c.radio.radioToolHandoffReservations.size, 0);
        for (const id of ['slow-selection', 'query-sibling', 'stronger-radio'])
          assert.equal(responses(ws).filter((r) => r.id === id).length, 1);
      } finally {
        f.lookupReleased.resolve();
        h.c.stop();
        f.runner.dispose();
        await f.manager.setEnabled('radio', false);
      }
      assert.equal(h.timers.size, 0);
    });
  }
}

for (const guard of ['malformed', 'replay', 'invalid-arguments']) {
  test(`native stronger Radio ${guard} cannot revoke a same-turn lookup`, async () => {
    const f = radioSiblingFixture();
    const { h, trace } = f;
    try {
      await f.manager.setEnabled('radio', true);
      await h.c.start();
      const ws = h.sockets[0];
      if (guard === 'replay') {
        request(ws, 'stronger-radio', 'control_radio', { action: 'stop' });
        await h.c.toolQueue;
      }
      speechTurn(ws);
      if (guard === 'replay')
        ws.message({
          serverContent: { interrupted: true, turnComplete: true },
        });
      request(ws, 'slow-selection', 'control_radio', {
        action: 'select',
        locationQuery: 'Deferred Place',
      });
      await f.lookupEntered.promise;
      const stops = trace.stops;
      const handoffEpoch = h.c.radio.radioHandoffEpoch;
      request(
        ws,
        guard === 'malformed' ? '\n' : 'stronger-radio',
        'control_radio',
        {
          action: 'stop',
          ...(guard === 'invalid-arguments'
            ? { latitude: 91, longitude: 0 }
            : {}),
        },
      );
      await tick();
      assert.equal(trace.lookupSignal.aborted, false);
      assert.equal(trace.stops, stops);
      assert.equal(h.c.radio.radioHandoffEpoch, handoffEpoch);
      assert.equal(h.c.radio.radioToolHandoffReservations.size, 0);
      if (guard === 'invalid-arguments') {
        assert.equal(responseFor(ws, 'stronger-radio').ok, false);
        assert.match(responseFor(ws, 'stronger-radio').error, /coordinates/);
      }
      f.lookupReleased.resolve();
      await h.c.toolQueue;
      assert.equal(
        trace.selections,
        1,
        'older eligible work retains authority',
      );
      assert.equal(responseFor(ws, 'slow-selection').ok, true);
      assert.equal(h.c.pendingTools, 0);
      assert.equal(h.c.tools.size, 0);
    } finally {
      f.lookupReleased.resolve();
      h.c.stop();
      f.runner.dispose();
      await f.manager.setEnabled('radio', false);
    }
    assert.equal(h.timers.size, 0);
  });
}

test('native failed Stop releases its reservation and lets the older selection finish', async () => {
  const f = radioSiblingFixture();
  const { h, trace } = f;
  const stopReleased = deferred();
  f.radio.stopPlayback = () => stopReleased.promise;
  try {
    await f.manager.setEnabled('radio', true);
    await h.c.start();
    const ws = h.sockets[0];
    speechTurn(ws);
    request(ws, 'slow-selection', 'control_radio', {
      action: 'select',
      locationQuery: 'Deferred Place',
    });
    await f.lookupEntered.promise;
    request(ws, 'failed-stop', 'control_radio', { action: 'stop' });
    await tick();
    assert.equal(h.c.radio.radioToolHandoffReservations.size, 1);
    assert.equal(
      trace.lookupSignal.aborted,
      false,
      'provisional Stop cannot revoke work',
    );
    assert.equal(h.c.pendingTools, 2);
    stopReleased.resolve(false);
    await tick();
    assert.equal(responseFor(ws, 'failed-stop').ok, false);
    assert.match(responseFor(ws, 'failed-stop').error, /could not be stopped/);
    assert.equal(h.c.radio.radioToolHandoffReservations.size, 0);
    assert.equal(trace.lookupSignal.aborted, false);
    f.lookupReleased.resolve();
    await h.c.toolQueue;
    assert.equal(responseFor(ws, 'slow-selection').ok, true);
    assert.equal(trace.selections, 1);
    assert.equal(f.state.selected.id, 'late-station');
    assert.equal(h.c.pendingTools, 0);
  } finally {
    stopReleased.resolve(false);
    f.lookupReleased.resolve();
    h.c.stop();
    f.runner.dispose();
    await f.manager.setEnabled('radio', false);
  }
  assert.equal(h.timers.size, 0);
});

test('native pending Stop preserves selection completed before its own successful settlement', async () => {
  const f = radioSiblingFixture();
  const { h } = f;
  const stopReleased = deferred();
  f.radio.stopPlayback = () => stopReleased.promise;
  try {
    await f.manager.setEnabled('radio', true);
    await h.c.start();
    const ws = h.sockets[0];
    speechTurn(ws);
    request(ws, 'slow-selection', 'control_radio', {
      action: 'select',
      locationQuery: 'Deferred Place',
    });
    await f.lookupEntered.promise;
    request(ws, 'pending-stop', 'control_radio', { action: 'stop' });
    await tick();
    f.lookupReleased.resolve();
    await tick();
    assert.equal(responseFor(ws, 'slow-selection').ok, true);
    assert.equal(f.state.selected.id, 'late-station');
    assert.equal(h.c.radio.radioToolHandoffReservations.size, 1);
    assert.ok(h.c.radio.pendingRadioPlaybackResult);
    stopReleased.resolve(true);
    await h.c.toolQueue;
    assert.equal(responseFor(ws, 'pending-stop').ok, true);
    assert.equal(responseFor(ws, 'pending-stop').stationId, 'late-station');
    assert.equal(f.state.selected.id, 'late-station');
    assert.equal(h.c.radio.pendingRadioPlaybackResult, null);
    assert.equal(h.c.pendingTools, 0);
  } finally {
    stopReleased.resolve(false);
    f.lookupReleased.resolve();
    h.c.stop();
    f.runner.dispose();
    await f.manager.setEnabled('radio', false);
  }
  assert.equal(h.timers.size, 0);
});

for (const restart of [false, true]) {
  test(`native Stop${restart ? '/restart' : ''} retires concurrent stronger Radio work without late output or count underflow`, async () => {
    const f = radioSiblingFixture();
    const { h } = f;
    const stopReleased = deferred();
    f.radio.stopPlayback = () => stopReleased.promise;
    try {
      await f.manager.setEnabled('radio', true);
      await h.c.start();
      const ws = h.sockets[0];
      speechTurn(ws);
      request(ws, 'slow-selection', 'control_radio', {
        action: 'select',
        locationQuery: 'Deferred Place',
      });
      await f.lookupEntered.promise;
      request(ws, 'pending-stop', 'control_radio', { action: 'stop' });
      await tick();
      const oldDrain = h.c.toolQueue;
      const stopOptions = f.trace.options.get('pending-stop');
      assert.equal(h.c.pendingTools, 2);
      h.c.stop();
      assert.equal(stopOptions.signal.aborted, true);
      assert.equal(f.trace.lookupSignal.aborted, true);
      if (restart) {
        await h.c.start();
        request(h.sockets[1], 'new-query', 'control_radio', {
          action: 'status',
        });
        await h.c.toolQueue;
        assert.equal(responseFor(h.sockets[1], 'new-query').ok, true);
      }
      stopReleased.resolve(true);
      f.lookupReleased.resolve();
      await oldDrain;
      await tick();
      assert.equal(responseFor(ws, 'pending-stop'), undefined);
      assert.equal(responseFor(ws, 'slow-selection'), undefined);
      assert.equal(f.trace.selections, 0);
      assert.equal(h.c.pendingTools, 0);
      assert.equal(h.c.tools.size, 0);
      assert.equal(h.c.radio.radioToolHandoffReservations.size, 0);
      assert.equal(h.c.isActive(), restart);
    } finally {
      stopReleased.resolve(false);
      f.lookupReleased.resolve();
      h.c.stop();
      f.runner.dispose();
      await f.manager.setEnabled('radio', false);
    }
    assert.equal(h.timers.size, 0);
  });
}

for (const phase of ['prepared', 'preflight']) {
  test(`native same-turn Stop revokes only voice-owned ${phase} playback and preserves completed station`, async () => {
    const f = radioSiblingFixture();
    const { h } = f;
    const ready = deferred();
    const stopped = [];
    let preflight;
    f.radio.playForVoice = () => ready.promise;
    f.radio.stopPlayback = (options) => {
      stopped.push(options);
      return true;
    };
    try {
      await f.manager.setEnabled('radio', true);
      await h.c.start();
      const ws = h.sockets[0];
      speechTurn(ws);
      request(ws, 'prepared-play', 'control_radio', { action: 'play' });
      await h.c.toolQueue;
      assert.equal(
        responseFor(ws, 'prepared-play').radioPlaybackRequested,
        true,
      );
      if (phase === 'preflight')
        preflight = h.c.radio.startPendingRadioHandoff();
      const attemptId = h.c.radio.radioHandoffAttemptId;
      request(ws, 'stronger-stop', 'control_radio', { action: 'stop' });
      await h.c.toolQueue;
      assert.equal(responseFor(ws, 'stronger-stop').ok, true);
      assert.equal(f.state.selected.id, 'existing-station');
      assert.equal(h.c.radio.pendingRadioPlaybackResult, null);
      assert.equal(h.c.radio.radioHandoffInFlight, false);
      const cleanups = stopped.filter((o) => o.origin === 'voice-cleanup');
      assert.deepEqual(
        cleanups,
        phase === 'preflight' ? [{ origin: 'voice-cleanup', attemptId }] : [],
      );
      ready.resolve(true);
      await preflight;
      await tick();
      assert.equal(
        h.c.isActive(),
        true,
        'late old readiness cannot stop voice',
      );
      assert.equal(h.c.radio.radioToolHandoffReservations.size, 0);
      assert.equal(h.c.pendingTools, 0);
    } finally {
      ready.resolve(false);
      h.c.stop();
      await preflight;
      f.runner.dispose();
      await f.manager.setEnabled('radio', false);
    }
    assert.equal(h.timers.size, 0);
  });
}

for (const phase of ['prepared', 'preflight', 'settling']) {
  test(`native Radio cancellation: ${phase} preserves selection truth and prevents stale speaker transfer`, async () => {
    const viewer = viewerFixture();
    const manager = new DataLayerManager(viewer);
    const prepared = deferred();
    const settleResult = deferred();
    const playbackReady = deferred();
    let playCalls = 0;
    let stopCalls = 0;
    let selections = 0;
    let activeOptions;
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
      runner: async (name, args, options) => {
        activeOptions = options;
        const result = await runner(name, args, options);
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
      assert.equal(session.sendText('Select Station One on Radio'), true);
      request(ws, 'prepared-radio', 'control_radio', {
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
      // Native call ownership revokes only this deferred playback. No caption
      // parsing or caption-driven provider policy participates in cancellation.
      ws.message({ toolCallCancellation: { ids: ['prepared-radio'] } });
      if (phase === 'settling')
        assert.equal(activeOptions.signal.aborted, true);
      settleResult.resolve();
      await h.c.toolQueue;
      assert.equal(h.c.radio.pendingRadioPlaybackResult, null);
      assert.equal(h.c.radio.radioHandoffInFlight, false);
      assert.equal(manager.isEnabled('radio'), true);
      assert.equal(state.selected.id, 'station-1');
      assert.equal(selections, 1);
      const modelResult = responseFor(ws, 'prepared-radio');
      if (phase === 'settling')
        assert.equal(
          modelResult,
          undefined,
          'cancelled active call never sends a late result',
        );
      else {
        assert.equal(modelResult.ok, true);
        assert.equal(modelResult.stationId, 'station-1');
      }
      const stopsAfterCancellation = stopCalls;
      assert.equal(stopsAfterCancellation, phase === 'preflight' ? 1 : 0);
      drainRadioReply(h);
      playbackReady.resolve(true);
      await preflight;
      await tick();
      assert.equal(
        playCalls,
        phase === 'preflight' ? 1 : 0,
        'drain cannot revive cancelled playback',
      );
      assert.equal(h.c.isActive(), true, 'late readiness cannot stop voice');
      assert.equal(h.c.radio.radioHandoffInFlight, false);
      assert.equal(h.c.pendingTools, 0);
      assert.equal(h.c.tools.size, 0);
      assert.equal(session.sendText('Play radio'), true);
      request(ws, 'fresh-radio', 'control_radio', { action: 'play' });
      await h.c.toolQueue;
      assert.ok(h.c.radio.pendingRadioPlaybackResult);
      drainRadioReply(h);
      await tick();
      assert.equal(playCalls, phase === 'preflight' ? 2 : 1);
      assert.equal(
        h.c.isActive(),
        false,
        'fresh typed Radio handoff alone ends voice',
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
  });
}

// A stronger Radio control skips the ordered queue. An older Radio call still
// queued behind a slow sibling must not start after that control succeeded,
// while a failed control or a later call in the same turn keeps its order.
for (const [label, ids, stopOk, expectPending] of [
  [
    'older queued select is revoked by a later successful stop',
    ['slow', 'sel', 'stop'],
    true,
    false,
  ],
  [
    'a failed stop leaves the older queued select current',
    ['slow', 'sel', 'stop'],
    false,
    true,
  ],
  [
    'a select after the stop in the same turn still runs',
    ['slow', 'stop', 'sel'],
    true,
    true,
  ],
]) {
  test(`stronger Radio ordering: ${label}`, async () => {
    const viewer = viewerFixture();
    const manager = new DataLayerManager(viewer);
    const state = {
      stationCount: 2,
      selected: { id: 'existing', name: 'Existing' },
      audioState: 'stopped',
    };
    const radio = {
      id: 'radio',
      name: 'Radio',
      updateInterval: -1,
      async init() {},
      async enable() {},
      async disable() {},
      async update() {},
      getStats: () => ({ count: 2 }),
      getUIState: () => ({ ...state }),
      setVoiceDucked() {},
      pause() {
        state.audioState = 'paused';
        return true;
      },
      stopPlayback() {
        state.audioState = 'stopped';
        return stopOk;
      },
      selectRequestedStation() {
        state.selected = { id: 'late', name: 'Late' };
        return state.selected;
      },
      async playForVoice() {
        return true;
      },
      subscribePlaybackControls: () => () => {},
    };
    manager.register(radio);
    const runner = createGevActionRunner({
      viewer,
      dataManager: manager,
      placeSearch: {
        async geocode() {
          return { place: { lat: 10, lng: 20, label: 'Place' } };
        },
      },
    });
    const slow = deferred();
    const h = harness({
      dataManager: manager,
      radioLayer: radio,
      async runAction(name, args, options) {
        if (name === 'slow_sibling') {
          await slow.promise;
          return { ok: true, action: 'slow_sibling' };
        }
        if (name === 'control_radio' && args.action === 'stop' && !stopOk)
          return {
            ok: false,
            action: 'control_radio',
            error: 'Radio stop failed',
          };
        return runner(name, args, options);
      },
    });
    const calls = {
      slow: { id: 'slow', name: 'slow_sibling', args: {} },
      sel: {
        id: 'sel',
        name: 'control_radio',
        args: { action: 'select', locationQuery: 'Place' },
      },
      stop: { id: 'stop', name: 'control_radio', args: { action: 'stop' } },
    };
    try {
      await manager.setEnabled('radio', true);
      await h.c.start();
      const ws = h.sockets[0];
      speechTurn(ws);
      ws.message({ toolCall: { functionCalls: ids.map((id) => calls[id]) } });
      await tick();
      assert.equal(
        responseFor(ws, 'stop')?.ok,
        stopOk,
        'stop settles without waiting',
      );
      slow.resolve();
      await h.c.toolQueue;
      await tick();
      assert.equal(
        Boolean(h.c.radio.pendingRadioPlaybackResult),
        expectPending,
      );
      assert.equal(responseFor(ws, 'sel')?.ok, expectPending);
    } finally {
      slow.resolve();
      h.c.stop();
      runner.dispose();
      await manager.setEnabled('radio', false);
    }
    assert.equal(h.timers.size, 0);
  });
}
