import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORBITAL_ZOOM_LADDER,
  ORBITAL_BASE_FOV_LEO_RAD,
  ORBITAL_EARTH_RADIUS_M,
  ORBITAL_SETTLE_MAX_MS,
  ORBITAL_WHEEL_COOLDOWN_MS,
  cesiumFrustumFovRad,
  earthAngularRadiusRad,
  footprintWidthKm,
  fovForZoom,
  interpolateZoomFov,
  nadirOrientation,
  nextOrbitalZoom,
  offNadirAngleDeg,
  offNadirCentreMeetsEarth,
  centreLinesFirst,
  offNadirSwathScale,
  orbitalMaxZoom,
  sensorStripFraction,
  sensorSwathZoom,
  viewWidthKm,
  wheelZoomStep,
  ORBITAL_WHEEL_GESTURE_GAP_MS,
  offNadirOrientation,
  orbitalBaseFovRad,
  previousOrbitalZoom,
  zoomSettleHolding,
  zoomTransitionBlurPx,
  zoomTransitionProgress,
  zoomTransitionState,
  ORBITAL_PREFETCH_ACROSS,
  ORBITAL_PREFETCH_LEAD_S,
  ORBITAL_PREFETCH_MAX_TILES,
  destinationPoint,
  groundTrackAhead,
  imageryLevelForView,
  tilesForPoints,
} from './cockpitOrbital.js';
import * as Cesium from 'cesium';
import { greatCircleKm } from './geoDistance.js';

const RAD = Math.PI / 180;
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (v) => Math.hypot(v.x, v.y, v.z);

/** ECEF position on the mean sphere at a latitude, longitude and altitude. */
function ecef(latDeg, lonDeg, altitudeM) {
  const r = ORBITAL_EARTH_RADIUS_M + altitudeM;
  const lat = latDeg * RAD;
  const lon = lonDeg * RAD;
  return {
    x: r * Math.cos(lat) * Math.cos(lon),
    y: r * Math.cos(lat) * Math.sin(lon),
    z: r * Math.sin(lat),
  };
}

/** Local north unit vector at a latitude and longitude. */
function localNorth(latDeg, lonDeg) {
  const lat = latDeg * RAD;
  const lon = lonDeg * RAD;
  return {
    x: -Math.sin(lat) * Math.cos(lon),
    y: -Math.sin(lat) * Math.sin(lon),
    z: Math.cos(lat),
  };
}

function assertOrthonormal(orientation) {
  const { direction, up, right } = orientation;
  for (const v of [direction, up, right])
    assert.ok(Math.abs(norm(v) - 1) < 1e-9);
  assert.ok(Math.abs(dot(direction, up)) < 1e-9);
  assert.ok(Math.abs(dot(direction, right)) < 1e-9);
  assert.ok(Math.abs(dot(up, right)) < 1e-9);
}

test('the nadir view points at the Earth centre with north up', () => {
  for (const [lat, lon, alt] of [
    [0, 0, 420e3],
    [51.6, -97.3, 420e3],
    [-33.9, 151.2, 20.2e6],
    [0.05, 75, 35.786e6],
  ]) {
    const position = ecef(lat, lon, alt);
    const orientation = nadirOrientation(position);
    const toCentre = {
      x: -position.x / norm(position),
      y: -position.y / norm(position),
      z: -position.z / norm(position),
    };
    assert.ok(dot(orientation.direction, toCentre) > 1 - 1e-12);
    assert.ok(dot(orientation.up, localNorth(lat, lon)) > 1 - 1e-9);
    assertOrthonormal(orientation);
    // North up puts east on the right of a picture looking down.
    const east = { x: -Math.sin(lon * RAD), y: Math.cos(lon * RAD), z: 0 };
    assert.ok(dot(orientation.right, east) > 1 - 1e-9);
  }
});

