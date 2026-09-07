import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DroneMissionSimulator,
  MISSION_STATES,
  interpolateProfilePosition,
} from './simulator.js';
import { createMissionEntitySnapshots } from './entities.js';
import { createRoute } from './route.js';

function profile() {
  const vertices = [
    { latitude: 0, longitude: 0, altitudeMsl: 100, terrainHeightMsl: 20, cumulativeDistanceMeters: 0, routeSegmentIndex: 0 },
    { latitude: 0, longitude: 0.001, altitudeMsl: 150, terrainHeightMsl: 40, cumulativeDistanceMeters: 100, routeSegmentIndex: 0 },
    { latitude: 0.001, longitude: 0.001, altitudeMsl: 150, terrainHeightMsl: 50, cumulativeDistanceMeters: 200, routeSegmentIndex: 1 },
    { latitude: 0.001, longitude: 0.002, altitudeMsl: 100, terrainHeightMsl: 20, cumulativeDistanceMeters: 300, routeSegmentIndex: 2 },
  ].map(Object.freeze);
  return Object.freeze({
    vertices: Object.freeze(vertices),
    totalLengthMeters: 300,
    groundSpeedMps: 10,
  });
}

function simulator(options = {}) {
  return new DroneMissionSimulator({
    profile: profile(),
    groundSpeedMps: 10,
    takeoffDurationSeconds: 2,
    arrivalHoldSeconds: 1,
    ...options,
  });
}

test('mission state vocabulary includes every specified deterministic state', () => {
  assert.deepEqual(MISSION_STATES, [
    'draft', 'ready', 'takeoff', 'climb', 'cruise', 'descent',
    'paused', 'aborted', 'arrived', 'landed',
  ]);
});

test('simulator begins draft without a profile and becomes ready when loaded', () => {
  const sim = new DroneMissionSimulator();
  assert.equal(sim.state, 'draft');
  assert.equal(sim.getTelemetry().missionState, 'draft');
  sim.loadProfile(profile());
  assert.equal(sim.state, 'ready');
  assert.equal(sim.getTelemetry().distanceFlownMeters, 0);
});

test('state machine progresses through takeoff, climb, cruise, descent, arrived, landed', () => {
  const sim = simulator();
  assert.equal(sim.state, 'ready');
  sim.launch();
  assert.equal(sim.state, 'takeoff');
  sim.tick(3);
  assert.equal(sim.state, 'climb');
  sim.tick(10);
  assert.equal(sim.state, 'cruise');
  sim.tick(10);
  assert.equal(sim.state, 'descent');
  sim.tick(9);
  assert.equal(sim.state, 'arrived');
  sim.tick(1);
  assert.equal(sim.state, 'landed');
  assert.equal(sim.running, false);
});

test('pause freezes clock, position, ETA and resume restores the derived flight state', () => {
  const sim = simulator();
  sim.launch();
  const beforePause = sim.tick(7);
  assert.equal(beforePause.missionState, 'climb');
  const paused = sim.pause();
  assert.equal(paused.missionState, 'paused');
  assert.equal(paused.groundSpeedMps, 0);
  assert.deepEqual(sim.tick(100), paused);
  const resumed = sim.resume();
  assert.equal(resumed.missionState, 'climb');
  assert.equal(resumed.groundSpeedMps, 10);
});

test('abort freezes progress and reset returns to a replayable ready state', () => {
  const sim = simulator();
  sim.launch();
  sim.tick(12);
  const aborted = sim.abort();
  assert.equal(aborted.missionState, 'aborted');
  assert.equal(aborted.etaSeconds, null);
  assert.deepEqual(sim.tick(50), aborted);
  const reset = sim.reset();
  assert.equal(reset.missionState, 'ready');
  assert.equal(reset.distanceFlownMeters, 0);
  assert.equal(reset.simulationTimeSeconds, 0);
});

test('replay restarts deterministically from aborted and completed missions', () => {
  const sim = simulator();
  const firstLaunch = sim.launch();
  sim.tick(5);
  sim.abort();
  assert.deepEqual(sim.replay(), firstLaunch);
  sim.tick(33);
  assert.equal(sim.state, 'landed');
  assert.deepEqual(sim.replay(), firstLaunch);
});

