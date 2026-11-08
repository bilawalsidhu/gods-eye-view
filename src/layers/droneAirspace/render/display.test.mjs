// Layer display behavior on the fake engine.

import assert from 'node:assert/strict';
import test from 'node:test';

import * as geo from '../../../geo/index.js';
import {
  GROUND_HARNESSES,
  createFakeGroundHarness,
} from '../../../testSupport/groundDisplayEngines.mjs';
import { rgbaFromCss } from '../../shared/color.js';
import { droneAirspaceAccent } from '../cards.js';
import { createDroneAirspaceLayer } from '../index.js';
import { createDroneAirspaceDisplay } from './display.js';

const outer = [
  [-77.2, 38.8],
  [-76.9, 38.8],
  [-76.9, 39.1],
  [-77.2, 39.1],
  [-77.2, 38.8],
];
const hole = [
  [-77.1, 38.9],
  [-77.0, 38.9],
  [-77.0, 39.0],
  [-77.1, 38.9],
];
const second = outer.map(([lon, lat]) => [lon + 1, lat]);
const row = {
  stableId: '310',
  name: 'P-56',
  typeCode: 'P',
  type: 'Prohibited',
  lowerAltitude: 'SFC',
  upperAltitude: '18,000 ft MSL',
  timesOfUse: 'CONTINUOUS',
  agency: null,
  city: 'WASHINGTON',
  state: 'DC',
  polygons: [[outer, hole]],
};
const other = {
  ...row,
  stableId: '400',
  name: 'R-4001',
  typeCode: 'R',
  type: 'Restricted',
  polygons: [[second], [second.map(([lon, lat]) => [lon, lat + 1])]],
};
const PICKS = [
  'drone-airspace:310:0',
  'drone-airspace:400:0',
  'drone-airspace:400:1',
];
const colorOf = (zone) => rgbaFromCss(droneAirspaceAccent(zone.typeCode));
// Per polygon: its incident's colour.
const COLORS = [colorOf(row), colorOf(other), colorOf(other)];

function fixture(makeHarness) {
  const h = makeHarness();
  const entries = new Map();
  const layer = createDroneAirspaceLayer({
    source: { getSnapshot: async () => [row, other] },
    overlayHost: {
      setEntries: (id, value) => entries.set(id, value),
      setVisible() {},
      clearSource: (id) => entries.delete(id),
      hitTest: () => null,
    },
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: (_layer, id) => id.startsWith('other-layer:'),
    },
    pointer: { isPointerFree: () => true },
  });
  layer.init(null, { engine: h.engine });
  layer.enable();
  return { ...h, layer, entries, card: () => entries.get('drone-airspace') };
}

const near = (actual, expected, label, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${label}: ${actual} vs ${expected}`,
  );

for (const makeHarness of GROUND_HARNESSES) {
  const { name } = makeHarness();

  test(`each polygon is a 0.25 fill with its holes under a 2 px outline at 0.9 on its outer ring (${name})`, async () => {
    const f = fixture(makeHarness);
    try {
      assert.equal(await f.layer.update(), true);
      const set = f.set('drone-airspace');
      assert.equal(set.options.kind, 'polygon');
      assert.equal(set.options.pickable, true);
      assert.equal(set.shown, true);
      const fills = set.items.slice(0, 3);
      const lines = set.items.slice(3);
      assert.equal(set.items.length, 6, 'every fill, then every outline');
      assert.deepEqual(
        fills.map(({ rings, pickId, outline }) => ({ rings, pickId, outline })),
        [
          { rings: [outer, hole], pickId: PICKS[0], outline: undefined },
          { rings: [second], pickId: PICKS[1], outline: undefined },
          {
            rings: other.polygons[1],
            pickId: PICKS[2],
            outline: undefined,
          },
        ],
      );
      assert.deepEqual(
        lines.map(({ rings, pickId, fill, outline }) => ({
          rings,
          pickId,
          fill,
          widthPx: outline.widthPx,
        })),
        [
          { rings: [outer], pickId: PICKS[0], fill: undefined, widthPx: 2 },
          { rings: [second], pickId: PICKS[1], fill: undefined, widthPx: 2 },
          {
            rings: other.polygons[1],
            pickId: PICKS[2],
            fill: undefined,
            widthPx: 2,
          },
        ],
      );
      fills.forEach(({ fill }, index) =>
        assert.deepEqual(fill, COLORS[index].withAlpha(0.25).rgba()),
      );
      lines.forEach(({ outline }, index) =>
        assert.deepEqual(outline.color, COLORS[index].withAlpha(0.9).rgba()),
      );

      f.layer.disable();
      assert.equal(f.set('drone-airspace').shown, false);
    } finally {
      f.layer.destroy();
    }
    assert.equal(f.sets(), 0);
    f.destroy();
  });

  test(`a click on a zone or its outline selects the zone; empty space clears it (${name})`, async () => {
    const f = fixture(makeHarness);
    try {
      await f.layer.update();
      assert.equal(f.listeners(), 1, 'one click listener while enabled');
      f.click({ set: 'drone-airspace', instance: 0 });
      assert.equal(f.card()[0].id, 'drone-airspace-card:310');
      // The other zone's second outline.
      f.click({ set: 'drone-airspace', instance: 5 });
      assert.equal(f.card()[0].id, 'drone-airspace-card:400');
      f.click({ id: 'other-layer:aircraft-1' });
      assert.equal(
        f.card()[0].id,
        'drone-airspace-card:400',
        'a sibling layer pick keeps the selection',
      );
      f.click(undefined);
      assert.deepEqual(f.card(), []);
      f.layer.disable();
      assert.equal(f.listeners(), 0, 'disable removes the click listener');
      f.layer.enable();
      assert.equal(f.listeners(), 1);
      f.layer.detachRenderer();
      assert.equal(f.listeners(), 0, 'detach removes it too');
      assert.equal(f.sets(), 0);
    } finally {
      f.layer.destroy();
      f.destroy();
    }
  });
}

test('a click inside a zone picks it on the ground, not in its hole (the fake engine)', async () => {
  const f = fixture(createFakeGroundHarness);
  try {
    await f.layer.update();
    const clickAt = (lon, lat) => {
      f.engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(lon, lat, 30_000),
      });
      const { width, height } = f.engine.host.size();
      f.engine.fake.input('click', {
        position: { x: width / 2, y: height / 2 },
      });
    };
    clickAt(-77.15, 39.05);
    assert.equal(f.card()[0].id, 'drone-airspace-card:310');
    clickAt(-77.03, 38.92);
    assert.deepEqual(f.card(), [], 'the hole is empty space');
  } finally {
    f.layer.destroy();
    f.destroy();
  }
});

test('the display ignores calls after destroy and destroys once', () => {
  const h = createFakeGroundHarness();
  const display = createDroneAirspaceDisplay(h.engine);
  assert.equal(h.set('drone-airspace').shown, false, 'hidden until shown');
  const off = display.onClick(() => {});
  assert.equal(h.listeners(), 1);
  display.destroy();
  display.destroy();
  assert.equal(h.listeners(), 0, 'destroy removes its click listeners');
  off();
  assert.equal(h.sets(), 0);
  display.setVisible(true);
  display.replace([row]);
  assert.equal(h.listeners(), 0);
  display.onClick(() => {})();
  h.destroy();
});
