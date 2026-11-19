import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FL180_FT,
  UNKNOWN_TOP_FT,
  altitudeBand,
  epochMs,
  normalizeGairmet,
  normalizePireps,
  normalizePolygons,
  normalizeSigmets,
  turbulenceIntensity,
  validateTurbulenceSnapshot,
} from './records.js';
import { GAIRMET_FORE6, PIREPS, SIGMETS } from './awc.fixture.mjs';

// The fixtures were captured at about 20:20Z on 2026-11-17.
const NOW = Date.parse('2026-11-17T20:20:00Z');
const square = (lon = -100, lat = 40, size = 2) => [
  [lon, lat],
  [lon + size, lat],
  [lon + size, lat + size],
  [lon, lat + size],
  [lon, lat],
];
const polygonFeature = (properties, ring = square()) => ({
  type: 'Feature',
  properties,
  geometry: { type: 'Polygon', coordinates: [ring] },
});

test('epochMs reads ISO strings, epoch seconds and epoch ms', () => {
  assert.equal(
    epochMs('2026-11-17T21:00:00.000Z'),
    Date.parse('2026-11-17T21:00:00Z'),
  );
  assert.equal(epochMs(1794945840), 1794945840000);
  assert.equal(epochMs(1794945840000), 1794945840000);
  assert.equal(epochMs('not a time'), null);
  assert.equal(epochMs(null), null);
});

test('turbulenceIntensity reads the upper end of a range and ignores smooth air', () => {
  assert.equal(turbulenceIntensity('LGT'), 'light');
  assert.equal(turbulenceIntensity('LGT-MOD'), 'moderate');
  assert.equal(turbulenceIntensity('MOD-SEV'), 'severe');
  assert.equal(turbulenceIntensity('OCNL SEV'), 'severe');
  assert.equal(turbulenceIntensity('SMTH-LGT'), 'light');
  assert.equal(turbulenceIntensity('EXTRM'), 'extreme');
  assert.equal(turbulenceIntensity('NEG'), null);
  assert.equal(turbulenceIntensity(''), null);
  assert.equal(turbulenceIntensity(undefined), null);
});

test('altitudeBand splits at FL180', () => {
  assert.equal(altitudeBand(0, FL180_FT), 'low');
  assert.equal(altitudeBand(FL180_FT, 34_000), 'high');
  assert.equal(altitudeBand(8_000, 36_000), 'both');
});

test('G-AIRMET: turbulence areas in hundreds of feet, SFC as the surface', () => {
  const records = normalizeGairmet(GAIRMET_FORE6, { now: NOW });
  assert.equal(records.length, 3);
  const [high, higher, low] = records;
  assert.equal(high.kind, 'forecast');
  assert.equal(high.hazard, 'TURB-HI');
  assert.equal(high.severity, 'moderate');
  assert.equal(high.baseFt, 18_000);
  assert.equal(high.topFt, 34_000);
  assert.equal(high.band, 'high');
  assert.equal(high.validAt, Date.parse('2026-11-17T21:00:00Z'));
  assert.equal(high.issuedAt, Date.parse('2026-11-17T17:30:00Z'));
  assert.equal(higher.topFt, 41_000);
  assert.equal(low.hazard, 'TURB-LO');
  assert.equal(low.baseFt, 0);
  assert.equal(low.baseIsSurface, true);
  assert.equal(low.topFt, 18_000);
  assert.equal(low.band, 'low');
  for (const record of records) {
    const outer = record.polygons[0][0];
    assert.deepEqual(outer[0], outer.at(-1), 'rings are closed');
  }
  assert.equal(new Set(records.map((r) => r.id)).size, 3, 'ids are unique');
});

test('G-AIRMET: other Tango hazards and malformed altitudes are skipped', () => {
  const base = {
    hazard: 'TURB-HI',
    validTime: '2026-11-17T21:00:00Z',
    severity: 'MOD',
  };
  const records = normalizeGairmet(
    {
      features: [
        polygonFeature({ ...base, hazard: 'SFC_WND', base: 'SFC', top: '100' }),
        polygonFeature({ ...base, hazard: 'LLWS', base: 'SFC', top: '020' }),
        polygonFeature({ ...base, base: 'FZL', top: '200' }),
        polygonFeature({ ...base, base: '300', top: '200' }),
        polygonFeature({ ...base, base: '240', top: '380' }),
      ],
    },
    { now: NOW },
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].baseFt, 24_000);
});

test('G-AIRMET: a payload that is not a collection is refused, not emptied', () => {
  assert.equal(normalizeGairmet({ error: 'x' }), null);
  assert.deepEqual(normalizeGairmet({ features: [] }), []);
});

