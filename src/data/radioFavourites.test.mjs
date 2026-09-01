import assert from 'node:assert/strict';
import test from 'node:test';
import radioLayer, { getRadioUIState } from './radio.js';

/** A directory-shaped station row (matches `isValidRadioDirectoryStation`). */
const stationRow = (suffix, overrides = {}) => ({
  id: `00000000-0000-4000-8000-0000000000${suffix}`,
  name: `Station ${suffix}`,
  lat: 30,
  lon: -97,
  streamUrl: `https://radio.example.com/${suffix}.mp3`,
  homepage: null,
  tags: ['news'],
  languages: ['English'],
  state: 'Texas',
  country: 'United States',
  countryCode: 'US',
  metadataTrust: 'untrusted-community',
  codec: 'MP3',
  bitrate: 128,
  ...overrides,
});

/** Boot the layer with a stubbed directory + audio, presentation-ready. */
async function bootRadio(catalogRows) {
  const originalAudio = globalThis.Audio;
  const originalFetch = globalThis.fetch;
  const audioInstances = [];
  globalThis.Audio = class FakeAudio {
    constructor() {
      this.volume = 0.8;
      this.src = '';
      this.currentSrc = '';
      this.listeners = new Map();
      this.playCalls = 0;
      audioInstances.push(this);
    }

    addEventListener(type, listener) { this.listeners.set(type, listener); }
    pause() {}
    play() { this.playCalls += 1; this.currentSrc = this.src; return new Promise(() => {}); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() {}
  };
  let rows = catalogRows;
  globalThis.fetch = async (url) => (String(url).startsWith('/api/radio/click/')
    ? { ok: true }
    : {
      ok: true,
      json: async () => ({
        stations: rows,
        updatedAt: new Date().toISOString(),
        stale: false,
        degraded: false,
        acceptedGeneration: 1,
        catalogInstance: 'fav-test-instance',
      }),
    });
  const viewer = {
    camera: { positionWC: { x: 7_000_000, y: 0, z: 0 }, flyTo() {} },
    scene: {
      // `disableRootEvents` makes Cesium's ScreenSpaceEventHandler skip the
      // document/window listeners that don't exist under node:test.
      canvas: { disableRootEvents: true, onwheel: null, addEventListener() {}, removeEventListener() {} },
      requestRender() {},
    },
    dataSources: { add() {}, remove() {} },
    entities: { add(entity) { return entity; }, remove() {} },
  };
  radioLayer.destroy();
  radioLayer.init(viewer);
  radioLayer.enable();
  await radioLayer.update();
  radioLayer.setLifecyclePresentation({ lifecycleState: 'enabled', enabled: true, uncertain: false });
  return {
    audioInstances,
    setCatalog: (next) => { rows = next; },
    teardown: () => {
      radioLayer.destroy();
      if (originalAudio === undefined) delete globalThis.Audio; else globalThis.Audio = originalAudio;
      if (originalFetch === undefined) delete globalThis.fetch; else globalThis.fetch = originalFetch;
    },
  };
}

test('pinStation validates the record and reflects in getUIState', async () => {
  const ctx = await bootRadio([stationRow('01')]);
  try {
    assert.equal(radioLayer.pinStation({ id: 'not-a-uuid', name: '' }), false, 'malformed rejected');
    assert.equal(radioLayer.pinStation(stationRow('42')), true);
    assert.deepEqual(getRadioUIState().pinnedStationIds, [stationRow('42').id]);
    assert.equal(radioLayer.isPinned(stationRow('42').id), true);
  } finally {
    ctx.teardown();
  }
});

test('a pinned station is playable even though it is not in the geolocated catalog', async () => {
  const ctx = await bootRadio([stationRow('01')]);
  try {
    const remote = stationRow('99', { name: 'Far Away FM', lat: -41, lon: 174 });
    radioLayer.pinStation(remote);
    const ok = radioLayer.selectStation(remote.id, { autoplay: true, focus: false, origin: 'user' });
    assert.equal(ok, true, 'select resolves through the pinned map');
    await Promise.resolve();
    assert.equal(getRadioUIState().selected?.id, remote.id);
    assert.ok(ctx.audioInstances.some((a) => a.playCalls > 0), 'playback started');
  } finally {
    ctx.teardown();
  }
});

test('a directory refresh without the pinned station keeps it selected and playing', async () => {
  const ctx = await bootRadio([stationRow('01')]);
  try {
    const remote = stationRow('99', { name: 'Far Away FM', lat: -41, lon: 174 });
    radioLayer.pinStation(remote);
    radioLayer.selectStation(remote.id, { autoplay: true, focus: false, origin: 'user' });
    await Promise.resolve();

    ctx.setCatalog([stationRow('02'), stationRow('03')]); // entirely different region
    await radioLayer.update();

    assert.equal(getRadioUIState().selected?.id, remote.id, 'not evicted by reconcileStations');
    assert.equal(getRadioUIState().audioState !== 'idle', true, 'audio was not stopped');
  } finally {
    ctx.teardown();
  }
});

test('unpinStation removes the pin', async () => {
  const ctx = await bootRadio([stationRow('01')]);
  try {
    radioLayer.pinStation(stationRow('42'));
    assert.equal(radioLayer.unpinStation(stationRow('42').id), true);
    assert.equal(radioLayer.unpinStation(stationRow('42').id), false, 'idempotent');
    assert.deepEqual(getRadioUIState().pinnedStationIds, []);
  } finally {
    ctx.teardown();
  }
});
