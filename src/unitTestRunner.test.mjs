import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('allocation runtime calibration covers every supported Node major', () => {
  assert.equal(assertCalibratedAllocationRuntime('24.19.0'), '24.19.0');
  assert.throws(
    () => assertCalibratedAllocationRuntime('22.23.1'),
    /calibrated Node 24 or 26/,
  );
  assert.equal(assertCalibratedAllocationRuntime('26.0.0'), '26.0.0');
  assert.equal(isCalibratedAllocationRuntime('24.19.0'), true);
  assert.equal(isCalibratedAllocationRuntime('22.23.1'), false);
  assert.equal(isCalibratedAllocationRuntime('26.3.0'), true);
});

test('npm test runs allocation gates on every supported engine', () => {
  // package.json wiring: `npm test` must invoke this runner, and the engines
  // range it advertises must not be narrower than what the runner tolerates.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/run-unit-tests.mjs');
  const enginesNode = String(pkg.engines?.node || '');
  assert.ok(enginesNode, 'engines.node must be declared');
  // Supported Node majors are calibrated; only unsupported runtimes may skip
  // unless the explicit hard-gate environment variable is set.
  const runner = readFileSync(new URL('../scripts/run-unit-tests.mjs', import.meta.url), 'utf8');
  assert.match(runner, /GEV_REQUIRE_ALLOCATION_GATE/);
  assert.match(runner, /SKIPPED .*allocation microbenchmarks/);

  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /node: \[24\.14\.0, 26\.x\]/);
});
