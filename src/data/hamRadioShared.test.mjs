import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HAM_BANDS,
  HAM_BAND_COLORS,
  PROGRAM_COLORS,
  bandColor,
  bandForHz,
  destinationPoint,
  distanceKm,
  formatAge,
  formatHz,
  greatCirclePoints,
  initialBearingDeg,
  receiverModeForSpot,
  splitAtDateline,
  subsolarPoint,
  terminatorRing,
} from './hamRadioShared.js';
import { haversineKm } from './webReceiverTuning.js';

const TWENTE = { lat: 52.2292, lon: 6.875 };
const ARVIKA = { lat: 59.546, lon: 12.526 };

test('band colours and program colours are frozen and complete', () => {
  assert.ok(Object.isFrozen(HAM_BAND_COLORS));
  assert.ok(Object.isFrozen(PROGRAM_COLORS));
  assert.equal(HAM_BAND_COLORS['20m'], '#8be04a');
  assert.equal(HAM_BAND_COLORS.other, '#9aa4b2');
  assert.deepEqual(Object.keys(PROGRAM_COLORS), ['POTA', 'SOTA', 'WWFF', 'BOTA']);
  assert.equal(bandColor('20m'), '#8be04a');
  assert.equal(bandColor('20M'), '#8be04a', 'case-insensitive');
  assert.equal(bandColor('23cm'), HAM_BAND_COLORS.other, 'bands without a colour fall back');
  assert.equal(bandColor(null), HAM_BAND_COLORS.other);
});

test('bandForHz matches the shared band table and returns null off-band', () => {
  assert.equal(HAM_BANDS.length, 19);
  assert.equal(bandForHz(14_074_000), '20m');
  assert.equal(bandForHz(7_074_000), '40m');
  assert.equal(bandForHz(5_357_000), '60m');
  assert.equal(bandForHz(136_000), '2200m');
  assert.equal(bandForHz(475_000), '630m');
  assert.equal(bandForHz(145_500_000), '2m');
  assert.equal(bandForHz(223_500_000), '1.25m');
  assert.equal(bandForHz(435_000_000), '70cm');
  assert.equal(bandForHz(1_296_000_000), '23cm');
  assert.equal(bandForHz(14_350_000), '20m', 'upper edge inclusive');
  assert.equal(bandForHz(14_350_001), null);
  assert.equal(bandForHz(27_000_000), null, 'CB is not a ham band');
  assert.equal(bandForHz('14074000'), '20m', 'numeric strings are accepted');
  assert.equal(bandForHz(null), null);
  assert.equal(bandForHz('abc'), null);
});

test('formatHz uses kHz with one decimal below 30 MHz and MHz with three above', () => {
  assert.equal(formatHz(14_025_000), '14025.0 kHz');
  assert.equal(formatHz(7_074_500), '7074.5 kHz');
  assert.equal(formatHz(145_500_000), '145.500 MHz');
  assert.equal(formatHz(29_999_999), '30000.0 kHz');
  assert.equal(formatHz(30_000_000), '30.000 MHz');
  assert.equal(formatHz(14_025_000, { unit: false }), '14025.0');
  assert.equal(formatHz(0), '');
  assert.equal(formatHz(null), '');
  assert.equal(formatHz('nope'), '');
});

test('formatAge picks seconds, minutes, hours or days', () => {
  const now = Date.parse('2026-09-12T12:00:00Z');
  assert.equal(formatAge('2026-09-12T11:59:40Z', now), '20 s');
  assert.equal(formatAge('2026-09-12T11:57:00Z', now), '3 min');
  assert.equal(formatAge('2026-09-12T10:00:00Z', now), '2 h');
  assert.equal(formatAge('2026-09-09T12:00:00Z', now), '3 d');
  assert.equal(formatAge('2026-09-12T12:05:00Z', now), '0 s', 'future timestamps clamp to zero');
  assert.equal(formatAge(now - 90_000, now), '2 min', 'numeric ms are accepted');
  assert.equal(formatAge('garbage', now), '');
  assert.equal(formatAge(null, now), '');
});

test('distanceKm takes {lat,lon} objects and agrees with the haversine formula', () => {
  const km = distanceKm(TWENTE, ARVIKA);
  assert.ok(Math.abs(km - haversineKm(TWENTE.lat, TWENTE.lon, ARVIKA.lat, ARVIKA.lon)) < 1e-9, `got ${km}`);
  assert.ok(Math.abs(km - 885.9) < 0.5, `Twente→Arvika is about 886 km, got ${km}`);
  assert.equal(distanceKm(TWENTE, TWENTE), 0);
  assert.ok(Math.abs(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 180 }) - 20015.1) < 1, 'antipodal');
  assert.ok(Number.isNaN(distanceKm(null, TWENTE)));
  assert.ok(Number.isNaN(distanceKm({ lat: 'x', lon: 0 }, TWENTE)));
});

