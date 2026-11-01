// Sky view brightness ESTIMATE. The ISS offset is
// calibrated against three real passes whose Heavens-Above values are pasted
// below (source and retrieval date with each row).
import test from 'node:test';
import { entryOf, tle } from '../testSupport/skyTleFixture.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gstime } from 'satellite.js';
import {
  lookAnglesAt,
  solarPositionECI,
  isSatelliteSunlit,
} from '../data/satellitePass.js';
import {
  ALWAYS_ELIGIBLE_CLASSES,
  clampMagLimit,
  diffuseSphereMagnitude,
  estimateMagnitude,
  formatEstMag,
  isNakedEyeCandidate,
  MAG_LIMIT_DEFAULT,
  phaseAngleDeg,
  phaseFunction,
  rcsValue,
  STATION_OFFSETS,
} from './brightness.js';
import {
  createSatEngine,
  ISS_NORAD,
  makeObserver,
  observerEci,
} from './satCore.js';
import { passesForEntry } from './passes.js';

const D2R = Math.PI / 180;
const ISS_RCS_M2 = 399.0524; // CelesTrak SATCAT 25544, fetched 2026-10-12 01:17 UTC

const FIXTURE = readFileSync(
  new URL('./reference/satFixture200.tle', import.meta.url),
  'utf8',
);
const ISS_TLE = tle(entryOf(25544));

/**
 * THREE REAL ISS PASSES, Houston (29.7600 N, 95.3700 W, 15 m), as published
 * by Heavens-Above (https://www.heavens-above.com/passdetails.aspx, satid
 * 25544, tz UCT), retrieved 2026-10-12 01:18 UTC. Orbit line on the pages:
 * "416 x 425 km, 51.6 deg (Epoch: 11 October)", the same element set as the
 * fixture. Rows: time UTC, altitude deg, azimuth deg, distance km,
 * Heavens-Above magnitude. Only the sunlit points carry a magnitude.
 */
const HEAVENS_ABOVE = Object.freeze([
  // pass 1, 14 October 2026 (mjd 61327.4741668274), max alt 73 deg
  ['2026-10-14T11:20:41Z', 21, 232, 1004, -2.3], // exits shadow
  ['2026-10-14T11:22:47Z', 73, 314, 443, -3.8], // maximum altitude
  ['2026-10-14T11:26:10Z', 10, 40, 1507, -0.4], // drops below 10 deg
  ['2026-10-14T11:28:17Z', 0, 42, 2375, 0.7], // sets
  // pass 2, 15 October 2026 (mjd 61328.4413122222), max alt 53 deg
  ['2026-10-15T10:36:12Z', 43, 86, 606, -2.6], // exits shadow
  ['2026-10-15T10:38:48Z', 10, 53, 1505, -0.2], // drops below 10 deg
  ['2026-10-15T10:40:56Z', 0, 49, 2373, 0.9], // sets
  // pass 3, 18 October 2026 (mjd 61331.4097956193), max alt 71 deg
  ['2026-10-18T09:54:36Z', 4, 41, 1963, 0.2], // exits shadow
]);
/**
 * Sanity band for a sunlit ISS pass above 30 deg: the
 * three passes above give -3.8 (73 deg) and -2.6 (43 deg) above 30 deg;
 * the band keeps a margin of the model's +/- 1 mag error on each side.
 */
const ISS_HIGH_PASS_BAND = Object.freeze({ brightest: -5, faintest: -1 });

function issGeometry(iso) {
  const engine = createSatEngine();
  engine.loadGroup('stations', ISS_TLE);
  const satrec = engine.byNorad(ISS_NORAD).satrec;
  const t = Date.parse(iso);
  const look = lookAnglesAt(satrec, t, 29.76, -95.37);
  const o = observerEci(makeObserver(29.76, -95.37), gstime(new Date(t))).r;
  return {
    look,
    rangeKm: Math.hypot(
      look.satECI.x - o.x,
      look.satECI.y - o.y,
      look.satECI.z - o.z,
    ),
    phaseDeg: phaseAngleDeg(look.satECI, o, solarPositionECI(t)),
    sunlit: isSatelliteSunlit(look.satECI, t),
  };
}

