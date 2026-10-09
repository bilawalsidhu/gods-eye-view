import test from 'node:test';
import assert from 'node:assert/strict';
import {
  READING_FIELDS,
  alpineStationRecord,
  describeWind,
  finiteOrNull,
  isoOrNull,
  isReporting,
  isStale,
  mergeNetworkStations,
  nearestStations,
  stationCardLines,
  summarizeStations,
  textOrNull,
  utcMinute,
} from './records.js';
import { parameterView } from './parameters.js';
import { SLF_NETWORK_ID, SMN_NETWORK_ID } from './networks.js';

const NOW = Date.UTC(2026, 9, 9, 12, 0);
const MEASURED = new Date(NOW - 10 * 60_000).toISOString();

function raw(overrides = {}) {
  return {
    networkId: SLF_NETWORK_ID,
    code: 'DAV2',
    label: 'Bärentälli',
    lat: 46.6988,
    lon: 9.8194,
    elevationM: 2558,
    region: 'GR',
    measuredAt: MEASURED,
    snowDepthCm: 42,
    airTempC: -3.5,
    windSpeedMs: 6,
    windDirDeg: 270,
    windGustMs: 11,
    ...overrides,
  };
}

test('a record is identified by network and code, so codes may collide', () => {
  // Station codes are only unique within an operator; "ZER" is a SwissMetNet
  // station and "ZER2" an SLF one, and two networks could reuse a code.
  const a = alpineStationRecord(raw({ networkId: SLF_NETWORK_ID, code: 'X' }));
  const b = alpineStationRecord(raw({ networkId: SMN_NETWORK_ID, code: 'X' }));
  assert.equal(a.id, `${SLF_NETWORK_ID}:X`);
  assert.notEqual(a.id, b.id);
});

test('a record without identity or a drawable position is dropped, not thrown', () => {
  // One degenerate station must never blank a country: a failed first update
  // makes the lifecycle disable the layer outright.
  assert.equal(alpineStationRecord(null), null);
  assert.equal(alpineStationRecord({}), null);
  assert.equal(alpineStationRecord(raw({ code: '  ' })), null);
  assert.equal(alpineStationRecord(raw({ networkId: 'invented' })), null);
  assert.equal(alpineStationRecord(raw({ lat: null })), null);
  assert.equal(alpineStationRecord(raw({ lon: undefined })), null);
  assert.equal(alpineStationRecord(raw({ lat: 91 })), null);
  assert.equal(alpineStationRecord(raw({ lon: -181 })), null);
  assert.equal(alpineStationRecord(raw({ lat: Number.NaN })), null);
});

test('a station falls back to its code and its network country', () => {
  const record = alpineStationRecord(raw({ label: null, country: null }));
  assert.equal(record.label, 'DAV2');
  assert.equal(record.country, 'CH');
});

test('a wind direction outside the compass is discarded, not clamped', () => {
  // A vane reading 400 degrees is broken. Clamping would invent a bearing.
  assert.equal(alpineStationRecord(raw({ windDirDeg: 400 })).windDirDeg, null);
  assert.equal(alpineStationRecord(raw({ windDirDeg: -1 })).windDirDeg, null);
  assert.equal(alpineStationRecord(raw({ windDirDeg: 0 })).windDirDeg, 0);
  assert.equal(alpineStationRecord(raw({ windDirDeg: 360 })).windDirDeg, 360);
});

test('absent stays null and a measured zero stays zero through the record', () => {
  const zeroed = alpineStationRecord(
    raw({ snowDepthCm: 0, airTempC: 0, precipMm: 0 }),
  );
  assert.equal(zeroed.snowDepthCm, 0);
  assert.equal(zeroed.airTempC, 0);
  assert.equal(zeroed.precipMm, 0);
  const silent = alpineStationRecord(
    Object.fromEntries(
      Object.entries(raw()).filter(([key]) => !READING_FIELDS.includes(key)),
    ),
  );
  for (const field of READING_FIELDS) assert.equal(silent[field], null, field);
  assert.equal(isReporting(zeroed), true, 'zero is a reading');
  assert.equal(isReporting(silent), false);
});

test('blank, dash and non-numeric strings all read as absent', () => {
  // The MeteoSwiss CSVs use `-` for a sensor a station does not carry.
  for (const value of [null, undefined, '', '   ', '-', '--', 'n/a', {}, []])
    assert.equal(finiteOrNull(value), null, JSON.stringify(value));
  assert.equal(finiteOrNull('0'), 0);
  assert.equal(finiteOrNull('-1.5'), -1.5);
  assert.equal(finiteOrNull(0), 0);
  assert.equal(finiteOrNull(Number.POSITIVE_INFINITY), null);
  assert.equal(textOrNull('  x '), 'x');
  assert.equal(textOrNull('   '), null);
  assert.equal(textOrNull(7), null);
  assert.equal(isoOrNull('2026-10-09T12:00:00Z'), '2026-10-09T12:00:00.000Z');
  assert.equal(isoOrNull('not a date'), null);
  assert.equal(isoOrNull(null), null);
});