test('over a pole the orientation stays valid and keeps the previous up', () => {
  for (const z of [1, -1]) {
    const position = { x: 0, y: 0, z: z * (ORBITAL_EARTH_RADIUS_M + 800e3) };
    const fallback = nadirOrientation(position);
    assertOrthonormal(fallback);
    assert.equal(fallback.direction.z, -z);
    // The prime-meridian limit of north.
    assert.ok(Math.abs(fallback.up.x - -z) < 1e-9);
    const kept = nadirOrientation(position, {
      previousUp: { x: 0, y: 1, z: 0 },
    });
    assertOrthonormal(kept);
    assert.ok(kept.up.y > 1 - 1e-9);
  }
  // Just off the pole, north still points over it.
  const nearPole = nadirOrientation(ecef(89.9999, 30, 500e3));
  assertOrthonormal(nearPole);
  assert.ok(dot(nearPole.up, localNorth(89.9999, 30)) > 1 - 1e-6);
});

test('a degenerate position has no orientation', () => {
  assert.equal(nadirOrientation(null), null);
  assert.equal(nadirOrientation({ x: 0, y: 0, z: 0 }), null);
  assert.equal(nadirOrientation({ x: NaN, y: 0, z: 0 }), null);
});

test('each zoom step divides the tangent of the half-angle', () => {
  const base = ORBITAL_BASE_FOV_LEO_RAD;
  for (const zoom of ORBITAL_ZOOM_LADDER) {
    const fov = fovForZoom(base, zoom);
    assert.ok(Math.abs(Math.tan(fov / 2) - Math.tan(base / 2) / zoom) < 1e-12);
  }
  assert.ok(
    Math.abs(
      Math.tan(fovForZoom(base, 4) / 2) / Math.tan(fovForZoom(base, 2) / 2) -
        0.5,
    ) < 1e-12,
  );
  assert.equal(fovForZoom(base, 1), base);
  assert.equal(fovForZoom(base, 0), base);
});

test('zoom steps clamp at both ends without wrapping', () => {
  assert.equal(nextOrbitalZoom(1), 2);
  assert.equal(nextOrbitalZoom(4), 8);
  assert.equal(nextOrbitalZoom(8), 8);
  assert.equal(previousOrbitalZoom(8), 4);
  assert.equal(previousOrbitalZoom(2), 1);
  assert.equal(previousOrbitalZoom(1), 1);
  assert.equal(nextOrbitalZoom(undefined), 2);
});

test('the base frame is regional in low orbit and fits the disk from GEO', () => {
  assert.equal(orbitalBaseFovRad(420e3), ORBITAL_BASE_FOV_LEO_RAD);
  const geo = orbitalBaseFovRad(35.786e6);
  const disk = 2 * earthAngularRadiusRad(35.786e6);
  assert.ok(geo > disk && geo < ORBITAL_BASE_FOV_LEO_RAD);
  // Continuous across the crossover: no jump as an orbit climbs.
  let previous = orbitalBaseFovRad(1e6);
  for (let alt = 1e6; alt <= 40e6; alt += 50e3) {
    const fov = orbitalBaseFovRad(alt);
    assert.ok(fov <= previous + 1e-12);
    assert.ok(previous - fov < 0.01);
    previous = fov;
  }
});

test('the footprint shrinks with zoom and stops at the limb', () => {
  const alt = 420e3;
  const widths = [1, 2, 4, 8].map((zoom) =>
    footprintWidthKm(alt, fovForZoom(orbitalBaseFovRad(alt), zoom)),
  );
  for (let i = 1; i < widths.length; i++) assert.ok(widths[i] < widths[i - 1]);
  assert.ok(widths[0] > 400 && widths[0] < 600, `1x ${widths[0]} km`);
  assert.ok(widths[3] > 40 && widths[3] < 80, `8x ${widths[3]} km`);
  // A wider frame covers more ground across.
  assert.ok(
    footprintWidthKm(alt, ORBITAL_BASE_FOV_LEO_RAD, 16 / 9) > widths[0],
  );
  // From GEO a frame wider than the disk spans the visible cap only.
  const cap =
    (2 *
      ORBITAL_EARTH_RADIUS_M *
      Math.acos(ORBITAL_EARTH_RADIUS_M / (ORBITAL_EARTH_RADIUS_M + 35.786e6))) /
    1000;
  assert.ok(Math.abs(footprintWidthKm(35.786e6, 40 * RAD) - cap) < 1e-6);
  assert.equal(footprintWidthKm(0, 1), null);
  assert.equal(footprintWidthKm(420e3, NaN), null);
});

