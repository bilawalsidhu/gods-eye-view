import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  AURORA_MIN_PROBABILITY,
  DEFAULT_OVERLAYS,
  VOACAP_FREQUENCIES,
  VOACAP_RAMP,
  VOACAP_RESOLUTIONS,
  antisolarPoint,
  auroraColor,
  auroraPointSize,
  bandConditionRows,
  buildVoacapQuery,
  defaultTxGrid,
  filterAuroraPoints,
  graylineGeometry,
  inferVoacapResolution,
  ionosondeColor,
  ionosondeFreshness,
  ionosondeLabel,
  nightHemisphereWedges,
  normalizeOverlays,
  normalizeTxGrid,
  normalizeVoacapHour,
  normalizeVoacapResolution,
  normalizeVoacapState,
  resolveVoacapFrequency,
  sanitizeIonosondes,
  summaryReadout,
  voacapCells,
  voacapQueryString,
  voacapRampColor,
  voacapStep,
} from './hamPropagationLogic.js';
import { distanceKm, subsolarPoint, terminatorRing } from './hamRadioShared.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../hamrig/fixtures/${name}`, import.meta.url), 'utf8'));

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

test('overlay defaults and partial updates', () => {
  assert.deepEqual({ ...DEFAULT_OVERLAYS }, { grayline: true, aurora: true, ionosondes: true, voacap: false });
  const next = normalizeOverlays(DEFAULT_OVERLAYS, { voacap: true, aurora: 'no', bogus: true });
  assert.deepEqual({ ...next }, { grayline: true, aurora: true, ionosondes: true, voacap: true });
  assert.ok(Object.isFrozen(next));
  assert.deepEqual({ ...normalizeOverlays(null, null) }, { ...DEFAULT_OVERLAYS });
  assert.deepEqual({ ...normalizeOverlays({ grayline: false }, {}) }, { grayline: false, aurora: true, ionosondes: true, voacap: false });
});

// ---------------------------------------------------------------------------
// VOACAP state
// ---------------------------------------------------------------------------

