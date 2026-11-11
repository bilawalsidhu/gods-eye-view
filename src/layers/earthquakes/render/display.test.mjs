// Layer display behavior on the fake engine.

import assert from 'node:assert/strict';
import test from 'node:test';

import * as geo from '../../../geo/index.js';
import {
  GROUND_HARNESSES,
  createFakeGroundHarness,
} from '../../../testSupport/groundDisplayEngines.mjs';
import { createEarthquakesLayer } from '../index.js';
import { createEarthquakesDisplay } from './display.js';

const rows = [
  {
    stableId: 'a',
    usgsId: 'us-a',
    lon: -122.42,
    lat: 37.77,
    depthKm: 8,
    mag: 2.5,
    place: 'A',
    time: 1000,
  },
  {
    stableId: 'b',
    usgsId: 'us-b',
    lon: 30,
    lat: 20,
    depthKm: 70,
    mag: 5,
    place: 'B',
    time: 2000,
  },
  {
    stableId: 'c',
    usgsId: null,
    lon: 150,
    lat: -30,
    depthKm: 300,
    mag: 6,
    place: 'C',
    time: 3000,
  },
];
// Red, orange, yellow by depth; 0.4 from magnitude 5, else 0.3.
const FILLS = [
  [1, 0, 0, 0.3],
  [1, 165 / 255, 0, 0.4],
  [1, 1, 0, 0.4],
];

function fixture(makeHarness) {
  const h = makeHarness();
  let snapshot = rows;
  const layer = createEarthquakesLayer({
    source: {
      async getSnapshot() {
        if (snapshot instanceof Error) throw snapshot;
        return snapshot;
      },
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(null, { engine: h.engine });
  layer.enable();
  return {
    ...h,
    layer,
    setSnapshot(value) {
      snapshot = value;
    },
  };
}

const near = (actual, expected, label, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${label}: ${actual} vs ${expected}`,
  );

for (const makeHarness of GROUND_HARNESSES) {
  const { name } = makeHarness();

  test(`each event is a ground disc of 2^mag km in its depth colour, without an outline (${name})`, async () => {
    const f = fixture(makeHarness);
    try {
      assert.equal(await f.layer.update(), true);
      const set = f.set('earthquakes');
      assert.equal(set.options.kind, 'disc');
      assert.equal(set.options.pickable, true);
      assert.equal(set.shown, true);
      assert.deepEqual(
        set.items.map(({ center, radiusM, pickId, outline }) => ({
          center,
          radiusM,
          pickId,
          outline,
        })),
        rows.map((row) => ({
          center: [row.lon, row.lat],
          radiusM: 2 ** row.mag * 1000,
          pickId: `earthquake:${row.stableId}`,
          outline: undefined,
        })),
      );
      set.items.forEach(({ fill }, index) =>
        fill.forEach((channel, at) =>
          near(channel, FILLS[index][at], `fill ${index}.${at}`),
        ),
      );

      assert.deepEqual(
        f.layer.getAnalystRecords().map((r) => r.id),
        ['us-a', 'us-b', 'QUAKE-0002'],
      );
      assert.equal(f.layer.getAnalystRecords(1).length, 1);
      assert.equal(f.layer.getAnalystRecords(0).length, 1);
      assert.equal(f.layer.getAnalystRecords(Infinity).length, 3);
      f.layer.disable();
      assert.deepEqual(f.layer.getAnalystRecords(), []);
      assert.equal(f.set('earthquakes').shown, false);
    } finally {
      f.layer.destroy();
    }
    assert.equal(f.sets(), 0);
    f.destroy();
  });

  test(`a failed refresh keeps the last discs and records (${name})`, async () => {
    const f = fixture(makeHarness);
    try {
      await f.layer.update();
      const before = f.set('earthquakes');
      const records = f.layer.getAnalystRecords();
      f.setSnapshot(new Error('fixture source unavailable'));
      assert.equal(await f.layer.update(), false);
      const after = f.set('earthquakes');
      assert.equal(after.commits, before.commits);
      assert.equal(after.items, before.items);
      assert.deepEqual(f.layer.getAnalystRecords(), records);
      assert.equal(f.layer.getStats().error, 'fixture source unavailable');
      f.setSnapshot([]);
      assert.equal(await f.layer.update(), true);
      assert.equal(f.set('earthquakes').items.length, 0);

      assert.equal(f.layer.getStats().error, null);
    } finally {
      f.layer.destroy();
      f.destroy();
    }
  });

  test(`a pick of a disc names its event (${name})`, async () => {
    const f = fixture(makeHarness);
    try {
      await f.layer.update();
      let picked;

      // The fake picks its ground items on the CPU, under the camera.
      f.engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(30, 20, 200_000),
      });
      const { width, height } = f.engine.host.size();
      picked = f.engine.picker.pick({ x: width / 2, y: height / 2 });

      assert.equal(picked.id, 'earthquake:b');
      assert.equal(picked.owner, 'earthquakes');
      assert.equal(picked.instance, 1);
    } finally {
      f.layer.destroy();
      f.destroy();
    }
  });

  test(`discs fetched between scenes draw on the next one without a second fetch (${name})`, async () => {
    const f = fixture(makeHarness);
    try {
      await f.layer.update();
      f.layer.detachRenderer();
      assert.equal(f.sets(), 0);
      const next = makeHarness();
      f.layer.attachRenderer({ engine: next.engine });
      assert.equal(next.set('earthquakes').items.length, 3);
      assert.equal(next.set('earthquakes').shown, true);
      f.layer.destroy();
      assert.equal(next.sets(), 0);
      next.destroy();
    } finally {
      f.layer.destroy();
      f.destroy();
    }
  });
}

test('the display ignores calls after destroy and destroys once', () => {
  const h = createFakeGroundHarness();
  const display = createEarthquakesDisplay(h.engine);
  assert.equal(h.set('earthquakes').shown, false, 'hidden until shown');
  display.setVisible(true);
  assert.equal(h.set('earthquakes').shown, true);
  display.setVisible(false);
  assert.equal(h.set('earthquakes').shown, false);
  display.destroy();
  display.destroy();
  assert.equal(h.sets(), 0);
  display.setVisible(true);
  display.replace([]);
  // A new display may take the set id again.
  createEarthquakesDisplay(h.engine).destroy();
  h.destroy();
});
