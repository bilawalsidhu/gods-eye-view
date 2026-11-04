#!/usr/bin/env node
import assert from 'node:assert/strict';
import { advanceSpriteFocus } from '../src/data/focusDeemphasis.js';
import { aircraftTreatmentAlpha } from '../src/data/aircraftRecession.js';
import { createIconSet } from '../src/data/iconSet.js';

if (typeof global.gc !== 'function') {
  throw new Error('focus-allocation-check.mjs requires node --expose-gc');
}

const CALLS = 100_000;
const TRIALS = 9;
const WARMUP_CALLS = 200_000;
const PURE_CALL_BUDGET = 16;
const PRODUCTION_SPRITE_TICK_BUDGET = 212;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function bytesPerCall(fn) {
  for (let index = 0; index < WARMUP_CALLS; index += 1) fn();
  const samples = [];
  for (let trial = 0; trial < TRIALS; trial += 1) {
    global.gc();
    const before = process.memoryUsage().heapUsed;
    let checksum = 0;
    for (let index = 0; index < CALLS; index += 1) checksum += fn();
    const after = process.memoryUsage().heapUsed;
    // Keep the returned scalar observable so V8 cannot delete the calls.
    assert.ok(Number.isFinite(checksum));
    samples.push((after - before) / CALLS);
  }
  const rawMedian = median(samples);
  return { rawMedian, samples };
}

function netOfLoopBaseline(observed, baseline) {
  // V8's callback/checksum loop itself retains roughly one boxed-number word
  // per call until the next collection. Subtract the identically measured
  // no-op loop so this gate reports allocation attributable to the treatment.
  const rawMedian = Math.max(0, observed.rawMedian - baseline.rawMedian);
  return {
    rawMedian,
    roundedMedian: Math.round(rawMedian),
    observedRawMedian: observed.rawMedian,
    baselineRawMedian: baseline.rawMedian,
    samples: observed.samples,
  };
}

const target = {
  screenRect: { left: 0, top: 0, right: 10, bottom: 10 },
  paddingPx: 18,
  cameraDistance: 1000,
};
const sprite = {};
const focusInput = {
  screenPosition: { x: 5, y: 5 },
  cameraDistance: 1200,
  nowMs: 1000,
  target,
};

const aircraftInput = {
  baseAlpha: 1,
  focusFactor: 1,
  cameraDistanceM: 100,
  cameraHeightM: 1000,
};
const icons = createIconSet({ capacity: 4 });
const row = icons.add('sprite', {});

const baseline = bytesPerCall(() => focusInput.nowMs);
const focus = netOfLoopBaseline(
  bytesPerCall(() => advanceSpriteFocus(sprite, focusInput).factor),
  baseline,
);
const aircraft = netOfLoopBaseline(
  bytesPerCall(() => aircraftTreatmentAlpha(aircraftInput)),
  baseline,
);
const productionSpriteTick = netOfLoopBaseline(
  bytesPerCall(() => {
    // Match the hot icon-set focus pass: the caller constructs a fresh option
    // literal, consumes the shared focus result immediately and writes it to
    // the row's focus column (the shader composes it with limb recession).
    const focusResult = advanceSpriteFocus(sprite, {
      screenPosition: focusInput.screenPosition,
      cameraDistance: focusInput.cameraDistance,
      nowMs: focusInput.nowMs,
      target,
    });
    icons.setFocus(row, focusResult.factor);
    return focusResult.factor;
  }),
  baseline,
);

assert.ok(
  focus.roundedMedian <= PURE_CALL_BUDGET,
  `advanceSpriteFocus allocated ${focus.rawMedian.toFixed(3)} B/call median`,
);
assert.ok(
  aircraft.roundedMedian <= PURE_CALL_BUDGET,
  `aircraftTreatmentAlpha allocated ${aircraft.rawMedian.toFixed(3)} B/call median`,
);
assert.ok(
  productionSpriteTick.roundedMedian <= PRODUCTION_SPRITE_TICK_BUDGET,
  `production sprite tick allocated ${productionSpriteTick.rawMedian.toFixed(3)} B/call median`,
);

console.log(
  JSON.stringify({
    callsPerTrial: CALLS,
    trials: TRIALS,
    budgets: {
      pureCall: PURE_CALL_BUDGET,
      productionSpriteTick: PRODUCTION_SPRITE_TICK_BUDGET,
    },
    loopBaseline: baseline,
    advanceSpriteFocus: focus,
    aircraftTreatmentAlpha: aircraft,
    productionSpriteTick,
  }),
);
