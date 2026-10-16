// Native ownership replacements for historical Radio regression cases.
// Real Gemini controller, action runner, DataLayerManager and RealtimeRadio consumers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, tick, deferred } from './geminiNativeHarness.mjs';
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

for (const guard of [
  'malformed',
  'replay',
  'invalid-arguments',
  'provider-veto',
]) {
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
      if (guard === 'provider-veto')
        request(ws, 'provider-setter', 'set_voice_provider', {
          provider: 'openai',
        });
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
      if (guard === 'provider-veto') {
        assert.equal(
          responseFor(ws, 'stronger-radio').providerRequestBlocked,
          true,
        );
        assert.equal(trace.options.has('stronger-radio'), false);
      }
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

let historicalId = 35;
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
      const id = `H${historicalId++}`;
      test(`${id} native setter quarantine: chooser=${providerDropdown} ${JSON.stringify(segments)} ${tool.name}/${tool.args.action || 'off'} leaves unrelated Radio preflight intact`, async () => {
        const mutations = [];
        const runner = createGevActionRunner({
          viewer: viewerFixture(),
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
          speechTurn(ws);
          for (const text of segments)
            ws.message({ serverContent: { inputTranscription: { text } } });
          assert.equal(trace.pauses, 1);
          h.c.radio.radioLayer.playForVoice = () => playbackReady.promise;
          const prepared = {
            ok: true,
            action: 'control_radio',
            radioAction: 'play',
            radioPlaybackRequested: true,
          };
          h.c.radio.setPendingPlayback(prepared);
          preflight = h.c.radio.startPendingRadioHandoff();
          const handoffEpoch = h.c.radio.radioHandoffEpoch;
          const attemptId = h.c.radio.radioHandoffAttemptId;
          assert.equal(h.c.radio.radioHandoffInFlight, true);
          for (const [method, counter] of [
            ['reserveRadioToolHandoff', 'reservations'],
            ['registerTool', 'registered'],
          ]) {
            const original = h.c.radio[method].bind(h.c.radio);
            h.c.radio[method] = (...args) => {
              trace[counter]++;
              return original(...args);
            };
          }
          const started = h.c.narration.toolStarted.bind(h.c.narration);
          h.c.narration.toolStarted = (...args) => {
            trace.toolStarted++;
            return started(...args);
          };
          // The ordinary sibling is first: batch inspection must quarantine it
          // before any runner, reservation or Radio registration can begin.
          ws.message({
            toolCall: {
              functionCalls: [
                { id: 'refused-radio', ...tool },
                {
                  id: 'native-setter',
                  name: 'set_voice_provider',
                  args: { provider: 'openai' },
                },
              ],
            },
          });
          await h.c.toolQueue;
          for (const callId of ['refused-radio', 'native-setter']) {
            const result = responseFor(ws, callId);
            assert.equal(result.providerRequestBlocked, true);
            assert.equal(result.providerDropdown, providerDropdown);
            assert.match(
              result.say,
              providerDropdown ? /dropdown/ : /switch voice providers directly/,
            );
          }
          request(ws, 'later-radio', tool.name, tool.args);
          await h.c.toolQueue;
          assert.equal(
            responseFor(ws, 'later-radio').providerRequestBlocked,
            true,
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
          assert.equal(h.state.stopped, 0);
          assert.equal(h.c.stopAfterReply, false);
          h.c.sendTextCommand('Set visual style to night vision');
          ws.message({
            serverContent: { interrupted: true, turnComplete: true },
          });
          request(ws, 'fresh-style', 'set_visual_style', {
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
      });
    }
  }
}

for (const [index, phase] of ['initializing', 'committed'].entries()) {
  test(`H${53 + index} native late setter: ${phase} manager work retains commit truth and quarantines later sibling`, async () => {
    const viewer = viewerFixture();
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
    let h;
    let activeOptions;
    let runnerCalls = 0;
    const session = createVoiceSession({
      runner: (name, args, options) => {
        runnerCalls++;
        activeOptions = options;
        return runner(name, args, options);
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
    try {
      await session.start();
      const ws = h.sockets[0];
      speechTurn(ws);
      ws.message({
        serverContent: { inputTranscription: { text: 'use foo as my voi' } },
      });
      request(ws, 'inflight-layer', 'set_layer_visibility', {
        layerId: 'rocket-launches',
        enabled: true,
      });
      await initEntered.promise;
      if (phase === 'committed') await committed.promise;
      assert.equal(activeOptions.signal.aborted, false);
      assert.equal(
        activeOptions.userTurn,
        undefined,
        'captions never become runner authority',
      );
      ws.message({
        serverContent: { inputTranscription: { text: 'ce provider' } },
      });
      request(ws, 'native-setter', 'set_voice_provider', {
        provider: 'openai',
      });
      request(ws, 'denied-sibling', 'set_layer_visibility', {
        layerId: 'rocket-launches',
        enabled: false,
      });
      assert.equal(
        activeOptions.signal.aborted,
        false,
        'late setter cannot retroactively revoke already-started work',
      );
      initReleased.resolve();
      settlement.resolve();
      await h.c.toolQueue;
      const result = responseFor(ws, 'inflight-layer');
      assert.equal(result.ok, true);
      assert.equal(result.providerRequestBlocked, undefined);
      assert.equal(result.enabled, true);
      assert.equal(manager.isEnabled('rocket-launches'), true);
      assert.equal(calls.includes('enable'), true);
      assert.equal(
        events.some((event) => event.type === 'visibility' && event.enabled),
        true,
      );
      assert.equal(
        responseFor(ws, 'native-setter').providerRequestBlocked,
        true,
      );
      assert.equal(
        responseFor(ws, 'denied-sibling').providerRequestBlocked,
        true,
      );
      assert.equal(runnerCalls, 1);
      session.sendText('Hide missions');
      ws.message({ serverContent: { interrupted: true, turnComplete: true } });
      request(ws, 'fresh-missions', 'set_layer_visibility', {
        layerId: 'rocket-launches',
        enabled: false,
      });
      await h.c.toolQueue;
      assert.equal(responseFor(ws, 'fresh-missions').ok, true);
      assert.equal(manager.isEnabled('rocket-launches'), false);
      assert.equal(runnerCalls, 2);
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
  });
}

for (const [chooserIndex, providerDropdown] of [false, true].entries()) {
  for (const [phaseIndex, phase] of [
    'prepared',
    'preflight',
    'settling',
  ].entries()) {
    test(`H${55 + chooserIndex * 3 + phaseIndex} native Radio cancellation: ${phase} chooser=${providerDropdown} preserves selection truth and prevents stale speaker transfer`, async () => {
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
        providerDropdown: () => providerDropdown,
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
