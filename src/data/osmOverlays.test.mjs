import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OSM_OVERLAYS,
  createOsmOverlayLayer,
  createOsmOverlayLayers,
  osmOverlayHiddenReason,
} from './osmOverlays.js';
import { NO_IMAGERY_HOST } from '../maps/imageryHost.js';

function fakeCollection() {
  const layers = [];
  const removed = [];
  return {
    layers,
    removed,
    add(layer) {
      layers.push(layer);
    },
    contains(layer) {
      return layers.includes(layer);
    },
    remove(layer, destroy) {
      const index = layers.indexOf(layer);
      if (index < 0) return false;
      layers.splice(index, 1);
      removed.push({ layer, destroy });
      if (destroy) layer.destroyed = true;
      return true;
    },
  };
}

function fakeMapStack() {
  const subscribers = new Set();
  return {
    tileset: null,
    getImageryHostTileset() {
      return this.tileset;
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
  const globe = fakeCollection();
  const viewer = {
    imageryLayers: globe,
    scene: { globe: { show: true }, requestRender() {} },
  };
  const created = [];
  const layer = createOsmOverlayLayer(overlay, {
    createProvider: (descriptor) => ({ descriptor }),
    createImageryLayer: (provider) => {
      const imagery = { provider, destroyed: false };
      created.push(imagery);
      return imagery;
    },
  });
  const mapStack = fakeMapStack();
  layer.init(viewer);
  layer.attachMapStackController(mapStack);
  return { layer, viewer, globe, created, mapStack };
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
  const { layer, globe, created } = setup(OSM_OVERLAYS[1]);
  assert.equal(created.length, 0);

  layer.enable();
  assert.equal(globe.layers.length, 1);
  assert.equal(globe.layers[0].provider.descriptor.id, 'ski-pistes');
  assert.deepEqual(layer.getStats(), { count: 1, error: null });

  layer.disable();
  assert.equal(globe.layers.length, 0);
  assert.equal(created[0].destroyed, true);
  assert.deepEqual(layer.diagnostics(), { host: 'none', ownedCount: 0 });
  assert.deepEqual(layer.getStats(), { count: 0, error: null });

  layer.enable();
  assert.equal(created.length, 2, 're-enabling creates a fresh imagery layer');
});

test('the overlay follows a map-stack switch onto the Google 3D tileset and back', () => {
  const { layer, viewer, globe, mapStack } = setup();
  layer.enable();
  const [imagery] = globe.layers;

  const tileset = { imageryLayers: fakeCollection() };
  viewer.scene.globe.show = false;
  mapStack.tileset = tileset;
  mapStack.emit();
  assert.equal(globe.layers.length, 0);
  assert.deepEqual(tileset.imageryLayers.layers, [imagery]);
  assert.equal(globe.removed[0].destroy, false);
  assert.equal(layer.diagnostics().host, 'tileset');
  assert.equal(layer.getStats().error, null);

  viewer.scene.globe.show = true;
  mapStack.tileset = null;
  mapStack.emit();
  assert.deepEqual(globe.layers, [imagery]);
  assert.equal(tileset.imageryLayers.layers.length, 0);
});

test('with no surface to drape on the row explains itself, and recovers when one appears', () => {
  const { layer, viewer, globe, mapStack } = setup();
  viewer.scene.globe.show = false;
  layer.enable();
  assert.equal(globe.layers.length, 0);
  assert.equal(layer.getStats().error, NO_IMAGERY_HOST);

  viewer.scene.globe.show = true;
  mapStack.emit();
  assert.equal(globe.layers.length, 1);
  assert.equal(layer.getStats().error, null);
});

test('destroy removes owned imagery and unsubscribes from the map stack', () => {
  const { layer, globe, created, mapStack } = setup();
  layer.enable();
  layer.destroy();
  assert.equal(globe.layers.length, 0);
  assert.equal(created[0].destroyed, true);
  assert.equal(mapStack.subscribers.size, 0);
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
  seaMarks.attachRenderer(null, { engine: engineWith() });
  assert.equal(added.length, 2);
  assert.equal(added[1].removed, false);
  seaMarks.disable();
  assert.equal(added[1].removed, true);
  seaMarks.destroy();
});
