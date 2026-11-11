import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OSM_OVERLAYS,
  createOsmOverlayLayer,
  createOsmOverlayLayers,
  osmOverlayHiddenReason,
} from './osmOverlays.js';
import { NO_IMAGERY_HOST } from '../layers/shared/imageryHost.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';

/** A layer on the fake engine, whose imagery drapes where `surface()` says. */
function setup(overlay = OSM_OVERLAYS[0]) {
  let surface = 'globe';
  const engine = createFakeEngine({ kind: 'cesium' });
  engine.imagery.surface = () => surface;
  const layer = createOsmOverlayLayer(overlay);
  layer.init(null, { engine });
  return {
    layer,
    engine,
    layers: () =>
      engine.imagery.list().filter(({ id }) => id.startsWith('osm-overlay-')),
    setSurface: (next) => (surface = next),
  };
}

test('OSM_OVERLAYS: the two shipped layers, each with a tile template and credit', () => {
  assert.deepEqual(
    OSM_OVERLAYS.map((o) => o.id),
    ['sea-marks', 'ski-pistes'],
  );
  for (const overlay of OSM_OVERLAYS) {
    assert.match(overlay.urlTemplate, /^https:\/\/.*\{z\}.*\{x\}.*\{y\}/);
    assert.match(overlay.credit, /OpenStreetMap contributors \(ODbL\)/);
  }
  assert.match(OSM_OVERLAYS[0].credit, /CC BY-SA 2\.0/);
  assert.match(OSM_OVERLAYS[1].credit, /www\.opensnowmap\.org/);
});

test('createOsmOverlayLayers builds one independent layer per overlay', () => {
  const layers = createOsmOverlayLayers();
  assert.deepEqual(
    layers.map((layer) => [layer.id, layer.name]),
    [
      ['sea-marks', 'Sea Marks'],
      ['ski-pistes', 'Ski Pistes'],
    ],
  );
  assert.notEqual(createOsmOverlayLayers()[0], layers[0]);
  assert.throws(() => createOsmOverlayLayer({ id: 'other' }), /Unknown/);
});

test('osmOverlayHiddenReason: only when enabled with no imagery host', () => {
  assert.equal(osmOverlayHiddenReason(false, 'none'), null);
  assert.equal(osmOverlayHiddenReason(true, 'globe'), null);
  assert.equal(osmOverlayHiddenReason(true, 'tileset'), null);
  assert.equal(osmOverlayHiddenReason(true, 'none'), NO_IMAGERY_HOST);
});

test('a layer owns no imagery until enabled and destroys it on disable', () => {
  const { layer, engine, layers } = setup(OSM_OVERLAYS[1]);
  assert.equal(layers().length, 0);

  layer.enable();
  assert.equal(layers().length, 1);
  const [{ id }] = layers();
  assert.equal(id, 'osm-overlay-ski-pistes');
  const { source, options } = engine.fake.imageryLayer(id);
  assert.equal(source.url, OSM_OVERLAYS[1].urlTemplate);
  assert.equal(source.maxLevel, 18);
  assert.equal(source.credit, OSM_OVERLAYS[1].credit);
  assert.equal(options.order, 10);
  assert.deepEqual(layer.getStats(), { count: 1, error: null });

  layer.disable();
  assert.equal(layers().length, 0);
  assert.deepEqual(layer.diagnostics(), { host: 'none', ownedCount: 0 });
  assert.deepEqual(layer.getStats(), { count: 0, error: null });

  layer.enable();
  assert.equal(layers().length, 1, 're-enabling creates a fresh layer');
});

test('the overlay reports the surface the engine drapes it on', () => {
  const { layer, setSurface } = setup();
  layer.enable();
  assert.equal(layer.diagnostics().host, 'globe');
  setSurface('tiles');
  assert.equal(layer.diagnostics().host, 'tileset');
  assert.equal(layer.getStats().error, null);
});

test('with no surface to drape on the row explains itself, and recovers when one appears', () => {
  const { layer, setSurface } = setup();
  setSurface('none');
  layer.enable();
  assert.equal(layer.getStats().error, NO_IMAGERY_HOST);
  setSurface('globe');
  assert.equal(layer.getStats().error, null);
});

test('destroy and a renderer detach remove the owned imagery', () => {
  const { layer, layers, engine } = setup();
  layer.enable();
  layer.detachRenderer();
  assert.equal(layers().length, 0);
  layer.attachRenderer({ engine });
  assert.equal(
    layers().length,
    1,
    'the enabled state stays for the next globe',
  );
  layer.destroy();
  assert.equal(layers().length, 0);
});

for (const kind of ['cesium', 'navara']) {
  test(`${kind}: both overlays follow imagery surfaces and survive an engine switch`, () => {
    let surface = 'tiles';
    const engine = createFakeEngine({ kind });
    engine.imagery.surface = () => surface;
    const nextEngine = createFakeEngine({
      kind: kind === 'navara' ? 'cesium' : 'navara',
    });
    const layers = createOsmOverlayLayers();
    for (const layer of layers) {
      layer.enable();
      layer.attachRenderer({ engine });
      layer.enable();
    }
    const owned = engine.imagery.list();
    assert.deepEqual(
      owned.map(({ id }) => id),
      OSM_OVERLAYS.map(({ id }) => `osm-overlay-${id}`),
    );
    for (const host of ['tiles', 'globe', 'none', 'tiles']) {
      surface = host;
      for (const layer of layers) {
        assert.deepEqual(layer.diagnostics(), {
          host: host === 'tiles' ? 'tileset' : host,
          ownedCount: 1,
        });
        assert.equal(
          layer.getStats().error,
          host === 'none' ? NO_IMAGERY_HOST : null,
        );
      }
      assert.deepEqual(engine.imagery.list(), owned);
    }
    for (const layer of layers) {
      layer.detachRenderer();
      layer.attachRenderer({ engine: nextEngine });
    }
    assert.deepEqual(engine.imagery.list(), []);
    assert.deepEqual(nextEngine.imagery.list(), owned);
    layers[0].disable();
    assert.equal(nextEngine.imagery.list().length, 1);
    for (const layer of layers) layer.destroy();
    assert.deepEqual(nextEngine.imagery.list(), []);
  });
}
