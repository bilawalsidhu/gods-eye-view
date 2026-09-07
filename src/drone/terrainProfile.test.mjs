import assert from 'node:assert/strict';
import test from 'node:test';

import { distanceMeters } from './geodesy.js';
import { createTerrainAwareProfile } from './profile.js';
import { createRoute } from './route.js';
import {
  MissingTerrainSampleError,
  createTerrainSamplingPlan,
  sampleTerrain,
} from './terrain.js';

function multipointRoute() {
  return createRoute({
    launch: { latitude: 0, longitude: 0 },
    waypoints: [{ id: 'turn', latitude: 0, longitude: 0.01 }],
    destination: { latitude: 0.01, longitude: 0.01 },
  });
}

test('terrain plan covers every route segment with bounded spacing and endpoints', () => {
  const maxSpacingMeters = 250;
  const plan = createTerrainSamplingPlan(multipointRoute(), { maxSpacingMeters });
  assert.equal(plan.segments.length, 2);
  for (const segment of plan.segments) {
    assert.equal(segment.samples[0].fraction, 0);
    assert.equal(segment.samples.at(-1).fraction, 1);
    for (let index = 1; index < segment.samples.length; index += 1) {
      assert.ok(
        distanceMeters(segment.samples[index - 1], segment.samples[index]) <= maxSpacingMeters + 1e-6,
      );
    }
  }
  assert.equal(plan.segments[0].samples.at(-1).latitude, plan.segments[1].samples[0].latitude);
  assert.ok(Math.abs(plan.totalLengthMeters - 2_223.9) < 2);
  assert.ok(Object.isFrozen(plan.samples));
});

test('terrain plan validates spacing', () => {
  assert.throws(() => createTerrainSamplingPlan(multipointRoute(), { maxSpacingMeters: 0 }), RangeError);
  assert.throws(() => createTerrainSamplingPlan(multipointRoute(), { maxSpacingMeters: Infinity }), RangeError);
});

test('terrain plan rejects routes that exceed the sample budget before allocation', () => {
  assert.throws(
    () => createTerrainSamplingPlan(multipointRoute(), {
      maxSpacingMeters: 100,
      maxSamples: 10,
    }),
    /10-sample planning limit/,
  );
});

test('async terrain sampler receives deterministic requests and preserves plan metadata', async () => {
  const plan = createTerrainSamplingPlan(multipointRoute(), { maxSpacingMeters: 500 });
  let requestsSeen;
  const sampled = await sampleTerrain(plan, async (requests) => {
    requestsSeen = requests;
    await Promise.resolve();
    return requests.map((_, index) => ({ heightMsl: 100 + index }));
  });
  assert.deepEqual(requestsSeen.map(({ id }) => id), plan.samples.map(({ id }) => id));
  assert.ok(Object.isFrozen(requestsSeen));
  assert.equal(sampled.samples[3].terrainHeightMsl, 103);
  assert.equal(sampled.samples[3].routeSegmentIndex, plan.samples[3].routeSegmentIndex);
});

test('terrain sampler accepts keyed Map results', async () => {
  const plan = createTerrainSamplingPlan(multipointRoute(), { maxSpacingMeters: 2_000 });
  const sampled = await sampleTerrain(plan, async (requests) => new Map(
    requests.map(({ id }, index) => [id, { heightMeters: index * 5 }]),
  ));
  assert.deepEqual(sampled.samples.map(({ terrainHeightMsl }) => terrainHeightMsl), [0, 5, 10, 15]);
});

test('terrain sampler fails explicitly and identifies every unavailable sample', async () => {
  const plan = createTerrainSamplingPlan(multipointRoute(), { maxSpacingMeters: 2_000 });
  await assert.rejects(
    sampleTerrain(plan, async () => [10, null, { heightMsl: Number.NaN }]),
    (error) => error instanceof MissingTerrainSampleError
      && error.sampleIds.join(',') === 'terrain-0-1,terrain-1-0,terrain-1-1',
  );
});

