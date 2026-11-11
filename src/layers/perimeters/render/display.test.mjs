// Layer display behavior on the fake engine.

import assert from 'node:assert/strict';
import test from 'node:test';

import * as geo from '../../../geo/index.js';
import {
  GROUND_HARNESSES,
  createFakeGroundHarness,
} from '../../../testSupport/groundDisplayEngines.mjs';
import { rgbaFromCss } from '../../shared/color.js';
import { containmentAccent } from '../cards.js';
import { createFirePerimetersLayer } from '../index.js';
import { createPerimetersDisplay } from './display.js';

const outer = [
  [-108.2, 35.1],
  [-107.9, 35.1],
  [-107.9, 35.4],
  [-108.2, 35.4],
  [-108.2, 35.1],
];
const hole = [
  [-108.1, 35.2],
  [-108.0, 35.2],
  [-108.0, 35.3],
  [-108.1, 35.2],
];
const second = outer.map(([lon, lat]) => [lon + 1, lat]);
const row = {
  stableId: '2026-NMGNF-000123',
  name: 'Fixture Fire',
  acres: 512.5,
  containedPct: 40,
  state: 'US-NM',
  discoveredTime: 1757900000000,
  updatedTime: 1757950000000,
  polygons: [[outer, hole]],
};
const other = {
  ...row,
  stableId: 'other',
  name: 'Other Fire',
  containedPct: 100,
  polygons: [[second], [second.map(([lon, lat]) => [lon, lat + 1])]],
};
const PICKS = [
  'fire-perimeter:2026-NMGNF-000123:0',
  'fire-perimeter:other:0',
  'fire-perimeter:other:1',
];
const colorOf = (incident) =>
  rgbaFromCss(containmentAccent(incident.containedPct));
// Per polygon: its incident's colour.
const COLORS = [colorOf(row), colorOf(other), colorOf(other)];

function fixture(makeHarness) {
  const h = makeHarness();
  const entries = new Map();
  const layer = createFirePerimetersLayer({
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
  return { ...h, layer, entries, card: () => entries.get('fire-perimeters') };
}

const near = (actual, expected, label, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${label}: ${actual} vs ${expected}`,
  );

for (const makeHarness of GROUND_HARNESSES) {
  const { name } = makeHarness();

  test(`each polygon is a 0.25 fill with its holes under a 2 px fire line at 0.9 on its outer ring (${name})`, async () => {
    const f = fixture(makeHarness);
    try {
      assert.equal(await f.layer.update(), true);
      const set = f.set('fire-perimeters');
      assert.equal(set.options.kind, 'polygon');
      assert.equal(set.options.pickable, true);
      assert.equal(set.shown, true);
      const fills = set.items.slice(0, 3);
      const lines = set.items.slice(3);
      assert.equal(set.items.length, 6, 'every fill, then every fire line');
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
      assert.equal(f.set('fire-perimeters').shown, false);
    } finally {
      f.layer.destroy();
    }
    assert.equal(f.sets(), 0);
    f.destroy();
  });

  test(`a click on a perimeter or its fire line selects the incident; empty space clears it (${name})`, async () => {
    const f = fixture(makeHarness);
    try {
      await f.layer.update();
      assert.equal(f.listeners(), 1, 'one click listener while enabled');
      f.click({ set: 'fire-perimeters', instance: 0 });
      assert.equal(f.card()[0].id, 'fire-perimeter-card:2026-NMGNF-000123');
      // The other incident's second fire line.
      f.click({ set: 'fire-perimeters', instance: 5 });
      assert.equal(f.card()[0].id, 'fire-perimeter-card:other');
      f.click({ id: 'other-layer:aircraft-1' });
      assert.equal(
        f.card()[0].id,
        'fire-perimeter-card:other',
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

test('a click inside a perimeter picks it on the ground, not in its hole (the fake engine)', async () => {
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
    clickAt(-108.15, 35.35);
    assert.equal(f.card()[0].id, 'fire-perimeter-card:2026-NMGNF-000123');
    clickAt(-108.03, 35.22);
    assert.deepEqual(f.card(), [], 'the unburned hole is empty space');
  } finally {
    f.layer.destroy();
    f.destroy();
  }
});

test('the display ignores calls after destroy and destroys once', () => {
  const h = createFakeGroundHarness();
  const display = createPerimetersDisplay(h.engine);
  assert.equal(h.set('fire-perimeters').shown, false, 'hidden until shown');
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
