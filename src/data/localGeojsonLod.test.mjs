// src/data/localGeojsonLod.test.mjs
// Pure LOD-engine tests for the bundled local-infrastructure layers:
// camera-height budget bands (inverted sense vs CCTV), importance+proximity
// ranking with an incumbency bonus, in-view filtering, dedupe, and the
// ported eviction-grace planner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INFRA_LOD_ACTIVE_MIN,
  INFRA_LOD_ACTIVE_MID,
  INFRA_LOD_ACTIVE_MAX,
  INFRA_LOD_GLOBAL_HEIGHT_M,
  INFRA_LOD_REGIONAL_HEIGHT_M,
  INFRA_LOD_INCUMBENT_BONUS,
  INFRA_LOD_FAR_M,
  INFRA_LOD_MAX_DISTANCE_PENALTY,
  INFRA_LOD_GRACE_PASSES,
  INFRA_LOD_GRACE_MS,
  infraLodBudget,
  infraRankScore,
  selectInfraLod,
  applyInfraEvictionGrace,
  INFRA_LOD_MOTION_PROBE_INTERVAL_MS,
  INFRA_LOD_MOTION_EPSILON_RATIO,
  INFRA_LOD_MOTION_EPSILON_MIN_M,
  infraLodMotionEpsilonM,
  shouldRecomputeInfraLod,
} from './localGeojsonLod.js';

/**
 * `count` in-view candidates. index 0 is the most important (highest priority)
 * and the nearest; importance and distance both worsen with index.
 */
function candidates(count, options = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `f-${String(index).padStart(3, '0')}`,
    priority: 1000 - index,
    distanceM: index * 1000,
    inView: options.hiddenAt !== index,
  }));
}

/* ----------------------------- budget ----------------------------- */

test('infraLodBudget clamps hardest at global height and opens up as you zoom in', () => {
  assert.equal(INFRA_LOD_ACTIVE_MIN, 80);
  assert.equal(INFRA_LOD_ACTIVE_MID, 200);
  assert.equal(INFRA_LOD_ACTIVE_MAX, 420);
  assert.deepEqual(infraLodBudget(9_000_000), { activeLimit: INFRA_LOD_ACTIVE_MIN });
  assert.deepEqual(infraLodBudget(1_000_000), { activeLimit: INFRA_LOD_ACTIVE_MID });
  assert.deepEqual(infraLodBudget(50_000), { activeLimit: INFRA_LOD_ACTIVE_MAX });
});

test('infraLodBudget band boundaries are inclusive at the lower edge', () => {
  assert.deepEqual(infraLodBudget(INFRA_LOD_GLOBAL_HEIGHT_M), { activeLimit: INFRA_LOD_ACTIVE_MIN });
  assert.deepEqual(infraLodBudget(INFRA_LOD_GLOBAL_HEIGHT_M - 1), { activeLimit: INFRA_LOD_ACTIVE_MID });
  assert.deepEqual(infraLodBudget(INFRA_LOD_REGIONAL_HEIGHT_M), { activeLimit: INFRA_LOD_ACTIVE_MID });
  assert.deepEqual(infraLodBudget(INFRA_LOD_REGIONAL_HEIGHT_M - 1), { activeLimit: INFRA_LOD_ACTIVE_MAX });
});

test('infraLodBudget uses the global band for non-finite height and clamps negative height to zero', () => {
  assert.deepEqual(infraLodBudget(undefined), { activeLimit: INFRA_LOD_ACTIVE_MIN });
  assert.deepEqual(infraLodBudget(NaN), { activeLimit: INFRA_LOD_ACTIVE_MIN });
  assert.deepEqual(infraLodBudget(Number.POSITIVE_INFINITY), { activeLimit: INFRA_LOD_ACTIVE_MIN });
  assert.deepEqual(infraLodBudget(-1), { activeLimit: INFRA_LOD_ACTIVE_MAX }); // max(0,-1) -> 0 -> closest band
});

/* ------------------------------ rank ----------------------------- */

