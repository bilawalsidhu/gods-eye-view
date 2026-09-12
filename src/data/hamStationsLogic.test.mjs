import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_MY_STATION_OVERLAYS,
  DXCC_NEEDED_COLOR,
  DXCC_WORKED_COLOR,
  HISTORY_LIMIT,
  ROTATOR_HALF_WIDTH_DEG,
  ROTATOR_RANGE_KM,
  STATION_COLOR,
  dxccCounts,
  dxccMarkerStyle,
  extractRows,
  findStation,
  frameRadiusM,
  gridMarkerSize,
  normalizeCallsign,
  normalizeMyStationOverlays,
  precisionLabel,
  pushHistory,
  rotatorLabel,
  rotatorWedge,
  sanitizeDxccEntities,
  sanitizeRotators,
  sanitizeStation,
  sanitizeWorkedGrids,
  stationFlyAltitudeM,
  stationLookupPath,
  stationMarkerStyle,
  stationSummaryLine,
  trimHistory,
} from './hamStationsLogic.js';
import { distanceKm, initialBearingDeg } from './hamRadioShared.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../hamrig/fixtures/${name}`, import.meta.url), 'utf8'));
const NOW = Date.parse('2026-09-12T16:00:00Z');

/** A Station row as the proxy emits it (contract §1.3 shape). */
const dh5dax = {
  callsign: 'DH5DAX',
  name: 'Michael Beck',
  country: 'Germany',
  dxcc: { adif: 230, name: 'Germany', prefix: 'DL', continent: 'EU', cqZone: 14, ituZone: 28 },
  lat: 52.186667,
  lon: 7.04,
  precision: 'exact',
  grid: 'JO32me',
  city: null,
  state: null,
  imageUrl: 'https://cdn-xml.qrz.com/x/dh5dax/IMG_6130_jpeg.jpg',
  licenseClass: 'A',
  qslManager: 'direct or eqsl',
  lotw: null,
  eqsl: null,
  hamrigUser: { username: 'DH5DAX', verified: true, avatarUrl: 'https://hamrig.com/uploads/avatars/avatar_1.jpg' },
  sources: ['callsign_database', 'cty.dat'],
};

// ---------------------------------------------------------------------------
// Callsigns + rows
// ---------------------------------------------------------------------------

test('normalizeCallsign upper-cases and applies the proxy route pattern', () => {
  assert.equal(normalizeCallsign(' dh5dax '), 'DH5DAX');
  assert.equal(normalizeCallsign('s79/dl2sby'), 'S79/DL2SBY');
  assert.equal(normalizeCallsign('W1AW/7'), 'W1AW/7');
  assert.equal(normalizeCallsign('DL8LAS-#'), null, 'skimmer suffixes are not valid callsigns');
  assert.equal(normalizeCallsign('DL'), null);
  assert.equal(normalizeCallsign('A'.repeat(16)), null);
  assert.equal(normalizeCallsign(''), null);
  assert.equal(normalizeCallsign(null), null);
  assert.equal(stationLookupPath('dh5dax'), '/api/hamrig/station/DH5DAX');
  assert.equal(stationLookupPath('s79/dl2sby'), '/api/hamrig/station/S79%2FDL2SBY');
  assert.equal(stationLookupPath('x'), null);
});

test('sanitizeStation freezes a valid row and rejects rows without a position', () => {
  const station = sanitizeStation(dh5dax, { nowMs: NOW });
  assert.ok(Object.isFrozen(station));
  assert.equal(station.id, 'DH5DAX');
  assert.equal(station.callsign, 'DH5DAX');
  assert.equal(station.precision, 'exact');
  assert.equal(station.grid, 'JO32me');
  assert.equal(station.dxcc.adif, 230);
  assert.equal(station.dxcc.continent, 'EU');
  assert.equal(station.hamrigUser.username, 'DH5DAX');
  assert.equal(station.hamrigUser.verified, true);
  assert.equal(station.imageUrl, dh5dax.imageUrl);
  assert.equal(station.lookedUpAt, '2026-09-12T16:00:00.000Z');
  assert.deepEqual([...station.sources], ['callsign_database', 'cty.dat']);
  assert.equal(sanitizeStation({ ...dh5dax, lat: null }), null);
  assert.equal(sanitizeStation({ ...dh5dax, callsign: 'x' }), null);
  assert.equal(sanitizeStation(null), null);
  const loose = sanitizeStation({ callsign: 'tf3xyz', lat: 65, lon: -18, precision: 'bogus', imageUrl: 'javascript:alert(1)', hamrigUser: null });
  assert.equal(loose.precision, 'entity');
  assert.equal(loose.imageUrl, null);
  assert.equal(loose.hamrigUser, null);
  assert.equal(loose.name, null);
});

