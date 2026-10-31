import assert from 'node:assert/strict';
import test from 'node:test';
import { Illumination, MakeTime } from 'astronomy-engine';
import {
  PLANETS,
  TELESCOPIC_PLANETS,
  bodyPosition,
  brightLimbAngle,
  makeObserver,
  moonState,
  planetState,
  skyEphemeris,
  sunState,
} from './ephemeris.js';

const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/*
 * JPL Horizons rows, pasted verbatim (fetched 2026-10-11 with
 * src/skyView/reference/horizons.py, Horizons API version 1.2).
 * Query per row: https://ssd.jpl.nasa.gov/api/horizons.api with
 *   EPHEM_TYPE='OBSERVER' CENTER='coord@399' COORD_TYPE='GEODETIC'
 *   SITE_COORD='<lon>,<lat>,<km>' TLIST='<UT>' TIME_TYPE='UT'
 *   QUANTITIES='4,10' ANG_FORMAT='DEG' APPARENT='AIRLESS' EXTRA_PREC='YES' CSV_FORMAT='YES'
 *   COMMAND = 10 (Sun) | 301 (Moon) | 299 (Venus) | 599 (Jupiter) | 699 (Saturn)
 * Columns: Date__(UT)__HR:MN:SC.fff, , ,Azimuth_(a-app), Elevation_(a-app), Illu%,
 * (quantity 4 = topocentric apparent az/el, airless; 10 = illuminated fraction %)
 */
const SITES = {
  Houston: { latDeg: 29.7604, lonDeg: -95.3698, heightM: 15 },
  Sydney: { latDeg: -33.8688, lonDeg: 151.2093, heightM: 50 },
  Reykjavik: { latDeg: 64.1466, lonDeg: -21.9426, heightM: 30 },
};
const HORIZONS = `
Houston|2026-12-01T03:00:00Z|Sun|2026-Dec-01 03:00:00.000, , ,  269.055450733,     -46.713589944,  100.00000,
Houston|2026-12-01T03:00:00Z|Moon|2026-Dec-01 03:00:00.000, , ,   53.160496390,     -36.334575128,   50.93626,
Houston|2026-12-01T03:00:00Z|Venus|2026-Dec-01 03:00:00.000, , ,  340.788809102,     -68.636498800,   27.87131,
Houston|2026-12-01T03:00:00Z|Jupiter|2026-Dec-01 03:00:00.000, , ,   55.820776346,     -25.135745759,   99.17357,
Houston|2026-12-01T03:00:00Z|Saturn|2026-Dec-01 03:00:00.000, , ,  202.319453565,      59.131868509,   99.79018,
Sydney|2031-06-15T12:00:00Z|Sun|2031-Jun-15 12:00:00.000, , ,  254.937583267,     -62.625737538,  100.00000,
Sydney|2031-06-15T12:00:00Z|Moon|2031-Jun-15 12:00:00.000, , ,  126.700774627,     -62.540833472,   17.23507,
Sydney|2031-06-15T12:00:00Z|Venus|2031-Jun-15 12:00:00.000, , ,  280.222860460,     -21.439818390,   41.65233,
Sydney|2031-06-15T12:00:00Z|Jupiter|2031-Jun-15 12:00:00.000, , ,   73.947787163,      62.480100322,   99.99994,
Sydney|2031-06-15T12:00:00Z|Saturn|2031-Jun-15 12:00:00.000, , ,  235.711024474,     -69.533193864,   99.98981,
Reykjavik|2036-03-20T22:00:00Z|Sun|2036-Mar-20 22:00:00.000,A, ,  303.570948720,     -14.632102051,  100.00000,
Reykjavik|2036-03-20T22:00:00Z|Moon|2036-Mar-20 22:00:00.000,A, ,   30.012242270,     -43.174180046,   39.29760,
Reykjavik|2036-03-20T22:00:00Z|Venus|2036-Mar-20 22:00:00.000,A, ,  273.137854519,      20.527566338,   50.84336,
Reykjavik|2036-03-20T22:00:00Z|Jupiter|2036-Mar-20 22:00:00.000,A, ,  268.686382141,      19.297303018,   99.44777,
Reykjavik|2036-03-20T22:00:00Z|Saturn|2036-Mar-20 22:00:00.000,A, ,  168.815475883,      43.484628152,   99.83597,
`
  .trim()
  .split('\n')
  .map((line) => {
    const [site, utc, body, row] = line.split('|');
    const cols = row.split(',').map((v) => v.trim());
    return {
      site,
      utc,
      body,
      azDeg: Number(cols[3]),
      elDeg: Number(cols[4]),
      illuminated: Number(cols[5]) / 100,
    };
  });

