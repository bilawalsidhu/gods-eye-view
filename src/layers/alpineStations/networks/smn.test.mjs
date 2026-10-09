import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SMN_OBSERVATION_COLUMNS,
  SMN_REJECTED_PRESSURE_COLUMNS,
  SMN_WIND_COLUMNS,
  joinSmnStations,
  normalizeSmnObservation,
  normalizeSmnStations,
  parseSmnTimestamp,
  readSemicolonCsv,
} from './smn.js';
import { SMN_NETWORK_ID, alpineNetwork } from '../networks.js';
import { alpineStationRecord } from '../records.js';
import {
  SMN_METADATA_CSV,
  SMN_OBSERVATIONS_CSV,
} from '../../../testSupport/alpineStationFixtures.mjs';

const byCode = (rows) => Object.fromEntries(rows.map((row) => [row.code, row]));

test('the CSV reader keys by header and treats a dash as absent', () => {
  const rows = readSemicolonCsv(SMN_OBSERVATIONS_CSV);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]['Station/Location'], 'ZER');
  assert.equal(rows[0].pp0qffs0, '-', 'the fixture must carry an absent cell');
  assert.deepEqual(readSemicolonCsv(''), []);
  assert.deepEqual(readSemicolonCsv('header-only'), []);
  assert.deepEqual(readSemicolonCsv(null), []);
  assert.equal(readSemicolonCsv('a;b\r\n1;2\r\n')[0].b, '2', 'CRLF is tolerated');
});

test('the YYYYMMDDHHMM stamp is read as UTC, not local time', () => {
  // Both halves are traps: `new Date` cannot read the layout, and a local
  // reading is one or two hours out in Switzerland, which is enough to make a
  // current reading look stale.
  assert.equal(parseSmnTimestamp('202610082310'), '2026-10-08T23:10:00.000Z');
  assert.equal(new Date(parseSmnTimestamp('202601011200')).getUTCHours(), 12);
  assert.equal(parseSmnTimestamp('20261008231'), null);
  assert.equal(parseSmnTimestamp('2026100823100'), null);
  assert.equal(parseSmnTimestamp(''), null);
  assert.equal(parseSmnTimestamp(null), null);
  assert.equal(parseSmnTimestamp('nonsense1234'), null);
  assert.equal(parseSmnTimestamp('202602310000'), null, 'February 31 is rejected');
  assert.equal(parseSmnTimestamp('202613010000'), null, 'month 13 is rejected');
});

test('metadata supplies the identity, canton, altitude and position', () => {
  // Every one of these comes from the metadata CSV, which is why the adapter
  // needs no STAC walk at all.
  const stations = normalizeSmnStations(SMN_METADATA_CSV);
  assert.equal(stations.size, 3);
  const zermatt = stations.get('ZER');
  assert.equal(zermatt.networkId, SMN_NETWORK_ID);
  assert.equal(zermatt.label, 'Zermatt');
  assert.equal(zermatt.region, 'VS');
  assert.equal(zermatt.country, 'CH');
  assert.equal(zermatt.elevationM, 1638);
  assert.equal(zermatt.lat, 46.029272);
  assert.equal(zermatt.lon, 7.752433);
});

test('the metadata file is ISO-8859-1, and its accents survive the parse', () => {
  // `Response.text()` assumes UTF-8 and mangles this name, so the proxy reads
  // the bytes and decodes them explicitly before this adapter sees them.
  assert.equal(normalizeSmnStations(SMN_METADATA_CSV).get('AEG').label, 'Oberägeri');
});

test('a station with no usable position is dropped from metadata', () => {
  const noPosition = SMN_METADATA_CSV.replace('46.029272;7.752433', ';');
  const stations = normalizeSmnStations(noPosition);
  assert.ok(!stations.has('ZER'));
  assert.equal(stations.size, 2, 'the other two are unaffected');
});

