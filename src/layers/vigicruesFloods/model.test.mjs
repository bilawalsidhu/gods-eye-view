import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildVigicruesStationCopy,
  buildVigicruesZoneCopy,
  vigicruesPick,
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
    stations: [
      { id: 'a', name: 'Nowhere' },
      { id: 'b', lon: 5, lat: 43 },
    ],
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

test('a picked entity id names a sensor or a zone, and a zone id may hold a colon', () => {
  assert.deepEqual(vigicruesPick('vigicrues-station:K123'), {
    kind: 'station',
    id: 'K123',
  });
  assert.deepEqual(vigicruesPick('vigicrues-zone:Z:7:2'), {
    kind: 'zone',
    id: 'Z:7',
  });
  assert.equal(vigicruesPick('vigicrues-station:'), null);
  assert.equal(vigicruesPick('other:1'), null);
  assert.equal(vigicruesPick(undefined), null);
});

test('the sensor and zone cards carry the published facts', () => {
  const t = (key) => key;
  const station = buildVigicruesStationCopy(
    {
      name: 'Paris',
      river: 'Seine',
      commune: 'Paris',
      hasBulletin: true,
      lat: 48.8566,
      lon: 2.3522,
    },
    t,
  );
  assert.equal(station.title, 'Paris');
  assert.ok(station.details.includes('Seine · Paris'));
  assert.ok(station.details.includes('Forecast bulletin published'));
  assert.ok(station.details.includes('48.857°, 2.352°'));
  const zone = buildVigicruesZoneCopy(
    { label: 'Seine aval', territory: 'Île-de-France', level: 2 },
    t,
  );
  assert.equal(zone.title, 'Seine aval');
  assert.ok(zone.details.includes('Vigilance 2'));
  assert.ok(zone.details.includes('Île-de-France'));
});
