import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  Body,
  Equator,
  MakeTime,
  Observer,
  Refraction,
} from 'astronomy-engine';
import {
  DEG,
  applyProperMotion,
  apparentAltitude,
  equatorialToHorizontal,
  gmstRad,
  julianCenturies,
  precessToDate,
  precessionMatrix,
  radecToVector,
  refractionDeg,
  starAzEl,
  starFrame,
  vectorToRadec,
} from './skyMath.js';
import { parseSkyData } from './starData.js';

const readJson = (name) =>
  JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const sky = parseSkyData(
  readJson('./data/stars.json'),
  readJson('./data/constellations.json'),
);
const star = (hip) => {
  const i = sky.hipIndex.get(hip);
  assert.ok(i !== undefined, `HIP ${hip} in bundled data`);
  return [
    sky.stars.ra[i],
    sky.stars.dec[i],
    sky.stars.pmRa[i],
    sky.stars.pmDec[i],
  ];
};
const POLARIS = 11767;
const SIRIUS = 32349;
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const sepDeg = (ra1, dec1, ra2, dec2) => {
  const a = radecToVector(ra1, dec1);
  const b = radecToVector(ra2, dec2);
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.min(1, dot)) / DEG;
};
const hms = (h, m, s) => (h + m / 60 + s / 3600) * 15;
const dms = (d, m, s) => Math.sign(d || 1) * (Math.abs(d) + m / 60 + s / 3600);
const jdToMs = (jd) => (jd - 2440587.5) * 86_400_000;

test('RA/Dec <-> vector round trip', () => {
  for (const [ra, dec] of [
    [0, 0],
    [359.9, -89.9],
    [123.456, 45.678],
  ]) {
    const back = vectorToRadec(radecToVector(ra, dec));
    assert.ok(
      Math.abs(back.raDeg - ra) < 1e-9 && Math.abs(back.decDeg - dec) < 1e-9,
    );
  }
});

