// The Local ADS-B logic on its display over a
// fake engine: magenta markers in the aircraft display's glyph sets,
// the UAT ring as its own point set, a click through the engine's selection
// dispatcher selects (the camera never follows), empty map releases, and the
// layer leaves no mover set behind.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalAdsbLayer } from './index.js';
import { createLocalAdsbDisplay } from './render/display.js';
import { aircraftAtlasLayout } from '../aircraft/render/display.js';
import * as selection from '../../data/selectionDispatcher.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import * as geo from '../../geo/index.js';

const receiver = {
  getState: () => ({
    connected: true,
    mode: 'adsb',
    status: 'streaming',
    aircraft: [],
  }),
  subscribe: () => () => {},
  setMode: async () => true,
};

function feedsOf(records) {
  return {
    getState: () => ({ configured: true, feeds: [], records }),
    subscribe: () => () => {},
    start() {},
    stop() {},
  };
}

const record = (icao, lat, band = '1090') => ({
  icao,
  callsign: `L${icao}`,
  lat,
  lon: 0,
  altitudeFt: 10_000,
  groundSpeedKt: 180,
  trackDeg: 90,
  verticalRateFpm: 0,
  lastPositionAt: 100_000,
  lastMessageAt: 100_000,
  messageCount: 10,
  band,
  source: 'feed',
});

test('local aircraft draw, ring and select on the display; the camera never follows', async () => {
  const engine = createFakeEngine();
  engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(0, 0, 60_000),
  });
  const layout = aircraftAtlasLayout();
  let renderer = null;
  const selected = [];
  const cleared = [];
  const layer = createLocalAdsbLayer({
    receiver,
    feeds: feedsOf([record('abc123', 0), record('def456', 0.05, '978')]),
    now: () => 100_500,
    services: {
      render: { governorRequestRender() {} },
      context: {
        registerEntityContext() {},
        selectEntityContext: (entity) => selected.push(entity.gevTrackedId),
        clearSelectedEntityContextForLayer: (layerId) => cleared.push(layerId),
        getSelectedEntityContext: () =>
          selected.length > cleared.length ? { id: selected.at(-1) } : null,
        removeEntityContextsForLayer() {},
      },
      picking: { registerPickOwner() {}, unregisterPickOwner() {} },
      selection,
      renderer: {
        create: ({ engine: given }) =>
          (renderer = createLocalAdsbDisplay(given, {
            drawAtlas: async () => ({
              canvas: { width: layout.width, height: layout.height },
              cells: layout.cells,
            }),
          })),
      },
    },
  });
  layer.init(null, { engine });
  await layer.enable();
  try {
    await renderer.whenReady();
    await layer.update();
    engine.fake.frame();
    await Promise.resolve();
    const sets = () => engine.movers.list();
    const sprites = sets().filter(({ id }) =>
      id.startsWith('local-adsb-sprites'),
    );
    assert.equal(sprites.length, 1);
    assert.equal(sprites[0].count, 2, 'one magenta glyph per aircraft');
    const { store } = engine.fake.moverSet(sprites[0].id);
    assert.deepEqual([...store.pickIds.slice(0, 2)].sort(), [
      'local-adsb:abc123',
      'local-adsb:def456',
    ]);
    // Magenta #ff4fd8.
    assert.deepEqual(
      [...store.colors.slice(0, 3)].map((value) => Math.round(value * 255)),
      [255, 79, 216],
    );
    const rings = sets().filter(({ id }) => id.startsWith('local-adsb-rings'));
    assert.equal(rings.length, 1);
    assert.equal(rings[0].count, 1, 'a ring for the UAT-only aircraft');
    // The ring: a transparent 24 px point with a 1.5 px outline, over the
    // markers, drawn through the scene.
    const ring = engine.fake.moverSet(rings[0].id);
    assert.equal(ring.options.kind, 'point');
    assert.equal(ring.options.point.sizePx, 24);
    assert.equal(ring.options.point.outlinePx, 1.5);
    assert.equal(ring.options.depthTest, 'always');
    assert.deepEqual([...ring.store.colors.slice(0, 4)], [0, 0, 0, 0]);
    assert.equal(ring.store.pickIds[0], 'local-adsb:def456');
    assert.equal(
      engine.fake.moverSet(sprites[0].id).options.depthTest,
      'always',
    );
    assert.equal(layer.getAllPositions().length, 2);

    // A click selects through the dispatcher; the camera does not follow.
    engine.fake.script('pick', () => ({ id: 'local-adsb:def456' }));
    engine.fake.script('drillPick', () => [{ id: 'local-adsb:def456' }]);
    const click = () => {
      engine.fake.input('down', { position: { x: 10, y: 10 } });
      engine.fake.input('up', { position: { x: 10, y: 10 } });
      engine.fake.input('click', { position: { x: 10, y: 10 } });
    };
    click();
    assert.deepEqual(selected, ['local-adsb:def456']);
    assert.equal(engine.camera.following(), null);
    // Empty map releases it.
    engine.fake.script('pick', () => undefined);
    engine.fake.script('drillPick', () => []);
    click();
    assert.deepEqual(cleared, ['local-adsb']);
  } finally {
    await layer.disable();
    layer.destroy();
  }
  assert.equal(engine.movers.list().length, 0, 'no mover set left behind');
  engine.destroy();
});