test('Cesium frustum fov widens to the horizontal on a landscape canvas', () => {
  const vertical = 30 * RAD;
  assert.equal(cesiumFrustumFovRad(vertical, 0.75), vertical);
  const horizontal = cesiumFrustumFovRad(vertical, 2);
  assert.ok(
    Math.abs(Math.tan(horizontal / 2) - 2 * Math.tan(vertical / 2)) < 1e-12,
  );
});

test('zoom transition curves stay bounded and settle', () => {
  assert.equal(zoomTransitionProgress(0), 0);
  assert.equal(zoomTransitionProgress(400), 1);
  assert.equal(zoomTransitionProgress(9999), 1);
  assert.equal(zoomTransitionProgress(-50), 0);
  assert.equal(zoomTransitionProgress(0, { reducedMotion: true }), 1);
  let previous = 0;
  for (let ms = 0; ms <= 500; ms += 10) {
    const p = zoomTransitionProgress(ms);
    assert.ok(p >= previous && p >= 0 && p <= 1);
    previous = p;
    const blur = zoomTransitionBlurPx(ms / 400);
    assert.ok(blur >= 0 && blur <= 6);
  }
  assert.equal(zoomTransitionBlurPx(0), 0);
  assert.ok(zoomTransitionBlurPx(1) < 1e-9);
  assert.ok(Math.abs(zoomTransitionBlurPx(0.5) - 6) < 1e-9);
  assert.equal(zoomTransitionBlurPx(0.5, { reducedMotion: true }), 0);

  const from = fovForZoom(1, 1);
  const to = fovForZoom(1, 2);
  assert.equal(interpolateZoomFov(from, to, 0).toFixed(12), from.toFixed(12));
  assert.equal(interpolateZoomFov(from, to, 1).toFixed(12), to.toFixed(12));
  const mid = interpolateZoomFov(from, to, 0.5);
  assert.ok(mid < from && mid > to);
});

test('the transition state blurs, then ticks the lock, then rests', () => {
  const moving = zoomTransitionState(200);
  assert.equal(moving.active, true);
  assert.ok(moving.blurPx > 5);
  assert.equal(moving.lockTick, false);
  const settled = zoomTransitionState(450);
  assert.equal(settled.active, false);
  assert.equal(settled.lockTick, true);
  assert.equal(settled.progress, 1);
  assert.ok(settled.blurPx < 1e-9);
  const rest = zoomTransitionState(2000);
  assert.equal(rest.lockTick, false);
  assert.deepEqual(zoomTransitionState(100, { reducedMotion: true }), {
    active: false,
    progress: 1,
    blurPx: 0,
    lockTick: false,
  });
});

test('an off-nadir tilt turns the view by its angle from the nadir frame', () => {
  const nadir = nadirOrientation(ecef(30, -97, 420_000));
  assert.equal(offNadirOrientation(nadir), nadir, 'no tilt is nadir itself');
  const angle = (v) => Math.acos(Math.min(1, dot(v, nadir.direction))) / RAD;
  const north = offNadirOrientation(nadir, { northDeg: 10 });
  assert.ok(Math.abs(angle(north.direction) - 10) < 1e-9);
  assert.ok(dot(north.direction, nadir.up) > 0, 'toward north');
  assert.ok(Math.abs(dot(north.direction, nadir.right)) < 1e-12);
  const west = offNadirOrientation(nadir, { eastDeg: -20 });
  assert.ok(Math.abs(angle(west.direction) - 20) < 1e-9);
  assert.ok(dot(west.direction, nadir.right) < 0, 'toward west');
  const both = offNadirOrientation(nadir, { northDeg: 45, eastDeg: 45 });
  const expected = Math.acos(Math.cos(45 * RAD) ** 2) / RAD;
  assert.ok(Math.abs(angle(both.direction) - expected) < 1e-9);
  for (const view of [north, west, both]) {
    assert.ok(Math.abs(norm(view.direction) - 1) < 1e-12);
    assert.ok(Math.abs(norm(view.up) - 1) < 1e-12);
    assert.ok(Math.abs(dot(view.direction, view.up)) < 1e-12);
  }
});