test('precession matrix is a rotation and the identity at J2000', () => {
  const I = precessionMatrix(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      assert.ok(Math.abs(I[r][c] - (r === c ? 1 : 0)) < 1e-4); // 2.65" angle offsets cancel to ~1e-8
  const P = precessionMatrix(0.37);
  for (let r = 0; r < 3; r++) {
    const norm = Math.hypot(...P[r]);
    assert.ok(Math.abs(norm - 1) < 1e-12);
  }
});

test('proper motion + IAU 2006 precession reproduce Meeus Example 21.b (theta Persei, 2028 Nov 13.19)', () => {
  // Meeus, Astronomical Algorithms 2nd ed., Example 21.b. J2000 place and proper
  // motion (mu_alpha = +0.03425 s/yr in RA, mu_delta = -0.0895"/yr); result
  // alpha = 2h46m11.331s, delta = +49d20'54.54" (IAU 1976 angles; Skyfield's
  // IAU 2006 compute_precession gives 11.324s / 54.50", run 2026-10-11).
  const ra0 = hms(2, 44, 11.986);
  const dec0 = dms(49, 13, 42.48);
  const pmRa = 0.03425 * 15 * 1000 * Math.cos(dec0 * DEG); // mas/yr, mu_alpha*
  const pmDec = -89.5;
  const ms = jdToMs(2462088.69);
  const years = (2462088.69 - 2451545.0) / 365.25;
  const moved = applyProperMotion(ra0, dec0, pmRa, pmDec, years);
  const out = precessToDate(moved.raDeg, moved.decDeg, ms);
  const sep =
    sepDeg(out.raDeg, out.decDeg, hms(2, 46, 11.324), dms(49, 20, 54.5)) * 3600;
  assert.ok(sep < 0.5, `separation from reference ${sep.toFixed(3)}"`);
  const meeus =
    sepDeg(out.raDeg, out.decDeg, hms(2, 46, 11.331), dms(49, 20, 54.54)) *
    3600;
  assert.ok(meeus < 1, `separation from Meeus ${meeus.toFixed(3)}"`);
});

test('precession agrees with astronomy-engine EQJ->EQD to within nutation (< 25")', () => {
  const observer = new Observer(0, 0, 0);
  for (const iso of [
    '1976-01-01T00:00:00Z',
    '2026-10-12T03:00:00Z',
    '2076-06-01T00:00:00Z',
  ]) {
    const ms = Date.parse(iso);
    const time = MakeTime(new Date(ms));
    for (const body of [Body.Mars, Body.Jupiter]) {
      const j2000 = Equator(body, time, observer, false, false);
      const ofDate = Equator(body, time, observer, true, false);
      const ours = precessToDate(j2000.ra * 15, j2000.dec, ms);
      const sep =
        sepDeg(ours.raDeg, ours.decDeg, ofDate.ra * 15, ofDate.dec) * 3600;
      assert.ok(sep < 25, `${iso} sep ${sep.toFixed(2)}"`);
    }
  }
});

test('proper motion is linear in time and stable at the pole', () => {
  const [ra, dec, pmRa, pmDec] = star(69673); // Arcturus, ~2.3"/yr
  const later = applyProperMotion(ra, dec, pmRa, pmDec, 100);
  const total = (Math.hypot(pmRa, pmDec) * 100) / 3_600_000;
  assert.ok(
    Math.abs(sepDeg(ra, dec, later.raDeg, later.decDeg) - total) < 1e-6,
  );
  const pole = applyProperMotion(0, 90, 1000, 0, 10);
  assert.ok(
    Number.isFinite(pole.raDeg) && pole.decDeg < 90 && pole.decDeg > 89.99,
  );
});

test('GMST matches Meeus Example 12.a (1987-04-10 0h UT = 13h10m46.3668s)', () => {
  const gmst = gmstRad(Date.UTC(1987, 3, 10)) / DEG;
  assert.ok(Math.abs(gmst - hms(13, 10, 46.3668)) < 0.1 / 240, `${gmst}`);
});

test('equatorial -> horizontal: pole star overhead at the pole, meridian transit due south', () => {
  const zenith = equatorialToHorizontal(0, 90, 90, 0, 1.234);
  assert.ok(Math.abs(zenith.elDeg - 90) < 1e-9);
  const lat = 30;
  const south = equatorialToHorizontal(100, 0, lat, 0, 100 * DEG); // HA 0
  assert.ok(
    Math.abs(south.azDeg - 180) < 1e-9 && Math.abs(south.elDeg - 60) < 1e-9,
  );
  const east = equatorialToHorizontal(100, 0, 0, 0, 10 * DEG); // HA -90 at equator
  assert.ok(Math.abs(east.azDeg - 90) < 1e-9 && Math.abs(east.elDeg) < 1e-9);
});

test('Polaris: altitude within 1.0 deg of latitude at 0/30/45/60 N over a sidereal day; azimuth near north', () => {
  const [ra, dec, pmRa, pmDec] = star(POLARIS);
  for (const lat of [0, 30, 45, 60]) {
    let maxAz = 0;
    for (let h = 0; h < 24; h += 0.5) {
      const frame = starFrame(
        Date.UTC(2026, 9, 12) + h * 3_600_000,
        lat,
        -95.37,
      );
      const p = starAzEl(frame, ra, dec, pmRa, pmDec);
      assert.ok(
        Math.abs(p.elDeg - lat) < 1.0,
        `lat ${lat} h ${h} el ${p.elDeg}`,
      );
      maxAz = Math.max(maxAz, angDiff(p.azDeg, 0));
      // Physical bound: azimuth swing is asin(sin(p) / cos(lat)) for polar distance p.
      const p0 = 90 - p.decDeg;
      const bound = Math.asin(Math.sin(p0 * DEG) / Math.cos(lat * DEG)) / DEG;
      assert.ok(
        angDiff(p.azDeg, 0) <= bound + 0.01,
        `lat ${lat} az ${p.azDeg} > ${bound}`,
      );
    }
    // the design asks for az within 1.0 deg of north. True for 0/30/45 N at all
    // hours; at 60 N Polaris (0.63 deg from the pole in 2026) swings up to
    // 0.63/cos 60 = 1.27 deg near elongation, which is physics, not error.
    if (lat <= 45) assert.ok(maxAz < 1.0, `lat ${lat} max az ${maxAz}`);
    else assert.ok(maxAz > 1.0 && maxAz < 1.3, `lat ${lat} max az ${maxAz}`);
  }
});

test('Polaris azimuth within 1.0 deg of north at 60 N near its culminations', () => {
  const [ra, dec, pmRa, pmDec] = star(POLARIS);
  const day = Date.UTC(2026, 9, 12);
  let checked = 0;
  for (let m = 0; m < 1440; m += 2) {
    const frame = starFrame(day + m * 60_000, 60, -95.37);
    const p = starAzEl(frame, ra, dec, pmRa, pmDec);
    const ha = (((frame.gmst / DEG - 95.37 - p.raDeg) % 360) + 360) % 360;
    if (Math.min(ha, 360 - ha) < 45 || Math.abs(ha - 180) < 45) {
      assert.ok(angDiff(p.azDeg, 0) < 1.0, `ha ${ha} az ${p.azDeg}`);
      checked += 1;
    }
  }
  assert.ok(checked > 300);
});

test('Sirius upper culmination altitude = 90 - |lat - dec| within 0.1 deg', () => {
  const [ra, dec, pmRa, pmDec] = star(SIRIUS);
  for (const lat of [0, 30, 45, 60, -30, -45]) {
    // Find the transit on 2026-10-12 by scanning HA then refining.
    const day = Date.UTC(2026, 9, 12);
    let best = null;
    for (let s = 0; s < 86_400; s += 30) {
      const frame = starFrame(day + s * 1000, lat, -95.37);
      const p = starAzEl(frame, ra, dec, pmRa, pmDec);
      if (!best || p.elDeg > best.p.elDeg) best = { p, frame };
    }
    const expected = 90 - Math.abs(lat - best.p.decDeg);
    assert.ok(
      Math.abs(best.p.elDeg - expected) < 0.1,
      `lat ${lat}: ${best.p.elDeg} vs ${expected}`,
    );
    assert.ok(angDiff(best.p.azDeg, lat > best.p.decDeg ? 180 : 0) < 2);
  }
});

test('Vega / Arcturus / Rigel az/el within 0.02 deg of the Skyfield reference (3 sites x 3 dates)', (t) => {
  const fixture = readJson('./reference/starReference.fixture.json');
  assert.equal(fixture.rows.length, 27);
  const site = Object.fromEntries(fixture.sites.map((s) => [s.name, s]));
  let worst = { el: 0, az: 0, azCos: 0 };
  for (const row of fixture.rows) {
    const [ra, dec, pmRa, pmDec] = star(row.hip);
    const { latDeg, lonDeg } = site[row.site];
    const p = starAzEl(
      starFrame(Date.parse(row.utc), latDeg, lonDeg),
      ra,
      dec,
      pmRa,
      pmDec,
    );
    const dEl = Math.abs(p.elDeg - row.elDeg);
    const dAz = angDiff(p.azDeg, row.azDeg);
    worst = {
      el: Math.max(worst.el, dEl),
      az: Math.max(worst.az, dAz),
      azCos: Math.max(worst.azCos, dAz * Math.cos(row.elDeg * DEG)),
    };
    const label = `${row.star} ${row.site} ${row.utc}`;
    assert.ok(dEl < 0.02, `${label} el ${p.elDeg} vs ${row.elDeg}`);
    assert.ok(dAz < 0.02, `${label} az ${p.azDeg} vs ${row.azDeg}`);
  }
  t.diagnostic(
    `worst el ${worst.el.toFixed(4)} az ${worst.az.toFixed(4)} az*cos(el) ${worst.azCos.toFixed(4)} deg`,
  );
});

test('refraction: Saemundsson, 0.57 deg at the apparent horizon, 0.48 deg at true 0, 0 at the zenith', () => {
  // A body ON the visible horizon (apparent 0) is really 0.57 deg below it.
  const atHorizon = refractionDeg(-0.57);
  assert.ok(Math.abs(atHorizon - 0.57) <= 0.03, `R(true -0.57) = ${atHorizon}`);
  assert.ok(Math.abs(apparentAltitude(-0.57)) < 0.03);
  // True altitude 0 is lifted to +0.48 (Meeus eq. 16.4: 28.98'); astronomy-engine agrees.
  const atTrueZero = refractionDeg(0);
  assert.ok(Math.abs(atTrueZero - 0.483) < 0.002, `R(0) = ${atTrueZero}`);
  for (const h of [0, 5, 10, 30, 60, 89]) {
    assert.ok(
      Math.abs(refractionDeg(h) - Refraction('normal', h)) < 0.002,
      `h ${h}`,
    );
  }
  assert.equal(refractionDeg(90), 0);
  assert.ok(refractionDeg(45) < 0.02 && refractionDeg(45) > 0.015);
  let previous = Infinity;
  for (let h = -1; h <= 90; h += 0.5) {
    const r = refractionDeg(h);
    assert.ok(r <= previous + 1e-12 && r >= 0, `monotone at ${h}`);
    previous = r;
  }
  assert.equal(refractionDeg(-5), refractionDeg(-1)); // clamped, no divergence
  assert.ok(
    refractionDeg(0, { pressureHPa: 700, temperatureC: -10 }) <
      refractionDeg(0) * 0.8,
  );
});

test('starAzEl applies refraction only when asked', () => {
  const [ra, dec, pmRa, pmDec] = star(SIRIUS);
  const frame = starFrame(Date.UTC(2026, 9, 12, 10), 29.76, -95.37);
  const plain = starAzEl(frame, ra, dec, pmRa, pmDec);
  const refracted = starAzEl(frame, ra, dec, pmRa, pmDec, { refraction: true });
  assert.equal(refracted.azDeg, plain.azDeg);
  assert.ok(
    Math.abs(refracted.elDeg - plain.elDeg - refractionDeg(plain.elDeg)) <
      1e-12,
  );
});

test('julianCenturies is zero at J2000.0 (2000-01-01T12:00Z)', () => {
  assert.equal(julianCenturies(Date.UTC(2000, 0, 1, 12)), 0);
  assert.ok(Math.abs(julianCenturies(Date.UTC(2100, 0, 1, 12)) - 1) < 1e-4);
});
