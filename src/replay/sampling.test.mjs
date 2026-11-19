import test from 'node:test';
import assert from 'node:assert/strict';
import { groupTracks } from './model.js';
import {
  boundingSphere,
  observedAt,
  positionAt,
  prepareTrack,
  trailAt,
} from './sampling.js';

const rows = (list) =>
  prepareTrack(
    [...groupTracks(list.map(([ts, lon, lat, alt]) => ({ id: 'a', layer: 'air', ts, lon, lat, alt }))).values()][0],
  );

test('positionAt blends between two samples and holds at the ends', () => {
  const track = rows([
    [100, 10, 50, 1000],
    [200, 12, 52, 3000],
  ]);
  assert.deepEqual(positionAt(track, 100000), { lon: 10, lat: 50, alt: 1000 });
  assert.deepEqual(positionAt(track, 150000), { lon: 11, lat: 51, alt: 2000 });
  assert.deepEqual(positionAt(track, 200000), { lon: 12, lat: 52, alt: 3000 });
});

test('positionAt is null outside the recording and inside a gap', () => {
  const track = rows([
    [100, 10, 50],
    [160, 10.1, 50],
    [1000, 11, 51],
    [1060, 11.1, 51],
  ]);
  assert.equal(positionAt(track, 50000), null);
  assert.equal(positionAt(track, 500000), null);
  assert.ok(positionAt(track, 1030000));
  assert.equal(positionAt(track, 2000000), null);
});

test('positionAt blends the short way across the date line', () => {
  const track = rows([
    [0, 179, 0],
    [100, -179, 0],
  ]);
  assert.equal(positionAt(track, 50000).lon, 180);
});

test('observedAt tells a recorded fix from an estimate', () => {
  const track = rows([
    [0, 0, 0],
    [200, 1, 1],
  ]);
  assert.equal(observedAt(track, 5000), true);
  assert.equal(observedAt(track, 100000), false);
});

test('trailAt runs from the trail start to the position now, within one span', () => {
  const track = rows([
    [0, 0, 0],
    [100, 1, 0],
    [200, 2, 0],
  ]);
  const trail = trailAt(track, 150000, 100000);
  assert.deepEqual(trail.map((p) => Math.round(p.lon * 100) / 100), [0.5, 1, 1.5]);
  assert.deepEqual(trailAt(track, 900000, 100000), []);
});

test('boundingSphere holds every point', () => {
  const sphere = boundingSphere([
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
  ]);
  assert.deepEqual(sphere.center, { x: 5, y: 0, z: 0 });
  assert.equal(sphere.radius, 5);
  assert.equal(boundingSphere([]), null);
});

test('positionAt holds a hair outside a span, so a converted clock does not lose the contact', () => {
  const track = rows([
    [100, 10, 50],
    [200, 12, 52],
  ]);
  assert.deepEqual(positionAt(track, 100000 - 500), { lon: 10, lat: 50, alt: 0 });
  assert.deepEqual(positionAt(track, 200000 + 500), { lon: 12, lat: 52, alt: 0 });
  assert.equal(positionAt(track, 100000 - 5000), null);
});
