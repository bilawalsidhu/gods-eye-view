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

test('camera counts use the same Latin digits and K notation in every UI language', () => {
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
    for (const locale of ['en', 'ru', 'ja', 'ar']) {
      setLocale(locale);
      for (const [count, label] of examples)
        assert.equal(formatCameraCount(count), label, `${locale}: ${count}`);
    }
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

test('stadiums merge by their own radii and segment lengths across grid boundaries', () => {
  const sizes = {
    2: { width: 28, height: 28 },
    7350: { width: 80, height: 48 },
  };
  const gap = 4;
  const check = (counts, positions, expected) => {
    const cells = counts.map((count, i) => ({
      ...createCameraCell(String(i)),
      count,
    }));
    let i = 0;
    const groups = mergeCountCells(
      cells,
      () => positions[i++],
      (count) => sizes[count],
      gap,
    );
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
