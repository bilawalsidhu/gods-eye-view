import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assetCountLabel,
  estimateBoundsAreaKm2,
  formatBoundsSummary,
  formatViewportCapture,
  groupContactsForBrief,
  landmarksNearBounds,
  summarizeAssetCounts,
} from './intelAreaContext.js';

test('formatViewportCapture strips data URL prefix', () => {
  const capture = formatViewportCapture({
    dataUrl: 'data:image/jpeg;base64,abc123',
    width: 640,
    height: 360,
  });
  assert.deepEqual(capture, {
    mimeType: 'image/jpeg',
    width: 640,
    height: 360,
    dataBase64: 'abc123',
  });
});

test('landmarksNearBounds returns catalog POIs near London Trafalgar sector', () => {
  const bounds = {
    south: 51.505,
    north: 51.512,
    west: -0.132,
    east: -0.122,
    center: { lat: 51.508, lon: -0.127 },
    crossesAntimeridian: false,
  };
  const landmarks = landmarksNearBounds(bounds, { maxDistanceKm: 1.5 });
  assert.ok(landmarks.some((entry) => entry.name.includes('Big Ben')));
});

test('formatBoundsSummary uses natural footprint wording', () => {
  const bounds = {
    south: 51.505,
    north: 51.512,
    west: -0.132,
    east: -0.122,
    center: { lat: 51.508, lon: -0.127 },
  };
  const summary = formatBoundsSummary(bounds, 0.42);
  assert.match(summary, /hectares|km/i);
});

test('formatBoundsSummary hides raw coords for huge selections', () => {
  const summary = formatBoundsSummary(
    { south: 10, north: 30, west: 50, east: 60, center: { lat: 20, lon: 55 } },
    120_000,
  );
  assert.match(summary, /Wide on-screen selection/i);
});

test('summarizeAssetCounts groups mixed layer contacts', () => {
  const counts = summarizeAssetCounts([
    { layerId: 'cctv' },
    { layerId: 'cctv' },
    { layerId: 'flights' },
    { layerId: 'radio' },
  ]);
  assert.equal(counts.cctv, 2);
  assert.equal(counts.aircraft, 1);
  assert.equal(counts.radio, 1);
  assert.match(assetCountLabel(counts), /2 cams/);
  assert.match(assetCountLabel(counts), /1 aircraft/);
});

test('groupContactsForBrief preserves layer order', () => {
  const groups = groupContactsForBrief([
    { layerId: 'flights', name: 'A' },
    { layerId: 'cctv', name: 'Cam' },
    { layerId: 'radio', name: 'FM' },
  ]);
  assert.deepEqual(groups.map((group) => group.layerId), ['cctv', 'flights', 'radio']);
});

test('estimateBoundsAreaKm2 returns positive area for valid bounds', () => {
  const area = estimateBoundsAreaKm2({
    south: 30,
    north: 31,
    west: -98,
    east: -97,
    center: { lat: 30.5, lon: -97.5 },
  });
  assert.ok(area > 9000 && area < 11000);
});
