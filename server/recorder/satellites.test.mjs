import test from 'node:test';
import assert from 'node:assert/strict';
import { recorderConfig } from './config.js';
import { createSatelliteSource } from './satellites.js';

const TLE = `ISS (ZARYA)
1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9006
2 25544  51.6400 208.9163 0006317  69.9862  25.2906 15.50000000    14
`;
const EPOCH = Date.UTC(2024, 0, 1, 12) / 1000;

test('satellite positions come from the orbital elements', () => {
  const src = createSatelliteSource({ groups: ['stations'] });
  assert.equal(src.learn('stations', TLE), 1);
  const [p] = src.points(EPOCH);
  assert.equal(p.layer, 'sat');
  assert.equal(p.id, 'SAT-25544');
  assert.ok(Math.abs(p.lat) <= 51.7, 'latitude stays inside the inclination');
  assert.ok(p.alt > 350000 && p.alt < 500000, 'low earth orbit height in metres');
  assert.ok(p.speed > 7000 && p.speed < 8000, 'about 7.7 km/s');
  const [later] = src.points(EPOCH + 60);
  assert.notEqual(later.lon, p.lon);
});

test('groups that were not asked for are ignored', () => {
  const src = createSatelliteSource({ groups: ['stations'] });
  assert.equal(src.learn('starlink', TLE), 0);
  assert.equal(src.count(), 0);
  assert.deepEqual(src.points(EPOCH), []);
});

test('a satellite in two groups is recorded once, and junk is skipped', () => {
  const src = createSatelliteSource({ groups: ['stations', 'visual'] });
  src.learn('stations', `${TLE}garbage\n`);
  src.learn('visual', TLE);
  assert.equal(src.points(EPOCH).length, 1);
});

test('satellites are opt-in', () => {
  assert.ok(!recorderConfig({}).layers.includes('sat'));
  const c = recorderConfig({
    GEV_RECORDER_LAYERS: 'air,sat',
    GEV_RECORDER_SAT_GROUPS: 'stations, gps-ops',
  });
  assert.deepEqual(c.layers, ['air', 'sat']);
  assert.deepEqual(c.satGroups, ['stations', 'gps-ops']);
});

test('an Alpha-5 catalogue number is named by its NORAD number', () => {
  const src = createSatelliteSource({ groups: ['visual'] });
  const alpha = TLE.replace('ISS (ZARYA)', 'NEW OBJECT')
    .replace('1 25544U', '1 A0057U')
    .replace('2 25544 ', '2 A0057 ');
  assert.equal(src.learn('visual', alpha), 1);
  assert.equal(src.points(EPOCH)[0].id, 'SAT-100057');
});

test('satellite points carry the name for search', () => {
  const src = createSatelliteSource({ groups: ['stations'] });
  src.learn('stations', TLE);
  assert.equal(src.points(EPOCH)[0].name, 'ISS (ZARYA)');
});

const N2YO_REPLY = {
  info: { satid: 25544, satname: 'SPACE STATION', transactionscount: 1 },
  tle: TLE.split('\n').slice(1, 3).join('\r\n'),
};
const standIn = (reply = N2YO_REPLY, status = 200) => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    return { ok: status === 200, status, json: async () => reply };
  };
  return { fetchImpl, seen };
};

test('N2YO elements fill in a pinned satellite CelesTrak did not give', async () => {
  const { createN2yoClient, refreshFromN2yo } = await import('./n2yo.js');
  const { fetchImpl, seen } = standIn();
  const client = createN2yoClient({ key: 'SECRET-KEY', fetchImpl });
  const sats = createSatelliteSource({ groups: ['stations'] });
  const last = new Map();
  const nowSec = EPOCH;
  const first = await refreshFromN2yo({ sats, pins: ['SAT-25544', 'A1B2C3'], client, last, nowSec });
  assert.equal(first.loaded, 1, 'only the satellite id is looked up');
  assert.equal(seen.length, 1);
  assert.match(seen[0], /\/tle\/25544&apiKey=SECRET-KEY$/);
  assert.equal(sats.extraCount(), 1);
  assert.equal(sats.points(EPOCH)[0].id, 'SAT-25544');
  // a fresh set is not fetched again, and not before six hours
  const again = await refreshFromN2yo({ sats, pins: ['SAT-25544'], client, last, nowSec: nowSec + 3600 });
  assert.equal(again.loaded, 0);
  assert.equal(seen.length, 1);
});

test('N2YO is not asked when CelesTrak has a recent set, and the key stays out of errors', async () => {
  const { createN2yoClient, refreshFromN2yo } = await import('./n2yo.js');
  const { fetchImpl, seen } = standIn();
  const client = createN2yoClient({ key: 'SECRET-KEY', fetchImpl });
  const sats = createSatelliteSource({ groups: ['stations'] });
  sats.learn('stations', TLE);
  const fresh = await refreshFromN2yo({ sats, pins: ['SAT-25544'], client, nowSec: EPOCH + 86400 });
  assert.equal(seen.length, 0, 'a one day old set is good enough');
  const old = await refreshFromN2yo({ sats, pins: ['SAT-25544'], client, nowSec: EPOCH + 9 * 86400 });
  assert.equal(seen.length, 1, 'a nine day old set is replaced');
  assert.equal(fresh.loaded + old.loaded, 1);

  const broken = createN2yoClient({ key: 'SECRET-KEY', fetchImpl: standIn({}, 500).fetchImpl });
  const failed = await refreshFromN2yo({ sats: createSatelliteSource({ groups: [] }), pins: ['SAT-25544'], client: broken, nowSec: EPOCH });
  assert.equal(failed.error, 'N2YO HTTP 500');
  assert.ok(!failed.error.includes('SECRET'));
  const down = createN2yoClient({ key: 'SECRET-KEY', fetchImpl: async () => { throw new Error('connect SECRET-KEY'); } });
  await assert.rejects(down.tle(25544), (e) => !e.message.includes('SECRET') && /could not be reached/.test(e.message));
  await assert.rejects(createN2yoClient({}).tle(25544), /No N2YO key/);
});

test('the newest element set wins and N2YO keeps within its hourly limit', async () => {
  const { createN2yoClient } = await import('./n2yo.js');
  const sats = createSatelliteSource({ groups: ['stations'] });
  sats.learn('stations', TLE);
  const newer = TLE.replace('24001.50000000', '24009.50000000');
  const [, l1, l2] = newer.split('\n');
  assert.ok(sats.addElements('ISS (ZARYA)', l1, l2));
  assert.ok(Math.abs(sats.epochAgeDays('SAT-25544', EPOCH + 9 * 86400)) < 2.1, 'the newer epoch is used');
  assert.equal(sats.addElements('x', 'junk', 'junk'), false);
  let clock = 0;
  const client = createN2yoClient({ key: 'k', fetchImpl: standIn().fetchImpl, now: () => clock });
  for (let i = 0; i < 600; i++) await client.tle(25544);
  await assert.rejects(client.tle(25544), /hourly limit/);
  clock = 3600_001;
  await client.tle(25544);
});
