import assert from 'node:assert/strict';
import test from 'node:test';
import { createDroneAirspaceLayer } from './index.js';
import {
  describeEntity,
  viewSummaryForLayer,
} from '../../data/entityContext.js';
import { fakeInputUnderLabel } from '../../input/testDoubles.mjs';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

async function layerWith(rows) {
  const viewer = { scene: { pick: () => null } };
  bindFakeDraw(viewer);
  const input = fakeInputUnderLabel(viewer);
  const layer = createDroneAirspaceLayer({
    source: { getSnapshot: async () => rows },
    overlayHost: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
      hitTest: () => null,
    },
    inputFor: () => input.input,
    picking: {
      resolvePickId: (p) => p?.id?.id ?? p?.id ?? null,
      isOwnedByOtherLayer: () => false,
      registerPickOwner() {},
      unregisterPickOwner() {},
      clickCard: () => null,
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  await layer.update(viewer);
  return layer;
}

// A 1 deg x 1 deg restricted area; its anchor is near (35.5, -117.5).
const ring = [
  [-118, 35],
  [-117, 35],
  [-117, 36],
  [-118, 36],
  [-118, 35],
];
const row = {
  stableId: '2508',
  name: 'R-2508',
  typeCode: 'R',
  type: 'Restricted',
  polygons: [[ring]],
};

async function readIn(rect, center) {
  const layer = await layerWith([row]);
  const dm = {
    isEnabled: () => true,
    layers: new Map([['drone-airspace', { module: layer }]]),
  };
  const summary = viewSummaryForLayer(
    dm,
    { id: 'drone-airspace', enabled: true },
    rect,
    center,
    {
      clipViewport: true,
      heightM: 15_000,
      includeEmpty: true,
    },
  );
  return { summary, dm };
}

test('a viewport inside the fill, away from the anchor, counts the zone', async () => {
  const { summary, dm } = await readIn(
    { west: -117.95, east: -117.85, south: 35.05, north: 35.12 },
    { lat: 35.08, lon: -117.9 },
  );
  assert.equal(summary.count, 1);
  const { identity } = summary.items[0];
  assert.equal(identity.lineAnchor, true);
  const card = describeEntity(dm, identity);
  assert.deepEqual([card.lat, card.lon], [35.08, -117.9]);
});

test('a viewport crossing only the east edge counts the zone', async () => {
  const { summary } = await readIn(
    { west: -117.05, east: -116.95, south: 35.4, north: 35.5 },
    { lat: 35.45, lon: -117 },
  );
  assert.equal(summary.count, 1);
});

test('a viewport outside the zone counts nothing (control)', async () => {
  const { summary } = await readIn(
    { west: -116.5, east: -116.4, south: 35.05, north: 35.12 },
    { lat: 35.08, lon: -116.45 },
  );
  assert.equal(summary.count, 0);
});