test('initialBearingDeg and destinationPoint are mutually consistent', () => {
  assert.equal(initialBearingDeg({ lat: 0, lon: 0 }, { lat: 10, lon: 0 }), 0);
  assert.equal(initialBearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 10 }), 90);
  assert.equal(initialBearingDeg({ lat: 0, lon: 0 }, { lat: -10, lon: 0 }), 180);
  assert.equal(initialBearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: -10 }), 270);
  const bearing = initialBearingDeg(TWENTE, ARVIKA);
  const km = distanceKm(TWENTE, ARVIKA);
  const there = destinationPoint(TWENTE, bearing, km);
  assert.ok(Math.abs(there.lat - ARVIKA.lat) < 1e-6 && Math.abs(there.lon - ARVIKA.lon) < 1e-6, JSON.stringify(there));
  const east = destinationPoint({ lat: 0, lon: 0 }, 90, 10 * 111.195);
  assert.ok(Math.abs(east.lat) < 1e-9 && Math.abs(east.lon - 10) < 0.01, JSON.stringify(east));
  const wrapped = destinationPoint({ lat: 0, lon: 179 }, 90, 2 * 111.195);
  assert.ok(Math.abs(wrapped.lon + 179) < 0.01, 'longitude wraps to −179, not 181');
  assert.equal(destinationPoint(null, 0, 1), null);
  assert.equal(destinationPoint(TWENTE, 'x', 1), null);
  assert.ok(Number.isNaN(initialBearingDeg(null, TWENTE)));
});

test('splitAtDateline breaks a polyline at ±180 with an interpolated crossing latitude', () => {
  const segments = splitAtDateline([{ lat: 0, lon: 170 }, { lat: 10, lon: -170 }, { lat: 20, lon: -160 }]);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0].map((p) => p.lon), [170, 180]);
  assert.deepEqual(segments[1].map((p) => p.lon), [-180, -170, -160]);
  assert.ok(Math.abs(segments[0][1].lat - 5) < 1e-9, 'crossing latitude is interpolated');
  assert.ok(Math.abs(segments[1][0].lat - 5) < 1e-9);
  const westward = splitAtDateline([{ lat: 0, lon: -170 }, { lat: 0, lon: 170 }]);
  assert.deepEqual(westward.map((s) => s.map((p) => p.lon)), [[-170, -180], [180, 170]]);
  assert.deepEqual(splitAtDateline([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }]).length, 1);
  assert.deepEqual(splitAtDateline([]), []);
  assert.deepEqual(splitAtDateline(null), []);
});

test('greatCirclePoints slerps along the great circle and returns dateline-split segments', () => {
  const single = greatCirclePoints(TWENTE, ARVIKA, 16);
  assert.equal(single.length, 1, 'no dateline crossing → one segment');
  assert.equal(single[0].length, 17);
  assert.deepEqual(single[0][0], TWENTE);
  assert.deepEqual(single[0][16], ARVIKA);
  // Every intermediate point lies on the great circle: distances add up.
  const total = distanceKm(TWENTE, ARVIKA);
  let walked = 0;
  for (let i = 1; i < single[0].length; i += 1) walked += distanceKm(single[0][i - 1], single[0][i]);
  assert.ok(Math.abs(walked - total) < 0.01, `walked ${walked} vs ${total}`);
  // Equal spacing (slerp, not lerp).
  const step0 = distanceKm(single[0][0], single[0][1]);
  const step8 = distanceKm(single[0][8], single[0][9]);
  assert.ok(Math.abs(step0 - step8) < 0.01);

  const tokyoToSf = greatCirclePoints({ lat: 35.7, lon: 139.7 }, { lat: 37.8, lon: -122.4 }, 32);
  assert.equal(tokyoToSf.length, 2, 'Pacific crossing splits at the dateline');
  assert.equal(tokyoToSf[0][tokyoToSf[0].length - 1].lon, 180);
  assert.equal(tokyoToSf[1][0].lon, -180);
  assert.ok(tokyoToSf[0].every((p) => p.lon > 0) && tokyoToSf[1].every((p) => p.lon < 0));
  const apex = Math.max(...tokyoToSf.flat().map((p) => p.lat));
  assert.ok(apex > 45, `great circle arcs north of both endpoints (apex ${apex})`);

  assert.equal(greatCirclePoints(TWENTE, TWENTE).length, 1, 'coincident endpoints');
  const antipodal = greatCirclePoints({ lat: 0, lon: 0 }, { lat: 0, lon: 180 }, 16);
  const flat = antipodal.flat();
  assert.ok(flat.length > 4 && flat.some((p) => p.lat > 80), 'antipodal path routes over the pole');
  assert.deepEqual(greatCirclePoints(null, TWENTE), []);
});