test('precision labels and the summary line', () => {
  assert.equal(precisionLabel('exact'), 'exact position');
  assert.equal(precisionLabel('grid'), 'grid square');
  assert.equal(precisionLabel('area'), 'call area (approximate)');
  assert.equal(precisionLabel('entity'), 'entity centroid (approximate)');
  assert.equal(precisionLabel(undefined), 'unknown precision');
  const station = sanitizeStation(dh5dax, { nowMs: NOW });
  assert.equal(stationSummaryLine(station), 'DH5DAX · Michael Beck · Germany · JO32me (exact position)');
  const city = sanitizeStation({ ...dh5dax, callsign: 'W1AW', city: 'Newington', state: 'CT', grid: null, precision: 'area' }, { nowMs: NOW });
  assert.equal(stationSummaryLine(city), 'W1AW · Michael Beck · Newington, CT · Germany · (call area (approximate))');
  assert.equal(stationSummaryLine(null), '');
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

test('history keeps the newest 50 unique callsigns, newest first', () => {
  assert.equal(HISTORY_LIMIT, 50);
  let history = Object.freeze([]);
  for (let index = 0; index < 60; index += 1) {
    history = pushHistory(history, { callsign: `DL${index}ABC`, lat: 0, lon: 0 });
  }
  assert.equal(history.length, 50);
  assert.equal(history[0].callsign, 'DL59ABC');
  assert.equal(history[49].callsign, 'DL10ABC');
  assert.ok(Object.isFrozen(history));
  const again = pushHistory(history, { callsign: 'DL30ABC', lat: 1, lon: 1 });
  assert.equal(again.length, 50);
  assert.equal(again[0].callsign, 'DL30ABC');
  assert.equal(again[0].lat, 1, 'a repeat lookup replaces the old row');
  assert.equal(again.filter((row) => row.callsign === 'DL30ABC').length, 1);
  assert.equal(pushHistory(history, null).length, 50);
  assert.equal(trimHistory([{ callsign: 'A1B' }, null, { nope: true }, { callsign: 'C2D' }], 1).length, 1);
  assert.deepEqual(trimHistory(undefined), []);
});

test('findStation matches by callsign case-insensitively or by name/country words', () => {
  const history = [
    sanitizeStation(dh5dax, { nowMs: NOW }),
    sanitizeStation({ ...dh5dax, callsign: 'W1AW', name: 'ARRL HQ', country: 'United States', city: 'Newington' }, { nowMs: NOW }),
  ];
  assert.equal(findStation(history, 'w1aw').callsign, 'W1AW');
  assert.equal(findStation(history, ' dh5dax ').callsign, 'DH5DAX');
  assert.equal(findStation(history, 'arrl').callsign, 'W1AW');
  assert.equal(findStation(history, 'beck germany').callsign, 'DH5DAX');
  assert.equal(findStation(history, 'nobody'), null);
  assert.equal(findStation(history, ''), null);
  assert.equal(findStation(null, 'w1aw'), null);
});

// ---------------------------------------------------------------------------
// Styling + camera
// ---------------------------------------------------------------------------

test('marker style is hollow unless exact, and fly altitude follows precision', () => {
  const exact = stationMarkerStyle({ precision: 'exact' });
  assert.equal(exact.hollow, false);
  assert.equal(exact.css, STATION_COLOR);
  assert.ok(exact.alpha > 0.9);
  const grid = stationMarkerStyle({ precision: 'grid' });
  assert.equal(grid.hollow, true);
  assert.equal(grid.alpha, 0);
  assert.ok(grid.outlineWidth >= 2);
  const selected = stationMarkerStyle({ precision: 'entity' }, { selected: true });
  assert.equal(selected.outlineCss, '#ffffff');
  assert.ok(selected.pixelSize > grid.pixelSize);
  assert.equal(stationMarkerStyle(null).hollow, true);
  assert.equal(stationFlyAltitudeM('exact'), 300_000);
  assert.equal(stationFlyAltitudeM('grid'), 600_000);
  assert.equal(stationFlyAltitudeM('area'), 2_500_000);
  assert.equal(stationFlyAltitudeM('entity'), 3_000_000);
  assert.equal(stationFlyAltitudeM('nope'), 1_500_000);
});

test('frameRadiusM pads the largest pairwise distance with a 60 km floor', () => {
  assert.equal(frameRadiusM([]), null);
  assert.equal(frameRadiusM([{ lat: 52, lon: 7 }]), 60_000);
  const radius = frameRadiusM([{ lat: 52.18, lon: 7.04 }, { lat: 41.7, lon: -72.7 }, { lat: 'x', lon: 1 }]);
  const span = distanceKm({ lat: 52.18, lon: 7.04 }, { lat: 41.7, lon: -72.7 }) * 1000;
  assert.ok(Math.abs(radius - span * 0.8) < 1);
});

// ---------------------------------------------------------------------------
// My station
// ---------------------------------------------------------------------------

test('my-station overlay switches default on and merge booleans only', () => {
  assert.deepEqual({ ...DEFAULT_MY_STATION_OVERLAYS }, { dxcc: true, grids: true, rotator: true });
  const next = normalizeMyStationOverlays(DEFAULT_MY_STATION_OVERLAYS, { dxcc: false, grids: 'off', extra: false });
  assert.deepEqual({ ...next }, { dxcc: false, grids: true, rotator: true });
  assert.ok(Object.isFrozen(next));
  assert.deepEqual({ ...normalizeMyStationOverlays(null, null) }, { ...DEFAULT_MY_STATION_OVERLAYS });
});

test('extractRows accepts keyed payloads or bare arrays', () => {
  assert.deepEqual(extractRows({ entities: [1, 2] }, ['entities']), [1, 2]);
  assert.deepEqual(extractRows({ grids: [3] }, ['rows', 'grids']), [3]);
  assert.deepEqual(extractRows([4], ['x']), [4]);
  assert.deepEqual(extractRows({ error: 'nope' }, ['entities']), []);
  assert.deepEqual(extractRows(null, ['entities']), []);
});

test('DXCC entities: styling, counts and sanitising', () => {
  const rows = sanitizeDxccEntities([
    { adif: 230, name: 'Germany', prefix: 'DL', continent: 'EU', cqz: 14, cq: 14, lat: 51, lon: 10, worked: true, bands: ['20m', '40m'] },
    { adif: 1, name: 'Canada', continent: 'NA', lat: 60, lon: -100, worked: false },
    { adif: null, name: 'Nowhere', lat: 0, lon: 0, worked: 'yes' },
    { adif: 5, name: 'Bad', lat: 999, lon: 0 },
    { adif: 6, lat: 1, lon: 1 },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].id, '230');
  assert.equal(rows[0].worked, true);
  assert.deepEqual([...rows[0].bands], ['20m', '40m']);
  assert.equal(rows[2].id, 'Nowhere');
  assert.equal(rows[2].worked, false, 'worked must be a real boolean');
  assert.deepEqual(dxccCounts(rows), { worked: 1, needed: 2, total: 3 });
  assert.deepEqual(dxccCounts(null), { worked: 0, needed: 0, total: 0 });
  assert.equal(dxccMarkerStyle(rows[0]).css, DXCC_WORKED_COLOR);
  assert.equal(dxccMarkerStyle(rows[1]).css, DXCC_NEEDED_COLOR);
  assert.ok(dxccMarkerStyle(rows[0]).pixelSize > dxccMarkerStyle(rows[1]).pixelSize);
});

test('worked grids scale by log qsos and drop bad rows', () => {
  const rows = sanitizeWorkedGrids([
    { grid: 'jo32', qsos: 15, lat: 52.5, lon: 7 },
    { grid: 'JO31', qsos: '3', lat: 51.5, lon: 7 },
    { grid: '', qsos: 1, lat: 0, lon: 0 },
    { grid: 'AA00', qsos: 1, lat: null, lon: 0 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].grid, 'JO32');
  assert.equal(rows[0].qsos, 15);
  assert.equal(rows[1].qsos, 3);
  assert.equal(gridMarkerSize(0), 4);
  assert.equal(gridMarkerSize(1), 5.5);
  assert.ok(gridMarkerSize(15) > gridMarkerSize(3));
  assert.equal(gridMarkerSize(1_000_000), 16);
  assert.equal(gridMarkerSize(-5), 4);
});

test('rotator rows from the fixture: only positioned rotators with an azimuth survive', () => {
  const raw = fixture('hamrig-rotators.json').list;
  // Shape the raw rows the way the server's normalizeRotators does (decimals as strings, no gateway_key).
  const normalized = raw.map((row) => ({
    id: row.id,
    name: row.nickname ?? `Rotator ${row.id}`,
    model: row.model,
    lat: row.location_lat === null ? null : Number(row.location_lat),
    lon: row.location_lng === null ? null : Number(row.location_lng),
    grid: row.location_grid,
    azimuth: Number(row.current_azimuth),
    elevation: Number(row.current_elevation),
    targetAzimuth: row.target_azimuth === null ? null : Number(row.target_azimuth),
    isMoving: Boolean(row.is_moving),
    status: row.status,
    online: row.is_online,
    lastSeenIso: row.last_seen_at ? `${row.last_seen_at.replace(' ', 'T')}Z` : null,
    bands: row.bands.map((band) => band.band),
  }));
  const rotators = sanitizeRotators(normalized);
  assert.equal(rotators.length, 1, 'the portable rotator has no coordinates');
  const [tower] = rotators;
  assert.equal(tower.id, '7');
  assert.equal(tower.name, 'Tower rotor');
  assert.equal(tower.azimuth, 95.5);
  assert.equal(tower.online, true);
  assert.deepEqual([...tower.bands], ['20m', '15m', '10m']);
  assert.ok(!JSON.stringify(rotators).includes('gateway_key'));
  assert.equal(sanitizeRotators([{ id: 1, lat: 0, lon: 0, azimuth: 370 }])[0].azimuth, 10);
  assert.equal(sanitizeRotators([{ id: 1, lat: 0, lon: 0, azimuth: -90 }])[0].azimuth, 270);
  assert.equal(sanitizeRotators([{ id: 1, lat: 0, lon: 0, azimuth: null }]).length, 0);
});

test('rotatorWedge spans ±12° out to 4000 km from the QTH', () => {
  assert.equal(ROTATOR_HALF_WIDTH_DEG, 12);
  assert.equal(ROTATOR_RANGE_KM, 4000);
  const origin = { lat: 52.186667, lon: 7.04 };
  const ring = rotatorWedge(origin, 95.5, { steps: 24 });
  assert.equal(ring.length, 26, 'origin + 25 arc samples');
  assert.deepEqual(ring[0], origin);
  for (const point of ring.slice(1)) {
    assert.ok(Math.abs(distanceKm(origin, point) - 4000) < 1);
  }
  assert.ok(Math.abs(initialBearingDeg(origin, ring[1]) - 83.5) < 0.05);
  assert.ok(Math.abs(initialBearingDeg(origin, ring[ring.length - 1]) - 107.5) < 0.05);
  assert.ok(Math.abs(initialBearingDeg(origin, ring[13]) - 95.5) < 0.05, 'the middle sample is the boresight');
  const north = rotatorWedge(origin, 0, { steps: 4 });
  assert.ok(Math.abs(initialBearingDeg(origin, north[1]) - 348) < 0.05, 'bearings wrap around north');
  assert.equal(rotatorWedge(origin, null), null);
  assert.equal(rotatorWedge({ lat: 100, lon: 0 }, 90), null);
  assert.equal(rotatorWedge(origin, 90, { rangeKm: 0 }), null);
  const narrow = rotatorWedge(origin, 180, { halfWidthDeg: 5, rangeKm: 1000, steps: 2 });
  assert.equal(narrow.length, 4);
  assert.ok(Math.abs(distanceKm(origin, narrow[1]) - 1000) < 1);
});

test('rotatorLabel shows heading, target and motion state', () => {
  assert.equal(rotatorLabel({ name: 'Tower rotor', azimuth: 95.5, targetAzimuth: 95.5, isMoving: false, online: true }), 'Tower rotor · 096°');
  assert.equal(rotatorLabel({ name: 'Spid', azimuth: 270, targetAzimuth: 300, isMoving: true, online: true }), 'Spid · 270° → 300° · moving');
  assert.equal(rotatorLabel({ name: 'Spid', azimuth: 5, targetAzimuth: null, isMoving: false, online: false }), 'Spid · 005° · offline');
  assert.equal(rotatorLabel(null), '');
});
