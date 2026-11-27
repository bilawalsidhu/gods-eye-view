// Radio's source switch: the internet stations, or a local USB receiver.
// With the local receiver chosen no station directory is read and no
// station is drawn, the internet stream stops, and the row shows the
// receiver's card instead of the station steps.
import test from 'node:test';
import assert from 'node:assert/strict';
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

class FakeAudio {
  constructor() {
    this.src = '';
    this.paused = true;
    this.volume = 1;
    this.listeners = {};
  }
  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }
  play() {
    this.paused = false;
    for (const listener of this.listeners.playing || []) listener();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    for (const listener of this.listeners.pause || []) listener();
  }
  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }
  load() {}
}

async function radio(t) {
  const realAudio = globalThis.Audio;
  globalThis.Audio = FakeAudio;
  t.after(() => {
    globalThis.Audio = realAudio;
  });
  const reads = [];
  const source = {
    getDirectory: async () => {
      reads.push(Date.now());
      return {
        stations: [
          station(ID_A, 'Radio A', 41.39, 2.17),
          station(ID_B, 'Radio B', 41.4, 2.18),
        ],
        stale: false,
        degraded: false,
        updatedAt: new Date().toISOString(),
        acceptedGeneration: 1,
        catalogInstance: 'test',
      };
    },
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
  const viewer = { scene: { requestRender() {} } };
  const camera = { pose: () => null, on: () => () => {} };
  const { draw, unbind } = bindFakeDraw(viewer, {
    camera,
    input: { on: () => () => {} },
    query: { pick: () => null },
  });
  t.after(unbind);
  const manager = new DataLayerManager(viewer);
  manager.register(layer);
  t.after(() => manager.destroyAll());
  const drawn = () =>
    [...draw.sets.values()]
      .filter((set) => !set.disposed && set.show)
      .reduce((count, set) => count + set.items.size, 0);
  const choose = (value) =>
    manager.setLayerParams('radio', { source: value }, { origin: 'user' });
  return { layer, manager, drawn, reads, choose, source };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the Radio row offers Internet stations or Local receiver, Internet stations first and chosen', async (t) => {
  const { layer, manager } = await radio(t);
  await manager.setEnabled('radio', true, { origin: 'user' });
  await layer.update();
  const row = layer.getRowControls();
  assert.equal(row.segmented.id, 'radio-source');
  assert.deepEqual(
    row.segmented.options.map((option) => [option.label, option.active]),
    [
      ['Internet stations', true],
      ['Local receiver', false],
    ],
  );
  assert.deepEqual(row.segmented.options[1].params, { source: 'local' });
  assert.equal(row.panel, undefined, 'no receiver card for the stations');
  assert.ok(row.chips.length > 0, 'the station steps');
  assert.equal(manager.getLayerParams('radio').source, 'internet');
});

test('Local receiver stops the internet stream, draws no station, reads no directory and shows the receiver card on the row', async (t) => {
  const { layer, manager, drawn, reads, choose } = await radio(t);
  await manager.setEnabled('radio', true, { origin: 'user' });
  await layer.update();
  layer.selectStation(ID_A, { autoplay: true, origin: 'user' });
  await settle();
  assert.equal(layer.getUIState().audioState, 'playing');
  assert.ok(drawn() > 0);

  choose('local');
  let ui = layer.getUIState();
  assert.equal(ui.audioState, 'stopped', 'the internet stream stops');
  assert.equal(drawn(), 0, 'no station drawn');
  assert.equal(ui.enabled, false, 'no internet stations to show');
  assert.equal(ui.localReceiver, true);
  assert.equal(ui.source, 'local');
  const row = layer.getRowControls();
  assert.equal(row.panel, 'sdr-radio-card', 'the receiver card on the row');
  assert.deepEqual(row.chips, [], 'no station steps');
  assert.equal(row.segmented.options[1].active, true);
  assert.equal(
    layer.selectStation(ID_B, { autoplay: true, origin: 'user' }),
    false,
    'no station is picked meanwhile',
  );
  const before = reads.length;
  await layer.update();
  assert.equal(reads.length, before, 'no directory read');
  assert.equal(manager.getLayerParams('radio').source, 'local', 'kept');

  choose('internet');
  ui = layer.getUIState();
  assert.equal(ui.enabled, true);
  assert.equal(ui.localReceiver, false);
  assert.ok(drawn() > 0, 'the stations are drawn again');
});