test('wind is published in km/h and stored in m/s', () => {
  // `fu3010z0` is km/h while `fkl010z0` is m/s, and both exist for the same
  // quantity. Passing the fu3 columns through would overstate every wind by
  // a factor of 3.6.
  assert.deepEqual(Object.keys(SMN_WIND_COLUMNS), ['fu3010z0', 'fu3010z1']);
  const reading = normalizeSmnObservation({
    'Station/Location': 'X',
    Date: '202610082310',
    fu3010z0: '36.0',
    fu3010z1: '72.0',
  });
  assert.equal(reading.windSpeedMs, 10);
  assert.equal(reading.windGustMs, 20);
});

test('pressure is QFF only; QFE and QNH are never substituted', () => {
  // QFE is a map of altitude (663-991 hPa measured across the network on a day
  // whose real spread was under 3 hPa) and QNH carries a standard-atmosphere
  // altitude bias. Zermatt in the fixture publishes QNH but NOT QFF.
  assert.equal(SMN_OBSERVATION_COLUMNS.pp0qffs0, 'pressureQffHpa');
  for (const column of SMN_REJECTED_PRESSURE_COLUMNS)
    assert.ok(
      !Object.hasOwn(SMN_OBSERVATION_COLUMNS, column),
      `${column} must not be read`,
    );
  const joined = byCode(joinSmnStations(SMN_METADATA_CSV, SMN_OBSERVATIONS_CSV));
  const row = readSemicolonCsv(SMN_OBSERVATIONS_CSV).find(
    (entry) => entry['Station/Location'] === 'ZER',
  );
  assert.equal(row.pp0qffs0, '-');
  assert.ok(Number(row.prestas0) > 0, 'QFE is present in the payload');
  assert.ok(Number(row.pp0qnhs0) > 0, 'QNH is present in the payload');
  assert.equal(joined.ZER.pressureQffHpa, null, 'and neither is borrowed');
});

test('SwissMetNet publishes no snow depth through this route', () => {
  // VQHA80 has no `htoauts0` column. The registry entry says so, and Swiss
  // snow depth comes from SLF IMIS instead.
  assert.ok(!alpineNetwork(SMN_NETWORK_ID).parameters.includes('snow'));
  for (const station of joinSmnStations(SMN_METADATA_CSV, SMN_OBSERVATIONS_CSV))
    assert.equal(station.snowDepthCm, null, station.code);
});

test('a measured zero is kept and an absent cell stays null', () => {
  const joined = byCode(joinSmnStations(SMN_METADATA_CSV, SMN_OBSERVATIONS_CSV));
  assert.equal(joined.ZER.precipMm, 0, '0 mm of rain is a real reading');
  assert.equal(joined.ZER.airTempC, 5);
  assert.equal(joined.ZER.humidityPct, 90.9);
  assert.equal(joined.ZER.windDirDeg, 229);
});

test('the join drops a reading with no station, and keeps a station with no reading', () => {
  // Only metadata carries a position, so a reading for an unknown station has
  // nowhere on the globe to go. Measured live, the two files disagreed by
  // exactly one station in each direction out of 159.
  const extra = `${SMN_OBSERVATIONS_CSV.trimEnd()}\nMRP;202610082310;1.00;-;-;-;-;-;-;-;-;-;-;-;-;-;-;-;-;-;-\n`;
  const joined = joinSmnStations(SMN_METADATA_CSV, extra);
  assert.equal(joined.length, 3, 'the orphan reading is not drawn');
  assert.ok(!joined.some((station) => station.code === 'MRP'));
  const noObservations = byCode(joinSmnStations(SMN_METADATA_CSV, 'Station/Location;Date\n'));
  assert.equal(noObservations.ZER.measuredAt, null);
  assert.equal(noObservations.ZER.label, 'Zermatt', 'identity survives silence');
});

test('every joined station survives canonical validation', () => {
  const joined = joinSmnStations(SMN_METADATA_CSV, SMN_OBSERVATIONS_CSV);
  assert.equal(joined.length, 3);
  for (const station of joined)
    assert.ok(alpineStationRecord(station), station.code);
});