test('a silent station is not stale, because it has no reading to age', () => {
  const silent = alpineStationRecord(
    raw({ measuredAt: null, snowDepthCm: null, airTempC: null, windSpeedMs: null, windGustMs: null, windDirDeg: null }),
  );
  assert.equal(isStale(silent, NOW), false, 'silent and stale read differently');
  assert.equal(isReporting(silent), false);
});

test('staleness follows the reporting network, not one global window', () => {
  // SLF publishes every 30 minutes and SwissMetNet every 10, so an identical
  // reading age is late for one and current for the other.
  const age = (ms, networkId) =>
    alpineStationRecord(
      raw({ networkId, measuredAt: new Date(NOW - ms).toISOString() }),
    );
  const twoHours = 2 * 60 * 60_000;
  assert.equal(isStale(age(twoHours, SLF_NETWORK_ID), NOW), false);
  assert.equal(isStale(age(twoHours, SMN_NETWORK_ID), NOW), true);
  assert.equal(isStale(age(7 * 24 * 60 * 60_000, SLF_NETWORK_ID), NOW), true);
  assert.equal(isStale(age(60_000, SMN_NETWORK_ID), NOW), false);
});

test('merging is de-duplicated, stable and tolerant of junk', () => {
  // The rail list and the entity set are both rebuilt from this array, so an
  // unstable order would reshuffle the panel on every poll.
  const first = mergeNetworkStations([
    [raw({ code: 'B' }), raw({ code: 'A' })],
    [raw({ code: 'A', label: 'duplicate' })],
    null,
    [null, {}, 'nonsense'],
  ]);
  assert.deepEqual(
    first.map((station) => station.code),
    ['A', 'B'],
  );
  assert.equal(first[0].label, 'Bärentälli', 'the first record for an id wins');
  const second = mergeNetworkStations([[raw({ code: 'A' }), raw({ code: 'B' })]]);
  assert.deepEqual(
    first.map((s) => s.id),
    second.map((s) => s.id),
  );
  assert.deepEqual(mergeNetworkStations(undefined), []);
});

test('the summary counts reporting honestly and keeps feed staleness out', () => {
  // `layerFeedState()` renders a row STALE on any truthy `stats.stale`, so a
  // count of late stations must never be reported there.
  const stations = mergeNetworkStations([
    [
      raw({ code: 'A' }),
      raw({ code: 'B', snowDepthCm: 100 }),
      raw({ code: 'C', measuredAt: null, snowDepthCm: null, airTempC: null, windSpeedMs: null, windGustMs: null, windDirDeg: null }),
      raw({
        code: 'D',
        measuredAt: new Date(NOW - 7 * 24 * 60 * 60_000).toISOString(),
      }),
    ],
  ]);
  const summary = summarizeStations(stations, {
    parameterId: 'snow',
    now: NOW,
  });
  assert.equal(summary.total, 4);
  assert.equal(summary.reporting, 3, 'the silent station is not reporting');
  assert.equal(summary.staleStations, 1);
  assert.ok(!Object.hasOwn(summary, 'stale'), 'stale is a feed-level flag');
  // Only readings the MAP draws count toward the range. D carries a snow
  // depth but its reading is a week old, so the markers show it offline and
  // the card must not take a network minimum or maximum from it.
  assert.equal(summary.measuring, 2, 'the week-old reading is not counted');
  assert.equal(summary.min, 42);
  assert.equal(summary.max, 100);
  assert.equal(summary.newestAt, MEASURED);
  assert.deepEqual(summary.networks, [
    { id: SLF_NETWORK_ID, total: 4, reporting: 3 },
  ]);
});

test('the summary reports no range for a parameter nothing measures', () => {
  const stations = mergeNetworkStations([[raw()]]);
  const summary = summarizeStations(stations, {
    parameterId: 'pressure',
    now: NOW,
  });
  assert.equal(summary.measuring, 0);
  assert.equal(summary.min, null);
  assert.equal(summary.max, null);
  const none = summarizeStations([], { parameterId: 'wind' });
  assert.equal(none.total, 0);
  assert.equal(none.reporting, 0);
  assert.deepEqual(none.networks, []);
});

test('nearest returns the closest stations first, bounded by count and range', () => {
  const stations = mergeNetworkStations([
    [
      raw({ code: 'NEAR', lat: 46.0, lon: 7.75 }),
      raw({ code: 'MID', lat: 46.5, lon: 7.75 }),
      raw({ code: 'FAR', lat: 52.5, lon: 13.4 }),
    ],
  ]);
  const near = nearestStations(stations, { lat: 46.0, lon: 7.75, limit: 2 });
  assert.deepEqual(
    near.map(({ station }) => station.code),
    ['NEAR', 'MID'],
  );
  assert.ok(near[0].km < 1);
  assert.ok(near[1].km > near[0].km);
  const bounded = nearestStations(stations, {
    lat: 46.0,
    lon: 7.75,
    limit: 6,
    maxKm: 100,
  });
  assert.equal(bounded.length, 2, 'Berlin is out of the Alpine window');
  assert.deepEqual(nearestStations(stations, { lat: null, lon: 7 }), []);
  assert.deepEqual(nearestStations(stations, { lat: 46, lon: 7.75, limit: 0 }), []);
  assert.deepEqual(nearestStations(null, { lat: 46, lon: 7.75 }), []);
});

