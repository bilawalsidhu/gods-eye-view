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
