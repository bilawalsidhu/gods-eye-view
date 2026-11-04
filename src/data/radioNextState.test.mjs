// Radio selection, fallbacks and voice handoffs on the real layer and its published view.
import assert from 'node:assert/strict';
import test from 'node:test';
import { radioLayer } from './radio.js';
import { setLocale } from '../i18n/index.js';
import { renderRadioState } from '../ui/radioPresentation.js';
import { radioStationRow, withRadioLayer } from '../testSupport/radioLayerHarness.mjs';

const READY = 'Ready — playback starts only from your action';
const ids = [1, 2, 3].map((n) => `00000000-0000-4000-8000-00000000009${n}`);
const stations = ids.map((id, index) => radioStationRow({
  id,
  name: `Station ${'ABC'[index]}`,
  lat: 30 + index,
  lon: -97 - index,
  streamUrl: `https://radio.example.com/${'abc'[index]}.mp3`,
}));
const withLayer = (failingUrls, body) => withRadioLayer({ stations, failingUrls }, body);
const settle = () => new Promise((resolve) => setTimeout(resolve));

// What the Radio panel and the Cockpit player show for a state.
function render(state) {
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: () => null, activeElement: null };
  try {
    let view = null;
    const host = {
      destroyed: false,
      _radioPanel: {},
      store: { publish: (published) => (view = published), publishTuner() {} },
      actions: {
        getLifecycle: () => null,
        preservePanelStateDuringClear: () => false,
        setPanelCollapsed() {},
        scheduleLayout() {},
      },
    };
    renderRadioState.call(host, state);
    return {
      status: view.playback.text,
      error: Boolean(view.playback.error),
      button: view.transport.play.text,
      stopDisabled: view.transport.stopDisabled,
      cockpit: view.cockpit.play.glyph,
    };
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

const readyToPlay = { status: READY, error: false, button: 'PLAY', stopDisabled: true, cockpit: '▶' };

test('Next before Play only selects, and Play tries just that station', async () => {
  await withLayer([stations[1].streamUrl], async ({ playUrls }) => {
    radioLayer.selectStation(ids[0], { autoplay: false });
    assert.equal(radioLayer.cycleStation(1, { stationIds: ids, autoplay: false, origin: 'user' }), true);
    await settle();
    assert.deepEqual(playUrls, []);
    assert.equal(radioLayer.getUIState().audioState, 'stopped');
    await radioLayer.togglePlayback({ origin: 'user' });
    await settle();
    const state = radioLayer.getUIState();
    assert.deepEqual(playUrls, [stations[1].streamUrl], 'no fallback picked by the silent step');
    assert.equal(state.selected?.id, ids[1]);
    assert.equal(state.audioState, 'error');
  });
});

test('Next after a failed stream leaves the new station ready to play, without the old error', async () => {
  setLocale('en');
  await withLayer([stations[0].streamUrl], async ({ playUrls }) => {
    radioLayer.selectStation(ids[0], { autoplay: true, origin: 'user' });
    await settle();
    assert.equal(radioLayer.getUIState().audioState, 'error');
    assert.equal(radioLayer.cycleStation(1, { stationIds: ids, autoplay: false, origin: 'user' }), true);
    const state = radioLayer.getUIState();
    assert.equal(state.selected?.id, ids[1]);
    assert.equal(state.audioState, 'stopped');
    assert.equal(state.playingStationId, null);
    assert.deepEqual(render(state), readyToPlay);
    await radioLayer.togglePlayback({ origin: 'user' });
    assert.deepEqual(playUrls, [stations[0].streamUrl, stations[1].streamUrl]);
    assert.equal(radioLayer.getUIState().playingStationId, ids[1]);
  });
});

test('Next while paused releases the paused stream, and Play starts the new station', async () => {
  setLocale('en');
  await withLayer([], async ({ playUrls }) => {
    radioLayer.selectStation(ids[0], { autoplay: true, origin: 'user' });
    await settle();
    await radioLayer.togglePlayback({ origin: 'user' });
    assert.equal(radioLayer.getUIState().audioState, 'paused');
    radioLayer.cycleStation(1, { stationIds: ids, autoplay: false, origin: 'user' });
    const state = radioLayer.getUIState();
    assert.equal(state.selected?.id, ids[1]);
    assert.equal(state.audioState, 'stopped');
    assert.equal(state.playingStationId, null);
    assert.deepEqual(render(state), readyToPlay);
    await radioLayer.togglePlayback({ origin: 'user' });
    assert.deepEqual(playUrls, [stations[0].streamUrl, stations[1].streamUrl]);
    assert.equal(radioLayer.getUIState().audioState, 'playing');
    assert.equal(radioLayer.getUIState().playingStationId, ids[1]);
  });
});

test('a catalog refresh after a paused Next cannot bring back Resume for an unnamed station', async () => {
  setLocale('en');
  await withLayer([], async ({ catalog }) => {
    radioLayer.selectStation(ids[0], { autoplay: true, origin: 'user' });
    await settle();
    await radioLayer.togglePlayback({ origin: 'user' });
    radioLayer.cycleStation(1, { stationIds: ids, autoplay: false, origin: 'user' });
    catalog.rows = stations.filter(({ id }) => id !== ids[1]);
    catalog.generation = 2;
    await radioLayer.update();
    const state = radioLayer.getUIState();
    assert.equal(state.selected, null);
    assert.equal(state.audioState, 'stopped');
    const shown = render(state);
    assert.equal(shown.status, READY);
    assert.equal(shown.button, 'PLAY');
  });
});

test('a voice station request after a voice pause keeps the fallback of that request', async () => {
  const failing = [];
  await withLayer(failing, async ({ playUrls }) => {
    radioLayer.selectStation(ids[0], { autoplay: true, origin: 'user' });
    await settle();
    radioLayer.pause({ origin: 'voice-duck' });
    playUrls.length = 0;
    // Anchor on the far station so the paused one is not the first match.
    const first = radioLayer.selectRequestedStation(
      { categoryId: 'all', anchor: { lat: 32, lon: -99 } },
      { autoplay: false },
    );
    failing.push(first.streamUrl);
    await radioLayer.play({ origin: 'voice' });
    await settle();
    await settle();
    assert.equal(playUrls.length, 2);
    assert.equal(playUrls[0], first.streamUrl);
    assert.equal(radioLayer.getUIState().audioState, 'playing');
  });
});

test('a cancelled voice step leaves no fallback for a later Play from the panel', async () => {
  await withLayer([stations[1].streamUrl], async ({ playUrls }) => {
    radioLayer.selectStation(ids[0], { autoplay: false });
    radioLayer.cycleStation(1, { stationIds: ids, autoplay: false, fallback: true, origin: 'voice' });
    // The handoff is cancelled (barge-in), so voice never starts playback.
    await settle();
    await radioLayer.togglePlayback({ origin: 'user' });
    await settle();
    await settle();
    const state = radioLayer.getUIState();
    assert.deepEqual(playUrls, [stations[1].streamUrl]);
    assert.equal(state.selected?.id, ids[1]);
    assert.equal(state.audioState, 'error');
  });
});

test('only a user step to another station tells voice to drop its prepared playback', async () => {
  await withLayer([], async () => {
    const controls = [];
    const unsubscribe = radioLayer.subscribePlaybackControls((event) => controls.push(event));
    try {
      radioLayer.cycleStation(1, { stationIds: ids, autoplay: false, fallback: true, origin: 'voice' });
      radioLayer.cycleStation(1, { stationIds: ids, autoplay: false, origin: 'user' });
      radioLayer.cycleStation(1, { stationIds: [ids[1]], autoplay: false, origin: 'user' });
    } finally {
      unsubscribe();
    }
    assert.equal(radioLayer.getUIState().selected?.id, ids[1]);
    assert.deepEqual(controls.map(({ action, origin }) => [action, origin]), [['select', 'user']]);
  });
});

test('an unavailable tuner release stops the paused stream once, and Play still falls back', async () => {
  setLocale('en');
  const failing = [];
  await withLayer(failing, async ({ playUrls, catalog }) => {
    radioLayer.selectStation(ids[2], { autoplay: true, origin: 'user' });
    await settle();
    assert.equal(radioLayer.beginTuning(), true);
    radioLayer.previewTuningStation(ids[1], { rotate: false });
    // A directory refresh changes the station under the needle mid-drag.
    catalog.rows = stations.map((row) => row.id === ids[1]
      ? { ...row, streamUrl: 'https://radio.example.com/b2.mp3' }
      : row);
    catalog.generation = 2;
    await radioLayer.update();
    const states = [];
    const controls = [];
    const unsubscribe = radioLayer.subscribe((state) => states.push(state));
    const unsubscribeControls = radioLayer.subscribePlaybackControls((event) => controls.push(event));
    states.length = 0;
    try {
      assert.equal(radioLayer.commitTuningStation(ids[1], { origin: 'user' }).reason, 'station-unavailable');
    } finally {
      unsubscribe();
      unsubscribeControls();
    }
    assert.equal(states.length, 1);
    assert.equal(states[0].tuningUnavailableStationId, ids[1]);
    assert.deepEqual(controls.map(({ action, origin }) => [action, origin]), [['stop', 'user']]);
    const state = radioLayer.getUIState();
    assert.equal(state.selected, null);
    assert.equal(state.audioState, 'stopped');
    assert.equal(state.playingStationId, null);
    assert.equal(render(state).button, 'PLAY');
    playUrls.length = 0;
    // Play picks the nearest station; its broadcaster fails.
    const play = globalThis.Audio.prototype.play;
    globalThis.Audio.prototype.play = function playFirstFails() {
      if (!failing.length) failing.push(this.src);
      return play.call(this);
    };
    try {
      await radioLayer.togglePlayback({ origin: 'user' });
      await settle();
      await settle();
    } finally {
      globalThis.Audio.prototype.play = play;
    }
    assert.equal(playUrls.length, 2);
    assert.equal(radioLayer.getUIState().audioState, 'playing');
  });
});

test('while a stream connects the transport buttons offer Pause, because a click pauses', () => {
  setLocale('en');
  const shown = render({
    enabled: true,
    audioState: 'loading',
    audioError: null,
    selected: { id: 'a', name: 'Station A' },
    selectedIndex: 0,
    filteredCount: 1,
    stationCount: 1,
    volume: 1,
  });
  assert.equal(shown.status, 'Connecting directly to broadcaster…');
  assert.equal(shown.button, 'PAUSE');
  assert.equal(shown.cockpit, 'Ⅱ');
});

test('a dial release plays only if a stream was active when the drag began', async () => {
  await withLayer([], async ({ playUrls }) => {
    radioLayer.selectStation(ids[0], { autoplay: false });
    assert.equal(radioLayer.beginTuning(), true);
    radioLayer.previewTuningStation(ids[1], { rotate: false });
    assert.equal(radioLayer.commitTuningStation(ids[1], { origin: 'user' }).ok, true);
    await settle();
    let state = radioLayer.getUIState();
    assert.deepEqual(playUrls, []);
    assert.equal(state.selected?.id, ids[1]);
    assert.equal(state.audioState, 'stopped');
    assert.equal(state.tuningStatic, false);

    await radioLayer.togglePlayback({ origin: 'user' });
    assert.equal(radioLayer.beginTuning(), true);
    radioLayer.previewTuningStation(ids[2], { rotate: false });
    radioLayer.commitTuningStation(ids[2], { origin: 'user' });
    await settle();
    state = radioLayer.getUIState();
    assert.deepEqual(playUrls, [stations[1].streamUrl, stations[2].streamUrl]);
    assert.equal(state.audioState, 'playing');
    assert.equal(state.playingStationId, ids[2]);
  });
});

// Like Chrome, resume() flips `state` only once the device starts, and suspend()
// on a context that is still suspended resolves at once without effect.
const RESUME_MS = 5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function withFakeAudioContext(body) {
  const log = { contexts: [], sources: [] };
  const node = () => ({ connect() {}, disconnect() {} });
  class FakeAudioContext {
    constructor() {
      Object.assign(this, { state: 'suspended', sampleRate: 8000, currentTime: 0, destination: {} });
      log.contexts.push(this);
    }
    resume() {
      if (this.state === 'running') return Promise.resolve();
      return new Promise((resolve) => setTimeout(() => {
        if (this.state !== 'closed') this.state = 'running';
        resolve();
      }, RESUME_MS));
    }
    suspend() {
      if (this.state === 'running') this.state = 'suspended';
      return Promise.resolve();
    }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createBuffer(_channels, length) { return { getChannelData: () => new Float32Array(length) }; }
    createBufferSource() {
      const source = { ...node(), started: false, stopped: false, start() { this.started = true; }, stop() { this.stopped = true; } };
      log.sources.push(source);
      return source;
    }
    createBiquadFilter() { return { ...node(), frequency: { value: 0 }, Q: { value: 0 } }; }
    createGain() {
      return { ...node(), gain: { value: 0, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} } };
    }
  }
  const original = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;
  return Promise.resolve(body(log)).finally(() => {
    if (original === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = original;
  });
}

test('a silent dial release stops the tuner noise and suspends its audio context, even before resume() settles', async () => {
  await withFakeAudioContext(async ({ contexts, sources }) => {
    await withLayer([], async ({ playUrls }) => {
      radioLayer.selectStation(ids[0], { autoplay: false });
      assert.equal(radioLayer.beginTuning(), true);
      radioLayer.previewTuningStation(ids[1], { rotate: false });
      assert.equal(radioLayer.commitTuningStation(ids[1], { origin: 'user' }).ok, true);
      await sleep(RESUME_MS * 4);
      assert.deepEqual(playUrls, []);
      assert.equal(sources[0].started, true);
      assert.equal(sources[0].stopped, true, 'noise source still looping');
      assert.equal(contexts[0].state, 'suspended', 'audio context still running');
    });
  });
});

test('a second gesture before the first resume() settles keeps its noise graph', async () => {
  await withFakeAudioContext(async ({ contexts, sources }) => {
    await withLayer([], async () => {
      radioLayer.selectStation(ids[0], { autoplay: false });
      radioLayer.beginTuning();
      radioLayer.commitTuningStation(ids[0], { origin: 'user' });
      assert.equal(radioLayer.beginTuning(), true);
      await sleep(RESUME_MS * 4);
      assert.equal(contexts[0].state, 'running', 'second gesture lost its context');
      assert.equal(sources.at(-1).stopped, false, 'second gesture lost its source');
      radioLayer.commitTuningStation(ids[1], { origin: 'user' });
      await sleep(RESUME_MS * 4);
      assert.equal(sources.at(-1).stopped, true);
      assert.equal(contexts[0].state, 'suspended');
    });
  });
});

test('a dial release from a paused stream only selects, without static', async () => {
  await withFakeAudioContext(async ({ contexts }) => {
    await withLayer([], async ({ playUrls }) => {
      radioLayer.selectStation(ids[0], { autoplay: true, origin: 'user' });
      await settle();
      await radioLayer.togglePlayback({ origin: 'user' });
      assert.equal(radioLayer.getUIState().audioState, 'paused');
      assert.equal(radioLayer.beginTuning(), true);
      await sleep(RESUME_MS * 4);
      radioLayer.previewTuningStation(ids[1], { rotate: false });
      radioLayer.commitTuningStation(ids[1], { origin: 'user' });
      await sleep(RESUME_MS * 4);
      const state = radioLayer.getUIState();
      assert.deepEqual(playUrls, [stations[0].streamUrl]);
      assert.equal(state.selected?.id, ids[1]);
      assert.equal(state.audioState, 'stopped');
      assert.equal(state.tuningStatic, false);
      assert.equal(state.tuningAwaitingStationId, null);
      assert.equal(contexts[0].state, 'suspended');
    });
  });
});

test('a dial release while a stream is still connecting plays the new station', async () => {
  await withLayer([], async ({ playUrls }) => {
    radioLayer.selectStation(ids[0], { autoplay: true, origin: 'user' });
    assert.equal(radioLayer.getUIState().audioState, 'loading');
    assert.equal(radioLayer.beginTuning(), true);
    radioLayer.previewTuningStation(ids[1], { rotate: false });
    radioLayer.commitTuningStation(ids[1], { origin: 'user' });
    await settle();
    const state = radioLayer.getUIState();
    assert.equal(playUrls.at(-1), stations[1].streamUrl);
    assert.equal(state.audioState, 'playing');
    assert.equal(state.playingStationId, ids[1]);
  });
});

test('a silent user step drops the fallback a voice step left behind', async () => {
  await withLayer(stations.map(({ streamUrl }) => streamUrl), async ({ playUrls }) => {
    radioLayer.selectStation(ids[0], { autoplay: false });
    // Voice steps to B and keeps C as its fallback; the user steps back to A.
    radioLayer.cycleStation(1, { stationIds: ids, autoplay: false, fallback: true, origin: 'voice' });
    radioLayer.cycleStation(-1, { stationIds: ids, autoplay: false, origin: 'user' });
    await radioLayer.play({ origin: 'voice' });
    await settle();
    await settle();
    assert.deepEqual(playUrls, [stations[0].streamUrl]);
    assert.equal(radioLayer.getUIState().audioState, 'error');
  });
});

test('a silent dial release drops the fallback a voice step left behind', async () => {
  await withLayer(stations.map(({ streamUrl }) => streamUrl), async ({ playUrls }) => {
    radioLayer.selectStation(ids[0], { autoplay: false });
    radioLayer.cycleStation(1, { stationIds: ids, autoplay: false, fallback: true, origin: 'voice' });
    assert.equal(radioLayer.beginTuning(), true);
    radioLayer.previewTuningStation(ids[0], { rotate: false });
    radioLayer.commitTuningStation(ids[0], { origin: 'user' });
    await radioLayer.play({ origin: 'voice' });
    await settle();
    await settle();
    assert.deepEqual(playUrls, [stations[0].streamUrl]);
    assert.equal(radioLayer.getUIState().audioState, 'error');
  });
});