test('a landed zoom step holds for its imagery, but never past the cap', () => {
  assert.equal(zoomSettleHolding(0, false), true, 'still loading');
  assert.equal(zoomSettleHolding(ORBITAL_SETTLE_MAX_MS - 1, false), true);
  assert.equal(zoomSettleHolding(ORBITAL_SETTLE_MAX_MS, false), false, 'cap');
  assert.equal(zoomSettleHolding(0, true), false, 'loaded: lock at once');
  assert.equal(zoomSettleHolding(Number.NaN, false), true);
});

const WIDE = 16 / 9;

test("the zoom ladder climbs to a satellite's own cap and steps off a SENSOR zoom", () => {
  assert.equal(nextOrbitalZoom(8), 8, 'no sensor: 8x is the top');
  assert.equal(nextOrbitalZoom(8, 64), 16);
  assert.equal(nextOrbitalZoom(32, 64), 64);
  assert.equal(nextOrbitalZoom(64, 64), 64, 'the cap holds');
  assert.equal(nextOrbitalZoom(5.7, 64), 8, 'between steps: the step above');
  assert.equal(previousOrbitalZoom(5.7), 4, 'between steps: the step below');
  assert.equal(previousOrbitalZoom(128), 64);
  assert.equal(previousOrbitalZoom(1), 1);
});

test('a sensor caps the zoom at its swath for the live altitude', () => {
  // WorldView-3 at 617 km, 13.1 km swath: 64x spans ~20 km, 128x ~10 km.
  assert.ok(viewWidthKm(617e3, 64, WIDE) >= 13.1);
  assert.ok(viewWidthKm(617e3, 128, WIDE) < 13.1);
  assert.equal(orbitalMaxZoom(617e3, 13.1, WIDE), 64);
  // ICEYE spotlight, 5 km at 570 km.
  assert.equal(orbitalMaxZoom(570e3, 5, WIDE), 128);
  // PlanetScope SuperDove, 32.5 km: 32x at 525 km but 16x at 470 km.
  assert.equal(orbitalMaxZoom(525e3, 32.5, WIDE), 32);
  assert.equal(orbitalMaxZoom(470e3, 32.5, WIDE), 16);
  // Landsat's 185 km swath fits inside 8x: no extra steps, never fewer.
  assert.equal(orbitalMaxZoom(705e3, 185, WIDE), 8);
  assert.equal(orbitalMaxZoom(705e3, 2330, WIDE), 8);
  // No sensor, or an unusable swath.
  assert.equal(orbitalMaxZoom(617e3, null, WIDE), 8);
  assert.equal(orbitalMaxZoom(617e3, 0, WIDE), 8);
  // A swath exactly as wide as the 16x view allows 16x.
  assert.equal(orbitalMaxZoom(617e3, viewWidthKm(617e3, 16, WIDE), WIDE), 16);
});

test('the SENSOR step frames the swath when it lies in range', () => {
  const landsat = sensorSwathZoom(705e3, 185, WIDE, 8);
  assert.ok(landsat > 4 && landsat < 8, String(landsat));
  assert.ok(Math.abs(viewWidthKm(705e3, landsat, WIDE) - 185) < 1);
  const worldview = sensorSwathZoom(617e3, 13.1, WIDE, 64);
  assert.equal(worldview, null, 'narrower than the 64x cap allows');
  assert.equal(sensorSwathZoom(705e3, 2330, WIDE, 8), null, 'wider than 1x');
  assert.equal(sensorSwathZoom(705e3, null, WIDE, 8), null);
});

test('the sensor strip spans its share of the view', () => {
  assert.equal(sensorStripFraction(13, 130), 0.1);
  assert.equal(sensorStripFraction(500, 131), 1, 'clipped to the view');
  assert.equal(sensorStripFraction(null, 131), null);
  assert.equal(sensorStripFraction(13.1, null), null);
});

