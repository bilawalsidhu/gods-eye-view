import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENTSOE_KEY_ID,
  ENTSOE_ZONE_PINS,
  buildEntsoeZoneCopy,
  entsoeBandColor,
  entsoeCurrentPoint,
  entsoeSparkline,
  entsoeZoneFromPick,
  normalizeEntsoeSnapshot,
  entsoeLoadBand,
  normalizeEntsoePayload,
  mapEntsoeRecord,
} from './model.js';

test('a load is banded against the largest value in the same snapshot', () => {
  assert.equal(entsoeLoadBand(100, 100), 'peak');
  assert.equal(entsoeLoadBand(60, 100), 'high');
  assert.equal(entsoeLoadBand(30, 100), 'moderate');
  assert.equal(entsoeLoadBand(10, 100), 'low');
});

test('a load without a maximum falls back to the low band', () => {
  assert.equal(entsoeLoadBand(100, 0), 'low');
  assert.equal(entsoeLoadBand(Number.NaN, 100), 'low');
});

test('a band has a colour, and an unknown band falls back', () => {
  assert.equal(entsoeBandColor('peak'), '#d0271d');
  assert.equal(entsoeBandColor('nope'), '#3aa76d');
});

test('a payload is normalized into a banded series', () => {
  const result = normalizeEntsoePayload({
    unit: 'MW',
    day: '2026-10-25',
    points: [
      { position: 1, value: 100 },
      { position: 2, value: 25 },
    ],
  });
  assert.equal(result.series.length, 2);
  assert.equal(result.unit, 'MW');
  assert.equal(result.day, '2026-10-25');
  assert.equal(result.series[0].band, 'peak');
  // 25 of 100 is a quarter of the snapshot max: the bottom edge of the
  // moderate band. The bands are a partition of [0,1] into quarter bins,
  // half-open on the left: [0,0.25) low, [0.25,0.5) moderate,
  // [0.5,0.75) high, [0.75,1] peak.
  assert.equal(result.series[1].band, 'moderate');
});

test('a structurally broken payload is refused so the last good one is kept', () => {
  assert.equal(normalizeEntsoePayload(null), null);
  assert.equal(normalizeEntsoePayload({ points: 'nope' }), null);
  assert.equal(normalizeEntsoePayload({ points: [] }), null);
});

test('a point with a non-numeric value is skipped, not fatal', () => {
  const result = normalizeEntsoePayload({
    points: [
      { position: 1, value: 10 },
      { position: 'x', value: 20 },
    ],
  });
  assert.equal(result.series.length, 1);
});

test('an analyst record carries only JSON-safe values', () => {
  const record = mapEntsoeRecord({
    value: 100,
    unit: 'MW',
    band: 'peak',
    position: 1,
  });
  assert.equal(record.id, 'GRID-0000');
  assert.equal(record.value, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
});

test('the layer names the key it needs through the registry id', () => {
  assert.equal(ENTSOE_KEY_ID, 'entsoe');
});

const day = '2026-10-25';
const zoneOf = (values, code = 'FR') => {
  const pin = ENTSOE_ZONE_PINS.find((zone) => zone.code === code);
  return {
    ...pin,
    ...normalizeEntsoePayload({
      unit: 'MW',
      day,
      points: values.map((value, index) => ({ position: index + 1, value })),
    }),
  };
};

test('a snapshot keeps usable zones and drops unknown or broken ones', () => {
  const ok = { points: [{ position: 1, value: 5 }], unit: 'MW', day };
  const snapshot = normalizeEntsoeSnapshot([
    { code: 'FR', payload: ok },
    { code: 'XX', payload: ok },
    { code: 'DE', payload: { points: [] } },
  ]);
  assert.deepEqual(
    snapshot.zones.map((zone) => zone.code),
    ['FR'],
  );
  assert.equal(snapshot.zones[0].name, 'France');
  assert.equal(normalizeEntsoeSnapshot([]), null);
});

test('every pin is a zone the proxy serves, on the right continent', () => {
  for (const pin of ENTSOE_ZONE_PINS) {
    assert.ok(pin.lat > 35 && pin.lat < 60, pin.code);
    assert.ok(pin.lon > -12 && pin.lon < 25, pin.code);
  }
  assert.equal(entsoeZoneFromPick('entsoe-zone:FR'), 'FR');
  assert.equal(entsoeZoneFromPick('entsoe-zone:ZZ'), null);
  assert.equal(entsoeZoneFromPick('other:FR'), null);
});

test('the current reading is the latest hour already started', () => {
  const zone = zoneOf([10, 20, 30, 40]);
  const at = (hour) => Date.parse(`${day}T${hour}:30:00Z`);
  assert.equal(entsoeCurrentPoint(zone, at('01')).value, 20);
  assert.equal(entsoeCurrentPoint(zone, at('23')).value, 40);
  // Read before the day starts: the first hour, not nothing.
  assert.equal(
    entsoeCurrentPoint(zone, Date.parse('2026-10-24T12:00:00Z')).value,
    10,
  );
  assert.equal(entsoeCurrentPoint({ series: [] }), null);
});

test('a sparkline is one block per value, flat series sit mid-height', () => {
  assert.equal(entsoeSparkline([1, 2, 3]).length, 3);
  assert.equal(entsoeSparkline([1, 8]), '▁█');
  assert.equal(entsoeSparkline([5, 5]), '▄▄');
  assert.equal(entsoeSparkline([]), '');
});

test('the zone card names the zone, the current reading and the day range', () => {
  const zone = zoneOf([100, 400, 250]);
  const copy = buildEntsoeZoneCopy(
    zone,
    (key, params) =>
      params ? key.replace(/\{(\w+)\}/g, (_, name) => params[name]) : key,
    Date.parse(`${day}T01:10:00Z`),
  );
  assert.equal(copy.title, 'France');
  assert.ok(copy.details.includes('400 MW at 01:00 UTC'));
  assert.ok(copy.details.some((line) => line.startsWith('Day low 100')));
  assert.equal(copy.accent, entsoeBandColor('peak'));
});
