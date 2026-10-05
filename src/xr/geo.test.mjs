import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { geoPosition, positionGeo, focusQuaternion, markerRadius, sampleContacts, GLOBE_RADIUS } from './geo.js';
import { isConsoleRoute, viewUrl } from './routes.js';

test('geographic round trips, UV axes and hemisphere focus agree', () => {
  assert.ok(geoPosition(0, -90, 1).distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-10);
  for (const [lat, lon] of [[0, 0], [45, -85], [-37, 179.9], [89, -170]]) {
    const point = geoPosition(lat, lon), back = positionGeo(point);
    assert.ok(Math.abs(back.lat - lat) < 1e-9); assert.ok(Math.abs(back.lon - lon) < 1e-9);
    assert.ok(point.applyQuaternion(focusQuaternion(lat, lon)).distanceTo(new THREE.Vector3(0, 0, GLOBE_RADIUS)) < 1e-9);
  }
});
test('contacts are bounded, valid, and sampled across the complete snapshot', () => {
  const rows = Array.from({ length: 2000 }, (_, id) => ({ id, lat: 10, lon: 20 }));
  rows.push({ id: 'invalid', lat: NaN, lon: 2 });
  const sampled = sampleContacts(rows, 100);
  assert.equal(sampled.length, 100); assert.equal(sampled[0].id, 0); assert.ok(sampled.at(-1).id > 1950);
  assert.equal(markerRadius({ layer: 'satellites', altitudeM: 6371000 }), GLOBE_RADIUS * 2);
});
test('embedded/shared console routes survive spatial default and view switching', () => {
  assert.equal(isConsoleRoute(''), false); assert.equal(isConsoleRoute('?view=console'), true);
  assert.equal(isConsoleRoute('?embed=1'), true); assert.equal(isConsoleRoute('', '#state=abc'), true);
  assert.equal(viewUrl('https://example.test/?foo=bar&embed=1#state', 'spatial'), 'https://example.test/?foo=bar');
  assert.equal(viewUrl('https://example.test/?foo=bar', 'console'), 'https://example.test/?foo=bar&view=console');
});
