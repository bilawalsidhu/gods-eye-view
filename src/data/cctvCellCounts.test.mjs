import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromDegrees } from '../geo/ellipsoid.js';
import { distance } from '../geo/vector.js';
import { getLocale, setLocale } from '../i18n/index.js';
import {
  createCameraCell,
  addCellCamera,
  cellCenter,
  cellBounds,
  formatCameraCount,
  mergeCountCells,
} from './cctvCellCounts.js';

test('camera counts use Latin digits and K notation whatever the UI language', () => {
  const previous = getLocale();
  const examples = [
    [2, '2'],
    [999, '999'],
    [1000, '1K'],
    [1150, '1.2K'],
    [1687, '1.7K'],
    [9960, '10K'],
    [10000, '10K'],
    [12345, '12K'],
    [12500, '13K'],
    [1000000, '1000K'],
  ];
  try {
    setLocale('ar');
    for (const [count, label] of examples)
      assert.equal(formatCameraCount(count), label);
  } finally {
    setLocale(previous);
  }
});

test('the marker mean weights every mount and the flight bounds cover the outlier', () => {
  const cameras = [
    { lon: 12, lat: 52, absoluteHeightM: 30 },
    { lon: 12, lat: 52, absoluteHeightM: 40 },
    { lon: 12.003, lat: 52.006, absoluteHeightM: 50 },
  ];
  const cell = createCameraCell();
  for (const camera of cameras) addCellCamera(cell, camera);
  const expected = fromDegrees(12.001, 52.002, 40);
  assert.ok(distance(cellCenter(cell), expected) < 0.001);
  const bounds = cellBounds(cell);
  for (const { lon, lat, absoluteHeightM } of cameras) {
    assert.ok(
      distance(bounds.center, fromDegrees(lon, lat, absoluteHeightM)) <
        bounds.radius,
    );
  }
});

function mergeCounts(sizes, counts, positions) {
  const cells = counts.map((count, i) => ({
    ...createCameraCell(String(i)),
    count,
  }));
  let i = 0;
  const groups = mergeCountCells(
    cells,
    () => positions[i++],
    (count) => sizes[count],
    4,
  );
  return { cells, groups };
}

test('stadiums merge by their own radii and segment lengths across grid boundaries', () => {
  const sizes = {
    2: { width: 28, height: 28 },
    7350: { width: 80, height: 48 },
  };
  const check = (counts, positions, expected) => {
    const { groups } = mergeCounts(sizes, counts, positions);
    assert.deepEqual(
      groups.map((cell) => cell.count),
      expected,
    );
    assert.equal(
      groups.reduce((sum, cell) => sum + cell.count, 0),
      counts[0] + counts[1],
    );
  };
  const origin = { x: 35, y: 37 };
  // Mixed radii sum to 38. At 42 pixels vertically the gap is exactly clear.
  check([2, 7350], [origin, { x: 35, y: 78 }], [7352]);
  check([2, 7350], [origin, { x: 35, y: 79 }], [2, 7350]);
  // The large pill's centre segment extends 16 pixels towards the circle.
  check([7350, 2], [origin, { x: 92, y: 37 }], [7352]);
  check([7350, 2], [origin, { x: 92, y: 49 }], [7350, 2]);
  check([2, 2], [origin, { x: 70, y: 37 }], [2, 2]);
  // Large pills can reach across a row boundary at their full diameter.
  check([7350, 7350], [origin, { x: 35, y: 88 }], [14700]);
});

