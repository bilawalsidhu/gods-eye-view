import test from 'node:test';
import assert from 'node:assert/strict';
import { VesselRecords } from './records.js';
import { createVesselSnapshotRenderer } from './snapshotRenderer.js';
import { layerPlacement } from '../../data/placementProvider.js';

const row = (id, fields = {}) => ({
  id,
  mmsi: id,
  lat: 51.93,
  lon: 4.05,
  speed: 10,
  course: 90,
  heading: 92,
  last_position_epoch: 1_000,
  ...fields,
});

function harness({ placement = null, following = false } = {}) {
  const visuals = [];
  const state = { selectedRecord: null, trailId: null };
  const records = new VesselRecords({ now: () => 5_000_000 });
  const rendering = {
    ensureCollections() {},
    makeOccluder: () => null,
    renderRowLimit: () => Infinity,
    prepareRecordVisual(record) {
      visuals.push(record.id);
      return { billboard: null };
    },
    addRecordPrimitives() {},
    removeRecordPrimitives() {},
    shipIcon: () => 'icon',
    shipScale: () => 1,
    updateVisibility() {},
  };
  const renderer = createVesselSnapshotRenderer({
    state,
    placement,
    records,
    rendering,
    tracking: {},
    selection: {},
    cards: {},
    followsClock: () => following,
  });
  return {
    visuals,
    reconcile: (rows, options) => renderer.reconcileVessels({}, rows, options),
  };
}

function recording() {
  const told = [];
  const forgotten = [];
  const placement = layerPlacement(
    {
      layer: () => ({
        observe: (id, fix) => told.push([id, fix]),
        place: () => null,
        forget: (id) => forgotten.push(id),
      }),
    },
    'vessels',
  );
  return { told, forgotten, placement };
}

test('vessels reconcile as before with no placement', () => {
  const own = harness();
  own.reconcile([row('a'), row('b')]);
  own.reconcile([row('a', { lat: 52, last_position_epoch: 1_060 })]);
  const { placement } = recording();
  const placed = harness({ placement });
  placed.reconcile([row('a'), row('b')]);
  placed.reconcile([row('a', { lat: 52, last_position_epoch: 1_060 })]);
  assert.deepEqual(placed.visuals, own.visuals);
});

test('each live vessel fix is told to the placement, in m/s, and a vessel that leaves is forgotten', () => {
  const { told, forgotten, placement } = recording();
  const probe = harness({ placement });
  probe.reconcile([row('a'), row('b', { speed: null, course: null })]);
  probe.reconcile([row('a', { lat: 52, last_position_epoch: 1_060 })]);
  assert.deepEqual(
    told.map(([id, fix]) => [id, fix.timeMs, fix.lat]),
    [
      ['a', 1_000_000, 51.93],
      ['b', 1_000_000, 51.93],
      ['a', 1_060_000, 52],
    ],
  );
  assert.ok(Math.abs(told[0][1].speedMps - 10 * (1852 / 3600)) < 1e-12);
  assert.equal(told[0][1].courseDeg, 90);
  assert.equal(told[0][1].headingDeg, 92);
  assert.ok(Number.isNaN(told[1][1].speedMps));
  assert.ok(Number.isNaN(told[1][1].courseDeg));
  assert.deepEqual(forgotten, ['b']);
});

test('following the world clock, or rows at another time, tell the placement nothing', () => {
  const { told, placement } = recording();
  harness({ placement, following: true }).reconcile([row('a')]);
  harness({ placement }).reconcile([row('a')], { replace: true });
  assert.deepEqual(told, []);
});