test('infraRankScore is priority minus a bounded distance penalty', () => {
  assert.equal(infraRankScore(1000, 0, false), 1000);
  assert.equal(infraRankScore(1000, INFRA_LOD_FAR_M, false), 1000 - INFRA_LOD_MAX_DISTANCE_PENALTY);
  // half-way to FAR -> half the penalty
  assert.equal(infraRankScore(1000, INFRA_LOD_FAR_M / 2, false), 1000 - INFRA_LOD_MAX_DISTANCE_PENALTY / 2);
  // beyond FAR the penalty is capped, not extrapolated
  assert.equal(infraRankScore(1000, INFRA_LOD_FAR_M * 10, false), 1000 - INFRA_LOD_MAX_DISTANCE_PENALTY);
});

test('infraRankScore incumbency bonus reorders within a tier but never beats a name gap', () => {
  // Two similarly-important features: incumbency flips the order.
  const freshNear = infraRankScore(900, 0, false);
  const incumbentFar = infraRankScore(900, INFRA_LOD_FAR_M, true);
  assert.ok(incumbentFar > freshNear);

  // An unnamed incumbent (priority ~60) must NOT outrank a fresh named feature
  // (priority ~1000): the incumbency bonus is smaller than that gap.
  const unnamedIncumbent = infraRankScore(60, 0, true);
  const namedFresh = infraRankScore(1000, INFRA_LOD_FAR_M, false);
  assert.ok(namedFresh > unnamedIncumbent);
  assert.ok(INFRA_LOD_INCUMBENT_BONUS < 700);
});

test('infraRankScore normalizes garbage inputs to a finite number', () => {
  assert.equal(infraRankScore(NaN, NaN, false), 0 - INFRA_LOD_MAX_DISTANCE_PENALTY); // priority 0, distance -> FAR
  assert.equal(Number.isFinite(infraRankScore('x', -5, true)), true);
  assert.equal(infraRankScore(500, -5, false), 500 - INFRA_LOD_MAX_DISTANCE_PENALTY); // negative dist -> FAR
});

/* --------------------------- selectInfraLod ---------------------- */

test('selectInfraLod returns everything in view when under budget', () => {
  const { activeIds, budget } = selectInfraLod(candidates(10), { cameraHeightM: 9_000_000 });
  assert.equal(budget.activeLimit, INFRA_LOD_ACTIVE_MIN);
  assert.equal(activeIds.length, 10);
  assert.deepEqual(activeIds.slice(0, 3), ['f-000', 'f-001', 'f-002']);
});

test('selectInfraLod caps at the global budget and keeps the most important', () => {
  const { activeIds } = selectInfraLod(candidates(500), { cameraHeightM: 9_000_000 });
  assert.equal(activeIds.length, INFRA_LOD_ACTIVE_MIN);
  assert.equal(activeIds[0], 'f-000');
  assert.equal(activeIds.at(-1), `f-${String(INFRA_LOD_ACTIVE_MIN - 1).padStart(3, '0')}`);
});

test('selectInfraLod cap follows the zoom band', () => {
  assert.equal(selectInfraLod(candidates(600), { cameraHeightM: 9_000_000 }).activeIds.length, INFRA_LOD_ACTIVE_MIN);
  assert.equal(selectInfraLod(candidates(600), { cameraHeightM: 1_000_000 }).activeIds.length, INFRA_LOD_ACTIVE_MID);
  assert.equal(selectInfraLod(candidates(600), { cameraHeightM: 50_000 }).activeIds.length, INFRA_LOD_ACTIVE_MAX);
});

test('selectInfraLod excludes out-of-view records', () => {
  const input = candidates(20, { hiddenAt: 0 });
  const { activeIds } = selectInfraLod(input, { cameraHeightM: 50_000 });
  assert.equal(activeIds.includes('f-000'), false);
  assert.equal(activeIds.length, 19);
});

test('selectInfraLod orders by score: a near unnamed node never displaces a far named one', () => {
  const input = [
    { id: 'named-far', priority: 1000, distanceM: INFRA_LOD_FAR_M, inView: true },
    { id: 'unnamed-near', priority: 60, distanceM: 0, inView: true },
  ];
  const { activeIds } = selectInfraLod(input, { cameraHeightM: 9_000_000 });
  assert.deepEqual(activeIds, ['named-far', 'unnamed-near']);
});