test('wind reads as the meteorological phrase the operator published', () => {
  // The published direction is where the wind blows FROM (WMO convention), so
  // the card must not silently flip it.
  assert.equal(describeWind({ windSpeedMs: 6, windDirDeg: 270, windGustMs: 11 }), '21.6 km/h W · gust 39.6 km/h');
  assert.equal(describeWind({ windSpeedMs: 6, windDirDeg: null }), '21.6 km/h');
  assert.equal(describeWind({ windSpeedMs: null }), null);
  assert.equal(describeWind(null), null);
});

test('a card line is never printed for a measurement a station did not make', () => {
  const station = alpineStationRecord(raw());
  const lines = stationCardLines(station, parameterView('snow'), { now: NOW });
  const ids = lines.map((line) => line.id);
  assert.ok(ids.includes('place'));
  assert.ok(ids.includes('selected'));
  assert.ok(!ids.includes('snow'), 'the selected parameter is not repeated');
  assert.ok(ids.includes('wind'));
  assert.ok(ids.includes('air'));
  assert.ok(ids.includes('measured'));
  assert.equal(new Set(ids).size, ids.length, 'line ids are stable and unique');
  assert.match(lines.find((line) => line.id === 'selected').text, /42 cm/);
  assert.match(lines.find((line) => line.id === 'place').text, /SLF IMIS · GR · 2558 m/);
});

test('a card says what a station does not measure, rather than omitting it', () => {
  const station = alpineStationRecord(raw());
  const lines = stationCardLines(station, parameterView('pressure'), { now: NOW });
  const selected = lines.find((line) => line.id === 'selected');
  assert.match(selected.text, /not measured here/);
  assert.equal(selected.muted, true);
});

test('a silent station reads as silent and stops', () => {
  const silent = alpineStationRecord(
    raw({ measuredAt: null, snowDepthCm: null, airTempC: null, windSpeedMs: null, windGustMs: null, windDirDeg: null }),
  );
  const lines = stationCardLines(silent, parameterView('snow'), { now: NOW });
  assert.deepEqual(
    lines.map((line) => line.id),
    ['place', 'silent'],
  );
  assert.deepEqual(stationCardLines(null, parameterView('snow')), []);
});

test('a late reading is labelled late on its own line', () => {
  const late = alpineStationRecord(
    raw({ measuredAt: new Date(NOW - 7 * 24 * 60 * 60_000).toISOString() }),
  );
  const measured = stationCardLines(late, parameterView('snow'), {
    now: NOW,
  }).find((line) => line.id === 'measured');
  assert.match(measured.text, /· late$/);
});

test('times print as a UTC minute, and an unusable one says so', () => {
  assert.equal(utcMinute('2026-10-09T12:34:56Z'), '10-09 12:34 UTC');
  assert.equal(utcMinute('nonsense'), 'Unavailable');
  assert.equal(utcMinute(null), 'Unavailable');
});

test('a stale reading is excluded from the range the card prints', () => {
  // The map draws a stale station as offline with no value, so letting its
  // figure set the network minimum or maximum would put a number on the card
  // that is nowhere on the globe.
  const fresh = raw({ code: 'FRESH', snowDepthCm: 50 });
  const ancient = raw({
    code: 'OLD',
    snowDepthCm: 400,
    measuredAt: new Date(NOW - 30 * 24 * 60 * 60_000).toISOString(),
  });
  const summary = summarizeStations(mergeNetworkStations([[fresh, ancient]]), {
    parameterId: 'snow',
    now: NOW,
  });
  assert.equal(summary.measuring, 1);
  assert.equal(summary.max, 50, 'not the 400 cm nobody can see');
  assert.equal(summary.reporting, 2, 'both still count as part of the network');
  assert.equal(summary.staleStations, 1);
});

test('a reading whose time will not parse cannot be called current', () => {
  // Reachable from a malformed VQHA80 Date or a TAWES timestamp that fails to
  // normalise: the values arrive, the time does not. There is no way to tell
  // whether it is ten minutes or ten days old, so it is not shown as current.
  const undated = alpineStationRecord(raw({ measuredAt: 'not a date' }));
  assert.equal(undated.measuredAt, null);
  assert.equal(isReporting(undated), true);
  assert.equal(isStale(undated, NOW), true);

  // A SILENT station is still not stale: it has no reading to be out of date.
  const silent = alpineStationRecord(
    raw({
      measuredAt: null,
      snowDepthCm: null,
      airTempC: null,
      windSpeedMs: null,
      windGustMs: null,
      windDirDeg: null,
    }),
  );
  assert.equal(isStale(silent, NOW), false);
});
