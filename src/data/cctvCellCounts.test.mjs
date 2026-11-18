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
} from './cctvCellCounts.js';

test('camera counts are exact through 999 and compact in the active locale', () => {
  const previous = getLocale();
  try {
    for (const locale of ['en', 'fr', 'ja']) {
      setLocale(locale);
      for (const n of [2, 999, 1000, 12345]) {
        const format = new Intl.NumberFormat(
          locale,
          n < 1000 ? {} : { notation: 'compact' },
        );
        assert.equal(formatCameraCount(n), format.format(n));
      }
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
