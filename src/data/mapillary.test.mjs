import test from 'node:test';
import assert from 'node:assert/strict';

import {
  destinationAtBearing,
  mapillaryAltitudeGate,
  mapillaryBoundsEquivalent,
  mapillaryNearbyBox,
  normalizeCompassAngle,
  normalizeMapillaryImage,
  selectMapillaryRenderRecords,
} from './mapillary.js';

test('Mapillary records prefer computed geometry and direction', () => {
  const record = normalizeMapillaryImage({
    id: '123',
    computed_geometry: { type: 'Point', coordinates: [4.9, 52.37] },
    geometry: { type: 'Point', coordinates: [1, 2] },
    captured_at: 1_700_000_000_000,
    computed_compass_angle: 361,
    compass_angle: 90,
    creator: { username: 'mapper' },
    camera_type: 'perspective',
    make: 'ExampleCam',
    model: 'Road One',
    thumb_1024_url: 'https://images.example.test/123-large.jpg',
    thumb_256_url: 'https://images.example.test/123.jpg',
  });
  assert.deepEqual(record, {
    id: '123',
    entityId: 'mapillary:123',
    latitude: 52.37,
    longitude: 4.9,
    capturedAt: 1_700_000_000_000,
    compassAngle: 1,
    creator: 'mapper',
    thumbnailUrl: 'https://images.example.test/123-large.jpg',
    cameraType: 'perspective',
    make: 'ExampleCam',
    model: 'Road One',
    imageUrl: 'https://www.mapillary.com/app/?pKey=123',
  });
});

test('Mapillary records retain usable original metadata fallbacks', () => {
  const record = normalizeMapillaryImage({
    id: 456,
    geometry: { type: 'Point', coordinates: [-97.74, 30.27] },
    compass_angle: -45,
  });
  assert.equal(record.compassAngle, 315);
  assert.equal(record.creator, null);
  assert.equal(record.thumbnailUrl, null);
  assert.equal(record.capturedAt, null);
  assert.equal(record.cameraType, null);
  assert.equal(record.make, null);
  assert.equal(record.model, null);
});

test('Mapillary rejects records without a stable id or valid point', () => {
  assert.equal(normalizeMapillaryImage({ geometry: { type: 'Point', coordinates: [1, 2] } }), null);
  assert.equal(normalizeMapillaryImage({ id: 'x', geometry: { type: 'LineString', coordinates: [1, 2] } }), null);
  assert.equal(normalizeMapillaryImage({ id: 'x', geometry: { type: 'Point', coordinates: [181, 2] } }), null);
  assert.equal(normalizeCompassAngle('unknown'), null);
});

test('altitude gate has a stable 7 km enter and 9 km exit band', () => {
  assert.equal(mapillaryAltitudeGate(false, 7001), false);
  assert.equal(mapillaryAltitudeGate(false, 7000), true);
  assert.equal(mapillaryAltitudeGate(true, 8999), true);
  assert.equal(mapillaryAltitudeGate(true, 9000), false);
});

test('direction endpoint follows compass convention', () => {
  const north = destinationAtBearing(0, 0, 0, 100);
  const east = destinationAtBearing(0, 0, 90, 100);
  assert.ok(north.latitude > 0 && Math.abs(north.longitude) < 1e-8);
  assert.ok(east.longitude > 0 && Math.abs(east.latitude) < 1e-8);
});

test('near-identical view bounds reuse the current result', () => {
  const base = { west: -97.75, south: 30.25, east: -97.70, north: 30.30 };
  const tinyPan = { west: -97.749, south: 30.251, east: -97.699, north: 30.301 };
  const farPan = { west: -97.70, south: 30.25, east: -97.65, north: 30.30 };
  assert.equal(mapillaryBoundsEquivalent(tinyPan, base), true);
  assert.equal(mapillaryBoundsEquivalent(farPan, base), false);
});

test('nearby query stays compact in dense areas and inside world bounds', () => {
  const amsterdam = mapillaryNearbyBox(52.373, 4.895, 0.05);
  assert.ok(Math.abs(amsterdam.south - 52.372) < 1e-12);
  assert.ok(Math.abs(amsterdam.west - 4.894) < 1e-12);
  assert.ok(Math.abs(amsterdam.north - 52.374) < 1e-12);
  assert.ok(Math.abs(amsterdam.east - 4.896) < 1e-12);
  const edge = mapillaryNearbyBox(90, 180);
  assert.ok(Math.abs(edge.south - 89.998) < 1e-12);
  assert.ok(Math.abs(edge.west - 179.998) < 1e-12);
  assert.equal(edge.north, 90);
  assert.equal(edge.east, 180);
  assert.equal(mapillaryNearbyBox('unknown', 0), null);
});

test('render selection keeps the newest spatially distinct imagery', () => {
  const records = [
    { id: 'old-near', latitude: 52.373, longitude: 4.895, capturedAt: 100 },
    { id: 'new-near', latitude: 52.37301, longitude: 4.89501, capturedAt: 300 },
    { id: 'far', latitude: 52.3733, longitude: 4.8953, capturedAt: 200 },
  ];
  assert.deepEqual(
    selectMapillaryRenderRecords(records, 10, 12).map((record) => record.id),
    ['new-near', 'far'],
  );
  assert.deepEqual(selectMapillaryRenderRecords(records, 1, 0).map((record) => record.id), ['new-near']);
});
