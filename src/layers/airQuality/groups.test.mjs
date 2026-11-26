import test from 'node:test';
import assert from 'node:assert/strict';
import { fromDegrees } from '../../geo/ellipsoid.js';
import {
  cellDegAt,
  groupRect,
  groupStations,
  groupTarget,
  nearestItem,
} from './groups.js';

const station = (id, lat, lon, value = 10) => ({ id, lat, lon, value });
const ids = (group) => group.members.map((member) => member.id).sort();

test('stations in one cell form one group with their mean', () => {
  const groups = groupStations(
    [
      station('a', 10.1, 10.1, 10),
      station('b', 10.3, 10.2, 20),
      station('c', 10.2, 10.4, 60),
    ],
    1,
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(ids(groups[0]), ['a', 'b', 'c']);
  assert.equal(groups[0].mean, 30);
  assert.ok(Math.abs(groups[0].lat - 10.2) < 1e-9);
  assert.ok(Math.abs(groups[0].lon - 30.7 / 3) < 1e-9);
});

test('stations two cells apart stay separate', () => {
  const groups = groupStations(
    [station('a', 10.5, 10.5), station('b', 10.5, 12.6)],
    1,
  );
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(ids).sort(), [['a'], ['b']]);
});

test('neighbouring cells join only when their centres are within 0.75 of a cell', () => {
  // Either side of a cell edge, 0.2 apart: one group.
  const near = groupStations(
    [station('a', 0.5, 0.9), station('b', 0.5, 1.1)],
    1,
  );
  assert.equal(near.length, 1);
  // Adjacent cells, 0.9 apart: two.
  const far = groupStations(
    [station('a', 0.5, 0.3), station('b', 0.5, 1.2)],
    1,
  );
  assert.equal(far.length, 2);
});

test('the selected station is never grouped', () => {
  const groups = groupStations(
    [
      station('a', 10.1, 10.1, 10),
      station('b', 10.2, 10.2, 20),
      station('sel', 10.15, 10.15, 90),
    ],
    1,
    { selectedId: 'sel' },
  );
  assert.equal(groups.length, 2);
  const selected = groups.find((group) => ids(group).includes('sel'));
  assert.deepEqual(ids(selected), ['sel']);
  const other = groups.find((group) => group !== selected);
  assert.deepEqual(ids(other), ['a', 'b']);
  assert.equal(other.mean, 15, 'the selected value is not in the mean');
});

