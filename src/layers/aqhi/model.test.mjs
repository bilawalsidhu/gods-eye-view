import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AQHI_BANDS,
  AQHI_UNKNOWN_COLOR,
  OBSERVATION_MAX_AGE_MS,
  aqhiBand,
  aqhiColor,
  aqhiDisplayValue,
  aqhiLabel,
  aqhiRiskText,
  mapAnalystRecord,
  normalizeAqhiObservations,
  normalizeAqhiStations,
  selectAqhiOverlayCohort,
} from './model.js';

const NOW = Date.parse('2026-09-14T18:30:00Z');
const RECENT = '2026-09-14T18:00:00Z';
const collection = (features) => ({ type: 'FeatureCollection', features });
const station = (id, name, zone, lon, lat) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: {
    location_id: id,
    location_name_en: name,
    'eccc-administrative-zone': zone,
    'eccc_administrative-zone': zone,
  },
});
const observation = (id, aqhi, when = RECENT) => ({
  type: 'Feature',
  properties: {
    location_id: id,
    aqhi,
    observation_datetime: when,
    special_notes_en: '',
  },
});

const STATIONS = collection([
  station('IAKID', 'Calgary', 'pnr', -114.0575, 51.0458),
  station('OAAAA', 'Toronto', 'ont', -79.3832, 43.6532),
  station('AAAAA', 'Halifax', 'atl', -63.5752, 44.6488),
]);

// ── published form ─────────────────────────────────────────────────────────

test('display value rounds to the published integer form and floors at 1', () => {
  assert.equal(aqhiDisplayValue(1.08), 1);
  assert.equal(aqhiDisplayValue(2.32), 2);
  assert.equal(aqhiDisplayValue(3.5), 4);
  assert.equal(aqhiDisplayValue('3'), 3);
  // There is no AQHI 0 — a very low reading is published as 1.
  assert.equal(aqhiDisplayValue(0), 1);
});

test('an absent reading never becomes a confident AQHI 1', () => {
  // Number(null) and Number('') are both 0, which would floor to 1. A station
  // that reported nothing must stay reported as nothing.
  for (const empty of [null, undefined, '', '   ', NaN, true, {}, [], -1]) {
    assert.equal(aqhiDisplayValue(empty), null, `${JSON.stringify(empty)}`);
    assert.equal(aqhiLabel(empty), '--');
    assert.equal(aqhiColor(empty), AQHI_UNKNOWN_COLOR);
    assert.equal(aqhiRiskText(empty), null);
  }
});

test('bands follow the published ECCC risk categories', () => {
  const bandOf = (v) => aqhiBand(v).id;
  assert.equal(bandOf(1), 'low');
  assert.equal(bandOf(3), 'low');
  assert.equal(bandOf(4), 'moderate');
  assert.equal(bandOf(6), 'moderate');
  assert.equal(bandOf(7), 'high');
  assert.equal(bandOf(10), 'high');
  assert.equal(bandOf(11), 'very-high');
  assert.equal(aqhiLabel(10), '10');
  assert.equal(aqhiLabel(11), '10+');
});

test('every band has a distinct colour and rises monotonically', () => {
  const colors = AQHI_BANDS.map((b) => b.color);
  assert.equal(new Set(colors).size, colors.length);
  const maxima = AQHI_BANDS.map((b) => b.max);
  assert.deepEqual(
    maxima,
    [...maxima].sort((a, b) => a - b),
  );
});

// ── snapshot validation ────────────────────────────────────────────────────

test('stations normalize into an id-keyed catalog carrying their zone', () => {
  const stations = normalizeAqhiStations(STATIONS);
  assert.equal(stations.size, 3);
  assert.equal(stations.get('IAKID').name, 'Calgary');
  assert.equal(stations.get('OAAAA').zone, 'ont');
});

test('a malformed station payload is rejected atomically', () => {
  assert.equal(normalizeAqhiStations(null), null);
  assert.equal(normalizeAqhiStations({ features: 'nope' }), null);
  assert.equal(normalizeAqhiStations(collection([{ properties: null }])), null);
});