test('only a source preference publication identifies who chose the receiver', async (t) => {
  const { layer, manager } = await radio(t);
  const choices = [];
  const off = layer.subscribe((state, sourceOrigin) => {
    if (sourceOrigin) choices.push([state.source, sourceOrigin]);
  });
  t.after(off);
  manager.setLayerParams(
    'radio',
    { source: 'local' },
    { origin: 'share-link' },
  );
  manager.setLayerParams(
    'radio',
    { source: 'local', volume: 0.3 },
    { origin: 'user' },
  );
  manager.setLayerParams('radio', { source: 'internet' }, { origin: 'user' });
  assert.deepEqual(choices, [
    ['local', 'share-link'],
    ['internet', 'user'],
  ]);
});

test('Radio turned on with the local receiver chosen reads no directory and draws nothing', async (t) => {
  const { layer, manager, drawn, reads, choose } = await radio(t);
  choose('local');
  await manager.setEnabled('radio', true, { origin: 'user' });
  await layer.update();
  assert.equal(reads.length, 0);
  assert.equal(drawn(), 0);
  assert.equal(layer.getUIState().localReceiver, true);
  // Back to the stations, they are read at once.
  choose('internet');
  await settle();
  assert.equal(reads.length, 1);
});

test('with Local receiver chosen no internet station plays, pinned or resumed, until the user switches back', async (t) => {
  const { layer, manager, choose } = await radio(t);
  await manager.setEnabled('radio', true, { origin: 'user' });
  await layer.update();
  layer.selectStation(ID_A, { autoplay: true, origin: 'user' });
  await settle();
  assert.equal(layer.getUIState().audioState, 'playing');
  choose('local');
  assert.equal(layer.getUIState().audioState, 'stopped');

  // A pinned station's Play, and Play on the station still selected.
  assert.equal(layer.playStation(ID_B, { origin: 'user' }), false);
  assert.equal(await layer.togglePlayback({ origin: 'user' }), false);
  await settle();
  let ui = layer.getUIState();
  assert.notEqual(ui.audioState, 'playing', 'no internet stream');
  assert.notEqual(ui.audioState, 'loading');
  assert.equal(ui.source, 'local', 'the source stays Local receiver');

  choose('internet');
  assert.equal(layer.playStation(ID_B, { origin: 'user' }), true);
  await settle();
  ui = layer.getUIState();
  assert.equal(ui.audioState, 'playing');
  assert.equal(ui.playingStationId, ID_B);
});

test('local receiver stats omit a cached internet directory failure', async (t) => {
  const { layer, manager, choose, source } = await radio(t);
  await manager.setEnabled('radio', true, { origin: 'user' });
  await layer.update();
  source.getDirectory = async () => {
    throw new Error('offline directory');
  };
  await layer.update();
  const directory = layer.getStats();
  assert.ok(directory.error);
  assert.ok(directory.lastUpdate);
  choose('local');
  const local = layer.getStats();
  assert.equal(local.error, null);
  assert.equal(local.lastUpdate, null);
  assert.equal(local.stale, false);
  assert.equal(local.degraded, false);
  assert.equal(local.loading, false);
  choose('internet');
  const restored = layer.getStats();
  for (const field of [
    'count',
    'error',
    'lastUpdate',
    'stale',
    'degraded',
    'loading',
  ])
    assert.equal(restored[field], directory[field], field);
});

test('returning from Local refreshes an expired or interrupted directory and keeps cached stations offline', async (t) => {
  const { layer, manager, reads, choose, source } = await radio(t);
  await manager.setEnabled('radio', true, { origin: 'user' });
  await layer.update();
  const initial = reads.length;
  const cached = layer.getStats();
  let now = cached.lastUpdate;
  t.mock.method(Date, 'now', () => now);
  choose('local');
  choose('internet');
  assert.equal(reads.length, initial, 'fresh cache needs no new request');

  const inFlight = Promise.withResolvers();
  let requests = 0;
  let signal;
  source.getDirectory = (options) => {
    signal = options.signal;
    requests++;
    if (requests === 1) return inFlight.promise;
    return Promise.reject(new Error('offline'));
  };
  const pending = layer.update();
  choose('local');
  assert.equal(signal.aborted, true);
  choose('internet');
  await settle();
  assert.equal(
    requests,
    2,
    'retry the interrupted request despite a young cache',
  );
  inFlight.reject(new Error('cancelled'));
  await pending;
  assert.equal(layer.getStats().count, cached.count);
  assert.equal(layer.getStats().stale, true);
  choose('local');
  now += layer.updateInterval;
  await layer.update();
  assert.equal(requests, 2, 'no internet read while Local owns the source');
  choose('internet');
  await settle();
  assert.equal(requests, 3, 'retry when the cached directory has aged out');
  assert.equal(layer.getStats().lastUpdate, cached.lastUpdate);
  assert.equal(layer.getStats().count, cached.count);
  assert.equal(layer.getUIState().audioState, 'stopped');
});