test('selectInfraLod proximity breaks ties among equally important features', () => {
  const input = [
    { id: 'far', priority: 500, distanceM: 5_000_000, inView: true },
    { id: 'near', priority: 500, distanceM: 1_000, inView: true },
  ];
  const { activeIds } = selectInfraLod(input, { cameraHeightM: 9_000_000 });
  assert.deepEqual(activeIds, ['near', 'far']);
});

test('selectInfraLod incumbency keeps a budget-edge stem that would otherwise be cut', () => {
  const base = candidates(INFRA_LOD_ACTIVE_MIN + 5, {});
  // The record that sits just past the cap:
  const edgeId = `f-${String(INFRA_LOD_ACTIVE_MIN).padStart(3, '0')}`;
  const withoutIncumbency = selectInfraLod(base, { cameraHeightM: 9_000_000 });
  assert.equal(withoutIncumbency.activeIds.includes(edgeId), false);

  const withIncumbency = selectInfraLod(base, {
    cameraHeightM: 9_000_000,
    incumbentIds: new Set([edgeId]),
  });
  assert.equal(withIncumbency.activeIds.includes(edgeId), true);
  assert.equal(withIncumbency.activeIds.length, INFRA_LOD_ACTIVE_MIN);
});

test('selectInfraLod accepts an array or a Set of incumbent ids', () => {
  const base = candidates(INFRA_LOD_ACTIVE_MIN + 3, {});
  const edgeId = `f-${String(INFRA_LOD_ACTIVE_MIN).padStart(3, '0')}`;
  const viaArray = selectInfraLod(base, { cameraHeightM: 9_000_000, incumbentIds: [edgeId] });
  assert.equal(viaArray.activeIds.includes(edgeId), true);
});

test('selectInfraLod collapses duplicate ids to their best-scoring representative', () => {
  const input = [
    { id: 'dup', priority: 100, distanceM: INFRA_LOD_FAR_M, inView: true },
    { id: 'dup', priority: 900, distanceM: 0, inView: true },
    { id: 'other', priority: 500, distanceM: 0, inView: true },
  ];
  const { activeIds } = selectInfraLod(input, { cameraHeightM: 9_000_000 });
  assert.deepEqual(activeIds, ['dup', 'other']);
  assert.equal(activeIds.filter((id) => id === 'dup').length, 1);
});

test('selectInfraLod is defensive about junk input', () => {
  assert.deepEqual(selectInfraLod(null, {}).activeIds, []);
  assert.deepEqual(selectInfraLod(undefined).activeIds, []);
  assert.deepEqual(
    selectInfraLod([null, {}, { id: '' }, { id: 'x', inView: false }], { cameraHeightM: 1000 }).activeIds,
    [],
  );
});

test('selectInfraLod produces a deterministic order for score+distance ties', () => {
  const input = [
    { id: 'b', priority: 500, distanceM: 1000, inView: true },
    { id: 'a', priority: 500, distanceM: 1000, inView: true },
    { id: 'c', priority: 500, distanceM: 1000, inView: true },
  ];
  const { activeIds } = selectInfraLod(input, { cameraHeightM: 50_000 });
  assert.deepEqual(activeIds, ['a', 'b', 'c']);
});

/* ---------------------- applyInfraEvictionGrace ------------------ */

test('applyInfraEvictionGrace keeps every selected id and starts no grace for them', () => {
  const out = applyInfraEvictionGrace({
    selectedIds: ['a', 'b'],
    builtIds: ['a', 'b'],
    nowMs: 1000,
  });
  assert.deepEqual(out.keepIds.sort(), ['a', 'b']);
  assert.deepEqual(out.evictIds, []);
  assert.equal(out.graceState.size, 0);
});

