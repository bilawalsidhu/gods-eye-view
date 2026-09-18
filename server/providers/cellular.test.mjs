import test from 'node:test';
import assert from 'node:assert/strict';
import { cellularBoxAreaM2, validCellularBox } from './cellular.js';

function params(values) {
  return new URLSearchParams(
    Object.entries(values).map(([key, value]) => [key, String(value)]),
  );
}

test('cellular provider validates bounded non-dateline boxes', () => {
  assert.deepEqual(
    validCellularBox(params({ south: 43, west: -80, north: 44, east: -79 })),
    {
      south: 43,
      west: -80,
      north: 44,
      east: -79,
    },
  );
  assert.equal(
    validCellularBox(params({ south: 43, west: -80, north: 46, east: -79 })),
    null,
  );
  assert.equal(
    validCellularBox(params({ south: 43, west: 179, north: 44, east: -179 })),
    null,
  );
});

test('cellular provider area estimate is finite and latitude-aware', () => {
  const equator = cellularBoxAreaM2({
    south: 0,
    west: 0,
    north: 0.01,
    east: 0.01,
  });
  const highLatitude = cellularBoxAreaM2({
    south: 70,
    west: 0,
    north: 70.01,
    east: 0.01,
  });
  assert.ok(equator > 1_000_000 && equator < 2_000_000);
  assert.ok(highLatitude > 0 && highLatitude < equator);
});

test('OpenCellID viewport planning splits a city box into stable API-safe tiles', async () => {
  const { planOpenCellIdTiles } = await import('./cellular.js');
  const box = { south: 45.4, west: -75.72, north: 45.46, east: -75.64 };
  const plan = planOpenCellIdTiles(box);
  assert.equal(plan.exceedsLimit, false);
  assert.ok(plan.tiles.length > 1);
  assert.equal(plan.tiles.length, plan.totalTiles);
  for (const tile of plan.tiles) {
    assert.ok(cellularBoxAreaM2(tile) <= 3_500_000);
    assert.match(tile.id, /^\d+:\d+$/);
  }

  const shifted = planOpenCellIdTiles({
    south: box.south + 0.001,
    west: box.west + 0.001,
    north: box.north + 0.001,
    east: box.east + 0.001,
  });
  const ids = new Set(plan.tiles.map((tile) => tile.id));
  assert.ok(shifted.tiles.some((tile) => ids.has(tile.id)));
});

test('OpenCellID viewport planning budgets large views around the viewport center', async () => {
  const { planOpenCellIdTiles } = await import('./cellular.js');
  const box = { south: 43, west: -80, north: 44, east: -79 };
  const plan = planOpenCellIdTiles(box, 8);
  assert.equal(plan.exceedsLimit, true);
  assert.ok(plan.totalTiles > 8);
  assert.equal(plan.tiles.length, 8);
  for (const tile of plan.tiles) {
    assert.ok(cellularBoxAreaM2(tile) <= 3_500_000);
  }
  const centerLat = (box.south + box.north) / 2;
  const centerLon = (box.west + box.east) / 2;
  const distances = plan.tiles.map((tile) => {
    const lat = (tile.south + tile.north) / 2 - centerLat;
    const lon = (tile.west + tile.east) / 2 - centerLon;
    return lat * lat + lon * lon;
  });
  assert.deepEqual(
    distances,
    [...distances].sort((a, b) => a - b),
  );
});

test('OpenCellID production planning samples 12 center tiles for wider views', async () => {
  const { planOpenCellIdRequest } = await import('./cellular.js');
  const box = { south: 45.35, west: -75.8, north: 45.55, east: -75.55 };
  const plan = planOpenCellIdRequest(box);
  assert.equal(plan.exceedsLimit, true);
  assert.equal(plan.viewportPartial, true);
  assert.equal(plan.tileLimit, 12);
  assert.equal(plan.tiles.length, 12);
  assert.ok(plan.totalTiles > plan.tiles.length);
});
