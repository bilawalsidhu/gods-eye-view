import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateLayerQuotas, ALLOCATION_WEIGHTED } from './labelArbiter.js';

/**
 * Null harness on the semantic layer weights the WEIGHTED strategy consumes
 * (LAYER_WEIGHTS in src/data/detection.js). The question is the one an
 * unweighted mean fails: if the weights were replaced by noise, would the
 * allocation still come out the same? A weight table that noise reproduces
 * most of the time carries no information and should not be in the code.
 *
 * Measured 2026-09-16 on the seeded fixture below (300 demand vectors x 20
 * random reweightings per capacity):
 *
 *   capacity   random weights in [0.5, 2] reproduce   labels moved vs flat (all 1.0)
 *   16         19.7%                                   0.45  (2.8% of capacity)
 *   32         18.0%                                   0.96  (3.0%)
 *   64         20.5%                                   1.84  (2.9%)
 *   128        31.0%                                   3.36  (2.6%)
 *
 * Reading: the weights are NOT flat (noise reproduces the allocation about a
 * fifth of the time, not three quarters), and what they decide is small: about
 * three labels in a hundred, on top of the sqrt(count) term that does the
 * rest. Both halves are pinned. If a later change makes the weights decisive
 * (moved fraction above 10%) or inert (noise reproduces above 50%), one of
 * these fails and the number that changed is in the message.
 */

/** The shipped table, copied rather than imported: detection.js pulls in Cesium. */
const SHIPPED_WEIGHTS = Object.freeze({
  military: 1.4,
  traffic: 1.15,
  cctv: 1.1,
  flights: 1,
  satellites: 1,
  bikeshare: 0.9,
  'ais-live-vessels': 1,
});
const LAYER_IDS = Object.keys(SHIPPED_WEIGHTS);
const CAPACITIES = [16, 32, 64, 128];
const DEMAND_VECTORS = 300;
const REWEIGHTINGS = 20;

/** Deterministic LCG so the measured numbers above are reproducible. */
function makeRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/** 2..7 active layers, counts log-uniform on [1, 2600] (LAYER_CANDIDATE_CAP). */
function sampleDemand(rnd) {
  const n = 2 + Math.floor(rnd() * 6);
  const ids = LAYER_IDS.slice().sort(() => rnd() - 0.5).slice(0, n);
  const demand = {};
  for (const id of ids) demand[id] = Math.max(1, Math.round(Math.exp(rnd() * Math.log(2600))));
  return demand;
}

function randomWeights(rnd, lo = 0.5, hi = 2) {
  const weights = {};
  for (const id of LAYER_IDS) weights[id] = lo + rnd() * (hi - lo);
  return weights;
}

/** Labels that changed layer between two allocations of the same capacity. */
function labelsMoved(a, b) {
  let sum = 0;
  for (const [layerId, quota] of a) sum += Math.abs(quota - (b.get(layerId) || 0));
  return sum / 2;
}

function identical(a, b) {
  return labelsMoved(a, b) === 0;
}

/** One pass of the harness at one capacity. Pure; the tests read its numbers. */
function runNull(capacity, seed = 7) {
  const rnd = makeRandom(seed);
  let reproduced = 0;
  let trials = 0;
  let movedVsFlat = 0;
  let movedVsRandom = 0;
  for (let i = 0; i < DEMAND_VECTORS; i++) {
    const demand = sampleDemand(rnd);
    const shipped = allocateLayerQuotas(demand, capacity, ALLOCATION_WEIGHTED, SHIPPED_WEIGHTS);
    movedVsFlat += labelsMoved(shipped, allocateLayerQuotas(demand, capacity, ALLOCATION_WEIGHTED, {}));
    for (let k = 0; k < REWEIGHTINGS; k++) {
      const noisy = allocateLayerQuotas(demand, capacity, ALLOCATION_WEIGHTED, randomWeights(rnd));
      if (identical(shipped, noisy)) reproduced++;
      movedVsRandom += labelsMoved(shipped, noisy);
      trials++;
    }
  }
  return {
    capacity,
    reproducedByNoise: reproduced / trials,
    movedVsFlatFraction: movedVsFlat / DEMAND_VECTORS / capacity,
    movedVsRandomFraction: movedVsRandom / trials / capacity,
  };
}

test('noise does not reproduce the shipped weighted allocation most of the time', () => {
  for (const capacity of CAPACITIES) {
    const r = runNull(capacity);
    assert.ok(
      r.reproducedByNoise < 0.5,
      `capacity ${capacity}: random weights reproduced the shipped allocation `
      + `${(100 * r.reproducedByNoise).toFixed(1)}% of the time; the table would be inert`,
    );
  }
});

test('the weights decide a small share of labels on top of sqrt(count)', () => {
  for (const capacity of CAPACITIES) {
    const r = runNull(capacity);
    assert.ok(
      r.movedVsFlatFraction > 0,
      `capacity ${capacity}: shipped weights moved no label against flat weights`,
    );
    assert.ok(
      r.movedVsFlatFraction < 0.10,
      `capacity ${capacity}: shipped weights moved ${(100 * r.movedVsFlatFraction).toFixed(1)}% `
      + 'of labels against flat weights; the table has become a policy, re-pin deliberately',
    );
  }
});

test('the weight vector is scale-invariant, so only ratios carry information', () => {
  const rnd = makeRandom(11);
  for (let i = 0; i < 200; i++) {
    const demand = sampleDemand(rnd);
    const capacity = CAPACITIES[i % CAPACITIES.length];
    const scaled = {};
    for (const id of LAYER_IDS) scaled[id] = SHIPPED_WEIGHTS[id] * 3.7;
    assert.ok(identical(
      allocateLayerQuotas(demand, capacity, ALLOCATION_WEIGHTED, SHIPPED_WEIGHTS),
      allocateLayerQuotas(demand, capacity, ALLOCATION_WEIGHTED, scaled),
    ), `capacity ${capacity}: scaling every weight by one constant changed the allocation`);
  }
});

test('the comparator can see a decisive weight (the harness is not blind)', () => {
  const demand = { military: 400, flights: 400, cctv: 400, traffic: 400 };
  const shipped = allocateLayerQuotas(demand, 64, ALLOCATION_WEIGHTED, SHIPPED_WEIGHTS);
  const decisive = allocateLayerQuotas(demand, 64, ALLOCATION_WEIGHTED, { ...SHIPPED_WEIGHTS, military: 10 });
  assert.ok(labelsMoved(shipped, decisive) >= 10, 'a 10x military weight must move at least 10 of 64 labels');
  assert.ok(decisive.get('military') > shipped.get('military'));
});