test('playback speed scales simulation clock but not modeled ground speed', () => {
  const sim = simulator({ playbackSpeed: 2 });
  sim.launch();
  const telemetry = sim.tick(3);
  assert.equal(telemetry.simulationTimeSeconds, 6);
  assert.equal(telemetry.distanceFlownMeters, 40);
  assert.equal(telemetry.groundSpeedMps, 10);
  assert.equal(telemetry.playbackSpeed, 2);
  sim.setPlaybackSpeed(0.5);
  assert.equal(sim.tick(2).simulationTimeSeconds, 7);
  assert.throws(() => sim.setPlaybackSpeed(0), RangeError);
});

test('profile interpolation returns deterministic 3D position and telemetry', () => {
  const halfway = interpolateProfilePosition(profile(), 50);
  assert.ok(Math.abs(halfway.latitude) < 1e-12);
  assert.ok(Math.abs(halfway.longitude - 0.0005) < 1e-9);
  assert.equal(halfway.altitudeMsl, 125);
  assert.equal(halfway.terrainHeightMsl, 30);
  assert.equal(halfway.aglMeters, 95);
  assert.ok(Math.abs(halfway.headingDegrees - 90) < 1e-6);
  assert.equal(halfway.routeSegmentIndex, 0);

  const sim = simulator();
  sim.launch();
  const telemetry = sim.tick(7);
  assert.equal(telemetry.distanceFlownMeters, 50);
  assert.equal(telemetry.distanceRemainingMeters, 250);
  assert.equal(telemetry.etaSeconds, 25);
  assert.equal(telemetry.currentSegment, 0);
  assert.equal(telemetry.altitudeMsl, 125);
  assert.equal(telemetry.altitudeAgl, 95);
});

test('identical command and tick sequences yield identical telemetry', () => {
  const first = simulator();
  const second = simulator();
  for (const sim of [first, second]) {
    sim.launch();
    sim.tick(1.25);
    sim.tick(2.5);
    sim.pause();
    sim.tick(99);
    sim.resume();
    sim.setPlaybackSpeed(1.5);
    sim.tick(3.75);
  }
  assert.deepEqual(first.getTelemetry(), second.getTelemetry());
});

test('invalid state transitions and clock deltas fail explicitly', () => {
  const sim = simulator();
  assert.throws(() => sim.pause(), /cannot pause/);
  assert.throws(() => sim.resume(), /cannot resume/);
  assert.throws(() => sim.tick(-1), RangeError);
  sim.launch();
  assert.throws(() => sim.launch(), /cannot launch/);
  sim.abort();
  assert.throws(() => sim.abort(), /cannot abort/);
});

test('entity snapshots are provider-neutral, immutable, and carry simulated provenance', () => {
  const route = createRoute({
    launch: { latitude: 0, longitude: 0 },
    waypoints: [{ id: 'turn', latitude: 0, longitude: 0.001 }],
    destination: {
      type: 'area',
      center: { latitude: 0.001, longitude: 0.002 },
      radiusMeters: 40,
    },
  });
  const sim = simulator();
  sim.launch();
  const entities = createMissionEntitySnapshots({
    route,
    profile: profile(),
    telemetry: sim.tick(7),
    missionId: 'mission-7',
    droneId: 'drone-7',
  });
  assert.deepEqual(entities.map(({ type }) => type), ['drone', 'polyline', 'area']);
  assert.ok(entities.every(({ simulated, provenance: itemProvenance }) => (
    simulated === true
    && itemProvenance.simulated === true
    && itemProvenance.source === 'synthetic-drone-mission'
  )));
  assert.equal(entities[0].id, 'drone-7');
  assert.equal(entities[1].positions.length, profile().vertices.length);
  assert.equal(entities[2].radiusMeters, 40);
  assert.doesNotThrow(() => JSON.stringify(entities));
  assert.ok(Object.isFrozen(entities));
});
