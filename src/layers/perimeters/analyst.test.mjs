// Fire Perimeters through the analyst engine: where a fire counts, and which
// fields its source carries.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFirePerimetersLayer } from './index.js';
import { createAnalystEngine } from '../../data/analystEngine.js';
import { fakeInput } from '../../input/testDoubles.mjs';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

const square = (lon, lat) => [
  [lon, lat],
  [lon + 0.1, lat],
  [lon + 0.1, lat + 0.1],
  [lon, lat + 0.1],
  [lon, lat],
];

/** A layer over `source`, enabled, and an engine reading it as the app does. */
function setup(source) {
  const viewer = { scene: { pick: () => null } };
  bindFakeDraw(viewer);
  const input = fakeInput(viewer);
  const layer = createFirePerimetersLayer({
    source,
    inputFor: () => input.input,
    inciwebSource: { getIndex: async () => [] },
  });
  layer.init(viewer);
  layer.enable(viewer);
  const engine = createAnalystEngine({
    getRecords: () => layer.getAnalystRecords(),
    getRecordFields: () => layer.getAnalystFields(),
    getRecordsAt: () => layer.getAnalystRecordsAt(),
    // A drawn box over the fire's west half only.
    resolveRegionRing: async () => ({
      name: 'West half',
      ring: [
        [-120.1, 35.9],
        [-119.92, 35.9],
        [-119.92, 36.2],
        [-120.1, 36.2],
      ],
    }),
    getViewContext: () => ({ lat: 36, lon: -120, viewRadiusKm: 25 }),
  });
  return { layer, engine };
}

/**
 * One fire spanning two cells, as a source that cuts it to the view gives
 * it: the anchor sits on the part in view, the analyst point stays put.
 */
function viewSnapshot(part, { analystPoint = true } = {}) {
  const west = { lon: -120, lat: 36 };
  const east = { lon: -119.9, lat: 36 };
  const shown = part === 'west' ? west : east;
  return {
    at: Date.UTC(2026, 7, 1, 12),
    fetchedAt: null,
    stale: false,
    revision: part,
    note: null,
    fires: [
      {
        id: 'ridge',
        name: 'Ridge Fire',
        acres: 900,
        discoveredTime: Date.UTC(2026, 6, 30),
        lastGrowthTime: Date.UTC(2026, 7, 1),
        anchor: { lon: shown.lon + 0.05, lat: shown.lat + 0.05 },
        ...(analystPoint
          ? { analystPoint: { lon: west.lon + 0.05, lat: west.lat + 0.05 } }
          : {}),
      },
    ],
    pieces: [
      {
        fireId: 'ridge',
        born: null,
        polygons: [[square(shown.lon, shown.lat)]],
        outline: [square(shown.lon, shown.lat)],
      },
    ],
  };
}

const countInWestHalf = (engine) =>
  engine
    .query({
      layers: ['fire-perimeters'],
      scope: { kind: 'region', name: 'West half' },
    })
    .then((result) => {
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.count;
    });

test('an area count does not change with the camera', async () => {
  let part = 'west';
  const { layer, engine } = setup({
    getSnapshot: async () => viewSnapshot(part),
  });
  await layer.update();
  assert.equal(await countInWestHalf(engine), 1);
  part = 'east';
  await layer.update();
  assert.equal(await countInWestHalf(engine), 1, 'same hour, other view');
  const [record] = layer.getAnalystRecords();
  assert.deepEqual([record.lon, record.lat], [-119.95, 36.05]);
  assert.equal('analystPoint' in record, false);
  layer.destroy();
});

test('without an analyst point a fire counts at its card anchor', async () => {
  let part = 'west';
  const { layer, engine } = setup({
    getSnapshot: async () => viewSnapshot(part, { analystPoint: false }),
  });
  await layer.update();
  assert.equal(await countInWestHalf(engine), 1);
  part = 'east';
  await layer.update();
  assert.equal(await countInWestHalf(engine), 0);
  layer.destroy();
});

test('a filter on a field the source does not declare is refused, apart from a real zero', async () => {
  const { layer, engine } = setup({
    analystFields: ['name', 'acres', 'discoveredTime', 'lastGrowthTime'],
    getSnapshot: async () => viewSnapshot('west'),
  });
  await layer.update();
  assert.deepEqual(layer.getAnalystFields(), [
    'name',
    'acres',
    'discoveredTime',
    'lastGrowthTime',
  ]);
  const refused = await engine.query({
    layers: ['fire-perimeters'],
    scope: { kind: 'anywhere' },
    filters: [{ field: 'state', op: 'eq', value: 'CA' }],
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'FIELD_UNAVAILABLE');
  assert.match(refused.error, /state is not available for fire-perimeters/);
  const zero = await engine.query({
    layers: ['fire-perimeters'],
    scope: { kind: 'anywhere' },
    filters: [{ field: 'acres', op: 'gt', value: 5000 }],
  });
  assert.equal(zero.ok, true);
  assert.equal(zero.count, 0);
  layer.destroy();
});

test('a source without a field list keeps every field queryable', async () => {
  const { layer } = setup({ getSnapshot: async () => viewSnapshot('west') });
  assert.equal(layer.getAnalystFields(), null);
  layer.destroy();
});