test('a group near the dateline joins across ±180', () => {
  const groups = groupStations(
    [station('east', 0.5, 179.95, 10), station('west', 0.5, -179.95, 30)],
    1,
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(ids(groups[0]), ['east', 'west']);
  assert.ok(
    Math.abs(Math.abs(groups[0].lon) - 180) < 1e-9,
    `the centre is on the dateline, not at 0: ${groups[0].lon}`,
  );
  assert.equal(groups[0].mean, 20);
});

test('unrated stations group with neighbours and only rated values contribute to the mean', () => {
  const groups = groupStations(
    [
      station('a', 1.1, 1.1, 40),
      station('b', 1.2, 1.2, 20),
      station('grey', 1.15, 1.15, null),
    ],
    1,
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(ids(groups[0]), ['a', 'b', 'grey']);
  assert.equal(groups[0].mean, 30);
  const grey = groupStations(
    [station('a', 1.1, 1.1, null), station('b', 1.2, 1.2, null)],
    1,
  );
  assert.equal(grey.length, 1);
  assert.equal(grey[0].mean, null);
});

test('a high-latitude neighbour in the next column joins', () => {
  // Row 60-70 degrees: columns 10 / cos(65) degrees wide, so 20.5 and 24.5
  // fall in columns 0 and 1, 1.4 degrees apart on the ground.
  const groups = groupStations(
    [station('a', 69, 20.5), station('b', 69, 24.5)],
    10,
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(ids(groups[0]), ['a', 'b']);
});

test('without a usable cell every station stands alone', () => {
  const list = [station('a', 1.1, 1.1), station('b', 1.2, 1.2)];
  for (const cell of [0, -1, NaN, Infinity])
    assert.equal(groupStations(list, cell).length, 2, String(cell));
});

test('the cell is the ground span of 46 px at the view centre, 6 degrees when a pick misses', () => {
  // 0.01 degrees of longitude per pixel at the equator.
  const camera = {
    width: 800,
    height: 600,
    pickEllipsoid: (x, y) => fromDegrees((x - 400) * 0.01, (300 - y) * 0.01),
  };
  assert.ok(Math.abs(cellDegAt(camera) - 0.46) < 1e-6);
  assert.ok(Math.abs(cellDegAt(camera, 10) - 0.1) < 1e-6);
  assert.equal(cellDegAt({ ...camera, pickEllipsoid: () => null }), 6);
});

test('a tilted view whose centre sees sky is measured lower on screen', () => {
  const rows = [];
  // Sky above 70 % of the height, ground below it.
  const camera = {
    width: 800,
    height: 600,
    pickEllipsoid: (x, y) => {
      rows.push(y);
      return y > 420 ? fromDegrees((x - 400) * 0.001, 0) : null;
    },
  };
  assert.ok(Math.abs(cellDegAt(camera) - 0.046) < 1e-6);
  assert.deepEqual([...new Set(rows)], [300, 450]);
  assert.equal(
    cellDegAt({ ...camera, pickEllipsoid: (x, y) => (rows.push(y), null) }),
    6,
  );
});

const world = { west: -180, south: -90, east: 180, north: 90 };

test('a group click flies in to its rectangle when that is smaller than the view', () => {
  const members = [station('a', 10, 20, 5), station('b', 12, 25, 9)];
  const target = groupTarget(members, world);
  assert.deepEqual(target, { rect: groupRect(members) });
  assert.deepEqual(groupTarget(members, null), { rect: groupRect(members) });
});

test('a group click never zooms out: it selects the highest member instead', () => {
  const members = [
    station('a', 10, 20, 5),
    station('b', 12, 25, 9),
    station('c', 11, 22, 7),
  ];
  const view = { west: 21, south: 10.5, east: 23, north: 11.5 };
  assert.deepEqual(groupTarget(members, view), { station: members[1] });
  // Across the dateline the view is 1 degree wide.
  const dateline = [station('e', 0, 179, 1), station('w', 1, -179, 2)];
  assert.deepEqual(
    groupTarget(dateline, { west: 179.5, south: -1, east: -179.5, north: 2 }),
    { station: dateline[1] },
  );
  assert.ok(
    groupTarget(dateline, { west: 170, south: -5, east: -170, north: 5 }).rect,
  );
});

test('stations within about 100 m cannot come apart: the highest is selected', () => {
  // About 30 m apart.
  const members = [
    station('low', 48.85, 2.35, 20),
    station('high', 48.85027, 2.35, 80),
  ];
  assert.deepEqual(groupTarget(members, world), { station: members[1] });
});

test('a click is near an item within its radius and 6 px', () => {
  // 0.01 degrees per 10 px at the equator.
  const at = { lon: 0, lat: 0 };
  const side = { lon: 0.01, lat: 0 };
  const items = [
    { id: 'dot', lon: 0.005, lat: 0, px: 7 },
    { id: 'far', lon: 0.05, lat: 0, px: 7 },
    { id: 'bubble', lon: 0, lat: 0.014, px: 18 },
  ];
  assert.equal(nearestItem(items, at, side).id, 'dot');
  assert.equal(nearestItem(items.slice(1), at, side).id, 'bubble');
  assert.equal(nearestItem(items.slice(1, 2), at, side), null);
});

test('a group rectangle is its members padded by 20 %, across the dateline too', () => {
  const rect = groupRect([
    station('a', 10, 20),
    station('b', 12, 25),
    station('c', 11, 22),
  ]);
  const expected = { west: 19, east: 26, south: 9.6, north: 12.4 };
  for (const [key, value] of Object.entries(expected))
    assert.ok(Math.abs(rect[key] - value) < 1e-9, `${key}: ${rect[key]}`);
  const dateline = groupRect([station('e', 0, 179), station('w', 1, -179)]);
  assert.ok(Math.abs(dateline.west - 178.6) < 1e-9);
  assert.ok(Math.abs(dateline.east - -178.6) < 1e-9);
});
