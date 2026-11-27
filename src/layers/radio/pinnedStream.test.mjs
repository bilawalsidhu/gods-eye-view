// A pinned station plays on through Clear all and Radio off, as a docked
// view stays live: the layer stops every other stream as it turns off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { controlRadio } from '../../voice/gevActions.js';
import { RealtimeRadio } from '../../voice/realtimeRadio.js';
import { DataLayerManager } from '../../data/manager.js';
import { createRadioLayer } from './index.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';
const station = (id, name, lat, lon) => ({
  id,
  name,
  lat,
  lon,
  streamUrl: `https://stream.example.com/${name.replace(/\W/g, '')}`,
  homepage: null,
  tags: ['news'],
  languages: ['english'],
  state: '',
  country: 'Spain',
  countryCode: 'ES',
  metadataTrust: 'untrusted-community',
  codec: 'MP3',
  bitrate: 128,
});

/** An audio element that records what is done to it. */
class FakeAudio {
  static made = [];
  constructor() {
    this.src = '';
    this.paused = true;
    this.volume = 1;
    this.listeners = {};
    this.log = [];
    FakeAudio.made.push(this);
  }
  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }
  play() {
    this.paused = false;
    this.log.push('play');
    for (const listener of this.listeners.playing || []) listener();
    return Promise.resolve();
  }
  pause() {
    if (!this.paused) this.log.push('pause');
    this.paused = true;
    for (const listener of this.listeners.pause || []) listener();
  }
  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }
  load() {
    this.log.push('load');
  }
}

async function radioOnWithStation(t, extraStations = []) {
  const realAudio = globalThis.Audio;
  globalThis.Audio = FakeAudio;
  FakeAudio.made = [];
  t.after(() => {
    globalThis.Audio = realAudio;
  });
  const source = {
    getDirectory: async () => ({
      stations: [
        station(ID_A, 'Radio A', 41.39, 2.17),
        { ...station(ID_B, 'Radio B', 41.4, 2.18), tags: ['music'] },
        ...extraStations,
      ],
      stale: false,
      degraded: false,
      updatedAt: new Date().toISOString(),
      acceptedGeneration: 1,
      catalogInstance: 'test',
    }),
    recordClick: async () => {},
  };
  const services = {
    ground: { cachedGroundFloor: () => null, warmGroundFloor() {} },
    picking: { registerPickOwner() {}, unregisterPickOwner() {} },
    globe: {},
    render: { governorRequestRender() {} },
    overlays: {
      clearOverlaySource() {},
      setOverlaySourceVisible() {},
      setOverlayEntries() {},
    },
  };
  const layer = createRadioLayer({ source, services });
  // A scene that draws into a fake port; a test moves its camera.
  const viewer = { scene: { requestRender() {} } };
  const moved = new Set();
  const camera = {
    pose: () => null,
    on: (event, cb) => {
      moved.add(cb);
      return () => moved.delete(cb);
    },
  };
  const input = { on: () => () => {} };
  const { draw, unbind } = bindFakeDraw(viewer, {
    camera,
    input,
    query: { pick: () => null },
  });
  t.after(unbind);
  const manager = new DataLayerManager(viewer);
  manager.register(layer);
  t.after(() => manager.destroyAll());
  assert.equal(
    await manager.setEnabled('radio', true, { origin: 'user' }),
    true,
  );
  await layer.update();
  assert.equal(layer.getUIState().stationCount, 2 + extraStations.length);
  const moveCamera = () => [...moved].forEach((cb) => cb());
  // The station dots drawn and shown right now.
  const drawn = () =>
    [...draw.sets.values()]
      .filter((set) => !set.disposed && set.show)
      .reduce((count, set) => count + set.items.size, 0);
  return { layer, manager, moveCamera, drawn };
}

async function play(layer, id) {
  layer.selectStation(id, { autoplay: true, origin: 'user' });
  await new Promise((resolve) => setImmediate(resolve));
  const state = layer.getUIState();
  assert.equal(state.audioState, 'playing');
  assert.equal(state.playingStationId, id);
  return FakeAudio.made.at(-1);
}

test('a pinned station playing as the layers are cleared plays on, live, without a pause or restart', async (t) => {
  const { layer, manager } = await radioOnWithStation(t);
  const pinned = new Set([ID_A]);
  layer.keepStreamWhenOff((id) => pinned.has(id));
  const audio = await play(layer, ID_A);
  const plays = audio.log.filter((entry) => entry === 'play').length;
  const heard = [];
  layer.subscribe((state) => heard.push(state.audioState));

  const result = await manager.clearSelectedLayers({ origin: 'user' });
  assert.deepEqual(result.clearedIds, ['radio']);
  const state = layer.getUIState();
  assert.equal(state.enabled, false, 'Radio is off');
  assert.equal(state.audioState, 'playing', 'the stream plays on');
  assert.equal(state.playingStationId, ID_A);
  assert.equal(state.selected?.id, ID_A, 'the station is still the one shown');
  assert.equal(audio.paused, false, 'never paused');
  assert.equal(
    audio.log.filter((entry) => entry === 'play').length,
    plays,
    'never restarted',
  );
  assert.ok(!audio.log.includes('load'), 'the stream was not released');
  assert.ok(
    !heard.some((each) => ['paused', 'stopped'].includes(each)),
    'no paused or stopped state on the way',
  );

  // Pausing still works with Radio off; stopping releases the stream.
  layer.pause({ origin: 'user' });
  assert.equal(layer.getUIState().audioState, 'paused');
  layer.stopPlayback({ origin: 'user' });
  assert.equal(layer.getUIState().audioState, 'stopped');
});