test('readings join to stations nationwide and sort worst-air-first', () => {
  const stations = normalizeAqhiStations(STATIONS);
  const rows = normalizeAqhiObservations(
    collection([
      observation('IAKID', 2),
      observation('OAAAA', 8),
      observation('AAAAA', 5),
    ]),
    stations,
    NOW,
  );
  assert.deepEqual(
    rows.map((r) => r.stationId),
    ['OAAAA', 'AAAAA', 'IAKID'],
  );
  assert.equal(rows[0].risk, 'High health risk');
  assert.deepEqual([...new Set(rows.map((r) => r.zone))].sort(), [
    'atl',
    'ont',
    'pnr',
  ]);
});

test('an observation with no matching station is dropped', () => {
  // The catalog is what supplies coordinates, so a reading without one cannot
  // be placed on the globe.
  const stations = normalizeAqhiStations(STATIONS);
  const rows = normalizeAqhiObservations(
    collection([observation('IAKID', 2), observation('ZZZZZ', 9)]),
    stations,
    NOW,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stationId, 'IAKID');
});

test('a stale reading is dropped rather than shown as current', () => {
  const stations = normalizeAqhiStations(STATIONS);
  const old = new Date(NOW - OBSERVATION_MAX_AGE_MS - 60_000).toISOString();
  const rows = normalizeAqhiObservations(
    collection([observation('IAKID', 3, old), observation('OAAAA', 4, RECENT)]),
    stations,
    NOW,
  );
  assert.deepEqual(
    rows.map((r) => r.stationId),
    ['OAAAA'],
  );
});

test('the newest reading per station wins', () => {
  const stations = normalizeAqhiStations(STATIONS);
  const rows = normalizeAqhiObservations(
    collection([
      observation('IAKID', 3, '2026-09-14T16:00:00Z'),
      observation('IAKID', 7, '2026-09-14T18:00:00Z'),
    ]),
    stations,
    NOW,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].aqhi, 7);
});

test('a station reporting no value produces no reading', () => {
  const stations = normalizeAqhiStations(STATIONS);
  assert.deepEqual(
    normalizeAqhiObservations(
      collection([observation('IAKID', null), observation('OAAAA', '')]),
      stations,
      NOW,
    ),
    [],
  );
});

test('a malformed observation payload is rejected atomically', () => {
  const stations = normalizeAqhiStations(STATIONS);
  assert.equal(normalizeAqhiObservations(null, stations, NOW), null);
  assert.equal(
    normalizeAqhiObservations(
      collection([{ properties: null }]),
      stations,
      NOW,
    ),
    null,
  );
  assert.equal(
    normalizeAqhiObservations(collection([]), 'not a map', NOW),
    null,
  );
});

// ── presentation seams ─────────────────────────────────────────────────────

test('the overlay cohort is capped and deterministic', () => {
  const entries = Array.from({ length: 120 }, (_, i) => ({
    id: `s${i}`,
    priority: i % 11,
  }));
  const cohort = selectAqhiOverlayCohort(entries);
  assert.ok(cohort.length <= 48);
  assert.deepEqual(
    cohort.map((e) => e.id),
    selectAqhiOverlayCohort(entries).map((e) => e.id),
  );
  assert.deepEqual(selectAqhiOverlayCohort(entries, 0), []);
});

test('analyst records are JSON-safe with nulls for anything missing', () => {
  const stations = normalizeAqhiStations(STATIONS);
  const [row] = normalizeAqhiObservations(
    collection([observation('IAKID', 2)]),
    stations,
    NOW,
  );
  const record = mapAnalystRecord(row, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
  assert.equal(record.name, 'Calgary');
  const empty = mapAnalystRecord(undefined, 7);
  assert.equal(empty.id, 'AQHI-0007');
  for (const [key, value] of Object.entries(empty)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
  }
});
