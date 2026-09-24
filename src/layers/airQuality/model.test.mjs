import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIR_QUALITY_BANDS,
  AIR_QUALITY_PROVIDERS,
  AIR_QUALITY_UNKNOWN_COLOR,
  OBSERVATION_MAX_AGE_MS,
  airQualityColor,
  aqhiDisplayValue,
  bandForValue,
  bandRiskText,
  mapAnalystRecord,
  normalizeAqhiObservations,
  normalizeAqhiStations,
  readingsInView,
  selectAirQualityOverlayCohort,
  valueLabel,
} from './model.js';

const NOW = Date.parse('2026-09-24T18:30:00Z');
const RECENT = '2026-09-24T18:00:00Z';
const collection = (features) => ({ type: 'FeatureCollection', features });
const station = (id, name, zone, lon, lat) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: {
    location_id: id,
    location_name_en: name,
    'eccc_administrative-zone': zone,
  },
});
const observation = (id, aqhi, when = RECENT) => ({
  type: 'Feature',
  properties: { location_id: id, aqhi, observation_datetime: when },
});

const STATIONS = collection([
  station('IAKID', 'Calgary', 'pnr', -114.0575, 51.0458),
  station('OAAAA', 'Toronto', 'ont', -79.3832, 43.6532),
  station('AAAAA', 'Halifax', 'atl', -63.5752, 44.6488),
]);

// ── provider-shaped records ────────────────────────────────────────────────

test('readings carry the provider-neutral {provider, scale, value, band} shape', () => {
  // Indices are not interchangeable numbers: AQHI is 1-10+ on health risk,
  // US AQI is 0-500 on concentration. The shape names which index a value is on
  // so a second network can be added without inventing a shared meaning.
  const stations = normalizeAqhiStations(STATIONS);
  const [row] = normalizeAqhiObservations(
    collection([observation('IAKID', 2.32)]),
    stations,
    NOW,
  );
  assert.equal(row.provider, 'eccc');
  assert.equal(row.scale, 'AQHI');
  assert.equal(row.value, 2);
  assert.equal(row.band, 'low');
});

test('bands map from a value on a named provider scale', () => {
  assert.equal(bandForValue('eccc', 1), 'low');
  assert.equal(bandForValue('eccc', 3), 'low');
  assert.equal(bandForValue('eccc', 4), 'moderate');
  assert.equal(bandForValue('eccc', 7), 'high');
  assert.equal(bandForValue('eccc', 11), 'very-high');
  // An unregistered provider cannot be banded rather than being guessed at.
  assert.equal(bandForValue('unknown-network', 5), null);
  assert.equal(bandForValue('eccc', null), null);
});

test('the provider states its coverage plainly', () => {
  assert.match(AIR_QUALITY_PROVIDERS.eccc.coverage, /Canada only/);
  assert.equal(AIR_QUALITY_PROVIDERS.eccc.scale, 'AQHI');
});

test("values above ten collapse to the scale's open-ended label", () => {
  assert.equal(valueLabel('eccc', 10), '10');
  assert.equal(valueLabel('eccc', 11), '10+');
  assert.equal(valueLabel('eccc', null), '--');
});

test('every band has a distinct colour, and an unknown band is neutral', () => {
  const colors = AIR_QUALITY_BANDS.map((b) => b.color);
  assert.equal(new Set(colors).size, colors.length);
  assert.equal(airQualityColor('nonsense'), AIR_QUALITY_UNKNOWN_COLOR);
  assert.equal(bandRiskText('high'), 'High health risk');
  assert.equal(bandRiskText(null), null);
});

// ── published form ─────────────────────────────────────────────────────────

test('AQHI rounds to the published integer form and floors at 1', () => {
  assert.equal(aqhiDisplayValue(1.08), 1);
  assert.equal(aqhiDisplayValue(3.5), 4);
  assert.equal(aqhiDisplayValue(0), 1);
  assert.equal(aqhiDisplayValue('3'), 3);
});

test('an absent reading never becomes a confident AQHI 1', () => {
  // Number(null) and Number('') are both 0, which would floor to 1.
  for (const empty of [null, undefined, '', '   ', NaN, true, {}, [], -1]) {
    assert.equal(aqhiDisplayValue(empty), null, `${JSON.stringify(empty)}`);
  }
});

// ── snapshot validation ────────────────────────────────────────────────────

test('stations normalize into an id-keyed catalog carrying their zone', () => {
  const stations = normalizeAqhiStations(STATIONS);
  assert.equal(stations.size, 3);
  assert.equal(stations.get('OAAAA').zone, 'ont');
});