test('voice resumes the retained station through its muted handoff with Radio still off', async (t) => {
  const { layer, manager, drawn } = await radioOnWithStation(t);
  layer.keepStreamWhenOff((id) => id === ID_A);
  await play(layer, ID_A);
  await manager.setEnabled('radio', false, { origin: 'user' });
  layer.pause({ origin: 'user' });
  const channel = { readyState: 'open' };
  let handedOff = false;
  const voice = new RealtimeRadio({
    readRadioLayer: () => layer,
    readDataManager: () => manager,
    readChannel: () => channel,
    readUserTurnPending: () => false,
    readSessionId: () => 'test',
    operations: {
      debugLog() {},
      stop() {
        assert.equal(layer.getUIState().voiceDucked, true);
        handedOff = true;
      },
    },
  });
  const prepared = await controlRadio({}, manager, { action: 'resume' });
  assert.equal(manager.isEnabled('radio'), false);
  assert.equal(prepared.radioPlaybackRequested, true);
  assert.equal(layer.getUIState().audioState, 'paused');
  voice.setPendingPlayback(prepared);
  await voice.startPendingRadioHandoff();
  assert.equal(handedOff, true);
  assert.equal(layer.getUIState().playingStationId, ID_A);
  assert.equal(layer.getUIState().audioState, 'playing');
  assert.equal(FakeAudio.made.at(-1).paused, false);
  assert.equal(drawn(), 0);

  layer.stopPlayback({ origin: 'user' });
  assert.equal(await layer.playForVoice({ resumeStationId: ID_A }), false);
  assert.equal(layer.getUIState().audioState, 'stopped');
});

test('a station that is not pinned stops as Radio turns off', async (t) => {
  const { layer, manager } = await radioOnWithStation(t);
  layer.keepStreamWhenOff((id) => id === ID_A);
  const audio = await play(layer, ID_B);
  await manager.setEnabled('radio', false, { origin: 'user' });
  assert.equal(layer.getUIState().audioState, 'stopped');
  assert.equal(audio.paused, true);
});

test('a pinned stream plays on as Radio turns back on, and stops when the layer is destroyed', async (t) => {
  const { layer, manager } = await radioOnWithStation(t);
  layer.keepStreamWhenOff((id) => id === ID_A);
  const audio = await play(layer, ID_A);
  await manager.setEnabled('radio', false, { origin: 'user' });
  await manager.setEnabled('radio', true, { origin: 'user' });
  assert.equal(layer.getUIState().audioState, 'playing');
  assert.equal(audio.paused, false);
  layer.destroy();
  assert.equal(audio.paused, true, 'nothing plays on after the layer goes');
});

test('a station plays with Radio off without turning the layer on or drawing it', async (t) => {
  const { layer, manager, drawn } = await radioOnWithStation(t);
  assert.ok(drawn() > 0, 'drawn while Radio is on');
  await manager.setEnabled('radio', false, { origin: 'user' });
  assert.equal(drawn(), 0);
  assert.equal(layer.playStation(ID_B, { origin: 'user' }), true);
  await new Promise((resolve) => setImmediate(resolve));
  const state = layer.getUIState();
  assert.equal(state.audioState, 'playing');
  assert.equal(state.playingStationId, ID_B);
  assert.equal(state.playingStation?.name, 'Radio B');
  assert.equal(state.selected?.id, ID_B);
  assert.equal(manager.isEnabled('radio'), false, 'the layer stays off');
  assert.equal(state.enabled, false);
  assert.equal(drawn(), 0, 'no station markers drawn');
  assert.equal(FakeAudio.made.at(-1).paused, false);
  // Paused, it resumes with the layer still off.
  layer.pause({ origin: 'user' });
  await layer.togglePlayback({ origin: 'user' });
  assert.equal(layer.getUIState().audioState, 'playing');
  assert.equal(manager.isEnabled('radio'), false);
  assert.equal(
    layer.playStation('00000000-0000-4000-8000-0000000000ff'),
    false,
    'a station not in the catalogue',
  );
});

