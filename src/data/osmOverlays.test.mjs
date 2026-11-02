import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OSM_OVERLAYS,
  applyOsmOverlayParams,
  createOsmOverlaysLayer,
  osmOverlaysHiddenReason,
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

function setup() {
  const globe = fakeCollection();
  const viewer = {
    imageryLayers: globe,
    scene: { globe: { show: true }, requestRender() {} },
  };
  const created = [];
  const layer = createOsmOverlaysLayer({
    createProvider: (overlay) => ({ overlay }),
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

test('OSM_OVERLAYS: exactly the two shipped overlays, each with a tile template and credit', () => {
  assert.deepEqual(
    OSM_OVERLAYS.map((o) => o.key),
    ['seamap', 'snowmap'],
  );
  for (const overlay of OSM_OVERLAYS) {
    assert.match(overlay.urlTemplate, /^https:\/\/.*\{z\}.*\{x\}.*\{y\}/);
    assert.match(overlay.credit, /OpenStreetMap contributors \(ODbL\)/);
  }
  assert.match(OSM_OVERLAYS[0].credit, /CC BY-SA 2\.0/);
  assert.match(OSM_OVERLAYS[1].credit, /www\.opensnowmap\.org/);
});

test('osmOverlaysHiddenReason: only when enabled, something chosen and no imagery host', () => {
  const both = { seamap: true, snowmap: true };
  assert.equal(osmOverlaysHiddenReason(false, both, 'none'), null);
  assert.equal(
    osmOverlaysHiddenReason(true, { seamap: false, snowmap: false }, 'none'),
    null,
  );
  assert.equal(osmOverlaysHiddenReason(true, both, 'globe'), null);
  assert.equal(osmOverlaysHiddenReason(true, both, 'tileset'), null);
  assert.equal(osmOverlaysHiddenReason(true, both, 'none'), NO_IMAGERY_HOST);
});

test('applyOsmOverlayParams: flips only known keys with boolean values, reports whether anything changed', () => {
  const current = { seamap: true, snowmap: true };
  const a = applyOsmOverlayParams(current, { seamap: false });
  assert.deepEqual(a.next, { seamap: false, snowmap: true });
  assert.equal(a.changed, true);

  const b = applyOsmOverlayParams(current, { seamap: true });
  assert.deepEqual(b.next, current);
  assert.equal(b.changed, false);

  const c = applyOsmOverlayParams(current, {
    unknownKey: false,
    snowmap: 'nope',
  });
  assert.deepEqual(c.next, current);
  assert.equal(c.changed, false);
  assert.equal(applyOsmOverlayParams(current, null).changed, false);
});

test('layer owns no imagery until enabled and destroys what it created on disable', () => {
  const { layer, globe, created } = setup();
  assert.equal(created.length, 0);
  assert.equal(globe.layers.length, 0);

  layer.enable();
  assert.equal(globe.layers.length, 2);
  assert.deepEqual(layer.getStats(), { count: 2, error: null });

  layer.setParams({ snowmap: false });
  assert.equal(globe.layers.length, 1);
  assert.equal(globe.layers[0].provider.overlay.key, 'seamap');
  assert.equal(created[1].destroyed, true);

  layer.disable();
  assert.equal(globe.layers.length, 0);
  assert.ok(created.every((imagery) => imagery.destroyed));
  assert.deepEqual(layer.diagnostics(), { host: 'none', ownedCount: 0 });
  assert.deepEqual(layer.getStats(), { count: 0, error: null });
});

test('overlays follow a map-stack switch from the globe onto the Google 3D tileset and back', () => {
  const { layer, viewer, globe, mapStack } = setup();
  layer.enable();
  const before = [...globe.layers];

  const tileset = { imageryLayers: fakeCollection() };
  viewer.scene.globe.show = false;
  mapStack.tileset = tileset;
  mapStack.emit();
  assert.equal(globe.layers.length, 0);
  assert.deepEqual(tileset.imageryLayers.layers, before);
  assert.ok(globe.removed.every(({ destroy }) => destroy === false));
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.diagnostics().host, 'tileset');

  viewer.scene.globe.show = true;
  mapStack.tileset = null;
  mapStack.emit();
  assert.deepEqual(globe.layers, before);
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
  assert.equal(globe.layers.length, 2);
  assert.equal(layer.getStats().error, null);
});

test('destroy removes owned imagery, unsubscribes from the map stack and resets params', () => {
  const { layer, globe, created, mapStack } = setup();
  layer.enable();
  layer.setParams({ seamap: false });
  layer.destroy();
  assert.equal(globe.layers.length, 0);
  assert.ok(created.every((imagery) => imagery.destroyed));
  assert.equal(mapStack.subscribers.size, 0);
  assert.deepEqual(layer.getParams(), { seamap: true, snowmap: true });
});

test('each catalog gets its own instance', () => {
  const a = createOsmOverlaysLayer();
  const b = createOsmOverlaysLayer();
  a.setParams({ seamap: false });
  assert.deepEqual(b.getParams(), { seamap: true, snowmap: true });
});

test('chips translate their labels and toggle one overlay each', () => {
  const { layer } = setup();
  assert.deepEqual(layer.getRowControls(), { chips: [], legend: [] });
  layer.enable();
  const { chips } = layer.getRowControls();
  assert.deepEqual(
    chips.map((chip) => [chip.id, chip.active, chip.params]),
    [
      ['seamap', true, { seamap: false }],
      ['snowmap', true, { snowmap: false }],
    ],
  );
  assert.match(chips[0].label, /Sea Marks/);
});
