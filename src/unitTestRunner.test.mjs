import { readSource } from './testSupport/readSource.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOCATION_TEST_FILES,
  allocationTestArgs,
  assertCalibratedAllocationRuntime,
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

test('allocation runtime calibration is explicit and pinned to measured Node majors', () => {
  // Every major package.json advertises must be IN the calibrated set; a new
  // major requires a measured calibration pass first (issue #39).
  assert.equal(assertCalibratedAllocationRuntime('24.19.0'), '24.19.0');
  assert.equal(assertCalibratedAllocationRuntime('26.8.2'), '26.8.2');
  assert.throws(
    () => assertCalibratedAllocationRuntime('22.23.1'),
    /calibrated runtime \(Node 24 or 26\)/,
  );
  assert.throws(
    () => assertCalibratedAllocationRuntime('27.0.0'),
    /calibrated runtime \(Node 24 or 26\)/,
  );
  assert.equal(isCalibratedAllocationRuntime('24.19.0'), true);
  assert.equal(isCalibratedAllocationRuntime('22.23.1'), false);
  assert.equal(isCalibratedAllocationRuntime('26.3.0'), true, 'whole 26 major is calibrated');
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
  // Issue #39: every major the package advertises must be a calibrated
  // allocation runtime — CI runs the suite on each of them with the gate
  // required, so an advertised-but-uncalibrated major would fail there.
  const runnerSource = readSource('../scripts/run-unit-tests.mjs', import.meta.url);
  const calibrated = runnerSource.match(/CALIBRATED_ALLOCATION_NODE_MAJORS = Object\.freeze\(new Set\(\[([^\]]+)\]\)\)/);
  assert.ok(calibrated, 'the calibrated major set must stay declared in the runner');
  for (const major of calibrated[1].split(',').map((v) => Number.parseInt(v.trim(), 10))) {
    assert.match(
      enginesNode,
      new RegExp(`>=${major}`),
      `advertised engines must include the calibrated major ${major}`,
    );
  }
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
    /\.\.\.\(coverage \? \['--experimental-test-coverage'\] : \[\]\),/,
    'coverage reporter must be attached inside the parallel battery, never the probes',
  );
  // Root-caused 2026-09-17: trafficTiming.test.mjs boots a vite dev server and
  // ssrLoadModule's the traffic graph, which re-compiles every file a second
  // time under a bare-path filename — c8 merges that transformed copy's
  // near-zero counts into the real ones (flowMatch read 42.97% batch vs 100%
  // solo). Coverage runs must skip it; plain `npm test` still runs it.
  assert.match(runner, /COVERAGE_EXCLUDED_TEST_FILES/);
  assert.match(runner, /underCoverage/);
  assert.match(
    runnerSource,
    /trafficTiming\.test\.mjs/,
    'the vite-ssr test must stay listed as coverage-excluded until its hooks load another way',
  );
});
