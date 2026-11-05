import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  eastNorthUp,
  fromDegrees,
  geodeticSurfaceNormal,
  scaleToGeodeticSurface,
  toCartographicRadians,
  toLonLatH,
} from './index.js';

/** A seeded generator, so a failure names a reproducible point. */
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function points(count = 500) {
  const next = random(20261105);
  const out = [
    { lon: 0, lat: 90, height: 0 },
    { lon: 0, lat: -90, height: 1000 },
    { lon: 180, lat: 0, height: -400 },
    { lon: -97.7431, lat: 30.2672, height: 150 },
  ];
  for (let i = 0; i < count; i++)
    out.push({
      lon: next() * 360 - 180,
      lat: next() * 180 - 90,
      height: next() * 4e7 - 1e4,
    });
  return out;
}

const close = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} vs ${expected} (± ${tolerance})`,
  );
const closeVec = (a, b, tolerance, message) => {
  close(a.x, b.x, tolerance, `${message} x`);
  close(a.y, b.y, tolerance, `${message} y`);
  close(a.z, b.z, tolerance, `${message} z`);
};

test('geodetic to ECEF matches the default renderer', () => {
  for (const p of points()) {
    const ours = fromDegrees(p.lon, p.lat, p.height);
    const theirs = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height);
    closeVec(ours, theirs, 1e-6, `${p.lon},${p.lat},${p.height}`);
  }
});

test('ECEF to geodetic matches the default renderer', () => {
  for (const p of points()) {
    const ecef = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height);
    const ours = toCartographicRadians(ecef);
    const theirs = Cesium.Cartographic.fromCartesian(ecef);
    const where = `${p.lon},${p.lat},${p.height}`;
    // Longitude is undefined at a pole.
    if (Math.abs(p.lat) < 89.999)
      close(ours.lon, theirs.longitude, 1e-12, `${where} lon`);
    close(ours.lat, theirs.latitude, 1e-12, `${where} lat`);
    close(ours.height, theirs.height, 1e-6, `${where} height`);
  }
  assert.equal(toCartographicRadians({ x: 0, y: 0, z: 0 }), null);
  assert.equal(
    Cesium.Cartographic.fromCartesian(Cesium.Cartesian3.ZERO),
    undefined,
  );
  const deg = toLonLatH(fromDegrees(-97.7431, 30.2672, 150));
  close(deg.lon, -97.7431, 1e-9, 'degrees lon');
  close(deg.lat, 30.2672, 1e-9, 'degrees lat');
  close(deg.height, 150, 1e-6, 'degrees height');
});

test('surface normals and projection match the default renderer', () => {
  for (const p of points()) {
    const ecef = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height);
    const where = `${p.lon},${p.lat},${p.height}`;
    closeVec(
      geodeticSurfaceNormal(ecef),
      Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(ecef),
      1e-15,
      `${where} normal`,
    );
    closeVec(
      scaleToGeodeticSurface(ecef),
      Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(ecef),
      1e-6,
      `${where} surface`,
    );
  }
});

test('east-north-up frames match the default renderer', () => {
  const column = (m, i) => ({ x: m[i * 4], y: m[i * 4 + 1], z: m[i * 4 + 2] });
  const origins = [
    ...points(200).map((p) =>
      Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height),
    ),
    // Exactly on the axis, where east is chosen by convention.
    new Cesium.Cartesian3(0, 0, 6356752.3142451793),
    new Cesium.Cartesian3(0, 0, -7000000),
  ];
  for (const origin of origins) {
    const m = Cesium.Matrix4.toArray(
      Cesium.Transforms.eastNorthUpToFixedFrame(origin),
    );
    const ours = eastNorthUp(origin);
    const where = `${origin.x},${origin.y},${origin.z}`;
    closeVec(ours.x, column(m, 0), 1e-12, `${where} east`);
    closeVec(ours.y, column(m, 1), 1e-12, `${where} north`);
    closeVec(ours.z, column(m, 2), 1e-12, `${where} up`);
    closeVec(ours.origin, column(m, 3), 0, `${where} origin`);
  }
});