test('a lone camera joins a count it touches, and lone cameras alone stay apart', () => {
  const sizes = {
    1: { width: 24, height: 24 },
    9: { width: 40, height: 40 },
  };
  const check = (counts, positions, expected) => {
    const { cells, groups } = mergeCounts(sizes, counts, positions);
    assert.deepEqual(
      groups.map((cell) => cell.count),
      expected,
    );
    // A lone camera that stays apart is still its own cell object.
    assert.deepEqual(
      groups.filter((cell) => cell.count === 1),
      cells.filter((cell) => groups.includes(cell) && cell.count === 1),
    );
  };
  const at = (x, y = 100) => ({ x, y });
  // Radii 20 and 12: the four-pixel gap is clear at 36 pixels.
  check([9, 1], [at(100), at(135)], [10]);
  check([9, 1], [at(100), at(136)], [9, 1]);
  check([1, 9], [at(135), at(100)], [10]);
  // Overlapping icons with no count beside them stay two icons.
  check([1, 1], [at(100), at(110)], [1, 1]);
  // A count takes every lone camera it touches, on either side.
  check([1, 9, 1], [at(70), at(100), at(130)], [11]);
  // A lone camera that only touches another lone camera is left alone.
  check([1, 1, 9], [at(40), at(70), at(100)], [1, 10]);
});

test('cells merged across the antimeridian stay at the antimeridian', () => {
  for (const lon of [179.9, 179.99, 179.999]) {
    for (const reversed of [false, true]) {
      const east = createCameraCell('e');
      const west = createCameraCell('w');
      for (let i = 0; i < 2; i++) {
        addCellCamera(east, { lon, lat: 0, absoluteHeightM: 0 });
        addCellCamera(west, { lon: -lon, lat: 0, absoluteHeightM: 0 });
      }
      const cells = reversed ? [west, east] : [east, west];
      const screens = [
        { x: 100, y: 100 },
        { x: 120, y: 100 },
      ];
      let i = 0;
      const [group, ...rest] = mergeCountCells(
        cells,
        () => screens[i++],
        () => ({ width: 40, height: 40 }),
        4,
      );
      assert.equal(rest.length, 0);
      assert.equal(group.count, 4);
      const expected = fromDegrees(180, 0, 0);
      assert.ok(distance(cellCenter(group), expected) < 1000, `${lon}: centre`);
      const bounds = cellBounds(group);
      assert.ok(bounds.radius < 15_000, `${lon}: radius ${bounds.radius}`);
      for (const l of [lon, -lon])
        assert.ok(
          distance(bounds.center, fromDegrees(l, 0, 0)) <= bounds.radius,
        );
    }
  }
});

test('flight bounds on drawn ground still contain every mount', () => {
  // Flat ellipsoid terrain (Re:Earth terrain failed), mounts at 1,800 m.
  const flat = createCameraCell('k');
  addCellCamera(flat, { lon: 10, lat: 46, absoluteHeightM: 1800 });
  addCellCamera(flat, { lon: 10, lat: 46, absoluteHeightM: 1800 });
  flat.groundM = 0;
  const fb = cellBounds(flat);
  assert.ok(
    distance(fromDegrees(10, 46, 1800), fb.center) <= fb.radius,
    'flat',
  );
  // Ravine: mounts 200 m apart at 600 m, the floor at 0 m between them.
  const east = 10 + 200 / (111_320 * Math.cos((46 * Math.PI) / 180));
  const ravine = createCameraCell('r');
  addCellCamera(ravine, { lon: 10, lat: 46, absoluteHeightM: 600 });
  addCellCamera(ravine, { lon: east, lat: 46, absoluteHeightM: 600 });
  ravine.groundM = 0;
  const rb = cellBounds(ravine);
  for (const lon of [10, east])
    assert.ok(
      distance(fromDegrees(lon, 46, 600), rb.center) <= rb.radius,
      'ravine',
    );
});

test('a lone camera between two counts joins one of them and does not merge them', () => {
  const sizes = { 1: { width: 24, height: 24 }, 9: { width: 40, height: 40 } };
  const run = (counts, xs) =>
    mergeCounts(
      sizes,
      counts,
      xs.map((x) => ({ x, y: 100 })),
    )
      .groups.map((cell) => cell.count)
      .sort((a, b) => a - b);
  assert.deepEqual(run([9, 9], [70, 130]), [9, 9]);
  for (const [counts, xs] of [
    [
      [9, 1, 9],
      [70, 100, 130],
    ],
    [
      [1, 9, 9],
      [100, 70, 130],
    ],
    [
      [9, 9, 1],
      [70, 130, 100],
    ],
  ])
    assert.deepEqual(run(counts, xs), [9, 10], String(counts));
});
