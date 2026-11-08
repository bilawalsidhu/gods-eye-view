import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FT_TO_M,
  KT_TO_MPS,
  MIN_SPEED_MPS,
  buildTimeline,
  legLengthM,
  normalizeScenario,
  pathPositions,
  routePositions,
  sampleTimeline,
  scenarioDurationS,
} from './scenario.js';

const bundled = JSON.parse(
  readFileSync(
    new URL('../../../public/scenarios/fleet-week-sf.json', import.meta.url),
    'utf8',
  ),
);

function straight({ loop = false } = {}) {
  return normalizeScenario({
    version: 1,
    id: 'line',
    aircraft: [
      {
        id: 'a1',
        callsign: 'test1',
        typeCode: 'B77W',
        loop,
        waypoints: [
          { lat: 37.8, lon: -122.5, altFt: 1000, speedKt: 200 },
          { lat: 37.8, lon: -122.4, altFt: 1000, speedKt: 200 },
          { lat: 37.8, lon: -122.3, altFt: 2000, speedKt: 200 },
        ],
      },
    ],
  });
}

test('the bundled Fleet Week scenario normalises with metric units and classes', () => {
  const scenario = normalizeScenario(bundled);
  assert.equal(scenario.id, 'fleet-week-sf');
  assert.equal(scenario.aircraft.length, 5);
  const heavy = scenario.aircraft.find((a) => a.id === 'united-heavy');
  assert.equal(heavy.klass, 'widebody');
  assert.equal(heavy.loop, false);
  assert.ok(Math.abs(heavy.waypoints[0].altM - 7000 * FT_TO_M) < 1e-9);
  assert.ok(Math.abs(heavy.waypoints[0].speedMps - 260 * KT_TO_MPS) < 1e-9);
  const jet = scenario.aircraft.find((a) => a.id === 'angel1');
  assert.equal(jet.klass, 'fastjet');
  assert.equal(jet.loop, true);
  assert.equal(scenario.aircraft.find((a) => a.id === 'sfpd-helo').klass, 'helicopter');
});

test('normalizeScenario refuses malformed documents instead of half-loading', () => {
  assert.throws(() => normalizeScenario(null), /must be an object/);
  assert.throws(() => normalizeScenario({ version: 2, id: 'x', aircraft: [] }), /version/);
  assert.throws(() => normalizeScenario({ version: 1, id: 'Bad Id', aircraft: [] }), /id/);
  assert.throws(() => normalizeScenario({ version: 1, id: 'x', aircraft: [] }), /non-empty/);
  const one = { id: 'a', waypoints: [{ lat: 0, lon: 0 }] };
  assert.throws(
    () => normalizeScenario({ version: 1, id: 'x', aircraft: [one] }),
    /two waypoints/,
  );
  const dupe = { id: 'a', waypoints: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] };
  assert.throws(
    () => normalizeScenario({ version: 1, id: 'x', aircraft: [dupe, dupe] }),
    /repeats/,
  );
  assert.throws(
    () =>
      normalizeScenario({
        version: 1,
        id: 'x',
        aircraft: [{ id: 'a', waypoints: [{ lat: 0, lon: 0 }, { lat: 95, lon: 0 }] }],
      }),
    /lat\/lon/,
  );
});

test('speeds have a floor, colours fall back, and callsigns default to the id', () => {
  const scenario = normalizeScenario({
    version: 1,
    id: 'x',
    aircraft: [
      {
        id: 'slow',
        color: 'not-a-colour',
        waypoints: [
          { lat: 0, lon: 0, speedKt: 0 },
          { lat: 0.01, lon: 0, speedKt: 1 },
        ],
      },
    ],
  });
  assert.equal(scenario.aircraft[0].callsign, 'SLOW');
  assert.equal(scenario.aircraft[0].color, '#9be7ff');
  assert.equal(scenario.aircraft[0].waypoints[0].speedMps, MIN_SPEED_MPS);
  assert.equal(scenario.aircraft[0].klass, 'airliner');
});

