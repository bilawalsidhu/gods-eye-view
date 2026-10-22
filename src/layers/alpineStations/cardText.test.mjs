import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeWind,
  localizedReading,
  readingNumber,
  stationCardLines,
  utcMinute,
} from './cardText.js';
import { alpineStationRecord } from './records.js';
import { parameterView } from './parameters.js';
import { SLF_NETWORK_ID } from './networks.js';
import { setLocale } from '../../i18n/index.js';

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

test('wind reads as the meteorological phrase the operator published', () => {
  // The published direction is where the wind blows FROM (WMO convention), so
  // the card must not silently flip it.
  assert.equal(
    describeWind({ windSpeedMs: 6, windDirDeg: 270, windGustMs: 11 }),
    '21.6 km/h W · gust 39.6 km/h',
  );
  assert.equal(describeWind({ windSpeedMs: 6, windDirDeg: null }), '21.6 km/h');
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
  assert.match(lines.find((line) => line.id === 'selected').text, /42\s?cm/);
  assert.match(
    lines.find((line) => line.id === 'place').text,
    /SLF IMIS · GR · 2558\s?m/,
  );
});

test('a card says what a station does not measure, rather than omitting it', () => {
  const station = alpineStationRecord(raw());
  const lines = stationCardLines(station, parameterView('pressure'), {
    now: NOW,
  });
  const selected = lines.find((line) => line.id === 'selected');
  assert.match(selected.text, /not measured here/);
  assert.equal(selected.muted, true);
});

test('a silent station reads as silent and stops', () => {
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

test('card text follows the reader language, numbers included', () => {
  // The whole reason this module is separate from records.js: the proxy
  // imports those records, so the translated text cannot live there.
  setLocale('es');
  try {
    const station = alpineStationRecord(raw());
    const lines = stationCardLines(station, parameterView('pressure'), {
      now: NOW,
    });
    assert.match(
      lines.find((line) => line.id === 'selected').text,
      /no se mide aquí/,
    );
    assert.match(lines.find((line) => line.id === 'air').text, /Aire/);
    // Spanish writes a decimal comma, so the formatter has to be the i18n one.
    assert.match(localizedReading(21.6, parameterView('wind')), /^22/);
    assert.match(localizedReading(-3.5, parameterView('temperature')), /-3,5/);
    assert.equal(utcMinute('nonsense'), 'No disponible');
  } finally {
    setLocale('en');
  }
});

test('both ends of a range round and group the same way', () => {
  // The card prints "{min} to {max}", and the open end used to go through a
  // bare formatNumber: that printed "1,005.4 to 1025 hPa" in one line, and
  // "4.2 to 76 km/h" beside a "4 km/h" on the map.
  const expected = {
    pressure: '1005 to 1025 hPa',
    wind: '1005 to 1025 km/h',
    snow: '1005 to 1025 cm',
    temperature: '1005.4 to 1025.0 \u00b0C',
    precipitation: '1005.4 to 1025.0 mm/10min',
  };
  for (const [id, line] of Object.entries(expected)) {
    const view = parameterView(id);
    const printed = `${readingNumber(1005.43, view)} to ${localizedReading(1025, view)}`;
    assert.equal(printed.replace(/\u00a0/g, ' '), line, id);
  }
  assert.equal(readingNumber(null, parameterView('snow')), null);
  assert.equal(readingNumber(Number.NaN, parameterView('snow')), null);
});

test('a range end carries no unit of its own, in any language', async () => {
  const view = parameterView('temperature');
  await setLocale('es');
  try {
    assert.equal(readingNumber(-3.5, view), '-3,5');
    assert.equal(
      localizedReading(-3.5, view).replace(/\u00a0/g, ' '),
      '-3,5 \u00b0C',
    );
  } finally {
    await setLocale('en');
  }
});