test('subsolarPoint follows the NOAA low-precision solar position', () => {
  const equinox = subsolarPoint(Date.parse('2026-03-20T12:00:00Z'));
  assert.ok(Math.abs(equinox.lat) < 0.15, `equinox declination ≈ 0, got ${equinox.lat}`);
  assert.ok(Math.abs(equinox.lon) < 3, `equinox noon longitude is only the EoT offset, got ${equinox.lon}`);
  assert.ok(Math.abs(equinox.lon - 1.86) < 0.2, 'EoT ≈ −7.4 min → sun ≈ 1.9° east of Greenwich');
  const june = subsolarPoint(Date.parse('2026-06-21T12:00:00Z'));
  assert.ok(Math.abs(june.lat - 23.44) < 0.05, `June solstice declination, got ${june.lat}`);
  const december = subsolarPoint(Date.parse('2026-12-21T20:50:00Z'));
  assert.ok(Math.abs(december.lat + 23.44) < 0.05, `December solstice declination, got ${december.lat}`);
  assert.ok(Math.abs(december.lon + 132.9) < 0.3, 'at 20:50 UTC the sun is ~133° west');
  const november = subsolarPoint(Date.parse('2026-11-03T12:00:00Z'));
  assert.ok(Math.abs(november.equationOfTimeMin - 16.4) < 0.3, `EoT peaks near +16.4 min in early November, got ${november.equationOfTimeMin}`);
  const midnight = subsolarPoint(Date.parse('2026-09-12T00:00:00Z'));
  assert.ok(Math.abs(Math.abs(midnight.lon) - 180) < 2, 'at 00:00 UTC the sun is near the antimeridian');
  assert.equal(subsolarPoint('nope'), null);
});

test('terminatorRing walks the sub-solar point at 90° and 102° and splits at the dateline', () => {
  const when = Date.parse('2026-03-20T12:00:00Z');
  const sun = subsolarPoint(when);
  const ring = terminatorRing(when);
  assert.ok(ring.length >= 1);
  const points = ring.flat();
  assert.ok(points.length >= 181, `at least samples+1 points plus crossings, got ${points.length}`);
  for (const point of points) {
    const arc = distanceKm(sun, point) / 111.195;
    assert.ok(Math.abs(arc - 90) < 0.05, `every point is 90° from the sun (got ${arc})`);
    assert.ok(point.lon >= -180 && point.lon <= 180);
  }
  const dateline = ring.flat().filter((p) => Math.abs(p.lon) === 180);
  assert.ok(dateline.length >= 2, 'the ring crosses the dateline and is split there');
  for (let i = 0; i < ring.length; i += 1) {
    for (let j = 1; j < ring[i].length; j += 1) {
      assert.ok(Math.abs(ring[i][j].lon - ring[i][j - 1].lon) <= 180, 'no segment jumps across the globe');
    }
  }
  const twilight = terminatorRing(when, 102, 90);
  const twilightArc = distanceKm(sun, twilight.flat()[10]) / 111.195;
  assert.ok(Math.abs(twilightArc - 102) < 0.05);
  assert.ok(twilight.flat().length >= 91);
  assert.deepEqual(terminatorRing('nope'), []);
});

test('receiverModeForSpot maps spot modes and 60 m onto receiver demodulators', () => {
  assert.equal(receiverModeForSpot({ mode: 'SSB', freqHz: 5_357_000 }), 'usb', '60 m is USB-only');
  assert.equal(receiverModeForSpot({ mode: 'SSB', freqHz: 7_100_000 }), 'lsb');
  assert.equal(receiverModeForSpot({ mode: 'SSB', freqHz: 14_200_000 }), 'usb');
  assert.equal(receiverModeForSpot({ mode: 'SSB', freqHz: 3_700_000 }), 'lsb');
  assert.equal(receiverModeForSpot({ mode: 'CW', freqHz: 7_025_000 }), 'cw');
  assert.equal(receiverModeForSpot({ mode: 'FT8', freqHz: 7_074_000 }), 'usb', 'digital below 10 MHz is still USB');
  assert.equal(receiverModeForSpot({ mode: 'RTTY', freqHz: 3_580_000 }), 'usb');
  assert.equal(receiverModeForSpot({ mode: 'PSK', freqHz: 14_070_000 }), 'usb');
  assert.equal(receiverModeForSpot({ mode: 'FM', freqHz: 145_500_000 }), 'nfm');
  assert.equal(receiverModeForSpot({ mode: 'AM', freqHz: 3_885_000 }), 'am');
  assert.equal(receiverModeForSpot({ mode: 'BEACON', freqHz: 14_100_000 }), 'cw');
  assert.equal(receiverModeForSpot({ mode: 'cw', freqHz: 7_025_000 }), 'cw', 'case-insensitive');
  assert.equal(receiverModeForSpot({ mode: null, freqHz: 7_150_000 }), 'lsb', 'unknown mode falls back to the SSB rule');
  assert.equal(receiverModeForSpot({ mode: null, freqHz: 21_300_000 }), 'usb');
  assert.equal(receiverModeForSpot({ mode: 'SSB', hz: 7_100_000 }), 'lsb', '`hz` is accepted too');
  assert.equal(receiverModeForSpot({}), 'usb', 'no information at all → usb');
  assert.equal(receiverModeForSpot(null), 'usb');
});