test('the wheel steps once per notch and sums a trackpad swipe', () => {
  // A mouse notch away from the viewer zooms in.
  let r = wheelZoomStep(null, { deltaY: -100, deltaMode: 0 }, 1000);
  assert.equal(r.step, 1);
  // The rest of that notch, inside the cooldown, is absorbed.
  r = wheelZoomStep(r.accumulator, { deltaY: -100, deltaMode: 0 }, 1050);
  assert.equal(r.step, 0);
  // A notch toward the viewer after the cooldown zooms out.
  r = wheelZoomStep(
    r.accumulator,
    { deltaY: 120, deltaMode: 0 },
    1050 + ORBITAL_WHEEL_COOLDOWN_MS + 1,
  );
  assert.equal(r.step, -1);
  // A trackpad's small deltas add up before they step.
  let pad = null;
  const steps = [];
  for (let i = 0; i < 4; i += 1) {
    const out = wheelZoomStep(
      pad,
      { deltaY: -30, deltaMode: 0 },
      5000 + i * 16,
    );
    pad = out.accumulator;
    steps.push(out.step);
  }
  assert.deepEqual(steps, [0, 0, 0, 1]);
  // Turning back starts the sum over.
  const turned = wheelZoomStep(
    { sum: -90, lastStepMs: -Infinity },
    { deltaY: 30, deltaMode: 0 },
    9000,
  );
  assert.equal(turned.step, 0);
  assert.equal(turned.accumulator.sum, 30);
  // Line-mode wheels (Firefox): three lines make a notch.
  assert.equal(wheelZoomStep(null, { deltaY: -3, deltaMode: 1 }, 0).step, 0);
  assert.equal(wheelZoomStep(null, { deltaY: -7, deltaMode: 1 }, 0).step, 1);
  assert.equal(wheelZoomStep(null, { deltaY: 0 }, 0).step, 0);
});

test('a heading turns the nadir frame, keeping north to fall back on', () => {
  // Over the equator at 0°E: north is +z, east is +y.
  const position = { x: ORBITAL_EARTH_RADIUS_M + 500_000, y: 0, z: 0 };
  const northUp = nadirOrientation(position);
  const east = nadirOrientation(position, { headingDeg: 90 });
  const close = (a, b) =>
    Math.abs(a.x - b.x) < 1e-9 &&
    Math.abs(a.y - b.y) < 1e-9 &&
    Math.abs(a.z - b.z) < 1e-9;
  assert.ok(close(northUp.up, { x: 0, y: 0, z: 1 }));
  assert.ok(close(east.up, { x: 0, y: 1, z: 0 }), 'east at the top');
  assert.ok(close(east.north, northUp.up), 'north kept for the next frame');
  assert.ok(
    close(nadirOrientation(position, { headingDeg: 0 }).up, northUp.up),
  );
});

test('a partial scroll does not carry over into a later gesture', () => {
  // 90 px: short of a step.
  let r = wheelZoomStep(null, { deltaY: -90, deltaMode: 0 }, 1000);
  assert.equal(r.step, 0);
  // Still the same gesture: 10 px more completes the step.
  const same = wheelZoomStep(
    r.accumulator,
    { deltaY: -10, deltaMode: 0 },
    1100,
  );
  assert.equal(same.step, 1);
  // Minutes later a 10 px nudge is a new gesture, not the rest of the old.
  r = wheelZoomStep(
    r.accumulator,
    { deltaY: -10, deltaMode: 0 },
    1000 + ORBITAL_WHEEL_GESTURE_GAP_MS + 60_000,
  );
  assert.equal(r.step, 0);
});

test('the total off-nadir angle combines both tilts', () => {
  assert.equal(offNadirAngleDeg(), 0);
  assert.ok(Math.abs(offNadirAngleDeg({ northDeg: 10 }) - 10) < 1e-9);
  // FWD 15° and RIGHT 10° read OFF-NADIR 18.0°.
  const total = offNadirAngleDeg({ northDeg: 15, eastDeg: 10 });
  assert.equal(total.toFixed(1), '18.0');
  assert.equal(offNadirAngleDeg({ northDeg: -15, eastDeg: -10 }), total);
});

test("a tilted view's width grows faster across the frame than along it", () => {
  assert.equal(offNadirSwathScale(), 1, 'nadir');
  const cos = (deg) => Math.cos((deg * Math.PI) / 180);
  assert.ok(
    Math.abs(offNadirSwathScale({ northDeg: 30 }) - 1 / cos(30)) < 1e-9,
  );
  assert.ok(
    Math.abs(offNadirSwathScale({ eastDeg: 30 }) - 1 / cos(30) ** 2) < 1e-9,
  );
  let last = 1;
  for (const deg of [5, 15, 25, 35, 45]) {
    const scale = offNadirSwathScale({ northDeg: deg, eastDeg: deg });
    assert.ok(scale > last, `${deg}°`);
    last = scale;
  }
  assert.equal(offNadirSwathScale({ northDeg: Number.NaN }), 1);
});

