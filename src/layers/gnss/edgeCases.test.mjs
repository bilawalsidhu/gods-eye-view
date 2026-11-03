import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GNSS_CELL_DEG,
  GNSS_WINDOW_MS,
  accumulateGnssObservations,
  binGnssCells,
  gnssCellKey,
  pruneGnssObservations,
} from './records.js';

const T0 = Date.UTC(2026, 0, 2, 12);
const MINUTE = 60_000;
const row = (hex, lat, lon, degraded) => ({ hex, lat, lon, degraded });
// Cell edge shared by the two zones: 10.5° N.
const SOUTH = 10.25;
const NORTH = 10.75;

const summary = (cells) =>
  cells.map(({ id, aircraft, degraded, level }) => ({
    id,
    aircraft,
    degraded,
    level,
  }));

test('edge:gnss-integrity: a stale zone and its refreshed neighbour never mix', () => {
  const store = new Map();
  accumulateGnssObservations(
    store,
    [
      row('aaa001', SOUTH, 20.2, true),
      row('aaa002', SOUTH, 20.3, true),
      row('aaa003', SOUTH, 20.4, false),
    ],
    T0,
  );
  // Twenty minutes later only the northern neighbour is refreshed; one
  // degraded aircraft has crossed into it and now reports healthy.
  accumulateGnssObservations(
    store,
    [
      row('aaa001', NORTH, 20.2, false),
      row('bbb001', NORTH, 20.3, false),
      row('bbb002', NORTH, 20.4, false),
    ],
    T0 + 20 * MINUTE,
  );
  const southId = gnssCellKey(SOUTH, 20.2);
  const northId = gnssCellKey(NORTH, 20.2);
  assert.notEqual(southId, northId);
  assert.deepEqual(
    summary(binGnssCells(store)),
    [
      { id: southId, aircraft: 3, degraded: 2, level: 'high' },
      { id: northId, aircraft: 3, degraded: 0, level: 'low' },
    ].toSorted((a, b) => a.id.localeCompare(b.id)),
  );

  // Once the southern evidence leaves the window, only the fresh zone remains,
  // unchanged: the stale zone's degraded reports do not leak into it.
  pruneGnssObservations(store, T0 + GNSS_WINDOW_MS + MINUTE);
  assert.deepEqual(summary(binGnssCells(store)), [
    { id: northId, aircraft: 3, degraded: 0, level: 'low' },
  ]);
});

test('edge:gnss-integrity: a position on the shared edge belongs to exactly one cell', () => {
  const edge = 10.5;
  const key = gnssCellKey(edge, 20.5);
  // The edge belongs to the cell that starts there (north and east).
  assert.equal(key, gnssCellKey(NORTH, 20.75));
  assert.notEqual(key, gnssCellKey(SOUTH, 20.25));
  for (let i = 0; i < 3; i++) assert.equal(gnssCellKey(edge, 20.5), key);

  const store = new Map();
  accumulateGnssObservations(
    store,
    [
      row('ccc001', edge, 20.5, true),
      row('ccc002', NORTH, 20.75, false),
      row('ccc003', NORTH, 20.75, false),
      row('ccc004', SOUTH, 20.25, false),
      row('ccc005', SOUTH, 20.25, false),
      row('ccc006', SOUTH, 20.25, false),
    ],
    T0,
  );
  const cells = binGnssCells(store);
  const total = cells.reduce((sum, cell) => sum + cell.aircraft, 0);
  assert.equal(total, 6);
  const north = cells.find((cell) => cell.id === key);
  assert.equal(north.aircraft, 3);
  assert.equal(north.degraded, 1);
  assert.equal(north.south, edge);
  assert.equal(north.north, edge + GNSS_CELL_DEG);
});