test('profile keeps every horizontal sample, removes only duplicate segment joints', async () => {
  const plan = createTerrainSamplingPlan(multipointRoute(), { maxSpacingMeters: 500 });
  const sampled = await sampleTerrain(plan, async (requests) => requests.map(() => 20));
  const profile = createTerrainAwareProfile(sampled);
  assert.equal(profile.vertices.length, plan.samples.length - 1);
  const expected = [
    ...plan.segments[0].samples,
    ...plan.segments[1].samples.slice(1),
  ];
  assert.deepEqual(
    profile.vertices.map(({ latitude, longitude }) => ({ latitude, longitude })),
    expected.map(({ latitude, longitude }) => ({ latitude, longitude })),
  );
});

test('profile maintains minimum AGL and climb/descent rate constraints', async () => {
  const route = createRoute({
    launch: { latitude: 0, longitude: 0 },
    destination: { latitude: 0, longitude: 0.009 },
  });
  const plan = createTerrainSamplingPlan(route, { maxSpacingMeters: 100 });
  const sampled = await sampleTerrain(plan, async (requests) => requests.map((_, index) => (
    index === Math.floor(requests.length / 2) ? 200 : 0
  )));
  const config = {
    minimumAglMeters: 50,
    maxClimbRateMps: 2,
    maxDescentRateMps: 1,
    groundSpeedMps: 10,
  };
  const profile = createTerrainAwareProfile(sampled, config);

  for (const vertex of profile.vertices) assert.ok(vertex.aglMeters >= 50 - 1e-9);
  for (let index = 1; index < profile.vertices.length; index += 1) {
    const previous = profile.vertices[index - 1];
    const current = profile.vertices[index];
    const seconds = (current.cumulativeDistanceMeters - previous.cumulativeDistanceMeters)
      / config.groundSpeedMps;
    assert.ok(current.altitudeMsl - previous.altitudeMsl <= config.maxClimbRateMps * seconds + 1e-9);
    assert.ok(previous.altitudeMsl - current.altitudeMsl <= config.maxDescentRateMps * seconds + 1e-9);
  }
  assert.ok(profile.vertices[0].altitudeMsl > 50, 'backward pass anticipates rising terrain');
  assert.ok(profile.vertices.at(-1).altitudeMsl > 50, 'forward pass smooths the descent');
});

test('profile conservatively uses the higher duplicate terrain height at a segment joint', async () => {
  const plan = createTerrainSamplingPlan(multipointRoute(), { maxSpacingMeters: 2_000 });
  const sampled = await sampleTerrain(plan, async (requests) => requests.map(({ id }) => {
    if (id === 'terrain-0-1') return 80;
    if (id === 'terrain-1-0') return 120;
    return 0;
  }));
  const profile = createTerrainAwareProfile(sampled, {
    minimumAglMeters: 30,
    maxClimbRateMps: 100,
    maxDescentRateMps: 100,
  });
  assert.equal(profile.vertices[1].terrainHeightMsl, 120);
  assert.equal(profile.vertices[1].altitudeMsl, 150);
});

test('profile independently rejects incomplete sampled terrain', async () => {
  const plan = createTerrainSamplingPlan(multipointRoute(), { maxSpacingMeters: 2_000 });
  const sampled = await sampleTerrain(plan, async (requests) => requests.map(() => 0));
  const corrupt = {
    plan,
    samples: sampled.samples.map((sample, index) => (
      index === 0 ? { ...sample, terrainHeightMsl: null } : sample
    )),
  };
  assert.throws(() => createTerrainAwareProfile(corrupt), MissingTerrainSampleError);
});

test('profile validates clearance, rates, and planning speed', async () => {
  const plan = createTerrainSamplingPlan(multipointRoute(), { maxSpacingMeters: 2_000 });
  const sampled = await sampleTerrain(plan, async (requests) => requests.map(() => 0));
  assert.throws(() => createTerrainAwareProfile(sampled, { minimumAglMeters: -1 }), RangeError);
  assert.throws(() => createTerrainAwareProfile(sampled, { maxClimbRateMps: 0 }), RangeError);
  assert.throws(() => createTerrainAwareProfile(sampled, { maxDescentRateMps: Number.NaN }), RangeError);
  assert.throws(() => createTerrainAwareProfile(sampled, { groundSpeedMps: 0 }), RangeError);
});