// ── imagery pre-load ahead of the ground track ─────────────────────────

const PASS = Object.freeze({
  latitude: 30,
  longitude: -97,
  groundTrackDeg: 45,
  velocityMps: 7_600,
  altitudeM: 500_000,
});

test('destinationPoint walks a great circle along a bearing', () => {
  const east = destinationPoint(0, 179.9, 90, 111_195 * 0.2);
  assert.ok(Math.abs(east.lat) < 1e-9);
  assert.ok(Math.abs(east.lon - -179.9) < 1e-3, 'wraps the antimeridian');
  const north = destinationPoint(10, 20, 0, 50_000);
  assert.ok(Math.abs(greatCircleKm({ lat: 10, lon: 20 }, north) - 50) < 0.1);
  assert.ok(north.lat > 10 && Math.abs(north.lon - 20) < 1e-9);
});

test('the points ahead run along the ground track at ground speed', () => {
  const points = groundTrackAhead(PASS, 20);
  const across = ORBITAL_PREFETCH_ACROSS.length;
  assert.equal(points.length, ORBITAL_PREFETCH_LEAD_S.length * across);
  // Ground speed is the orbital speed scaled to the surface: ~7.0 km/s.
  const groundKmPerS = (7.6 * 6371) / (6371 + 500);
  const start = { lat: PASS.latitude, lon: PASS.longitude };
  ORBITAL_PREFETCH_LEAD_S.forEach((seconds, i) => {
    const centre = points[i * across];
    const km = greatCircleKm(start, centre);
    assert.ok(Math.abs(km - groundKmPerS * seconds) < 0.5, `${seconds} s`);
    // North-east of the start, on a 45° track.
    assert.ok(centre.lat > PASS.latitude && centre.lon > PASS.longitude);
    // The side points sit their fraction of the view off the centre line.
    points.slice(i * across + 1, (i + 1) * across).forEach((side, k) => {
      const offKm = 20 * Math.abs(ORBITAL_PREFETCH_ACROSS[k + 1]);
      assert.ok(Math.abs(greatCircleKm(centre, side) - offKm) < 0.05);
    });
  });
  assert.deepEqual(groundTrackAhead({ ...PASS, groundTrackDeg: null }, 20), []);
  assert.deepEqual(groundTrackAhead(PASS, null), []);
});

test('the tile level is the one Cesium draws for the view', () => {
  const mercator = new Cesium.WebMercatorTilingScheme();
  // Worked case: 10 m per CSS pixel at the equator. Cesium refines the
  // ellipsoid terrain until a tile's error is at most 2 px, 20 m: level 12,
  // 78,271.5 m / 2^12 = 19.11 m. The Web Mercator texel nearest that is
  // level 13's (156,543 m / 2^13 = 19.11 m), about 1.9 px each, where a
  // one-pixel texel would have asked for level 14.
  assert.equal(
    imageryLevelForView(mercator, { metresPerPixel: 10, latitudeDeg: 0 }),
    13,
  );
  // 5 m/px: terrain level 13 (9.55 m), imagery level 14.
  assert.equal(
    imageryLevelForView(mercator, { metresPerPixel: 5, latitudeDeg: 0 }),
    14,
  );
  // 7 m/px still takes terrain level 13 (9.55 m <= 14 m): level 14, so a
  // texel spans 1.4 px.
  assert.equal(
    imageryLevelForView(mercator, { metresPerPixel: 7, latitudeDeg: 0 }),
    14,
  );
  // At 60° a Mercator texel covers half the ground: one level coarser.
  assert.equal(
    imageryLevelForView(mercator, { metresPerPixel: 10, latitudeDeg: 60 }),
    12,
  );
  // A geographic scheme starts from two root tiles and keeps its texels at
  // every latitude.
  const geographic = new Cesium.GeographicTilingScheme();
  for (const latitudeDeg of [0, 60])
    assert.equal(
      imageryLevelForView(geographic, {
        metresPerPixel: 10,
        latitudeDeg,
        geographic: true,
      }),
      12,
      `${latitudeDeg}°`,
    );
  // A terrain provider's own errors (Cesium World Terrain: 65-sample tiles)
  // and a looser screen-space error are honoured.
  const worldTerrain = (level) =>
    (6378137 * 2 * Math.PI * 0.25) / (65 * 2) / 2 ** level;
  assert.equal(
    imageryLevelForView(mercator, {
      metresPerPixel: 10,
      latitudeDeg: 0,
      terrainLevelErrorM: worldTerrain,
    }),
    13,
  );
  assert.equal(
    imageryLevelForView(mercator, {
      metresPerPixel: 10,
      latitudeDeg: 0,
      maximumScreenSpaceError: 4,
    }),
    12,
  );
  // Clamped to the provider's levels.
  assert.equal(
    imageryLevelForView(mercator, {
      metresPerPixel: 5,
      latitudeDeg: 0,
      maximumLevel: 12,
    }),
    12,
  );
  assert.equal(
    imageryLevelForView(mercator, { metresPerPixel: 0, latitudeDeg: 0 }),
    null,
  );
});