test('VOACAP frequency table covers ten bands and resolves by band or MHz', () => {
  assert.equal(VOACAP_FREQUENCIES.length, 10);
  assert.deepEqual(VOACAP_FREQUENCIES.map((row) => row.mhz), [1.85, 3.6, 5.35, 7.1, 10.1, 14.1, 18.1, 21.1, 24.9, 28.2]);
  assert.deepEqual(VOACAP_FREQUENCIES.map((row) => row.band), ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m']);
  assert.equal(resolveVoacapFrequency('20m').mhz, 14.1);
  assert.equal(resolveVoacapFrequency('20 M').mhz, 14.1);
  assert.equal(resolveVoacapFrequency('40').mhz, 7.1);
  assert.equal(resolveVoacapFrequency(14.25).band, '20m');
  assert.equal(resolveVoacapFrequency('21.3 MHz').band, '15m');
  assert.equal(resolveVoacapFrequency({ band: '10m' }).mhz, 28.2);
  assert.equal(resolveVoacapFrequency({ mhz: 3.5 }).band, '80m');
  assert.equal(resolveVoacapFrequency(144), null);
  assert.equal(resolveVoacapFrequency('2m'), null);
  assert.equal(resolveVoacapFrequency(''), null);
  assert.equal(resolveVoacapFrequency(null), null);
});

test('resolution whitelist, hour wrap, grid normalisation', () => {
  assert.deepEqual([...VOACAP_RESOLUTIONS], [5, 10, 15, 20]);
  assert.equal(normalizeVoacapResolution(15), 15);
  assert.equal(normalizeVoacapResolution('20'), 20);
  assert.equal(normalizeVoacapResolution(0), 10);
  assert.equal(normalizeVoacapResolution(7), 10);
  assert.equal(normalizeVoacapResolution(undefined), 10);
  assert.equal(normalizeVoacapHour(null), null);
  assert.equal(normalizeVoacapHour('now'), null);
  assert.equal(normalizeVoacapHour(23), 23);
  assert.equal(normalizeVoacapHour(24), 0);
  assert.equal(normalizeVoacapHour(-1), 23);
  assert.equal(normalizeVoacapHour('abc'), null);
  assert.equal(normalizeTxGrid('jo32me'), 'JO32');
  assert.equal(normalizeTxGrid('JO32'), 'JO32');
  assert.equal(normalizeTxGrid('JO'), null);
  assert.equal(normalizeTxGrid('ZZ99'), null);
  assert.equal(normalizeTxGrid(''), null);
});

test('defaultTxGrid prefers the home grid and falls back to the view centre', () => {
  assert.equal(defaultTxGrid({ homeGrid: 'JO32me', viewCentre: { lat: 40, lon: -74 } }), 'JO32');
  assert.equal(defaultTxGrid({ homeGrid: 'nope', viewCentre: { lat: 52.187, lon: 7.04 } }), 'JO32');
  assert.equal(defaultTxGrid({ homeGrid: null, viewCentre: { lat: 30.4, lon: -97.7 } }), 'EM10');
  assert.equal(defaultTxGrid({ homeGrid: null, viewCentre: null }), null);
  assert.equal(defaultTxGrid({}), null);
});

test('normalizeVoacapState merges patches and ignores bad fields', () => {
  const base = normalizeVoacapState({}, {});
  assert.deepEqual({ ...base }, { txGrid: null, frequencyMhz: 14.1, hour: null, resolution: 10 });
  const next = normalizeVoacapState(base, { grid: 'jo32', frequencyMhz: 7.1, hour: 6, resolution: 15 });
  assert.deepEqual({ ...next }, { txGrid: 'JO32', frequencyMhz: 7.1, hour: 6, resolution: 15 });
  const kept = normalizeVoacapState(next, { grid: 'bad', frequencyMhz: 500, resolution: 3 });
  assert.deepEqual({ ...kept }, { txGrid: 'JO32', frequencyMhz: 7.1, hour: 6, resolution: 10 });
  const byBand = normalizeVoacapState(next, { band: '10m', hour: null });
  assert.equal(byBand.frequencyMhz, 28.2);
  assert.equal(byBand.hour, null);
  assert.ok(Object.isFrozen(next));
});

test('buildVoacapQuery turns the tx grid into lat/lon and omits hour when unset', () => {
  const query = buildVoacapQuery({ txGrid: 'JO32', frequencyMhz: 14.1, hour: null, resolution: 10 });
  assert.deepEqual(query, { lat: 52.5, lon: 7, frequencyMhz: 14.1, resolution: 10 });
  assert.equal(voacapQueryString(query), 'lat=52.5&lon=7&frequencyMhz=14.1&resolution=10');
  const timed = buildVoacapQuery({ txGrid: 'EM10', frequencyMhz: 28.2, hour: 18, resolution: 5 });
  assert.equal(timed.hour, 18);
  assert.equal(timed.lat, 30.5);
  assert.equal(timed.lon, -97);
  assert.equal(voacapQueryString(timed), 'lat=30.5&lon=-97&frequencyMhz=28.2&hour=18&resolution=5');
  assert.equal(buildVoacapQuery({ txGrid: null }), null);
  assert.equal(buildVoacapQuery({ txGrid: 'XX' }), null);
  assert.equal(voacapQueryString(null), '');
});

// ---------------------------------------------------------------------------
// VOACAP ramp + cells
// ---------------------------------------------------------------------------

test('VOACAP ramp has ten steps and cells drop below 20 % reliability', () => {
  assert.equal(VOACAP_RAMP.length, 10);
  assert.equal(voacapStep(0), 0);
  assert.equal(voacapStep(99.9), 9);
  assert.equal(voacapStep(100), 9);
  assert.equal(voacapStep(55), 5);
  assert.equal(voacapStep('x'), null);
  assert.equal(voacapRampColor(19), null);
  const low = voacapRampColor(20);
  assert.equal(low.step, 2);
  assert.equal(low.css, VOACAP_RAMP[2]);
  assert.ok(low.alpha > 0.2 && low.alpha < 0.25);
  const high = voacapRampColor(100);
  assert.equal(high.step, 9);
  assert.ok(high.alpha > low.alpha);
  assert.ok(high.alpha <= 0.62);
});

test('voacapCells builds resolution-sized rectangles from the fixture', () => {
  const payload = fixture('hamrig-overlay-voacap.json');
  const points = payload.points.map((row) => ({ lat: row.lat, lon: row.lon, reliability: row.value, snr: row.snr }));
  assert.equal(inferVoacapResolution(points), 20);
  const cells = voacapCells(points);
  assert.ok(cells.length > 0);
  assert.ok(cells.length <= points.length);
  assert.ok(cells.every((cell) => cell.reliability >= 20));
  const first = cells.find((cell) => cell.lat === -80 && cell.lon === -180);
  assert.ok(first);
  assert.equal(first.west, -180);
  assert.equal(first.east, -170);
  assert.equal(first.south, -90);
  assert.equal(first.north, -70);
  assert.equal(first.step, 5);
  assert.equal(first.snr, 15);
  const inner = cells.find((cell) => cell.lat === -60 && cell.lon === -160);
  assert.deepEqual([inner.west, inner.east, inner.south, inner.north], [-170, -150, -70, -50]);
  assert.ok(cells.every((cell) => cell.west <= cell.east && cell.south <= cell.north));
});

test('voacapCells honours explicit resolution and drops bad rows', () => {
  const cells = voacapCells([
    { lat: 0, lon: 0, reliability: 50 },
    { lat: 10, lon: 10, reliability: 10 },
    { lat: 'x', lon: 0, reliability: 90 },
  ], { resolution: 5 });
  assert.equal(cells.length, 1);
  assert.deepEqual([cells[0].west, cells[0].east, cells[0].south, cells[0].north], [-2.5, 2.5, -2.5, 2.5]);
  assert.equal(inferVoacapResolution([], 15), 15);
  assert.equal(inferVoacapResolution([{ lat: 0, lon: 0 }, { lat: 0, lon: 7 }]), 10);
});

// ---------------------------------------------------------------------------
// Aurora
// ---------------------------------------------------------------------------

test('aurora colour follows the SWPC scale and alpha grows with probability', () => {
  assert.equal(AURORA_MIN_PROBABILITY, 10);
  assert.equal(auroraColor(5), null);
  assert.equal(auroraColor(10), null);
  const faint = auroraColor(11);
  assert.ok(faint.g > faint.r && faint.g > faint.b, 'faint aurora is green');
  assert.ok(faint.a >= 0.18 && faint.a < 0.25);
  const mid = auroraColor(30);
  assert.ok(mid.r > 0.9 && mid.g > 0.8, 'around 30 % it is yellow');
  const strong = auroraColor(50);
  assert.ok(strong.r > 0.95 && strong.g < 0.2, 'from 50 % it is red');
  const max = auroraColor(100);
  assert.deepEqual([max.r, max.g, max.b], [strong.r, strong.g, strong.b]);
  assert.ok(max.a > strong.a);
  assert.ok(max.a <= 0.9);
  assert.equal(auroraPointSize(10), 4);
  assert.equal(auroraPointSize(50), 9);
  assert.equal(auroraPointSize(90), 9);
});

test('filterAuroraPoints applies the threshold to the fixture and wraps longitude', () => {
  const payload = fixture('hamrig-overlay-aurora.json');
  const all = filterAuroraPoints(payload.points, { minProbability: 0 });
  assert.equal(all.length, payload.points.length);
  const kept = filterAuroraPoints(payload.points);
  assert.ok(kept.length < all.length);
  assert.ok(kept.every((point) => point.value > 10));
  const wrapped = filterAuroraPoints([{ lat: 70, lon: 270, value: 40 }, { lat: 95, lon: 0, value: 40 }, { lat: 70, lon: 0, value: null }]);
  assert.deepEqual(wrapped, [{ lat: 70, lon: -90, value: 40 }]);
  assert.deepEqual(filterAuroraPoints(null), []);
});

// ---------------------------------------------------------------------------
// Ionosondes
// ---------------------------------------------------------------------------

test('ionosonde label, freshness and colour', () => {
  assert.equal(ionosondeLabel({ mufd: 20.84 }), 'MUF(3000) 20.8');
  assert.equal(ionosondeLabel({ mufd: null }), 'MUF(3000) —');
  assert.equal(ionosondeLabel({ mufd: 25, stale: true }), 'MUF(3000) 25.0 · stale');
  const now = Date.parse('2026-09-12T16:00:00Z');
  assert.deepEqual(ionosondeFreshness({ timeIso: '2026-09-12T15:45:00Z' }, now), { ageMin: 15, stale: false });
  assert.deepEqual(ionosondeFreshness({ timeIso: '2026-09-12T14:30:00Z' }, now), { ageMin: 90, stale: true });
  assert.deepEqual(ionosondeFreshness({ ageMin: 7, stale: false }, now), { ageMin: 7, stale: false });
  assert.deepEqual(ionosondeFreshness({ ageMin: 250 }, now), { ageMin: 250, stale: true });
  assert.equal(ionosondeColor({ stale: true, highestBand: '15m' }, () => '#123456'), '#8b95a3');
  assert.equal(ionosondeColor({ stale: false, highestBand: '15m' }, () => '#123456'), '#123456');
  assert.equal(ionosondeColor({ stale: false, highestBand: null }, () => '#123456'), '#38bdf8');
  assert.equal(ionosondeColor(null), '#8b95a3');
});

test('sanitizeIonosondes dedupes by code, wraps longitude and sorts by name', () => {
  const rows = sanitizeIonosondes([
    { code: 'b', name: 'Zulu', lat: 10, lon: 262.3 },
    { code: 'A', name: 'Alpha', lat: 20, lon: 5 },
    { code: 'A', name: 'Alpha 2', lat: 21, lon: 6 },
    { code: '', name: 'nameless', lat: 0, lon: 0 },
    { code: 'C', name: 'Bad', lat: 91, lon: 0 },
  ]);
  assert.deepEqual(rows.map((row) => row.code), ['A', 'B']);
  assert.equal(rows[0].name, 'Alpha 2');
  assert.ok(Math.abs(rows[1].lon - -97.7) < 1e-9);
});

// ---------------------------------------------------------------------------
// Grayline geometry
// ---------------------------------------------------------------------------

test('antisolar point is the antipode of the subsolar point', () => {
  const when = Date.parse('2026-06-21T12:00:00Z');
  const sun = subsolarPoint(when);
  const anti = antisolarPoint(when);
  assert.ok(Math.abs(anti.lat + sun.lat) < 1e-9);
  assert.ok(Math.abs(distanceKm(sun, anti) - 20015) < 20);
});

test('night hemisphere wedges fan out from the antisolar point along the 90° ring', () => {
  const when = Date.parse('2026-03-20T12:00:00Z');
  const wedges = nightHemisphereWedges(when, { wedges: 12, samplesPerWedge: 6 });
  const centre = antisolarPoint(when);
  assert.equal(wedges.length, 12);
  for (const ring of wedges) {
    assert.equal(ring.length, 8, 'centre + 7 arc samples');
    assert.deepEqual(ring[0], centre);
    for (const point of ring.slice(1)) {
      assert.ok(Math.abs(distanceKm(centre, point) - 90 * 111.19492664455873) < 1, 'arc points sit on the terminator');
      assert.ok(Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180);
    }
  }
  // consecutive wedges share their boundary sample
  const lastOfFirst = wedges[0][wedges[0].length - 1];
  const firstOfSecond = wedges[1][1];
  assert.ok(Math.abs(lastOfFirst.lat - firstOfSecond.lat) < 1e-9 && Math.abs(lastOfFirst.lon - firstOfSecond.lon) < 1e-9);
  assert.equal(nightHemisphereWedges('nope').length, 0);
  assert.equal(nightHemisphereWedges(when, { wedges: 1 }).length, 4, 'wedge count is clamped to a sane minimum');
});

test('graylineGeometry bundles sun, rings and night wedges', () => {
  const when = Date.parse('2026-12-21T00:00:00Z');
  const geometry = graylineGeometry(when, { terminatorRingFn: terminatorRing });
  assert.equal(geometry.computedAt, '2026-12-21T00:00:00.000Z');
  assert.ok(geometry.sun.lat < -23 && geometry.sun.lat > -23.6, 'December solstice subsolar latitude');
  assert.ok(Array.isArray(geometry.terminator) && geometry.terminator.length >= 1);
  assert.ok(Array.isArray(geometry.twilight) && geometry.twilight.length >= 1);
  assert.equal(geometry.night.length, 12);
  assert.equal(graylineGeometry(Number.NaN), null);
  const bare = graylineGeometry(when);
  assert.deepEqual(bare.terminator, []);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

test('summary readout and band condition rows', () => {
  const summary = {
    solar: { sfi: 110, kIndex: 2, aIndex: 8, ssn: 43.7, xrayClass: 'C1.2' },
    bands: { '6m': 'poor', '20m': 'good', '160m': 'poor', '4m': 'fair' },
  };
  assert.equal(summaryReadout(summary), 'SFI 110 · K 2 · A 8 · SSN 44 · X-ray C1.2');
  assert.equal(summaryReadout({ solar: {} }), '');
  assert.equal(summaryReadout(null), '');
  assert.deepEqual(bandConditionRows(summary), [
    { band: '160m', condition: 'poor' },
    { band: '20m', condition: 'good' },
    { band: '6m', condition: 'poor' },
    { band: '4m', condition: 'fair' },
  ]);
  assert.deepEqual(bandConditionRows({}), []);
});
