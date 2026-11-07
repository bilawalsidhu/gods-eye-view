import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OSM_OVERLAYS,
  createOsmOverlayLayer,
  createOsmOverlayLayers,
  osmOverlayHiddenReason,
  osmOverlaySpec,
} from './osmOverlays.js';
import { NO_IMAGERY_HOST } from '../maps/imageryHost.js';

/** A globe port recording the imagery layers added and removed through it. */
function fakeGlobe() {
  const layers = [];
  return {
    layers,
    imagery: {
      add(spec) {
        const layer = {
          spec,
          removed: false,
          remove() {
            layer.removed = true;
            layers.splice(layers.indexOf(layer), 1);
          },
        };
        layers.push(layer);
        return layer;
      },
      list: () => layers.slice(),
    },
  };
}

function fakeMapStack() {
  const subscribers = new Set();
  return {
    surface: 'globe',
    getDrapeSurface() {
      return this.surface;
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    emit() {
      for (const fn of subscribers) fn();
    },
    subscribers,
  };
}

function setup(overlay = OSM_OVERLAYS[0]) {
  const globe = fakeGlobe();
  const viewer = { scene: { globe: { show: true } } };
  const layer = createOsmOverlayLayer(overlay, {
    globeOf: (given) => (given === viewer ? globe : null),
  });
  const mapStack = fakeMapStack();
  layer.init(viewer);
  layer.attachMapStackController(mapStack);
  return { layer, viewer, globe, mapStack };
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

test('a layer owns no imagery until enabled and removes it on disable', () => {
  const { layer, globe } = setup(OSM_OVERLAYS[1]);
  assert.equal(globe.layers.length, 0);

  layer.enable();
  assert.equal(globe.layers.length, 1);
  assert.deepEqual(globe.layers[0].spec, osmOverlaySpec(OSM_OVERLAYS[1]));
  assert.deepEqual(globe.layers[0].spec, {
    kind: 'xyz',
    url: 'https://www.opensnowmap.org/pistes/{z}/{x}/{y}.png',
    maxLevel: 18,
    credit: { text: OSM_OVERLAYS[1].credit },
  });
  assert.deepEqual(layer.getStats(), { count: 1, error: null });

  const [first] = globe.layers;
  layer.disable();
  assert.equal(globe.layers.length, 0);
  assert.equal(first.removed, true);
  assert.deepEqual(layer.diagnostics(), { host: 'none', ownedCount: 0 });
  assert.deepEqual(layer.getStats(), { count: 0, error: null });

  layer.enable();
  assert.notEqual(globe.layers[0], first, 're-enabling adds a fresh layer');
});

test('a map-stack switch onto Google 3D keeps the one layer, which the renderer drapes there', () => {
  const { layer, globe, mapStack } = setup();
  layer.enable();
  const [imagery] = globe.layers;

  mapStack.surface = 'tileset';
  mapStack.emit();
  assert.deepEqual(globe.layers, [imagery]);
  assert.equal(layer.diagnostics().host, 'tileset');
  assert.equal(layer.getStats().error, null);

  mapStack.surface = 'globe';
  mapStack.emit();
  assert.deepEqual(globe.layers, [imagery]);
  assert.equal(layer.diagnostics().host, 'globe');
});

test('with no surface to drape on the row explains itself, and recovers when one appears', () => {
  const { layer, globe, mapStack } = setup();
  mapStack.surface = 'none';
  layer.enable();
  assert.equal(globe.layers.length, 1, 'kept, drawn when a surface is');
  assert.equal(layer.getStats().error, NO_IMAGERY_HOST);

  mapStack.surface = 'globe';
  mapStack.emit();
  assert.equal(layer.getStats().error, null);
});

test('without a map stack, the viewer’s globe decides, polled by the stats', () => {
  const globe = fakeGlobe();
  const viewer = { scene: { globe: { show: false } } };
  const layer = createOsmOverlayLayer(OSM_OVERLAYS[0], {
    globeOf: () => globe,
  });
  layer.init(viewer);
  layer.enable();
  assert.equal(layer.getStats().error, NO_IMAGERY_HOST);
  viewer.scene.globe.show = true;
  assert.equal(layer.getStats().error, null);
});

test('destroy removes owned imagery and unsubscribes from the map stack', () => {
  const { layer, globe, mapStack } = setup();
  layer.enable();
  const [imagery] = globe.layers;
  layer.destroy();
  assert.equal(globe.layers.length, 0);
  assert.equal(imagery.removed, true);
  assert.equal(mapStack.subscribers.size, 0);
});

test('an overlay enabled before its viewer has a globe port adds it once one does', () => {
  const globe = fakeGlobe();
  let port = null;
  const layer = createOsmOverlayLayer(OSM_OVERLAYS[0], { globeOf: () => port });
  layer.init({ scene: { globe: { show: true } } });
  layer.enable();
  assert.equal(layer.diagnostics().ownedCount, 0);
  port = globe;
  layer.getStats();
  assert.equal(globe.layers.length, 1);
  layer.getStats();
  assert.equal(globe.layers.length, 1, 'added once');
});
