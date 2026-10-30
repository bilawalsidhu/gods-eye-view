import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeVigicruesStationPayload,
  normalizeVigicruesZonePayload,
  mapVigicruesStationRecord,
  vigicruesLevelColor,
  zoneLines,
} from './model.js';

test('a station payload is normalized into rows', () => {
  const result = normalizeVigicruesStationPayload({
    total: 2376,
    observedAt: 1792963200000,
    stations: [
      {
        id: 'X302001001',
        name: 'Meyrargues',
        river: 'Durance',
        commune: '13059',
        lon: 5.6261,
        lat: 43.4216,
        hasBulletin: true,
      },
    ],
  });
  assert.equal(result.stations.length, 1);
  assert.equal(result.total, 2376);
  assert.equal(result.observedAt, 1792963200000);
  assert.equal(result.stations[0].river, 'Durance');
  assert.equal(result.stations[0].color, '#e5383b');
});

test('a structurally broken payload is refused so the last good one is kept', () => {
  assert.equal(normalizeVigicruesStationPayload(null), null);
  assert.equal(normalizeVigicruesStationPayload({ stations: 'nope' }), null);
});

test('a station without coordinates is skipped, not fatal', () => {
  const result = normalizeVigicruesStationPayload({
    stations: [{ id: 'a', name: 'Nowhere' }, { id: 'b', lon: 5, lat: 43 }],
  });
  assert.equal(result.stations.length, 1);
});

test('a warning-zone payload keeps only drawable geometries', () => {
  const result = normalizeVigicruesZonePayload({
    bbox: [-4.1, 42.4, 8.2, 50.8],
    zones: [
      {
        id: '764',
        label: 'Golo aval',
        territory: 'TCC22',
        level: 2,
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [9.1, 42.4],
              [9.2, 42.5],
            ],
          ],
        },
      },
      { id: 'no-geometry', label: 'x', level: 1 },
      {
        id: 'bad-type',
        geometry: { type: 'Point', coordinates: [1, 2] },
      },
    ],
  });
  assert.equal(result.zones.length, 1);
  assert.equal(result.zones[0].color, '#ff9f1c');
  assert.deepEqual(result.bbox, [-4.1, 42.4, 8.2, 50.8]);
});

test('a structurally broken zone payload is refused', () => {
  assert.equal(normalizeVigicruesZonePayload(null), null);
  assert.equal(normalizeVigicruesZonePayload({ zones: 'nope' }), null);
});

test('the vigilance colour follows the level', () => {
  assert.equal(vigicruesLevelColor(1), '#ffd43b');
  assert.equal(vigicruesLevelColor(3), '#e5383b');
  assert.equal(vigicruesLevelColor(9), '#6b7785');
  assert.equal(vigicruesLevelColor(null), '#6b7785');
});

test('zone geometry is flattened into drawable lines', () => {
  const lines = zoneLines({
    type: 'MultiLineString',
    coordinates: [
      [
        [9.1, 42.4],
        [9.2, 42.5],
      ],
      [[999, 42.5]],
    ],
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 2);
  assert.equal(lines[0][0].lon, 9.1);
});

test('an unknown geometry type yields no lines', () => {
  assert.deepEqual(zoneLines({ type: 'Point', coordinates: [1, 2] }), []);
  assert.deepEqual(zoneLines(null), []);
});

test('an analyst record carries only JSON-safe values', () => {
  const record = mapVigicruesStationRecord({
    id: 'X302001001',
    name: 'Meyrargues',
    river: 'Durance',
    commune: '13059',
    hasBulletin: true,
    lat: 43.4216,
    lon: 5.6261,
  });
  assert.equal(record.id, 'X302001001');
  assert.equal(record.hasBulletin, true);
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
});
