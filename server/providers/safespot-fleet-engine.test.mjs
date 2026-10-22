import test from 'node:test';
import assert from 'node:assert/strict';
import { createSafeSpotFleetEngine } from './safespot-fleet-engine.js';

const T0 = 1_000_000;

function fallbackEngine() {
  return createSafeSpotFleetEngine({ graphPath: null, now: () => T0 });
}

function assertContiguous(engine, state) {
  for (const veh of state.vehicles) {
    const wps = veh.waypoints;
    for (let i = 1; i < wps.length; i++) {
      assert.equal(
        engine.graph.edgeFrom(wps[i].edgeId),
        engine.graph.edgeTo(wps[i - 1].edgeId),
        `${veh.id} waypoint ${i} does not continue from waypoint ${i - 1}`
      );
      assert.equal(
        engine.graph.isTurnForbidden(wps[i - 1].edgeId, wps[i].edgeId),
        false,
        `${veh.id} takes a forbidden turn at waypoint ${i}`
      );
    }
  }
}

test('coverage does not advance without simulated time', () => {
  const engine = fallbackEngine();
  const first = engine.stepCoverage({ nowMs: T0 });
  assert.equal(first.coverage.coveredEdges, 0);
  assert.equal(first.coverage.isComplete, false);
  assert.equal(first.vehicles.length, 50);
  assertContiguous(engine, first);

  // The removed sweep parameters must not mark anything covered.
  const again = engine.stepCoverage({ nowMs: T0, sweepTo100: true, sweepEdgesCount: 250000 });
  assert.equal(again.coverage.coveredEdges, 0);
});

test('an edge counts as covered only once a vehicle has driven it end to end', () => {
  const engine = fallbackEngine();
  engine.stepCoverage({ nowMs: T0, speedMultiplier: 1 });
  const firstEdgeSec = Math.min(
    ...engine.stepCoverage({ nowMs: T0 }).vehicles.map((v) => v.waypoints[0].durationSec)
  );

  // Half of the shortest first edge: every vehicle is still mid-edge.
  const mid = engine.stepCoverage({ nowMs: T0 + (firstEdgeSec / 2) * 1000 });
  assert.equal(mid.coverage.coveredEdges, 0);
  assert.ok(mid.vehicles.every((v) => v.progressSec > 0));

  // Long enough for everyone to finish at least their first edge. Wall time is
  // capped at 15 s per call, so advance in 15 s ticks at 1x.
  let now = T0 + (firstEdgeSec / 2) * 1000;
  let later = mid;
  for (let i = 0; i < 40; i++) {
    now += 15_000;
    later = engine.stepCoverage({ nowMs: now });
  }
  assert.ok(later.coverage.coveredEdges > 0);
  const distinctDriven = new Set();
  for (const v of later.vehicles) assert.ok(v.odometerKm > 0, `${v.id} drove nothing`);
  assert.ok(later.vehicles.some((v) => v.edgesCovered >= 1));
  for (const seg of later.coveredSegmentsSample) distinctDriven.add(seg.edgeId);
  assert.equal(later.coverage.coveredEdges, distinctDriven.size);
  assertContiguous(engine, later);
});

test('the fleet reaches 100% by driving, with no relocations on a connected ring', () => {
  const engine = fallbackEngine();
  let now = T0;
  let state = engine.stepCoverage({ nowMs: now, speedMultiplier: 250 });
  for (let i = 0; i < 400 && !state.coverage.isComplete; i++) {
    now += 15_000;
    state = engine.stepCoverage({ nowMs: now });
    assertContiguous(engine, state);
  }
  assert.equal(state.coverage.isComplete, true);
  assert.equal(state.coverage.coveredEdges, engine.graph.totalDrivableEdges);
  assert.equal(state.coverage.relocations, 0);
  assert.ok(state.simSeconds > 0);
  assert.ok(state.vehicles.every((v) => v.status === 'patrol' || v.status === 'waiting'));

  const reset = engine.resetCoverage({ nowMs: now });
  assert.equal(reset.coverage.coveredEdges, 0);
  assert.equal(reset.simSeconds, 0);
});

test('turn restrictions are obeyed and unreachable pockets are reported as relocations', () => {
  // 0 -A-> 1 -B-> 2 -D-> 0 forms the ring; 1 -C-> 3 -E-> 0 is a side pocket.
  // An `only_straight_on` from way A at node 1 forbids 1->3 and 1->0, so the
  // pocket can never be entered legally and must be reached by relocation.
  const base = { lat: 1.3327, lng: 103.8479 };
  const nodes = [
    { id: 0, lat: base.lat, lng: base.lng },
    { id: 1, lat: base.lat, lng: base.lng + 0.001 },
    { id: 2, lat: base.lat, lng: base.lng + 0.002 },
    { id: 3, lat: base.lat + 0.001, lng: base.lng + 0.001 },
  ];
  const mk = (from, to, wayId) => ({
    from, to, wayId, length: 110, seconds: 20, maxspeed: 50, highway: 'residential', name: `way ${wayId}`,
  });
  const edges = [mk(0, 1, 10), mk(1, 2, 20), mk(2, 0, 40), mk(1, 3, 30), mk(3, 0, 50), mk(1, 0, 10)];
  const graph = {
    nodes,
    edges,
    turnRestrictions: [{ viaNode: 1, fromWayId: 10, toWayId: 20, type: 'only_straight_on' }],
    trafficSignalNodes: [],
  };
  const engine = createSafeSpotFleetEngine({ graph, now: () => T0 });
  assert.equal(engine.graph.isTurnForbidden(0, 3), true);
  assert.equal(engine.graph.isTurnForbidden(0, 1), false);

  let now = T0;
  let state = engine.stepCoverage({ nowMs: now, speedMultiplier: 250 });
  let sawRelocation = false;
  for (let i = 0; i < 200 && !state.coverage.isComplete; i++) {
    now += 15_000;
    state = engine.stepCoverage({ nowMs: now });
    assertContiguous(engine, state);
    if (state.vehicles.some((v) => v.relocated)) sawRelocation = true;
  }
  assert.equal(state.coverage.isComplete, true);
  assert.ok(state.coverage.relocations >= 1, 'pocket edges need a reported relocation');
  assert.equal(sawRelocation, true);
});