test('phase function: F(0)=1, F(90)=1/pi, F(180)=0, monotonic', () => {
  assert.equal(phaseFunction(0), 1);
  assert.ok(Math.abs(phaseFunction(Math.PI / 2) - 1 / Math.PI) < 1e-12);
  assert.ok(Math.abs(phaseFunction(Math.PI)) < 1e-12);
  let prev = Infinity;
  for (let d = 0; d <= 180; d += 5) {
    const f = phaseFunction(d * D2R);
    assert.ok(f <= prev + 1e-12);
    prev = f;
  }
});

test('phase angle: Sun behind the observer = 0 deg, Sun behind the satellite = 180 deg', () => {
  const sat = { x: 7000, y: 0, z: 0 };
  assert.ok(
    Math.abs(
      phaseAngleDeg(sat, { x: 6400, y: 0, z: 0 }, { x: -1e8, y: 0, z: 0 }),
    ) < 1e-9,
  );
  assert.ok(
    Math.abs(
      phaseAngleDeg(sat, { x: 6400, y: 0, z: 0 }, { x: 1e8, y: 0, z: 0 }) - 180,
    ) < 1e-9,
  );
  assert.ok(
    Math.abs(
      phaseAngleDeg(sat, { x: 6400, y: 0, z: 0 }, { x: 7000, y: 1e8, z: 0 }) -
        90,
    ) < 1e-6,
  );
});

test('diffuse-sphere model reproduces the design hand-runs', () => {
  const near = (a, b, tol = 0.06) =>
    assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);
  near(diffuseSphereMagnitude({ rcsM2: 1, rangeKm: 550, phaseDeg: 90 }), 6.6);
  near(diffuseSphereMagnitude({ rcsM2: 10, rangeKm: 800, phaseDeg: 90 }), 5.0);
  near(
    diffuseSphereMagnitude({ rcsM2: 400, rangeKm: 1000, phaseDeg: 90 }),
    1.4,
  );
  // inverse square: twice the range = +1.505 mag
  near(
    diffuseSphereMagnitude({ rcsM2: 5, rangeKm: 1200, phaseDeg: 60 }) -
      diffuseSphereMagnitude({ rcsM2: 5, rangeKm: 600, phaseDeg: 60 }),
    5 * Math.log10(2),
    1e-9,
  );
});

test('Starlink-like fixture estimates +5..+8 over typical visible geometry', () => {
  // RCS ~1 m2 (Starlink v1-class bus + array, radar size), 550 km shell.
  const cases = [
    { rangeKm: 550, phaseDeg: 90 },
    { rangeKm: 550, phaseDeg: 30 },
    { rangeKm: 700, phaseDeg: 60 },
    { rangeKm: 800, phaseDeg: 45 },
    { rangeKm: 1000, phaseDeg: 40 },
  ];
  for (const c of cases) {
    const m = estimateMagnitude({ noradId: 44714, rcsM2: 1, ...c });
    assert.ok(m >= 5 && m <= 8, `${JSON.stringify(c)} -> ${m}`);
  }
});

test('ISS offset is re-derived from the three Heavens-Above passes; every sunlit point within 1.0 mag', () => {
  const residuals = [];
  for (const [iso, alt, az, distKm, haMag] of HEAVENS_ABOVE) {
    const g = issGeometry(iso);
    // our geometry agrees with Heavens-Above (same elements)
    assert.ok(Math.abs(g.look.elevDeg - alt) < 1, `${iso} alt`);
    assert.ok(
      Math.abs(((g.look.azDeg - az + 540) % 360) - 180) < 4,
      `${iso} az`,
    );
    assert.ok(Math.abs(g.rangeKm - distKm) < 10, `${iso} range`);
    assert.equal(g.sunlit, true, `${iso} sunlit`);
    const plain = diffuseSphereMagnitude({ rcsM2: ISS_RCS_M2, ...g });
    residuals.push(haMag - plain);
  }
  // the plain model is too faint for the ISS by 2.7..4.6 mag here
  assert.ok(Math.max(...residuals) < -2.5 && Math.min(...residuals) > -5);
  const midRange = (Math.max(...residuals) + Math.min(...residuals)) / 2;
  assert.equal(Math.round(midRange * 10) / 10, STATION_OFFSETS[ISS_NORAD]);
  for (const [iso, , , , haMag] of HEAVENS_ABOVE) {
    const g = issGeometry(iso);
    const est = estimateMagnitude({
      noradId: ISS_NORAD,
      rcsM2: ISS_RCS_M2,
      ...g,
    });
    assert.ok(
      Math.abs(est - haMag) <= 1.0,
      `${iso}: est ${est.toFixed(2)} vs ${haMag}`,
    );
  }
});

