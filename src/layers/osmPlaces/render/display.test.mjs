// Layer display behavior on the fake engine.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';

import { createOsmPlacesLayer } from '../index.js';
import { createOsmPlacesDisplay } from './display.js';

const places = [
  { id: 'node/1', name: 'Bir Hospital', lat: 27.7, lon: 85.31 },
  { id: 'node/2', name: '', lat: 27.71, lon: 85.32 },
];

function fakeHarness() {
  const engine = createFakeEngine();
  return {
    name: 'the fake engine',
    engine,
    /** The surface under every place answers `height` (undefined: none). */
    surface(height) {
      engine.fake.script('sampleHeight', height);
    },
    destroy: () => engine.destroy(),
  };
}

const HARNESSES = [fakeHarness];

function layerOn(engine) {
  const overlay = new Map();
  const layer = createOsmPlacesLayer({
    overpassConfigured: async () => true,
    overlayHost: {
      setEntries: (id, entries) => overlay.set(id, entries),
      setVisible() {},
      clearSource: (id) => overlay.delete(id),
    },
  });
  layer.init(null, { engine });
  return { layer, overlay };
}

const count = (engine) =>
  engine.movers.list().find(({ id }) => id === 'osm-places')?.count;
const heightOf = (position) => geo.cartographic.fromCartesian(position).height;

for (const makeHarness of HARNESSES) {
  const { name } = makeHarness();

  test(`places draw as 9 px outlined discs, on top only up close (${name})`, () => {
    const h = makeHarness();
    const display = createOsmPlacesDisplay(h.engine);
    try {
      display.setVisible(true);
      display.replace(places);
      assert.equal(count(h.engine), 2);

      const set = h.engine.fake.moverSet('osm-places');
      assert.equal(set.options.kind, 'point');
      assert.equal(set.options.point.sizePx, 9);
      assert.equal(set.options.point.outlinePx, 2);
      assert.deepEqual(set.options.point.outlineColor, [0, 0, 0, 0.8]);
      assert.deepEqual(set.options.depthTest, { disableWithinM: 2500 });
      assert.equal(set.options.pickable, true);
      assert.ok(set.options.order < 0, 'under the moving contacts');
      assert.equal(set.store.pickIds[1], 'osm-place:node/2');
      assert.ok(Math.abs(set.store.colors[0] - 0x7f / 255) < 1e-6);
    } finally {
      display.destroy();
      h.destroy();
    }
  });

  test(`places sit 2 m over the sampled surface, read again after a move (${name})`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = makeHarness();
    const display = createOsmPlacesDisplay(h.engine);
    const position = () =>
      (() => {
        const { positions } = h.engine.fake.moverSet('osm-places').store;
        return { x: positions[0], y: positions[1], z: positions[2] };
      })();
    try {
      h.surface(undefined);
      display.setVisible(true);
      display.replace(places);
      assert.ok(Math.abs(heightOf(position()) - 2) < 1e-6, 'no surface yet');
      h.surface(1340);
      t.mock.timers.tick(500);
      assert.ok(
        Math.abs(heightOf(position()) - 1342) < 1e-6,
        'asked again shortly after',
      );
      h.surface(1360);
      h.engine.camera.moveEnd.raiseEvent();
      assert.ok(
        Math.abs(heightOf(position()) - 1362) < 1e-6,
        'and after a camera move',
      );
    } finally {
      display.destroy();
      h.destroy();
    }
  });

  test(`places follow the layer across toggles and a globe switch (${name})`, () => {
    const h = makeHarness();
    const { layer, overlay } = layerOn(h.engine);
    try {
      layer.setResults(places, {
        kind: 'hospital',
        label: 'Hospitals',
        area: 'Kathmandu',
      });
      assert.equal(count(h.engine), 0, 'nothing drawn while off');
      layer.enable();
      assert.equal(count(h.engine), 2, 'one point per place');
      assert.equal(
        overlay.get('osm-places').length,
        1,
        'only named places get labels',
      );
      layer.detachRenderer();
      assert.equal(count(h.engine), undefined, 'the points go with the globe');
      const next = makeHarness();
      layer.attachRenderer(null, { engine: next.engine });
      assert.equal(count(next.engine), 2);
      assert.equal(layer.getAnalystRecords().length, 2, 'the results stayed');
      layer.disable();
      assert.equal(count(next.engine), 0);
      layer.destroy();
      assert.equal(count(next.engine), undefined);
      next.destroy();
    } finally {
      h.destroy();
    }
  });
}
