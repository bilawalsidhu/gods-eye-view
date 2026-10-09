import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TAWES_PARAMETERS,
  TAWES_PARAMETER_QUERY,
  joinTawesStationRecords,
  joinTawesStations,
  normalizeTawesStations,
  tawesReadingIndex,
  tawesReadings,
  tawesStationIds,
  titleCase,
} from './tawes.js';
import { TAWES_NETWORK_ID, alpineNetwork } from '../networks.js';
import { alpineStationRecord } from '../records.js';
import {
  TAWES_METADATA,
  TAWES_OBSERVATIONS,
} from '../../../testSupport/alpineStationFixtures.mjs';

const byCode = (rows) => Object.fromEntries(rows.map((row) => [row.code, row]));
const reporting = TAWES_OBSERVATIONS.features.filter((feature) =>
  Object.values(feature.properties.parameters).some((parameter) =>
    parameter.data.some((value) => value !== null),
  ),
);

test('only active stations are requested, and the ids are shaped safely', () => {
  // The metadata list retains decommissioned boxes; asking for them costs
  // query length for columns that are always null.
  const ids = tawesStationIds(TAWES_METADATA);
  const inactive = TAWES_METADATA.stations.filter(
    (station) => station.is_active === false,
  );
  assert.ok(inactive.length, 'the fixture must carry a decommissioned station');
  for (const station of inactive) assert.ok(!ids.includes(station.id));
  for (const id of ids) assert.match(id, /^[0-9A-Za-z-]{1,16}$/);
  assert.deepEqual(tawesStationIds(null), []);
  assert.deepEqual(tawesStationIds({ stations: 'nope' }), []);
});

test('the parameter query is fixed by the column table', () => {
  assert.equal(TAWES_PARAMETER_QUERY, Object.keys(TAWES_PARAMETERS).join(','));
  assert.match(TAWES_PARAMETER_QUERY, /^[A-Z,]+$/);
  assert.equal(new Set(Object.values(TAWES_PARAMETERS)).size, Object.keys(TAWES_PARAMETERS).length);
});

test('GeoSphere reduces pressure to a local datum, so neither column is read', () => {
  // Wien/Hohe Warte at 198 m reads P 991.7 against PRED 1016.4, but Sonnblick
  // at 3109 m reads P 696.7 against PRED 707.7 — an 11 hPa correction over
  // three kilometres. Nothing in the payload says which regime applies, so
  // including it would draw a map of Austrian altitude.
  assert.ok(!Object.hasOwn(TAWES_PARAMETERS, 'P'));
  assert.ok(!Object.hasOwn(TAWES_PARAMETERS, 'PRED'));
  assert.ok(!Object.values(TAWES_PARAMETERS).includes('pressureQffHpa'));
  assert.ok(!alpineNetwork(TAWES_NETWORK_ID).parameters.includes('pressure'));
  for (const station of joinTawesStations(TAWES_METADATA, TAWES_OBSERVATIONS))
    assert.equal(station.pressureQffHpa, null, station.code);
});

test('readings are found at each station OWN timestamp slot, not at index 0', () => {
  // This is the trap in this feed. `timestamps` is the UNION of observation
  // times across every station requested, and each station carries a value at
  // only one index. Measured live, 275 of 285 stations sat at the last index
  // and `data[0]` was non-null for exactly one of them.
  const slots = TAWES_OBSERVATIONS.timestamps.length;
  assert.ok(slots >= 3, 'the fixture must span several timestamps');
  const found = new Map(
    TAWES_OBSERVATIONS.features.map((feature) => [
      feature.properties.station,
      tawesReadingIndex(feature.properties.parameters, slots),
    ]),
  );
  const indices = [...found.values()].filter((index) => index >= 0).sort();
  assert.ok(indices.length >= 2, 'at least two stations report');
  assert.notEqual(indices[0], indices.at(-1), 'and they report at DIFFERENT slots');
  assert.ok(indices.includes(0), 'one of them reports at the oldest slot');
  const readings = tawesReadings(TAWES_OBSERVATIONS);
  for (const [code, index] of found) {
    if (index < 0) continue;
    assert.equal(
      readings.get(code).measuredAt,
      new Date(TAWES_OBSERVATIONS.timestamps[index]).toISOString(),
      code,
    );
  }
});