test('ISS-like sunlit passes above 30 deg fall inside the band recorded from the three real passes', () => {
  for (const [iso, alt, , , haMag] of HEAVENS_ABOVE) {
    if (alt <= 30) continue;
    assert.ok(
      haMag <= ISS_HIGH_PASS_BAND.faintest &&
        haMag >= ISS_HIGH_PASS_BAND.brightest,
    );
    const g = issGeometry(iso);
    const est = estimateMagnitude({
      noradId: ISS_NORAD,
      rcsM2: ISS_RCS_M2,
      ...g,
    });
    assert.ok(
      est <= ISS_HIGH_PASS_BAND.faintest && est >= ISS_HIGH_PASS_BAND.brightest,
      `${iso} ${est}`,
    );
  }
  // and every VISIBLE ISS pass over 30 deg the pass finder lists in the
  // Heavens-Above week (estimate = brightest sunlit point)
  const engine = createSatEngine();
  engine.loadGroup('stations', ISS_TLE);
  engine.setRcs({ [ISS_NORAD]: ISS_RCS_M2 });
  const iss = engine.byNorad(ISS_NORAD);
  const observer = makeObserver(29.76, -95.37);
  const passes = [
    ...passesForEntry(iss, observer, Date.parse('2026-10-13T00:00:00Z')),
    ...passesForEntry(iss, observer, Date.parse('2026-10-15T00:00:00Z')),
    ...passesForEntry(iss, observer, Date.parse('2026-10-17T00:00:00Z')),
  ].filter((p) => p.visible && p.peakElevDeg > 30 && p.estMag != null);
  assert.ok(passes.length >= 2, `${passes.length} high visible passes`);
  for (const p of passes)
    assert.ok(
      p.estMag <= ISS_HIGH_PASS_BAND.faintest &&
        p.estMag >= ISS_HIGH_PASS_BAND.brightest,
      `${new Date(p.peakMs).toISOString()} ${p.peakElevDeg.toFixed(0)} deg est ${p.estMag}`,
    );
});

test('null / missing RCS => no estimate; shadow => no estimate', () => {
  for (const rcs of [null, undefined, '', 0, -1, 'N/A', NaN])
    assert.equal(
      estimateMagnitude({ noradId: 1, rcsM2: rcs, rangeKm: 600, phaseDeg: 60 }),
      null,
    );
  assert.equal(rcsValue('2.5'), 2.5);
  assert.equal(
    estimateMagnitude({
      noradId: 1,
      rcsM2: 3,
      rangeKm: 600,
      phaseDeg: 60,
      sunlit: false,
    }),
    null,
  );
  assert.equal(
    diffuseSphereMagnitude({ rcsM2: 3, rangeKm: 600, phaseDeg: 180 }),
    null,
  );
});

test('naked-eye filter: VISIBLE and est. mag <= limit, or class station/visual; no estimate => class only', () => {
  assert.deepEqual([...ALWAYS_ELIGIBLE_CLASSES], ['station', 'visual']);
  assert.equal(MAG_LIMIT_DEFAULT, 5.5);
  const c = (o) => isNakedEyeCandidate({ visible: true, limit: 5.5, ...o });
  assert.equal(c({ klass: 'other', estMag: 5.4 }), true);
  assert.equal(c({ klass: 'other', estMag: 5.6 }), false);
  assert.equal(c({ klass: 'other', estMag: 5.6, limit: 7 }), true);
  assert.equal(c({ klass: 'other', estMag: null }), false, 'null RCS excluded');
  assert.equal(c({ klass: 'comms', estMag: NaN }), false);
  assert.equal(c({ klass: 'station', estMag: null }), true, 'station always');
  assert.equal(c({ klass: 'visual', estMag: 9 }), true, 'visual always');
  assert.equal(c({ klass: 'station', visible: false }), false, 'not VISIBLE');
  assert.equal(clampMagLimit(1), 3);
  assert.equal(clampMagLimit(9), 7);
  assert.equal(clampMagLimit('x'), 5.5);
  assert.equal(formatEstMag(3.24), 'est. mag 3.2');
  assert.equal(formatEstMag(-3.66), 'est. mag -3.7');
  assert.equal(formatEstMag(null), null);
});