test('Horizons fixture parsed: 3 dates 2026-2036 x Sun, Moon, Venus, Jupiter, Saturn', () => {
  assert.equal(HORIZONS.length, 15);
  assert.deepEqual(
    new Set(HORIZONS.map((r) => r.utc.slice(0, 4))),
    new Set(['2026', '2031', '2036']),
  );
  for (const r of HORIZONS)
    assert.ok(Number.isFinite(r.azDeg) && Number.isFinite(r.elDeg));
});

test('Sun, Moon, Venus, Jupiter, Saturn az/el within 0.05 deg of JPL Horizons (topocentric apparent, airless)', (t) => {
  let worst = 0;
  for (const row of HORIZONS) {
    const p = bodyPosition(row.body, Date.parse(row.utc), SITES[row.site]);
    const dAz = angDiff(p.azDeg, row.azDeg);
    const dEl = Math.abs(p.elDeg - row.elDeg);
    worst = Math.max(worst, dAz, dEl);
    const label = `${row.body} ${row.site} ${row.utc}`;
    assert.ok(dAz < 0.05, `${label} az ${p.azDeg} vs ${row.azDeg}`);
    assert.ok(dEl < 0.05, `${label} el ${p.elDeg} vs ${row.elDeg}`);
  }
  t.diagnostic(`worst az/el difference ${worst.toFixed(4)} deg`);
});

test('Moon illuminated fraction (topocentric) within 0.01 of Horizons', () => {
  for (const row of HORIZONS.filter((r) => r.body === 'Moon')) {
    const moon = moonState(Date.parse(row.utc), SITES[row.site]);
    assert.ok(
      Math.abs(moon.illuminatedFraction - row.illuminated) < 0.01,
      `${row.utc} ${moon.illuminatedFraction} vs ${row.illuminated}`,
    );
  }
});

test('Venus, Jupiter, Saturn illuminated fraction also tracks Horizons (phase maths sanity)', () => {
  for (const row of HORIZONS.filter((r) =>
    ['Venus', 'Jupiter', 'Saturn'].includes(r.body),
  )) {
    const ill = Illumination(row.body, MakeTime(new Date(Date.parse(row.utc))));
    assert.ok(
      Math.abs(ill.phase_fraction - row.illuminated) < 0.01,
      `${row.body} ${row.utc}`,
    );
  }
});

test('bright-limb angle reproduces Meeus Example 48.a (chi = 285.0 deg)', () => {
  // Meeus, Astronomical Algorithms 2nd ed., Example 48.a, 1992 April 12 0h TD:
  // Moon alpha 134.6885 delta 13.7684, Sun alpha0 20.6579 delta0 8.6964.
  assert.ok(
    Math.abs(brightLimbAngle(20.6579, 8.6964, 134.6885, 13.7684) - 285.0) < 0.1,
  );
  // Same instant through astronomy-engine (topocentric at 0N 0E shifts the Moon a little).
  const moon = moonState(Date.UTC(1992, 3, 11, 23, 59, 1), {
    latDeg: 0,
    lonDeg: 0,
  });
  assert.ok(
    angDiff(moon.brightLimbAngleDeg, 285.0) < 1.5,
    `${moon.brightLimbAngleDeg}`,
  );
  assert.ok(
    Math.abs(moon.illuminatedFraction - 0.6786) < 0.012,
    `${moon.illuminatedFraction}`,
  );
  assert.equal(moon.waxing, true);
});