test('the tiles ahead are the ones the points fall in, bounded and new', () => {
  const mercator = new Cesium.WebMercatorTilingScheme();
  const points = groundTrackAhead(PASS, 20);
  const tiles = tilesForPoints(mercator, points, 13);
  assert.ok(tiles.length > 0 && tiles.length <= ORBITAL_PREFETCH_MAX_TILES);
  assert.equal(new Set(tiles.map((tile) => tile.key)).size, tiles.length);
  // Each tile holds its point: the first is the centre line 5 s ahead.
  const first = mercator.tileXYToRectangle(tiles[0].x, tiles[0].y, 13);
  assert.ok(
    Cesium.Rectangle.contains(
      first,
      Cesium.Cartographic.fromDegrees(points[0].lon, points[0].lat),
    ),
  );
  // Ahead along a north-east track: rows north (smaller y), columns east.
  const here = mercator.positionToTileXY(
    Cesium.Cartographic.fromDegrees(PASS.longitude, PASS.latitude),
    13,
  );
  assert.ok(tiles.every((tile) => tile.x >= here.x && tile.y <= here.y));
  // Bounded, and a tile already asked for is skipped.
  assert.equal(tilesForPoints(mercator, points, 15, { maxTiles: 3 }).length, 3);
  const asked = new Set(
    tilesForPoints(mercator, points, 13, { maxTiles: Infinity }).map(
      (tile) => tile.key,
    ),
  );
  assert.deepEqual(
    tilesForPoints(mercator, points, 13, { skip: (key) => asked.has(key) }),
    [],
  );
  assert.deepEqual(tilesForPoints({}, points, 13), []);
});

test('a view tilted past the limb no longer meets the Earth', () => {
  // GEO: the Earth spans about 8.7 degrees either side of nadir.
  assert.equal(offNadirCentreMeetsEarth(35_786_000, { northDeg: 5 }), true);
  assert.equal(offNadirCentreMeetsEarth(35_786_000, { northDeg: 15 }), false);
  // LEO: a 30 degree tilt still lands on the ground.
  assert.equal(
    offNadirCentreMeetsEarth(420_000, { northDeg: 20, eastDeg: 20 }),
    true,
  );
  assert.equal(offNadirCentreMeetsEarth(420_000, { eastDeg: 80 }), false);
  assert.equal(offNadirCentreMeetsEarth(NaN, {}), false);
});

test('the centre line of every lead comes before the frame edges', () => {
  const points = groundTrackAhead(PASS, 20);
  const across = ORBITAL_PREFETCH_ACROSS.length;
  const ordered = centreLinesFirst(points);
  assert.equal(ordered.length, points.length);
  const leads = ORBITAL_PREFETCH_LEAD_S.length;
  assert.deepEqual(
    ordered.slice(0, leads),
    points.filter((_, i) => i % across === 0),
  );
  // The 12-tile cap at a level of small tiles still reaches the far lead.
  const mercator = new Cesium.WebMercatorTilingScheme();
  const tiles = tilesForPoints(mercator, ordered, 17);
  const far = mercator.positionToTileXY(
    Cesium.Cartographic.fromDegrees(
      ordered[leads - 1].lon,
      ordered[leads - 1].lat,
    ),
    17,
  );
  assert.ok(tiles.some((tile) => tile.x === far.x && tile.y === far.y));
});
