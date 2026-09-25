import test from 'node:test';
import assert from 'node:assert/strict';

import {
  haversineDistanceM,
  isPointInPolygon,
  GeofenceEngine,
} from './geofenceEngine.js';

test('haversineDistanceM computes accurate surface distance', () => {
  // Distance from London (51.5074, -0.1278) to Paris (48.8566, 2.3522) is ~343 km
  const dist = haversineDistanceM(51.5074, -0.1278, 48.8566, 2.3522);
  assert.ok(dist > 340000 && dist < 346000);
});

test('isPointInPolygon correctly detects interior and exterior points', () => {
  // Triangle around (10, 10), (10, 20), (20, 15)
  const triangle = [
    { latDeg: 10, lonDeg: 10 },
    { latDeg: 10, lonDeg: 20 },
    { latDeg: 20, lonDeg: 15 },
  ];

  // Point inside
  assert.equal(isPointInPolygon(12, 15, triangle), true);

  // Point outside
  assert.equal(isPointInPolygon(5, 5, triangle), false);
  assert.equal(isPointInPolygon(25, 15, triangle), false);
});

test('GeofenceEngine triggers breach alerts only on zone entry transitions', () => {
  let breachCount = 0;
  let lastBreachedEntity = null;

  const engine = new GeofenceEngine({
    onAlert: (alert) => {
      if (alert.type === 'breach') {
        breachCount++;
        lastBreachedEntity = alert.entity;
      }
    },
  });

  // Circle zone at (0, 0) with radius 100km (~100,000m)
  engine.addZone({
    id: 'test-zone-1',
    name: 'Sector 1',
    type: 'circle',
    center: { latDeg: 0, lonDeg: 0 },
    radiusM: 100000,
    alertLevel: 'warning',
  });

  // Entity starts outside (at ~222km north: lat 2.0, lon 0)
  const outsideEntity = { id: 'FLIGHT-1', latDeg: 2.0, lonDeg: 0 };
  let alerts = engine.scanEntities([outsideEntity]);
  assert.equal(alerts.length, 0);
  assert.equal(breachCount, 0);

  // Entity moves inside (at ~55km north: lat 0.5, lon 0)
  const insideEntity = { id: 'FLIGHT-1', latDeg: 0.5, lonDeg: 0 };
  alerts = engine.scanEntities([insideEntity]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'breach');
  assert.equal(breachCount, 1);
  assert.equal(lastBreachedEntity.id, 'FLIGHT-1');

  // Entity stays inside -> should NOT fire breach alert again
  alerts = engine.scanEntities([insideEntity]);
  assert.equal(alerts.length, 0);
  assert.equal(breachCount, 1);

  // Entity exits zone
  alerts = engine.scanEntities([outsideEntity]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'exit');
});