test('SIGMET: turbulence and mountain wave only, feet as numbers, worldwide', () => {
  const records = normalizeSigmets(SIGMETS, { now: NOW });
  assert.deepEqual(
    records.map((r) => r.hazard),
    ['TURB', 'TURB', 'TURB', 'MTW'],
    'the volcanic ash SIGMET is not turbulence',
  );
  const guangzhou = records[0];
  assert.equal(guangzhou.kind, 'warning');
  assert.equal(guangzhou.severity, 'severe');
  assert.equal(guangzhou.baseFt, 8_000);
  assert.equal(guangzhou.topFt, 36_000);
  assert.equal(guangzhou.band, 'both');
  assert.equal(guangzhou.region, 'ZGZU GUANGZHOU');
  assert.equal(guangzhou.validFrom, Date.parse('2026-11-17T16:55:00Z'));
  assert.equal(guangzhou.validTo, Date.parse('2026-11-17T20:55:00Z'));
  assert.match(guangzhou.raw, /SEV TURB/);
  assert.ok(!guangzhou.raw.includes('\n'), 'raw text is one line');
  const magadan = records.find((r) => r.region?.includes('MAGADAN'));
  assert.ok(magadan.polygons.length > 1, 'a MultiPolygon keeps every part');
  assert.equal(magadan.baseIsSurface, true);
});

test('SIGMET: expired warnings drop; a missing top is capped and flagged', () => {
  const later = Date.parse('2026-11-17T21:30:00Z');
  assert.deepEqual(
    normalizeSigmets(SIGMETS, { now: later }).map((r) => r.region),
    ['UHMM MAGADAN'],
  );
  const [record] = normalizeSigmets(
    {
      features: [
        polygonFeature({
          hazard: 'TURB',
          qualifier: 'SEV',
          validTimeFrom: '2026-11-17T18:00:00Z',
          validTimeTo: '2026-11-17T22:00:00Z',
          base: null,
          top: null,
          icaoId: 'KKCI',
        }),
      ],
    },
    { now: NOW },
  );
  assert.equal(record.baseFt, 0);
  assert.equal(record.topFt, UNKNOWN_TOP_FT);
  assert.equal(record.topUnknown, true);
});

test('PIREP: intensities, flight levels and the reporting window', () => {
  const records = normalizePireps(PIREPS, { now: NOW });
  assert.deepEqual(
    records.map((r) => r.severity),
    ['light', 'moderate', 'moderate', 'severe', 'severe'],
    'NEG and icing-only reports are dropped',
  );
  const [first] = records;
  assert.equal(first.kind, 'report');
  assert.equal(first.baseFt, 39_000);
  assert.equal(first.topFt, 39_000);
  assert.equal(first.band, 'high');
  assert.equal(first.aircraft, 'B737');
  assert.ok(Number.isFinite(first.lon) && Number.isFinite(first.lat));
  assert.equal(new Set(records.map((r) => r.id)).size, records.length);
  // Three hours later, every report has aged out.
  assert.deepEqual(normalizePireps(PIREPS, { now: NOW + 3 * 3_600_000 }), []);
});

test('polygons: slivers and broken rings drop; long rings are thinned', () => {
  assert.deepEqual(
    normalizePolygons({ type: 'Point', coordinates: [0, 0] }),
    [],
  );
  assert.deepEqual(
    normalizePolygons({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [0.00001, 0],
          [0, 0.00001],
          [0, 0],
        ],
      ],
    }),
    [],
    'a sliver is not an area',
  );
  assert.deepEqual(
    normalizePolygons({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [400, 1],
        ],
      ],
    }),
    [],
  );
  const open = normalizePolygons({
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
      ],
    ],
  });
  assert.equal(open[0][0].length, 5, 'an open ring is closed');
  const circle = Array.from({ length: 1000 }, (_, i) => [
    10 * Math.cos((i / 1000) * 2 * Math.PI),
    10 * Math.sin((i / 1000) * 2 * Math.PI),
  ]);
  const thinned = normalizePolygons({ type: 'Polygon', coordinates: [circle] });
  assert.ok(thinned[0][0].length <= 256);
  assert.deepEqual(thinned[0][0][0], thinned[0][0].at(-1));
});

test('validateTurbulenceSnapshot keeps good records and drops bad ones', () => {
  const forecasts = normalizeGairmet(GAIRMET_FORE6, { now: NOW });
  const snapshot = validateTurbulenceSnapshot({
    schemaVersion: 1,
    fetchedAt: NOW,
    stale: true,
    partial: false,
    forecasts: [...forecasts, { ...forecasts[0], id: 'x', severity: 'awful' }],
    warnings: [{ kind: 'warning', id: 'y' }],
    reports: normalizePireps(PIREPS, { now: NOW }),
  });
  assert.equal(snapshot.forecasts.length, 3);
  assert.equal(snapshot.warnings.length, 0);
  assert.equal(snapshot.reports.length, 5);
  assert.equal(snapshot.stale, true);
  assert.throws(() => validateTurbulenceSnapshot(null), /Malformed/);
  assert.throws(
    () => validateTurbulenceSnapshot({ schemaVersion: 2 }),
    /Unsupported/,
  );
});
