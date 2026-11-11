import assert from 'node:assert/strict';
import test from 'node:test';
import { LayerLifecycle } from '../../data/lifecycle.js';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createRadioLayer } from './index.js';
import { createRadioDisplay } from './render/display.js';

const station = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Station',
  lat: 0,
  lon: 0,
  streamUrl: 'https://audio.example.test/station.mp3',
  homepage: null,
  tags: ['news'],
  languages: ['English'],
  state: '',
  country: 'United States',
  countryCode: 'US',
  metadataTrust: 'untrusted-community',
  codec: 'MP3',
  bitrate: 128,
};
const noop = () => {};
const at = (engine, longitude) =>
  engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(longitude, 0, 1_000_000),
  });

function assertSelection(engine, shown) {
  for (const id of ['radio-selected', 'radio-bracket']) {
    const { store } = engine.fake.moverSet(id);
    assert.equal(store.count, 1, id);
    assert.equal(store.pickIds[0], `radio:selected:${station.id}`, id);
    assert.equal(Boolean(store.shows[0]), shown, id);
  }
}

async function fixture(t, kind, longitude = 0) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const engine = createFakeEngine({ kind });
  at(engine, longitude);
  const layer = createRadioLayer({
    source: {
      getDirectory: async () => ({
        stations: [station],
        updatedAt: new Date().toISOString(),
        stale: false,
        degraded: false,
        acceptedGeneration: 1,
        catalogInstance: 'fixture',
      }),
      recordClick: async () => {},
    },
    services: {
      ground: { cachedGroundFloor: () => 0, warmGroundFloor: noop },
      globe: {},
      picking: {
        resolvePickId: (pick) => pick?.id,
        isOwnedByOtherLayer: () => false,
      },
      render: {
        governorRequestRender: (reason, engine) =>
          engine.render.request(reason),
      },
      overlays: { clearSource: noop, setVisible: noop, setEntries: noop },
    },
    rendererFactory: (context) => createRadioDisplay(context.engine, context),
  });
  const catalog = {
    layers: [layer],
    metadata: [{ id: 'radio', disposition: 'enabled-only', token: 'r' }],
  };
  const manager = new LayerLifecycle(null);
  t.after(async () => {
    await manager.destroyAll();
    engine.destroy();
  });
  await manager.bindCatalog(engine, catalog);
  assert.equal(await manager.setEnabled('radio', true), true);
  assert.equal(layer.selectStation(station.id), true);
  engine.fake.frame();
  return { engine, layer, manager, catalog };
}

for (const [from, to] of [
  ['cesium', 'navara'],
  ['navara', 'cesium'],
]) {
  test(`selected radio markers resume at the restored camera (${from} -> ${to})`, async (t) => {
    const { engine, layer, manager, catalog } = await fixture(t, from);
    assertSelection(engine, true);
    const incoming = createFakeEngine({ kind: to });
    t.after(() => incoming.destroy());
    at(incoming, 90);
    await manager.detachScene();
    let restoreView;
    const viewRestored = new Promise((resolve) => {
      restoreView = resolve;
    });
    await manager.bindCatalog(incoming, catalog, { viewRestored });
    incoming.fake.frame();
    assertSelection(incoming, false);
    at(incoming, 0);
    restoreView();
    await manager.resumeScene();
    incoming.fake.frame();
    assertSelection(incoming, true);
    assert.equal(layer.getUIState().selected.id, station.id);
    assert.equal(layer.getUIState().audioState, 'stopped');
    t.mock.timers.tick(1500);
    incoming.fake.frame();
    assertSelection(incoming, true);
    await manager.setEnabled('radio', false);
    layer.resumeViewport();
    for (const id of ['radio-selected', 'radio-bracket'])
      assert.equal(incoming.fake.moverSet(id).store.count, 0, id);
  });

  test(`a stationary far-side radio selection stays hidden across rebuilds and engines (${from} -> ${to})`, async (t) => {
    const { engine, layer, manager, catalog } = await fixture(t, from, 90);
    // A preference update checks the horizon before the delayed marker rebuild.
    layer.setParams({ volume: 0.36 });
    assertSelection(engine, false);
    t.mock.timers.tick(1500);
    engine.fake.frame();
    assertSelection(engine, false);
    const incoming = createFakeEngine({ kind: to });
    t.after(() => incoming.destroy());
    at(incoming, 90);
    await manager.detachScene();
    await manager.bindCatalog(incoming, catalog);
    await manager.resumeScene();
    incoming.fake.frame();
    assertSelection(incoming, false);
    assert.equal(layer.getUIState().selected.id, station.id);
  });
}
