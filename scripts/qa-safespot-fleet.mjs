#!/usr/bin/env node
/**
 * QA: drive the SafeSpot autonomous fleet over the real Singapore road graph
 * and verify that coverage is earned honestly.
 *
 *   node scripts/qa-safespot-fleet.mjs [--max-steps=N] [--wall-step-ms=15000] [--speed=250]
 *
 * Each step advances the engine by `wall-step-ms` of wall time at `speed`×,
 * checks every vehicle's planned track is contiguous and legal, and prints
 * coverage, relocations (teleports) and waiting vehicles. Exits non-zero if a
 * track is discontinuous, a forbidden turn is planned, or coverage never completes.
 */
import { createSafeSpotFleetEngine } from '../server/providers/safespot-fleet-engine.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);
const MAX_STEPS = Number(args['max-steps'] || 120);
const WALL_STEP_MS = Number(args['wall-step-ms'] || 15000);
const SPEED = Number(args.speed || 250);

const t0 = Date.now();
const engine = createSafeSpotFleetEngine();
console.log(
  `graph loaded in ${Date.now() - t0}ms: ${engine.graph.edgeCount} edges, ${engine.graph.totalDrivableEdges} drivable, ${engine.graph.reachableEdges} legally reachable from core, ${engine.graph.droppedRestrictions} unsatisfiable only_* restrictions dropped`
);

let now = 1_000_000;
let state = engine.stepCoverage({ nowMs: now, speedMultiplier: SPEED });
let violations = 0;
let maxStepMs = 0;
let totalStepMs = 0;

function checkTracks(s) {
  for (const veh of s.vehicles) {
    const wps = veh.waypoints;
    for (let i = 1; i < wps.length; i++) {
      const prev = wps[i - 1].edgeId;
      const cur = wps[i].edgeId;
      if (engine.graph.edgeFrom(cur) !== engine.graph.edgeTo(prev)) {
        violations++;
        console.error(`DISCONTINUITY ${veh.id} wp${i}: ${prev} -> ${cur}`);
      } else if (engine.graph.isTurnForbidden(prev, cur)) {
        violations++;
        console.error(`FORBIDDEN TURN ${veh.id} wp${i}: ${prev} -> ${cur}`);
      }
      if (!engine.graph.vehicleMayUse(cur, veh.vehicleType)) {
        violations++;
        console.error(`CLASS VIOLATION ${veh.id} on edge ${cur}`);
      }
    }
  }
}

checkTracks(state);
for (let step = 1; step <= MAX_STEPS && !state.coverage.isComplete; step++) {
  now += WALL_STEP_MS;
  const s0 = Date.now();
  state = engine.stepCoverage({ nowMs: now });
  const ms = Date.now() - s0;
  maxStepMs = Math.max(maxStepMs, ms);
  totalStepMs += ms;
  checkTracks(state);
  const c = state.coverage;
  console.log(
    `step ${String(step).padStart(3)} | sim ${(state.simSeconds / 3600).toFixed(2)}h | ` +
      `${c.coveragePct.toFixed(2)}% (${c.coveredEdges}/${c.totalDrivableEdges}) | ` +
      `claimed ${c.claimedEdges} | waiting ${c.waitingVehicles} | reloc ${c.relocations} | ` +
      `fleet ${c.fleetDistanceKm} km | ${ms}ms`
  );
}

const c = state.coverage;
console.log('---');
console.log(`complete: ${c.isComplete} at ${c.coveragePct}% after ${(state.simSeconds / 3600).toFixed(2)} sim-hours`);
console.log(`relocations (teleports): ${c.relocations}`);
console.log(`track violations: ${violations}`);
console.log(`step time: max ${maxStepMs}ms, mean ${(totalStepMs / Math.max(1, MAX_STEPS)).toFixed(1)}ms`);
console.log(`one-way ${c.coveredOneWayEdges}/${c.totalOneWayEdges}, two-way ${c.coveredTwoWayEdges}/${c.totalTwoWayEdges}`);

if (violations > 0 || !c.isComplete) process.exit(1);
