import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createGroundFloor, GROUND_FLOOR } from './groundFloor.js';

const { cartesian3, cartographic } = geo;
const WGS84 = geo.ellipsoid.WGS84;
const at = (lon, lat, height) => cartesian3.fromDegrees(lon, lat, height);
const heightOf = (position) =>
  cartographic.fromCartesian(position, WGS84).height;
const radiusAt = (lon, lat, height) =>
  cartesian3.magnitude(at(lon, lat, height));

function setup({ ground = 100, terrain, free = true } = {}) {
  const state = {
    position: at(2.35, 48.85, 5000),
    free,
    time: 0,
    ground,
    samples: 0,
    lifts: [],
    clamps: [],
  };
  const floor = createGroundFloor({
    surface: {
      sampleHeight: () => {
        state.samples += 1;
        return state.ground;
      },
      terrainHeight: () => terrain,
    },
    position: () => state.position,
    isFree: () => state.free,
    lift: (position) => {
      state.lifts.push(position);
      state.position = position;
    },
    setMinimumZoomDistance: (distance) => state.clamps.push(distance),
    now: () => state.time,
  });
  return { floor, state };
}

test('a camera below the ground plus the margin is lifted straight up', () => {
  const { floor, state } = setup({ ground: 100 });
  state.position = at(2.35, 48.85, 40);
  assert.equal(floor.update(), true);
  assert.equal(state.lifts.length, 1);
  const lifted = cartographic.fromCartesian(state.lifts[0], WGS84);
  assert.ok(Math.abs(lifted.height - (100 + GROUND_FLOOR.MIN_ABOVE)) < 1e-6);
  assert.ok(Math.abs(geo.math.toDegrees(lifted.longitude) - 2.35) < 1e-9);
  assert.ok(Math.abs(geo.math.toDegrees(lifted.latitude) - 48.85) < 1e-9);
  // Navara's own clamp: the geocentric radius of the ground plus the margin.
  assert.equal(state.clamps.length, 1);
  assert.ok(
    Math.abs(
      state.clamps[0] - (radiusAt(2.35, 48.85, 100) + GROUND_FLOOR.MIN_ABOVE),
    ) < 1e-6,
  );
  // Now at the floor: nothing more to do.
  assert.equal(floor.update(), false);
  assert.equal(state.lifts.length, 1);
});

test('a camera above the floor is left alone', () => {
  const { floor, state } = setup({ ground: 100 });
  state.position = at(2.35, 48.85, 1000);
  assert.equal(floor.update(), false);
  assert.deepEqual(state.lifts, []);
  assert.equal(state.clamps.length, 1, 'the clamp still follows the ground');
});

test('the ground falls back to the terrain, then to the ellipsoid', () => {
  for (const [terrain, expected] of [
    [250, 250],
    [undefined, 0],
  ]) {
    const { floor, state } = setup({ ground: null, terrain });
    state.position = at(10, 45, -500);
    assert.equal(floor.update(), true);
    assert.ok(
      Math.abs(heightOf(state.position) - (expected + GROUND_FLOOR.MIN_ABOVE)) <
        1e-6,
    );
  }
});

test('the floor stands aside during a flight or a lookAt and resets the clamp', () => {
  const { floor, state } = setup({ ground: 100 });
  state.position = at(2.35, 48.85, 500);
  floor.update();
  assert.equal(state.clamps.length, 1);
  state.free = false;
  state.position = at(2.35, 48.85, 10);
  assert.equal(floor.update(), false);
  assert.deepEqual(state.lifts, []);
  assert.deepEqual(
    state.clamps.slice(1),
    [undefined],
    "Navara's default again",
  );
  assert.equal(floor.update(), false);
  assert.equal(state.clamps.length, 2, 'reset once');
  state.free = true;
  assert.equal(floor.update(), true, 'lifted once the camera is free again');
});

test('above the floor height the ground is not sampled and the clamp is reset', () => {
  const { floor, state } = setup({ ground: 100 });
  state.position = at(2.35, 48.85, 500);
  floor.update();
  state.position = at(2.35, 48.85, GROUND_FLOOR.MAX_HEIGHT + 1000);
  const samples = state.samples;
  assert.equal(floor.update(), false);
  assert.equal(state.samples, samples);
  assert.deepEqual(state.clamps.slice(1), [undefined]);
});

test('the ground is resampled after a move or a while, and the clamp only on real change', () => {
  const { floor, state } = setup({ ground: 100 });
  state.position = at(2.35, 48.85, 500);
  floor.update();
  floor.update();
  assert.equal(state.samples, 1, 'cached within the same place and time');
  state.time = GROUND_FLOOR.RESAMPLE_MS + 1;
  state.ground = 105;
  floor.update();
  assert.equal(state.samples, 2, 'resampled after RESAMPLE_MS');
  assert.equal(state.clamps.length, 1, 'a 5 m change is not sent');
  state.position = at(2.36, 48.85, 500);
  state.ground = 140;
  floor.update();
  assert.equal(state.samples, 2, 'not within MIN_RESAMPLE_MS of the last');
  state.time += GROUND_FLOOR.MIN_RESAMPLE_MS;
  floor.update();
  assert.equal(state.samples, 3, 'resampled after a move');
  assert.equal(state.clamps.length, 2, 'a 40 m change is sent');
});

test('a pan resamples at most every MIN_RESAMPLE_MS, however far it moves', () => {
  // A sample of the ground outside the view costs about 1.6 ms (surface.js):
  // not on every frame of a pan.
  assert.ok(GROUND_FLOOR.MIN_RESAMPLE_MS >= 100);
  const { floor, state } = setup({ ground: 100 });
  state.position = at(2.35, 48.85, 500);
  floor.update();
  for (let frame = 1; frame <= 30; frame++) {
    state.time = frame * 16;
    state.position = at(2.35 + frame * 0.001, 48.85, 500); // ~73 m a frame
    floor.update();
  }
  // 480 ms of panning: the first sample and one every 100 ms at most.
  assert.ok(state.samples <= 1 + Math.ceil(480 / GROUND_FLOOR.MIN_RESAMPLE_MS));
  assert.ok(state.samples >= 3, 'still follows the pan');
});