test('applyInfraEvictionGrace holds a dropped stem through the grace window then evicts it', () => {
  let grace = new Map();
  // pass 1: 'x' built but not selected -> graced (miss 1)
  let out = applyInfraEvictionGrace({ selectedIds: ['a'], builtIds: ['a', 'x'], graceState: grace, nowMs: 0 });
  assert.deepEqual(out.keepIds.sort(), ['a', 'x']);
  assert.deepEqual(out.evictIds, []);
  grace = out.graceState;

  // pass 2: still missing -> miss 2, still within gracePasses (2)
  out = applyInfraEvictionGrace({ selectedIds: ['a'], builtIds: ['a', 'x'], graceState: grace, nowMs: 10 });
  assert.equal(out.keepIds.includes('x'), true);
  grace = out.graceState;

  // pass 3: miss 3 > gracePasses -> evicted
  out = applyInfraEvictionGrace({ selectedIds: ['a'], builtIds: ['a', 'x'], graceState: grace, nowMs: 20 });
  assert.deepEqual(out.evictIds, ['x']);
  assert.equal(out.keepIds.includes('x'), false);
  assert.equal(out.graceState.has('x'), false);
});

test('applyInfraEvictionGrace evicts on wall-clock even before the pass count', () => {
  const grace = new Map([['x', { misses: 1, since: 0 }]]);
  const out = applyInfraEvictionGrace({
    selectedIds: [],
    builtIds: ['x'],
    graceState: grace,
    nowMs: INFRA_LOD_GRACE_MS,
    gracePasses: 99,
  });
  assert.deepEqual(out.evictIds, ['x']);
});

test('applyInfraEvictionGrace never exceeds the cap: oldest-in-grace evicted first', () => {
  const grace = new Map([
    ['old', { misses: 1, since: 0 }],
    ['mid', { misses: 1, since: 5 }],
    ['new', { misses: 1, since: 9 }],
  ]);
  const out = applyInfraEvictionGrace({
    selectedIds: ['s1', 's2'],
    builtIds: ['s1', 's2', 'old', 'mid', 'new'],
    graceState: grace,
    nowMs: 10,
    activeLimit: 3, // room for only ONE graced stem on top of s1,s2
  });
  assert.deepEqual(out.keepIds.slice(0, 2).sort(), ['s1', 's2']);
  assert.equal(out.keepIds.includes('new'), true);
  assert.deepEqual(out.evictIds.sort(), ['mid', 'old']);
});

test('applyInfraEvictionGrace does not mutate the graceState it was given', () => {
  const grace = new Map([['x', { misses: 1, since: 0 }]]);
  const snapshot = JSON.stringify([...grace]);
  applyInfraEvictionGrace({ selectedIds: [], builtIds: ['x'], graceState: grace, nowMs: 5 });
  assert.equal(JSON.stringify([...grace]), snapshot);
});

test('applyInfraEvictionGrace tolerates missing / malformed input', () => {
  const out = applyInfraEvictionGrace();
  assert.deepEqual(out.keepIds, []);
  assert.deepEqual(out.evictIds, []);
  assert.equal(out.graceState instanceof Map, true);

  const out2 = applyInfraEvictionGrace({ selectedIds: ['a', '', null], builtIds: [null, 'a', 3] });
  assert.deepEqual(out2.keepIds, ['a']);
});

test('grace constants are the documented defaults', () => {
  assert.equal(INFRA_LOD_GRACE_PASSES, 2);
  assert.equal(INFRA_LOD_GRACE_MS, 4_000);
});

/* -------------------------- motion fallback ------------------------- */

test('infraLodMotionEpsilonM scales with camera height above a fixed floor', () => {
  assert.equal(INFRA_LOD_MOTION_EPSILON_RATIO, 0.02);
  assert.equal(INFRA_LOD_MOTION_EPSILON_MIN_M, 250);
  // Well above the floor: pure ratio.
  assert.equal(infraLodMotionEpsilonM(3_000_000), 60_000);
  assert.equal(infraLodMotionEpsilonM(1_000_000), 20_000);
  // Near the surface the floor wins, so a low camera still needs real travel.
  assert.equal(infraLodMotionEpsilonM(5_000), INFRA_LOD_MOTION_EPSILON_MIN_M);
  assert.equal(infraLodMotionEpsilonM(0), INFRA_LOD_MOTION_EPSILON_MIN_M);
});

