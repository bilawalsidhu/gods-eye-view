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
  const fake = createFakeEngine({ kind: 'cesium' });
  const engine = {
    ...fake,
    imagery: { ...fake.imagery, surface: () => surface },
  };
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

test('on Navara an overlay drapes through engine.maps and follows the globe', () => {
  const added = [];
  const engineWith = () => ({
    maps: {
      addOverlay(options) {
        const entry = { options, removed: false };
        added.push(entry);
        return () => (entry.removed = true);
      },
    },
  });
  const [seaMarks] = createOsmOverlayLayers();
  seaMarks.init(null, { engine: engineWith() });
  assert.equal(added.length, 0, 'nothing until enabled');
  seaMarks.enable();
  assert.equal(added.length, 1);
  assert.equal(added[0].options.url, OSM_OVERLAYS[0].urlTemplate);
  assert.equal(added[0].options.credit, OSM_OVERLAYS[0].credit);
  assert.equal(seaMarks.getStats().error, null);
  // An engine switch: the drape leaves with the old globe, comes back on the next.
  seaMarks.detachRenderer();
  assert.equal(added[0].removed, true);
  seaMarks.attachRenderer({ engine: engineWith() });
  assert.equal(added.length, 2);
  assert.equal(added[1].removed, false);
  seaMarks.disable();
  assert.equal(added[1].removed, true);
  seaMarks.destroy();
});