test('with Radio off, a step goes to the next station of the catalogue, the stream following, the layer off', async (t) => {
  const { layer, manager, drawn } = await radioOnWithStation(t);
  await play(layer, ID_A);
  layer.keepStreamWhenOff((id) => id === ID_A);
  await manager.setEnabled('radio', false, { origin: 'user' });
  assert.equal(layer.stepStationWhileOff(1, { origin: 'user' }), true);
  await new Promise((resolve) => setImmediate(resolve));
  const state = layer.getUIState();
  assert.equal(state.playingStationId, ID_B);
  assert.equal(state.audioState, 'playing');
  assert.equal(manager.isEnabled('radio'), false);
  assert.equal(drawn(), 0);
});

test('with no catalogue read, a step has nothing to step to', async (t) => {
  const services = {
    ground: { cachedGroundFloor: () => null, warmGroundFloor() {} },
    picking: { registerPickOwner() {}, unregisterPickOwner() {} },
    globe: {},
    render: { governorRequestRender() {} },
    overlays: {
      clearOverlaySource() {},
      setOverlaySourceVisible() {},
      setOverlayEntries() {},
    },
  };
  const layer = createRadioLayer({
    source: { getDirectory: async () => ({}) },
    services,
  });
  t.after(() => layer.destroy());
  assert.equal(layer.getUIState().filteredCount, 0);
  assert.equal(layer.stepStationWhileOff(1), false);
  assert.equal(layer.playStation(ID_A), false);
});

test('a pinned station stays paused through Radio off, and plays on through camera moves', async (t) => {
  const { layer, manager, moveCamera } = await radioOnWithStation(t);
  layer.keepStreamWhenOff((id) => id === ID_A);
  const audio = await play(layer, ID_A);
  moveCamera();
  moveCamera();
  assert.equal(layer.getUIState().audioState, 'playing');
  assert.equal(audio.paused, false);
  layer.pause({ origin: 'user' });
  await manager.setEnabled('radio', false, { origin: 'user' });
  const state = layer.getUIState();
  assert.equal(state.audioState, 'paused', 'still paused, not stopped');
  assert.equal(state.playingStationId, ID_A);
});

test('voice ducking lowers what is heard, not the user volume; a volume set meanwhile keeps the duck', async (t) => {
  const { layer } = await radioOnWithStation(t);
  const audio = await play(layer, ID_A);
  layer.setParams({ volume: 0.6 });
  assert.equal(audio.volume, 0.6);
  layer.setVoiceDucked(true);
  assert.equal(audio.volume, 0, 'ducked');
  assert.equal(
    layer.getUIState().volume,
    0.6,
    'the volume shown is the user volume',
  );
  layer.setParams({ volume: 0.3 });
  const state = layer.getUIState();
  assert.equal(state.volume, 0.3);
  assert.equal(state.voiceDucked, true, 'still ducked');
  assert.equal(audio.volume, 0, 'still silent under voice');
});

test('a single filtered station keeps its current stream and offers no row steps', async (t) => {
  const { layer } = await radioOnWithStation(t);
  const audio = await play(layer, ID_A);
  const rowChanges = [];
  layer.setRowControlsListener(() =>
    rowChanges.push(layer.getRowControls().chips.length),
  );
  layer.setParams({ filter: 'news' });
  assert.deepEqual(layer.getRowControls().chips, []);
  assert.equal(rowChanges.at(-1), 0);
  layer.cycleStation(1, { origin: 'user' });
  assert.equal(FakeAudio.made.at(-1), audio);
  layer.setParams({ filter: 'all' });
  assert.equal(rowChanges.at(-1), 2);
});

test('a pinned pending step reports a playback failure after Radio turns off', async (t) => {
  const { layer, manager } = await radioOnWithStation(t);
  await play(layer, ID_A);
  const pending = Promise.withResolvers();
  t.mock.method(FakeAudio.prototype, 'play', () => pending.promise);
  layer.keepStreamWhenOff((id) => id === ID_B);
  layer.cycleStation(1, { stationIds: [ID_A, ID_B] });
  await manager.setEnabled('radio', false, { origin: 'user' });
  assert.equal(layer.getUIState().audioState, 'loading');
  pending.reject(new Error('fixture playback failed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(layer.getUIState().audioState, 'error');
  assert.equal(layer.getUIState().selected.id, ID_B);
});

test('explicit pinned playback owns its failure after a pending station step', async (t) => {
  const idC = '00000000-0000-4000-8000-00000000000c';
  const { layer } = await radioOnWithStation(t, [
    station(idC, 'Radio C', 41.5, 2.2),
  ]);
  await play(layer, ID_A);
  const stepped = Promise.withResolvers();
  const pinned = Promise.withResolvers();
  const pending = [stepped.promise, pinned.promise];
  t.mock.method(FakeAudio.prototype, 'play', () => pending.shift());
  layer.cycleStation(1, { stationIds: [ID_A, ID_B] });
  assert.equal(layer.playStation(idC, { origin: 'user' }), true);
  const attempts = FakeAudio.made.length;
  pinned.reject(new Error('fixture playback failed'));
  stepped.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(layer.getUIState().audioState, 'error');
  assert.equal(layer.getUIState().selected.id, idC);
  assert.equal(FakeAudio.made.length, attempts);
});