test('malformed payloads are rejected atomically', () => {
  assert.equal(normalizeAqhiStations(null), null);
  assert.equal(normalizeAqhiStations(collection([{ properties: null }])), null);
  const stations = normalizeAqhiStations(STATIONS);
  assert.equal(normalizeAqhiObservations(null, stations, NOW), null);
  assert.equal(
    normalizeAqhiObservations(collection([]), 'not a map', NOW),
    null,
  );
});

test('an observation with no matching station is dropped', () => {
  const stations = normalizeAqhiStations(STATIONS);
  const rows = normalizeAqhiObservations(
    collection([observation('IAKID', 2), observation('ZZZZZ', 9)]),
    stations,
    NOW,
  );
  assert.equal(rows.length, 1);
});

test('a stale reading is dropped rather than shown as current', () => {
  const stations = normalizeAqhiStations(STATIONS);
  const old = new Date(NOW - OBSERVATION_MAX_AGE_MS - 60_000).toISOString();
  const rows = normalizeAqhiObservations(
    collection([observation('IAKID', 3, old), observation('OAAAA', 4)]),
    stations,
    NOW,
  );
  assert.deepEqual(
    rows.map((r) => r.stationId),
    ['OAAAA'],
  );
});

test('the newest reading per station wins and worst air sorts first', () => {
  const stations = normalizeAqhiStations(STATIONS);
  const rows = normalizeAqhiObservations(
    collection([
      observation('IAKID', 3, '2026-09-24T16:00:00Z'),
      observation('IAKID', 7, '2026-09-24T18:00:00Z'),
      observation('OAAAA', 5),
    ]),
    stations,
    NOW,
  );
  assert.deepEqual(
    rows.map((r) => r.value),
    [7, 5],
  );
});

// ── readout selection ──────────────────────────────────────────────────────

const reading = (id, value, lat, lon) => ({
  id,
  stationId: id,
  value,
  lat,
  lon,
  name: id,
});

test('the readout lists the worst readings inside the view rectangle', () => {
  const rows = [
    reading('west', 9, 51.0, -114.0),
    reading('east', 4, 43.6, -79.3),
    reading('mild', 2, 51.1, -114.1),
  ];
  const inView = readingsInView(
    rows,
    { west: -115, south: 50, east: -113, north: 52 },
    5,
  );
  assert.deepEqual(
    inView.map((r) => r.id),
    ['west', 'mild'],
  );
});

test('an unresolvable view rectangle degrades to the worst overall, not to blank', () => {
  // A space-level or fully oblique camera cannot produce a rectangle; the card
  // should still say something useful.
  const rows = [reading('a', 3, 0, 0), reading('b', 8, 10, 10)];
  assert.deepEqual(
    readingsInView(rows, null, 5).map((r) => r.id),
    ['b', 'a'],
  );
  assert.deepEqual(readingsInView(rows, null, 0), []);
  assert.deepEqual(readingsInView(null, null, 5), []);
});

test('a view rectangle crossing the antimeridian still selects correctly', () => {
  // west > east is how a dateline-crossing rectangle is expressed.
  const rows = [reading('near', 5, 0, 179), reading('far', 9, 0, 100)];
  const inView = readingsInView(
    rows,
    { west: 170, south: -10, east: -170, north: 10 },
    5,
  );
  assert.deepEqual(
    inView.map((r) => r.id),
    ['near'],
  );
});

test('the overlay cohort is capped and deterministic', () => {
  const entries = Array.from({ length: 120 }, (_, i) => ({
    id: `s${i}`,
    priority: i % 11,
  }));
  const cohort = selectAirQualityOverlayCohort(entries);
  assert.ok(cohort.length <= 48);
  assert.deepEqual(
    cohort.map((e) => e.id),
    selectAirQualityOverlayCohort(entries).map((e) => e.id),
  );
});

test('analyst records are JSON-safe and name the provider and scale', () => {
  const stations = normalizeAqhiStations(STATIONS);
  const [row] = normalizeAqhiObservations(
    collection([observation('IAKID', 2)]),
    stations,
    NOW,
  );
  const record = mapAnalystRecord(row, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
  assert.equal(record.provider, 'eccc');
  assert.equal(record.scale, 'AQHI');
  const empty = mapAnalystRecord(undefined, 7);
  assert.equal(empty.id, 'AIR-0007');
  for (const [key, value] of Object.entries(empty)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
  }
});
