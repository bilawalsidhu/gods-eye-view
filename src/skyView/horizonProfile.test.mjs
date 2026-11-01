import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  EARTH_RADIUS_M,
  PROFILE_AZ_COUNT,
  PROFILE_DISTANCE_COUNT,
  buildProfile,
  computeHorizonProfile,
  destination,
  elevationAngle,
  horizonAt,
  occlusion,
  profileDistances,
  profileSamplePoints,
} from './horizonProfile.js';
import { createObserver } from './observer.js';

const DEG = Math.PI / 180;

/** Great-circle distance in metres on the same sphere. */
function haversine(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const a =
    Math.sin((p2 - p1) / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

const OBS = createObserver({
  latDeg: 35,
  lonDeg: -106,
  groundHeightM: 0,
  heightKnown: true,
});

test('profile distances: 24 log-spaced from 100 m to 60 km', () => {
  const d = profileDistances();
  assert.equal(d.length, PROFILE_DISTANCE_COUNT);
  assert.equal(d[0], 100);
  assert.equal(d.at(-1), 60_000);
  const ratio = d[1] / d[0];
  for (let i = 1; i < d.length; i++)
    assert.ok(Math.abs(d[i] / d[i - 1] - ratio) < 1e-9);
});

test('destination: distance and bearing are honoured', () => {
  for (const bearing of [0, 45, 90, 180, 270, 333]) {
    const p = destination(35, -106, bearing, 25_000);
    assert.ok(
      Math.abs(haversine(35, -106, p.latDeg, p.lonDeg) - 25_000) < 0.01,
    );
  }
  const north = destination(35, -106, 0, 10_000);
  assert.ok(north.latDeg > 35 && Math.abs(north.lonDeg + 106) < 1e-9);
  // across the antimeridian stays in [-180, 180)
  const wrap = destination(0, 179.99, 90, 10_000);
  assert.ok(wrap.lonDeg < -179);
});

test('elevationAngle includes the curvature drop d^2 / 2R', () => {
  // flat ground, eye 1.7 m: horizon dips below 0
  assert.ok(elevationAngle(4000, 0, 1.7) < 0);
  // a 1000 m ridge 50 km away: with curvature ~0.92 deg, without ~1.14 deg
  const withCurvature = elevationAngle(50_000, 1000, 1.7);
  const flat = Math.atan2(1000 - 1.7, 50_000) / DEG;
  assert.ok(Math.abs(withCurvature - 0.9192) < 0.001, String(withCurvature));
  assert.ok(flat - withCurvature > 0.2);
});

test('sample grid: 180 azimuths x 24 distances = 4,320 points, azimuth-major', () => {
  const pts = profileSamplePoints(OBS.latDeg, OBS.lonDeg);
  assert.equal(pts.length, PROFILE_AZ_COUNT * PROFILE_DISTANCE_COUNT);
  assert.equal(pts.length, 4320);
  assert.equal(pts[0].bearing, 0);
  assert.equal(pts[PROFILE_DISTANCE_COUNT].bearing, 2);
  assert.equal(pts[PROFILE_DISTANCE_COUNT - 1].distanceM, 60_000);
});

test('synthetic cone terrain (observer at the bottom of a conical valley) gives the expected horizon angle within 0.1 deg', () => {
  const slope = 0.1; // height = slope * distance from the observer
  const pts = profileSamplePoints(OBS.latDeg, OBS.lonDeg);
  const heights = pts.map(
    (p) => slope * haversine(OBS.latDeg, OBS.lonDeg, p.latDeg, p.lonDeg),
  );
  const eye = OBS.groundHeightM + OBS.eyeHeightM;
  const profile = buildProfile(pts, heights, eye);
  // continuous maximum of atan((s d - eye - d^2/2R) / d): at d* = sqrt(2 R eye)
  const dStar = Math.sqrt(2 * EARTH_RADIUS_M * eye);
  const expected =
    Math.atan(slope - eye / dStar - dStar / (2 * EARTH_RADIUS_M)) / DEG;
  for (let a = 0; a < PROFILE_AZ_COUNT; a++)
    assert.ok(
      Math.abs(profile.anglesDeg[a] - expected) < 0.1,
      `az bin ${a}: ${profile.anglesDeg[a]} vs ${expected}`,
    );
  assert.ok(Math.abs(horizonAt(profile, 123.4) - expected) < 0.1);
});

test('synthetic mountain cone to the east raises only the eastern horizon', () => {
  const peak = destination(OBS.latDeg, OBS.lonDeg, 90, 20_000);
  const height = (p) =>
    Math.max(
      0,
      2000 - 0.2 * haversine(peak.latDeg, peak.lonDeg, p.latDeg, p.lonDeg),
    );
  const pts = profileSamplePoints(OBS.latDeg, OBS.lonDeg);
  const eye = OBS.eyeHeightM;
  const profile = buildProfile(pts, pts.map(height), eye);
  // expected = max over the actual samples on the 90 deg ray (exact)
  const ray = pts.filter((p) => p.bearing === 90);
  const expected = Math.max(
    ...ray.map((p) => elevationAngle(p.distanceM, height(p), eye)),
  );
  assert.ok(Math.abs(horizonAt(profile, 90) - expected) < 1e-9);
  assert.ok(horizonAt(profile, 90) > 5);
  assert.ok(horizonAt(profile, 270) < 0.01);
  assert.equal(occlusion(profile, 90, 3), 'terrain');
  assert.equal(occlusion(profile, 90, 8), 'clear');
  assert.equal(occlusion(profile, 270, 3), 'clear');
});

test('missing samples: per-azimuth default 0, all missing -> null; no profile hides below 0', () => {
  const pts = profileSamplePoints(0, 0, { azCount: 4, distances: [100, 1000] });
  assert.equal(
    buildProfile(
      pts,
      pts.map(() => undefined),
      1.7,
      4,
    ),
    null,
  );
  const partial = buildProfile(
    pts,
    [5, 5, undefined, undefined, undefined, undefined, undefined, undefined],
    1.7,
    4,
  );
  assert.ok(partial.anglesDeg[0] > 0);
  assert.equal(partial.anglesDeg[1], 0);
  assert.equal(occlusion(null, 10, -1), 'below');
  assert.equal(occlusion(null, 10, 1), 'clear');
  assert.equal(horizonAt(null, 10), 0);
});

test('horizonAt interpolates between bins and wraps at north', () => {
  const profile = { azCount: 4, anglesDeg: Float64Array.from([0, 4, 8, 12]) };
  assert.equal(horizonAt(profile, 45), 2);
  assert.equal(horizonAt(profile, 315), 6); // between 270 (12) and 360 (0)
  assert.equal(horizonAt(profile, -90), 12);
});

test('computeHorizonProfile: ONE batch of 4,320 samples, null without real terrain or on failure/timeout', async () => {
  const terrain = { requestTileGeometry() {} };
  let calls = 0;
  let size = 0;
  const sample = async (provider, cartos) => {
    calls += 1;
    size = cartos.length;
    assert.equal(provider, terrain);
    for (const c of cartos) c.height = 0;
    return cartos;
  };
  const profile = await computeHorizonProfile({
    Cesium,
    terrainProvider: terrain,
    observer: OBS,
    sample,
  });
  assert.equal(calls, 1);
  assert.equal(size, 4320);
  assert.equal(profile.azCount, 180);
  assert.ok(profile.anglesDeg.every((a) => a < 0 && a > -1));
  assert.equal(
    await computeHorizonProfile({
      Cesium,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      observer: OBS,
      sample,
    }),
    null,
  );
  assert.equal(calls, 1, 'no sampling without real terrain');
  assert.equal(
    await computeHorizonProfile({
      Cesium,
      terrainProvider: terrain,
      observer: OBS,
      sample: async () => {
        throw new Error('x');
      },
    }),
    null,
  );
  assert.equal(
    await computeHorizonProfile({
      Cesium,
      terrainProvider: terrain,
      observer: OBS,
      sample: () => new Promise(() => {}),
      timeoutMs: 20,
    }),
    null,
  );
  assert.equal(
    await computeHorizonProfile({
      Cesium,
      terrainProvider: terrain,
      observer: null,
      sample,
    }),
    null,
  );
});
