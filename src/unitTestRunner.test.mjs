import { readSource } from './testSupport/readSource.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOCATION_TEST_FILES,
  allocationTestArgs,
  assertNode24AllocationRuntime,
  buildUnitTestPlan,
  isCalibratedAllocationRuntime,
} from '../scripts/run-unit-tests.mjs';

test('unit runner serializes only GC-bracketed allocation microbenchmarks', () => {
  const ordinary = [
    'src/data/manager.test.mjs',
    'src/data/radio.test.mjs',
    'src/unitTestRunner.test.mjs',
  ];
  const plan = buildUnitTestPlan([
    ordinary[1],
    ALLOCATION_TEST_FILES[1],
    ordinary[0],
    ALLOCATION_TEST_FILES[0],
    ordinary[2],
  ]);

  assert.deepEqual(plan.parallel, ordinary);
  assert.deepEqual(plan.serializedAllocations, ALLOCATION_TEST_FILES);
  assert.equal(plan.parallel.some((file) => ALLOCATION_TEST_FILES.includes(file)), false);
  for (const file of ALLOCATION_TEST_FILES) {
    assert.deepEqual(allocationTestArgs(file), [
      '--expose-gc', '--test', '--test-concurrency=1', file,
    ]);
  }
  assert.throws(
    () => allocationTestArgs('src/data/radio.test.mjs'),
    /Not an allocation microbenchmark/,
  );
});

test('allocation runtime calibration is explicit and pinned to Node 24', () => {
  assert.equal(assertNode24AllocationRuntime('24.19.0'), '24.19.0');
  assert.throws(
    () => assertNode24AllocationRuntime('22.23.1'),
    /calibrated Node 24 runtime/,
  );
  assert.throws(
    () => assertNode24AllocationRuntime('26.0.0'),
    /calibrated Node 24 runtime/,
  );
  assert.equal(isCalibratedAllocationRuntime('24.19.0'), true);
  assert.equal(isCalibratedAllocationRuntime('22.23.1'), false);
  assert.equal(isCalibratedAllocationRuntime('26.3.0'), false);
});

test('npm test stays green on every supported engine, not only the calibrated one', () => {
  // package.json wiring: `npm test` must invoke this runner, and the engines
  // range it advertises must not be narrower than what the runner tolerates.
  const pkg = JSON.parse(readSource('../package.json', import.meta.url));
  assert.equal(pkg.scripts.test, 'node scripts/run-unit-tests.mjs');
  // Coverage is measured by c8 (raw V8 coverage from every child process):
  // Node's built-in reporter under-reports large heavily-tested files — it
  // credited flights.js 34.80% while raw V8 coverage from the very same test
  // processes recorded those functions executing (c8 measures 75.1%). The
  // runner still owns plan discovery; --parallel-only keeps the allocation
  // probes out, because coverage instrumentation allocates and would fail
  // their calibrated budgets.
  assert.equal(
    pkg.scripts['test:coverage'],
    'c8 node scripts/run-unit-tests.mjs --parallel-only',
    'coverage must go through the same runner, wrapped in c8, parallel-only',
  );
  assert.deepEqual(pkg.c8.include, ['src/**/*.js', 'functions/**/*.js']);
  assert.ok(pkg.c8.exclude.includes('**/*.test.mjs'));
  const enginesNode = String(pkg.engines?.node || '');
  assert.ok(enginesNode, 'engines.node must be declared');
  // The runner throws for uncalibrated runtimes ONLY behind the explicit
  // opt-in env; by default it skips, so a supported non-24 engine cannot fail.
  const runner = readSource('../scripts/run-unit-tests.mjs', import.meta.url);
  assert.match(runner, /GEV_REQUIRE_ALLOCATION_GATE/);
  assert.match(runner, /SKIPPED .*allocation microbenchmarks/);
  assert.match(runner, /parallelOnly/);
  // Coverage must ride the parallel battery only: the allocation probes run
  // WITHOUT the coverage reporter so its overhead can't skew the budgets.
  assert.match(
    runner,
    /coverage\s*\n\s*\?\s*\['--test',\s*'--experimental-test-coverage'/,
  );
});
