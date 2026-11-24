import assert from 'node:assert/strict';
import test from 'node:test';
import { locateOnTrack, onScreen, readingAt } from './locate.js';
import { fromDegreesInto } from '../geo/ellipsoid.js';

const point = (observedAtMs, latitude, longitude, extra = {}) => ({
  observedAtMs,
  latitude,
  longitude,
  ...extra,
});

test('the reading at a time is the newest point at or before it', () => {
  const track = [
    point(3_000, 3, 30),
    point(1_000, 1, 10, { baroAltitudeM: 900 }),
    point(2_000, 2, 20),
    point(Number.NaN, 9, 90),
    point(4_000, Number.NaN, 40),
  ];
  assert.deepEqual(readingAt(track, 2_500), {
    lat: 2,
    lon: 20,
    altitudeM: null,
    observedAtMs: 2_000,
  });
  assert.equal(readingAt(track, 1_000).altitudeM, 900, 'at its own time');
  assert.equal(readingAt(track).observedAtMs, 3_000, 'no time: the newest');
  assert.equal(readingAt(track, 500), null, 'before its first point');
  assert.equal(readingAt([], 500), null);
});

test('a track lookup asks for the time and reads the point at it', async () => {
  const asked = [];
  const source = {
    async getTrack(reference, options) {
      asked.push([reference, options.atMs]);
      return { records: [point(1_000, 1, 10), point(5_000, 5, 50)] };
    },
  };
  assert.deepEqual(await locateOnTrack(source, 'vessel:a', { atMs: 2_000 }), {
    status: 'found',
    lat: 1,
    lon: 10,
    altitudeM: null,
    observedAtMs: 1_000,
    atMs: 2_000,
  });
  assert.deepEqual(asked, [['vessel:a', 2_000]]);
  assert.deepEqual(await locateOnTrack(source, 'vessel:a', { atMs: 500 }), {
    status: 'none',
  });
  const live = await locateOnTrack(source, 'vessel:a');
  assert.equal(live.observedAtMs, 5_000, 'live: its newest point');
  assert.equal(asked.at(-1)[1], undefined, 'live asks for no time');
});

test('a source without tracks, or one that fails, finds nothing', async () => {
  assert.deepEqual(await locateOnTrack({}, 'a'), { status: 'none' });
  assert.deepEqual(await locateOnTrack(null, 'a'), { status: 'none' });
  const failing = {
    getTrack: async () => {
      throw new Error('down');
    },
  };
  assert.deepEqual(await locateOnTrack(failing, 'a'), { status: 'none' });
  assert.deepEqual(
    await locateOnTrack({ getTrack: async () => ({ records: [] }) }, ''),
    { status: 'none' },
    'no reference',
  );
});

/** A camera 1000 km above a point, looking straight down. */
function poseAbove(lat, lon) {
  const at = fromDegreesInto(lon, lat, 0, { x: 0, y: 0, z: 0 });
  const length = Math.hypot(at.x, at.y, at.z);
  const up = { x: at.x / length, y: at.y / length, z: at.z / length };
  const position = {
    x: at.x + up.x * 1e6,
    y: at.y + up.y * 1e6,
    z: at.z + up.z * 1e6,
  };
  const direction = { x: -up.x, y: -up.y, z: -up.z };
  // North-ish screen up, east right: any pair at right angles will do.
  const east = {
    x: -Math.sin((lon * Math.PI) / 180),
    y: Math.cos((lon * Math.PI) / 180),
    z: 0,
  };
  const north = {
    x: up.y * east.z - up.z * east.y,
    y: up.z * east.x - up.x * east.z,
    z: up.x * east.y - up.y * east.x,
  };
  return {
    position,
    direction,
    up: north,
    right: east,
    fovy: Math.PI / 3,
    aspectRatio: 1.5,
  };
}

test('a point is on screen in view, and not out of view or behind the globe', () => {
  const pose = poseAbove(10, 20);
  assert.equal(onScreen(pose, 10, 20), true, 'under the camera');
  assert.equal(onScreen(pose, 11, 21), true, 'near it');
  assert.equal(onScreen(pose, 30, 20), false, 'outside the view');
  assert.equal(onScreen(pose, -10, -160), false, 'the far side of the globe');
  assert.equal(onScreen(pose, Number.NaN, 20), false, 'no position');
  assert.equal(onScreen(null, 10, 20), false, 'no camera');
});
