import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SLF_STATION_TYPE_LABELS,
  joinSlfStations,
  latestSlfMeasurements,
  normalizeSlfMeasurement,
  normalizeSlfStation,
} from './slf.js';
import { SLF_NETWORK_ID } from '../networks.js';
import { alpineStationRecord } from '../records.js';
import {
  SLF_MEASUREMENTS,
  SLF_STATIONS,
} from '../../../testSupport/alpineStationFixtures.mjs';

const byCode = (rows) =>
  Object.fromEntries(rows.map((row) => [row.code, row]));

test('a station carries its published identity, canton and altitude', () => {
  const station = normalizeSlfStation(SLF_STATIONS[0]);
  assert.equal(station.networkId, SLF_NETWORK_ID);
  assert.equal(station.code, 'DAV2');
  assert.equal(station.label, 'Bärentälli');
  assert.equal(station.region, 'GR');
  assert.equal(station.country, 'CH');
  assert.equal(station.elevationM, 2558);
  assert.ok(station.lat > 46 && station.lat < 47);
  assert.ok(station.lon > 9 && station.lon < 10);
  assert.equal(station.stationTypeLabel, SLF_STATION_TYPE_LABELS.SNOW_FLAT);
});

test('a station type the network adds later keeps its station', () => {
  // The position and the readings are what the layer draws; an unmodelled
  // label is not a reason to lose a box from the map.
  const station = normalizeSlfStation({
    ...SLF_STATIONS[0],
    type: 'SOMETHING_NEW',
  });
  assert.equal(station.stationType, 'SOMETHING_NEW');
  assert.equal(station.stationTypeLabel, null);
  assert.equal(normalizeSlfStation({ ...SLF_STATIONS[0], type: null }).stationTypeLabel, null);
  assert.equal(normalizeSlfStation({}), null, 'no code means no station');
});

test('measurement codes map to the canonical fields and units', () => {
  // Taken from the published OpenAPI schema, not guessed: HS is centimetres,
  // the TA/TSS means are degrees Celsius and the VW means are metres/second.
  const row = normalizeSlfMeasurement(SLF_MEASUREMENTS.at(-1));
  assert.equal(row.code, 'VSC1');
  assert.match(row.measuredAt, /^2026-10-08T\d\d:\d\d:00\.000Z$/);
  for (const field of [
    'snowDepthCm',
    'airTempC',
    'humidityPct',
    'windSpeedMs',
    'windGustMs',
    'windDirDeg',
  ])
    assert.ok(Object.hasOwn(row, field), field);
  assert.equal(normalizeSlfMeasurement({}), null);
  assert.equal(normalizeSlfMeasurement(null), null);
});

test('the rolling window reduces to the newest row per station', () => {
  // The endpoint returns a window for the whole network in one response, so
  // this is the join's hot path; DAV2 appears twice in the fixture.
  const dav2 = SLF_MEASUREMENTS.filter((row) => row.station_code === 'DAV2');
  assert.equal(dav2.length, 2, 'the fixture must exercise the reduction');
  const latest = latestSlfMeasurements(SLF_MEASUREMENTS);
  assert.equal(latest.size, 2);
  assert.equal(
    latest.get('DAV2').measuredAt,
    new Date(
      Math.max(...dav2.map((row) => Date.parse(row.measure_date))),
    ).toISOString(),
  );
});

test('a row with an unusable date loses to one that parses', () => {
  const latest = latestSlfMeasurements([
    { station_code: 'A', measure_date: 'rubbish', HS: 1 },
    { station_code: 'A', measure_date: '2026-10-08T23:00:00Z', HS: 2 },
    { station_code: 'A', measure_date: 'rubbish', HS: 3 },
  ]);
  assert.equal(latest.get('A').snowDepthCm, 2);
  assert.deepEqual([...latestSlfMeasurements(null).keys()], []);
});

test('the join keeps a station the measurement feed never mentions', () => {
  // A high-Alpine network always has boxes that are down, and the map should
  // show the network as it is rather than hiding them.
  const joined = byCode(joinSlfStations(SLF_STATIONS, SLF_MEASUREMENTS));
  assert.deepEqual(Object.keys(joined).sort(), ['DAV2', 'MUT2', 'VSC1']);
  assert.equal(joined.MUT2.measuredAt, null);
  assert.equal(joined.MUT2.snowDepthCm, null);
  assert.ok(joined.DAV2.measuredAt);
});

test('IMIS reports neither precipitation nor pressure, and says so explicitly', () => {
  // Null rather than absent keys, so the canonical record never carries a
  // reading it did not receive.
  for (const station of joinSlfStations(SLF_STATIONS, SLF_MEASUREMENTS)) {
    assert.equal(station.precipMm, null, station.code);
    assert.equal(station.pressureQffHpa, null, station.code);
  }
});

test('every joined station survives canonical validation', () => {
  // The adapter's output IS the proxy's output, so a shape mismatch here would
  // only surface as a silently shorter station list in the browser.
  const joined = joinSlfStations(SLF_STATIONS, SLF_MEASUREMENTS);
  assert.equal(joined.length, 3);
  for (const station of joined) {
    const record = alpineStationRecord(station);
    assert.ok(record, station.code);
    assert.equal(record.networkId, SLF_NETWORK_ID);
    assert.equal(record.id, `${SLF_NETWORK_ID}:${station.code}`);
  }
});

test('junk input produces an empty list rather than an exception', () => {
  assert.deepEqual(joinSlfStations(null, null), []);
  assert.deepEqual(joinSlfStations([null, {}, 'x'], 'nope'), []);
});