test('Moon: angular size ~0.5 deg, phase in 0..360, magnitude bright', () => {
  const moon = moonState(Date.parse('2026-10-12T03:00:00Z'), SITES.Houston);
  assert.ok(moon.angularDiameterDeg > 0.48 && moon.angularDiameterDeg < 0.58);
  assert.ok(moon.phaseDeg >= 0 && moon.phaseDeg < 360);
  assert.ok(moon.magnitude < -2 && moon.magnitude > -13.5);
  assert.ok(moon.distanceKm > 350_000 && moon.distanceKm < 410_000);
  assert.ok(moon.brightLimbAngleDeg >= 0 && moon.brightLimbAngleDeg < 360);
});

test('Sun state: magnitude about -26.7, diameter about 0.53 deg', () => {
  const sun = sunState(Date.parse('2026-12-01T03:00:00Z'), SITES.Houston);
  assert.ok(Math.abs(sun.magnitude + 26.75) < 0.1, `${sun.magnitude}`);
  assert.ok(sun.angularDiameterDeg > 0.52 && sun.angularDiameterDeg < 0.55);
});

test('planets Mercury..Neptune with magnitudes; Uranus and Neptune flagged telescopic', () => {
  const ms = Date.parse('2026-10-12T03:00:00Z');
  const sky = skyEphemeris(ms, SITES.Houston);
  assert.deepEqual(
    sky.planets.map((p) => p.name),
    PLANETS,
  );
  assert.deepEqual(TELESCOPIC_PLANETS, ['Uranus', 'Neptune']);
  const mag = Object.fromEntries(sky.planets.map((p) => [p.name, p.magnitude]));
  assert.ok(mag.Venus < -3.5 && mag.Venus > -5);
  assert.ok(mag.Jupiter < -1.5 && mag.Jupiter > -3);
  assert.ok(mag.Uranus > 5 && mag.Uranus < 6.2);
  assert.ok(mag.Neptune > 7.5 && mag.Neptune < 8.1);
  for (const p of sky.planets)
    assert.equal(p.telescopic, TELESCOPIC_PLANETS.includes(p.name));
  assert.throws(() => planetState('Pluto', ms, SITES.Houston), RangeError);
  assert.throws(() => planetState('Moon', ms, SITES.Houston), RangeError);
});

test('refraction option lifts a low body and leaves azimuth alone', () => {
  const ms = Date.parse('2036-03-20T22:00:00Z');
  const plain = bodyPosition('Venus', ms, SITES.Reykjavik);
  const lifted = bodyPosition('Venus', ms, SITES.Reykjavik, {
    refraction: true,
  });
  assert.ok(lifted.elDeg > plain.elDeg && lifted.elDeg - plain.elDeg < 0.06);
  assert.ok(angDiff(lifted.azDeg, plain.azDeg) < 1e-9);
});

test('valid over +/-50 years (spot checks 1976 and 2076)', () => {
  for (const iso of ['1976-07-04T00:00:00Z', '2076-07-04T00:00:00Z']) {
    const sky = skyEphemeris(Date.parse(iso), SITES.Sydney);
    for (const body of [sky.sun, sky.moon, ...sky.planets]) {
      assert.ok(
        Number.isFinite(body.azDeg) && Number.isFinite(body.elDeg),
        `${body.name} ${iso}`,
      );
      assert.ok(Number.isFinite(body.magnitude));
    }
  }
});

test('observer validation', () => {
  assert.throws(() => makeObserver({ latDeg: NaN, lonDeg: 0 }), TypeError);
  assert.equal(makeObserver({ latDeg: 1, lonDeg: 2 }).height, 0);
  assert.throws(() => bodyPosition('Vulcan', 0, SITES.Houston), RangeError);
});
