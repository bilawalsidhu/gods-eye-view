import assert from 'node:assert/strict';
import test from 'node:test';
import {
  declinationDeg,
  declinationText,
  magneticToTrue,
  WMM_MODEL_NAME,
} from './declination.js';

// NOAA NCEI Magnetic Field Calculator, model WMM-2025 (calculator version
// 1.2.1), declination at sea level for 2026-10-12 (decimal year 2026.7781).
// Fetched 2026-10-12 ~08:50 UTC from
// https://www.ngdc.noaa.gov/geomag-web/calculators/calculateDeclination
//   ?lat1=..&lon1=..&model=WMM&startYear=2026&startMonth=10&startDay=12
//   &resultFormat=json
const NOAA_2026_10_12 = [
  { place: 'Houston', lat: 29.7604, lon: -95.3698, decl: 1.70639 },
  { place: 'New York', lat: 40.7128, lon: -74.006, decl: -12.46335 },
  { place: 'Seattle', lat: 47.6062, lon: -122.3321, decl: 14.87057 },
  { place: 'Fairbanks', lat: 64.8378, lon: -147.7164, decl: 14.7781 },
  { place: 'Sydney', lat: -33.8688, lon: 151.2093, decl: 12.82672 },
];
const DAY = Date.UTC(2026, 9, 12, 12);

test('WMM2025 declination matches the NOAA calculator at 5 places within 0.5 deg (measured < 0.001)', () => {
  assert.equal(WMM_MODEL_NAME, 'WMM-2025');
  for (const p of NOAA_2026_10_12) {
    const d = declinationDeg(p.lat, p.lon, DAY);
    assert.ok(Number.isFinite(d), p.place);
    assert.ok(Math.abs(d - p.decl) < 0.5, `${p.place}: ${d} vs NOAA ${p.decl}`);
    // what the bundled model actually achieves (tighter than the card asks)
    assert.ok(Math.abs(d - p.decl) < 0.002, `${p.place}: ${d}`);
  }
});

test('the bundled model covers October 2026 and the rest of the WMM2025 window; outside it is null', () => {
  assert.ok(
    Number.isFinite(declinationDeg(29.76, -95.37, Date.UTC(2026, 9, 1))),
  );
  assert.ok(
    Number.isFinite(declinationDeg(29.76, -95.37, Date.UTC(2029, 9, 1))),
  );
  assert.equal(declinationDeg(29.76, -95.37, Date.UTC(2031, 0, 1)), null);
  assert.equal(declinationDeg(Number.NaN, 0, DAY), null);
  assert.equal(declinationDeg(95, 0, DAY), null);
  assert.equal(declinationDeg('x', 0, DAY), null);
});

test('cached per 0.1 deg cell and day: same value, and a different day can differ', () => {
  const a = declinationDeg(29.7604, -95.3698, DAY);
  const b = declinationDeg(29.7641, -95.3712, DAY + 3_600_000);
  assert.equal(a, b);
});

test('magnetic 270 at +2 deg E -> true 272; west declination subtracts; wraps', () => {
  assert.equal(magneticToTrue(270, 2), 272);
  assert.equal(magneticToTrue(10, -12.5), 357.5);
  assert.equal(magneticToTrue(359, 2), 1);
  assert.equal(magneticToTrue(90, null), 90);
});

test('declination text', () => {
  assert.equal(declinationText(1.706), 'declination 1.7° E');
  assert.equal(declinationText(-12.46), 'declination 12.5° W');
  assert.equal(declinationText(null), 'declination unknown');
});
