import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  readLookAt,
  readViewRect,
  resolveViewerRegion,
  watchCameraSettle,
} from './viewport.js';
import { greatCircleKm } from '../../data/trafficBounds.js';
import { REGION_LOOKAT_PULL_KM } from './policy.js';

/**
 * A viewer stand-in. `rect` is given in degrees (null = the camera sees no
 * globe), `nadir` is where the camera is, `hit` is what pickEllipsoid finds
 * under the canvas centre (null = a sky or horizon look that misses).
 */
function fakeViewer({ rect, nadir = { lat: 0, lon: 0 }, hit = null } = {}) {
  return {
    scene: { canvas: { clientWidth: 1200, clientHeight: 800 } },
    camera: {
      computeViewRectangle: () =>
        rect
          ? Cesium.Rectangle.fromDegrees(
              rect.west,
              rect.south,
              rect.east,
              rect.north,
            )
          : undefined,
      positionCartographic: nadir
        ? Cesium.Cartographic.fromDegrees(nadir.lon, nadir.lat, 40_000)
        : null,
      pickEllipsoid: () =>
        hit ? Cesium.Cartesian3.fromDegrees(hit.lon, hit.lat) : undefined,
    },
  };
}

test('the view rectangle comes back in degrees, and null when no globe is in view', () => {
  const rect = readViewRect(
    fakeViewer({ rect: { west: -1, south: 50, east: 1, north: 52 } }),
  );
  assert.ok(rect);
  assert.equal(Math.round(rect.west), -1);
  assert.equal(Math.round(rect.south), 50);
  assert.equal(Math.round(rect.east), 1);
  assert.equal(Math.round(rect.north), 52);
  assert.equal(readViewRect(fakeViewer({ rect: null })), null);
  assert.equal(readViewRect({}), null);
  assert.equal(readViewRect(null), null);
});

test('the look-at point is the ground under the canvas centre, not the camera', () => {
  const lookAt = readLookAt(
    fakeViewer({
      rect: { west: 0, south: 0, east: 1, north: 1 },
      nadir: { lat: 51.5, lon: -0.12 },
      hit: { lat: 51.45, lon: -0.2 },
    }),
  );
  assert.equal(lookAt.source, 'hit');
  assert.ok(Math.abs(lookAt.lat - 51.45) < 1e-6);
  assert.ok(Math.abs(lookAt.lon - -0.2) < 1e-6);
});

test('a sky look with no ground hit falls back to the camera nadir', () => {
  const lookAt = readLookAt(
    fakeViewer({ rect: null, nadir: { lat: 35.68, lon: 139.69 }, hit: null }),
  );
  assert.equal(lookAt.source, 'nadir');
  assert.ok(Math.abs(lookAt.lat - 35.68) < 1e-6);
  assert.equal(readLookAt(fakeViewer({ rect: null, nadir: null })), null);
});

test('a horizon gaze is pulled back to the widest circle the provider serves', () => {
  const lookAt = readLookAt(
    fakeViewer({
      rect: null,
      nadir: { lat: 0, lon: 0 },
      // ~556 km east: far past anything a 100 km circle could cover.
      hit: { lat: 0, lon: 5 },
    }),
  );
  assert.equal(lookAt.source, 'pulled');
  const pulledKm = greatCircleKm(0, 0, lookAt.lat, lookAt.lon);
  assert.ok(
    Math.abs(pulledKm - REGION_LOOKAT_PULL_KM) < 1,
    `pulled to ${pulledKm} km, expected ~${REGION_LOOKAT_PULL_KM}`,
  );
});

test('a metro view resolves to a circle; a continental one has none', () => {
  const metro = resolveViewerRegion(
    fakeViewer({
      rect: { west: 37.3, south: 55.5, east: 37.9, north: 56.0 },
      nadir: { lat: 55.75, lon: 37.62 },
      hit: { lat: 55.75, lon: 37.62 },
    }),
  );
  assert.equal(metro.band, 'local');
  assert.ok(metro.radiusKm <= 100 && metro.radiusKm >= 25);
  assert.deepEqual(metro.center, { lat: 55.5, lon: 37.5 });

  const continental = resolveViewerRegion(
    fakeViewer({
      rect: { west: -10, south: 35, east: 40, north: 70 },
      nadir: { lat: 52, lon: 15 },
      hit: { lat: 52, lon: 15 },
    }),
  );
  assert.equal(continental.band, 'global');
  assert.equal(continental.center, undefined);
});

test('the circle centres on what the camera is aimed at, not the rectangle midpoint', () => {
  // Midpoint (10.3, 20.3) snaps to (10.5, 20.5); the look-at snaps to (10, 20).
  const region = resolveViewerRegion(
    fakeViewer({
      rect: { west: 20.0, south: 10.0, east: 20.6, north: 10.6 },
      nadir: { lat: 10.05, lon: 20.05 },
      hit: { lat: 10.05, lon: 20.05 },
    }),
  );
  assert.equal(region.band, 'local');
  assert.deepEqual(
    region.center,
    { lat: 10, lon: 20 },
    'the rectangle midpoint would have given 10.5, 20.5',
  );
});

test('a camera with no globe in view asks for the worldwide feed', () => {
  const region = resolveViewerRegion(
    fakeViewer({ rect: null, nadir: { lat: 12, lon: 34 } }),
  );
  assert.equal(region.band, 'global');
});

test('the camera watch attaches, detaches once, and survives a throwing listener', () => {
  const listeners = new Set();
  const viewer = {
    camera: {
      moveEnd: {
        addEventListener: (fn) => listeners.add(fn),
        removeEventListener: (fn) => listeners.delete(fn),
      },
    },
  };
  let settled = 0;
  const dispose = watchCameraSettle(viewer, () => {
    settled++;
    throw new Error('panel exploded');
  });
  assert.equal(listeners.size, 1);
  for (const fn of listeners) fn();
  assert.equal(settled, 1, 'a throwing listener is contained, not propagated');
  dispose();
  dispose();
  assert.equal(listeners.size, 0);
});

test('a viewer without a camera event yields a no-op disposer', () => {
  const dispose = watchCameraSettle({ camera: {} }, () => {});
  assert.doesNotThrow(dispose);
  assert.doesNotThrow(() => watchCameraSettle(null, () => {})());
});