test('infraLodMotionEpsilonM falls back to the floor (most eager) on unreadable height', () => {
  // Opposite polarity to infraLodBudget on purpose: a missed recompute empties
  // the layer, a surplus one costs a single bounded pass.
  assert.equal(infraLodMotionEpsilonM(undefined), INFRA_LOD_MOTION_EPSILON_MIN_M);
  assert.equal(infraLodMotionEpsilonM(NaN), INFRA_LOD_MOTION_EPSILON_MIN_M);
  assert.equal(infraLodMotionEpsilonM(Number.POSITIVE_INFINITY), INFRA_LOD_MOTION_EPSILON_MIN_M);
  assert.equal(infraLodMotionEpsilonM(-9_000), INFRA_LOD_MOTION_EPSILON_MIN_M);
});

test('shouldRecomputeInfraLod recomputes once the camera has moved far enough', () => {
  const out = shouldRecomputeInfraLod({
    nowMs: 10_000,
    lastProbeMs: 0,
    movedSqM: 500_000 ** 2, // 500 km >> the 60 km epsilon at 3,000 km up
    cameraHeightM: 3_000_000,
  });
  assert.equal(out.recompute, true);
  assert.equal(out.lastProbeMs, 10_000, 'the window re-arms at this pass');
});

test('shouldRecomputeInfraLod holds the window shut inside the probe interval', () => {
  const out = shouldRecomputeInfraLod({
    nowMs: 500,
    lastProbeMs: 0,
    movedSqM: 9_000_000 ** 2, // enormous motion, but the rate limit comes first
    cameraHeightM: 3_000_000,
    probeIntervalMs: INFRA_LOD_MOTION_PROBE_INTERVAL_MS,
  });
  assert.equal(out.recompute, false);
  assert.equal(out.lastProbeMs, 0, 'a shut window does not re-arm');
});

test('shouldRecomputeInfraLod spends nothing on a parked camera', () => {
  const out = shouldRecomputeInfraLod({
    nowMs: 60_000,
    lastProbeMs: 0,
    movedSqM: 0,
    cameraHeightM: 3_000_000,
  });
  assert.equal(out.recompute, false);
  assert.equal(out.lastProbeMs, 60_000, 'the window still re-arms, so the probe stays on a fixed cadence');
});

test('shouldRecomputeInfraLod ignores sub-epsilon jitter but accumulates real travel', () => {
  const height = 1_000_000; // epsilon 20,000 m
  const jitter = shouldRecomputeInfraLod({
    nowMs: 5_000, lastProbeMs: 0, movedSqM: 19_999 ** 2, cameraHeightM: height,
  });
  assert.equal(jitter.recompute, false);
  // Travel is measured from the last SELECTION, so a creeping camera keeps
  // closing on the epsilon across windows instead of resetting every pass.
  const crept = shouldRecomputeInfraLod({
    nowMs: 10_000, lastProbeMs: 5_000, movedSqM: 20_001 ** 2, cameraHeightM: height,
  });
  assert.equal(crept.recompute, true);
});

test('shouldRecomputeInfraLod opens on first use and tolerates missing / malformed input', () => {
  // No prior probe: the window is open immediately.
  const first = shouldRecomputeInfraLod({ nowMs: 1_000, movedSqM: 5_000 ** 2, cameraHeightM: 50_000 });
  assert.equal(first.recompute, true);
  assert.equal(first.lastProbeMs, 1_000);

  const empty = shouldRecomputeInfraLod();
  assert.equal(empty.recompute, false, 'no motion reported means no recompute');
  assert.equal(empty.lastProbeMs, 0);

  const garbage = shouldRecomputeInfraLod({
    nowMs: NaN, lastProbeMs: NaN, movedSqM: NaN, cameraHeightM: NaN, probeIntervalMs: NaN,
  });
  assert.equal(garbage.recompute, false);

  // An explicit epsilon overrides the height scale.
  const explicit = shouldRecomputeInfraLod({
    nowMs: 2_000, lastProbeMs: 0, movedSqM: 300 ** 2, cameraHeightM: 9_000_000, motionEpsilonM: 100,
  });
  assert.equal(explicit.recompute, true);
});

test('motion-fallback constants are the documented defaults', () => {
  assert.equal(INFRA_LOD_MOTION_PROBE_INTERVAL_MS, 1_000);
  assert.equal(INFRA_LOD_MOTION_EPSILON_RATIO, 0.02);
  assert.equal(INFRA_LOD_MOTION_EPSILON_MIN_M, 250);
});
