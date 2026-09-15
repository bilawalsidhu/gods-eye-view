import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diskScanExtent,
  geodeticToScanAngles,
  satelliteNav,
  scanAnglesToGeodetic,
} from '../../server/providers/geostationary/projection.js';

const nav = satelliteNav(-75.2);
const near = (actual, expected, tolerance) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} != ${expected}`,
  );

test('GOES navigation analytic anchors and round trips', () => {
  const origin = scanAnglesToGeodetic(0, 0, nav);
  near(origin.lat, 0, 1e-6);
  near(origin.lon, -75.2, 1e-6);
  const zero = geodeticToScanAngles(0, -75.2, nav);
  near(zero.x, 0, 1e-9);
  near(zero.y, 0, 1e-9);
  const edge = diskScanExtent(nav);
  const edgePoint = scanAnglesToGeodetic(edge, 0, nav);
  near(edgePoint.lat, 0, 1e-4);
  near(edgePoint.lon, -75.2 + (Math.acos(nav.a / nav.H) * 180) / Math.PI, 1e-4);
  const longitude = 45;
  const expectedX = Math.asin(
    (nav.a * Math.sin((longitude * Math.PI) / 180)) /
      Math.hypot(
        nav.H - nav.a * Math.cos((longitude * Math.PI) / 180),
        nav.a * Math.sin((longitude * Math.PI) / 180),
      ),
  );
  const equator = geodeticToScanAngles(0, -75.2 + longitude, nav);
  near(equator.x, expectedX, 1e-9);
  near(equator.y, 0, 1e-9);
  for (const lat of [-60, -30, 0, 30, 60]) {
    for (const lon of [-120, -75.2, -30]) {
      const scan = geodeticToScanAngles(lat, lon, nav);
      const point = scanAnglesToGeodetic(scan.x, scan.y, nav);
      near(point.lat, lat, 1e-6);
      near(point.lon, lon, 1e-6);
    }
  }
  assert.equal(geodeticToScanAngles(0, 104.8, nav), null);
});