test('a station that reports nothing has no index and no time', () => {
  assert.equal(tawesReadingIndex({}, 3), -1);
  assert.equal(tawesReadingIndex({ TL: { data: [null, null, null] } }, 3), -1);
  assert.equal(tawesReadingIndex(null, 3), -1);
  const silent = TAWES_OBSERVATIONS.features.find(
    (feature) => !reporting.includes(feature),
  );
  assert.ok(silent, 'the fixture must carry a silent station');
  const reading = tawesReadings(TAWES_OBSERVATIONS).get(
    silent.properties.station,
  );
  assert.equal(reading.measuredAt, null);
  for (const field of Object.values(TAWES_PARAMETERS))
    assert.equal(reading[field], null, field);
});

test('the index never exceeds the timestamps the response declared', () => {
  // A `data` array longer than `timestamps` would otherwise index past it and
  // produce a reading stamped `undefined`.
  const index = tawesReadingIndex({ TL: { data: [1, 2, 3, 4, 5] } }, 2);
  assert.ok(index < 2);
  assert.equal(index, 1);
});

test('shouted station names are cased for display, keeping their separators', () => {
  // Every name is published in upper case; shouting them would be the loudest
  // thing on the map.
  assert.equal(titleCase('ACHENKIRCH CAMPINGPLATZ'), 'Achenkirch Campingplatz');
  assert.equal(titleCase('BRUNNENKOGEL / OETZTALER ALPEN'), 'Brunnenkogel / Oetztaler Alpen');
  assert.equal(titleCase('RUDOLFSHUETTE-ALPINZENTRUM'), 'Rudolfshuette-Alpinzentrum');
  assert.equal(titleCase('SONNBLICK - AUTOM.'), 'Sonnblick - Autom.');
  assert.equal(titleCase('WIEN/HOHE WARTE'), 'Wien/Hohe Warte');
  assert.equal(titleCase(''), null);
  assert.equal(titleCase(null), null);
});

test('metadata supplies identity, state and altitude', () => {
  const stations = normalizeTawesStations(TAWES_METADATA);
  const active = TAWES_METADATA.stations.filter(
    (station) => station.is_active !== false,
  );
  assert.equal(stations.size, active.length);
  for (const station of stations.values()) {
    assert.equal(station.networkId, TAWES_NETWORK_ID);
    assert.equal(station.country, 'AT');
    assert.ok(station.region, station.code);
    assert.ok(Number.isFinite(station.elevationM), station.code);
    assert.notEqual(station.label, station.label.toUpperCase());
  }
});

test('a reading with no metadata entry keeps the position its feature carries', () => {
  // Metadata is the authority, but a station missing from it must not lose its
  // coordinates and vanish.
  const orphan = TAWES_OBSERVATIONS.features.find(
    (feature) => !TAWES_METADATA.stations.some((s) => s.id === feature.properties.station),
  );
  assert.ok(orphan, 'the fixture must carry a station absent from metadata');
  const joined = byCode(joinTawesStations(TAWES_METADATA, TAWES_OBSERVATIONS));
  const record = joined[orphan.properties.station];
  assert.ok(record);
  assert.equal(record.lon, orphan.geometry.coordinates[0]);
  assert.equal(record.lat, orphan.geometry.coordinates[1]);
  assert.equal(record.elevationM, null, 'with no altitude, which metadata owns');
});

test('a measured zero survives the join', () => {
  const joined = joinTawesStations(TAWES_METADATA, TAWES_OBSERVATIONS);
  const zeroed = joined.filter((station) => station.snowDepthCm === 0);
  assert.ok(zeroed.length, '0 cm in October is a real reading, not an absence');
});

test('chunked responses merge without a silent copy overwriting a reading', () => {
  // The observation call is chunked by station id and every chunk is joined
  // against the same full metadata, so a station answering in chunk one must
  // not be blanked by its own absence from chunk two.
  const first = tawesReadings(TAWES_OBSERVATIONS);
  const empty = tawesReadings({ timestamps: [], features: [] });
  const merged = new Map([...empty, ...first]);
  const joined = byCode(joinTawesStationRecords(TAWES_METADATA, merged));
  const live = reporting[0].properties.station;
  assert.ok(joined[live].measuredAt, 'the reading survived the merge');
  const alone = byCode(joinTawesStationRecords(TAWES_METADATA, empty));
  assert.equal(
    Object.keys(alone).length,
    TAWES_METADATA.stations.filter((s) => s.is_active !== false).length,
    'with no readings at all, every active station is still drawn, silent',
  );
});

test('every joined station survives canonical validation', () => {
  const joined = joinTawesStations(TAWES_METADATA, TAWES_OBSERVATIONS);
  for (const station of joined)
    assert.ok(alpineStationRecord(station), station.code);
  assert.deepEqual(joinTawesStations(null, null), []);
});