test('timeline timing comes from leg length over mean speed', () => {
  const scenario = straight();
  const timeline = buildTimeline(scenario.aircraft[0]);
  const [a, b] = scenario.aircraft[0].waypoints;
  const expected = legLengthM(a, b) / (200 * KT_TO_MPS);
  assert.ok(Math.abs(timeline.times[1] - expected) < 1e-6);
  assert.equal(timeline.times.length, 3);
  assert.ok(timeline.durationS > 150 && timeline.durationS < 200);
  const loop = buildTimeline(straight({ loop: true }).aircraft[0]);
  assert.equal(loop.points.length, 4);
  assert.ok(loop.durationS > timeline.durationS);
});

test('sampling hits each waypoint at its time and heads east along the line', () => {
  const timeline = buildTimeline(straight().aircraft[0]);
  for (let i = 0; i < timeline.points.length; i++) {
    const s = sampleTimeline(timeline, timeline.times[i]);
    assert.ok(Math.abs(s.lat - timeline.points[i].lat) < 1e-9, `lat at ${i}`);
    assert.ok(Math.abs(s.lon - timeline.points[i].lon) < 1e-9, `lon at ${i}`);
    assert.ok(Math.abs(s.altM - timeline.points[i].altM) < 1e-6, `alt at ${i}`);
  }
  const mid = sampleTimeline(timeline, timeline.times[1] / 2);
  assert.ok(Math.abs(mid.headingDeg - 90) < 1, `heading ${mid.headingDeg}`);
  assert.ok(Math.abs(mid.pitchDeg) < 1);
  const climbing = sampleTimeline(timeline, (timeline.times[1] + timeline.times[2]) / 2);
  assert.ok(climbing.pitchDeg > 0.5, `pitch ${climbing.pitchDeg}`);
  assert.ok(climbing.altM > timeline.points[1].altM);
});

test('a finite path clamps and reports done; a loop wraps and never ends', () => {
  const finite = buildTimeline(straight().aircraft[0]);
  const after = sampleTimeline(finite, finite.durationS + 500);
  assert.equal(after.done, true);
  assert.ok(Math.abs(after.lon - -122.3) < 1e-9);
  assert.equal(sampleTimeline(finite, -50).done, false);
  assert.ok(Math.abs(sampleTimeline(finite, -50).lon - -122.5) < 1e-9);
  const loop = buildTimeline(straight({ loop: true }).aircraft[0]);
  const wrapped = sampleTimeline(loop, loop.durationS + 1);
  const early = sampleTimeline(loop, 1);
  assert.equal(wrapped.done, false);
  assert.ok(Math.abs(wrapped.lon - early.lon) < 1e-9);
  assert.ok(Math.abs(sampleTimeline(loop, -1).localS - (loop.durationS - 1)) < 1e-9);
});

test('pathPositions samples oldest-first at the step and clamps finite paths', () => {
  const timeline = buildTimeline(straight().aircraft[0]);
  const trail = pathPositions(timeline, 10, 20, 1);
  assert.equal(trail.length, 11);
  assert.ok(trail[0].lon < trail[10].lon);
  const clamped = pathPositions(timeline, -30, 5, 1);
  assert.equal(clamped.length, 6);
  assert.ok(Math.abs(clamped[0].lon - -122.5) < 1e-9);
  assert.equal(pathPositions(timeline, 5, 5).length, 1);
  const route = routePositions(timeline, 5);
  assert.ok(route.length > 20);
  assert.ok(Math.abs(route[route.length - 1].lon - -122.3) < 1e-9);
});

test('scenarioDurationS is the longest timeline', () => {
  const scenario = normalizeScenario(bundled);
  const timelines = scenario.aircraft.map(buildTimeline);
  const longest = Math.max(...timelines.map((tl) => tl.durationS));
  assert.equal(scenarioDurationS(timelines), longest);
  assert.ok(longest > 60);
});
