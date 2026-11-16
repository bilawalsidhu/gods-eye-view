import assert from 'node:assert/strict';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import test from 'node:test';
import { perfBudgetTestOptions } from '../../../scripts/run-perf-tests.mjs';
import { denseContinentalRendering } from './renderPerformanceFixtures.mjs';
import { WILDLIFE_MOVE_END_BUDGET_MS } from './performance.js';

const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const percentile95 = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)];

// A GC pause is outside the layer's CPU work. Keep raw wall times in the
// diagnostic and subtract only directly observed, overlapping GC intervals
// for the strict CPU budget; never hide a slow layer phase as an outlier.
function activeMs(slice, collections) {
  const start = slice.startTimeMs;
  const end = start + slice.durationMs;
  return (
    slice.durationMs -
    collections.reduce(
      (sum, gc) =>
        sum +
        Math.max(
          0,
          Math.min(end, gc.startTime + gc.duration) -
            Math.max(start, gc.startTime),
        ),
      0,
    )
  );
}

test(
  'dense continental production moveEnd pipeline yields every 4ms, including cold tiles and real Cesium billboard updates',
  perfBudgetTestOptions(),
  async (t) => {
    // Settle CPU-triggered runtime startup before creating the cold layer;
    // cells, coordinates and billboard collections remain unwarmed.
    const calibrationStart = performance.now();
    let calibrationChecksum = 0;
    for (;;) {
      const cpu = process.threadCpuUsage();
      if (cpu.user + cpu.system >= 1_100_000) break;
      for (let i = 0; i < 65536; i++)
        calibrationChecksum =
          (calibrationChecksum + i) ^ (calibrationChecksum >>> 16);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const runtimeSettleMs = performance.now() - calibrationStart;
    const collections = [];
    const phases = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        (entry.entryType === 'gc' ? collections : phases).push(entry);
    });
    observer.observe({ entryTypes: ['gc', 'measure'] });
    const h = denseContinentalRendering();
    const runs = [];
    try {
      for (let i = 0; i < 65; i++) {
        const start = performance.now();
        assert.equal(h.moveEnd((i % 4) * 3), 'pending');
        const enqueueMs = performance.now() - start;
        const result = h.flush();
        runs.push({
          startTimeMs: start,
          endTimeMs: performance.now(),
          enqueueMs,
          ...result,
        });
        await new Promise((resolve) => setImmediate(resolve));
      }
      await new Promise((resolve) => setImmediate(resolve));
      for (const entry of observer.takeRecords())
        (entry.entryType === 'gc' ? collections : phases).push(entry);
      const warm = runs.slice(25);
      const allSlices = runs.flatMap((run) => run.slices);
      const warmSlices = warm.flatMap((run) => run.slices);
      const activeSlices = allSlices.map((slice) =>
        activeMs(slice, collections),
      );
      const warmTotal = warm.map((run) =>
        run.slices.reduce(
          (sum, slice) => sum + activeMs(slice, collections),
          run.enqueueMs,
        ),
      );
      const enqueueMax = Math.max(...runs.map((run) => run.enqueueMs));
      const coldMax = Math.max(
        ...runs[0].slices.map((slice) => activeMs(slice, collections)),
      );
      const sliceMax = Math.max(...activeSlices);
      if (sliceMax > WILDLIFE_MOVE_END_BUDGET_MS) {
        const slow = allSlices[activeSlices.indexOf(sliceMax)];
        const entries = phases
          .filter(
            (entry) =>
              entry.entryType === 'measure' &&
              entry.name !== 'wildlife-sightings:moveEnd:slice' &&
              entry.startTime >= slow.startTimeMs &&
              entry.startTime < slow.startTimeMs + slow.durationMs,
          )
          .map((entry) => ({
            phase: entry.name,
            durationMs: entry.duration,
            activeMs: activeMs(
              { startTimeMs: entry.startTime, durationMs: entry.duration },
              collections,
            ),
          }));
        t.diagnostic(
          `Slow slice ${JSON.stringify({ slice: slow, phases: entries, gc: collections.map((entry) => ({ start: entry.startTime, duration: entry.duration })), now: performance.now(), uptimeMs: process.uptime() * 1000 })}`,
        );
      }
      assert.ok(
        enqueueMax <= WILDLIFE_MOVE_END_BUDGET_MS,
        `moveEnd enqueue ${enqueueMax.toFixed(3)}ms`,
      );
      assert.ok(
        sliceMax <= WILDLIFE_MOVE_END_BUDGET_MS,
        `longest layer CPU slice ${sliceMax.toFixed(3)}ms exceeds 4ms`,
      );
      assert.ok(
        median(warmTotal) <= WILDLIFE_MOVE_END_BUDGET_MS,
        `median full moveEnd CPU ${median(warmTotal).toFixed(3)}ms exceeds 4ms`,
      );
      assert.equal(warm.at(-1).cartesianBuilds, 0);
      const phaseMeans = Object.fromEntries(
        [
          'density',
          'bucket',
          'rank',
          'billboard-update',
          'overlay-publish',
        ].map((name) => {
          const duration = phases
            .filter(
              (entry) =>
                entry.name === `wildlife-sightings:${name}` &&
                entry.startTime >= warm[0].startTimeMs,
            )
            .reduce(
              (sum, entry) =>
                sum +
                activeMs(
                  {
                    startTimeMs: entry.startTime,
                    durationMs: entry.duration,
                  },
                  collections,
                ),
              0,
            );
          return [name, (duration / warm.length).toFixed(3)];
        }),
      );
      t.diagnostic(
        `6,144 cells + 500 observations, ${runs.at(-1).glowPrimitives} glow splats + ${runs.at(-1).billboards} real icons; moveEnd enqueue max=${enqueueMax.toFixed(3)}ms; cold max CPU slice=${coldMax.toFixed(3)}ms; all max CPU slice=${sliceMax.toFixed(3)}ms; warm total CPU median=${median(warmTotal).toFixed(3)}ms; warm slice p95=${percentile95(warmSlices.map((slice) => activeMs(slice, collections))).toFixed(3)}ms; raw wall slice max=${Math.max(...allSlices.map((slice) => slice.durationMs)).toFixed(3)}ms; observed GC pauses=${collections.length}; repeated Cartesian builds=0; CPU startup calibration=${runtimeSettleMs.toFixed(0)}ms, checksum=${calibrationChecksum} (cold fixture created afterward); warm phase mean ms=${JSON.stringify(phaseMeans)}`,
      );
    } finally {
      h.destroy();
      observer.disconnect();
    }
  },
);
