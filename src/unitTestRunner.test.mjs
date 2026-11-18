import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOCATION_TEST_FILES,
  UNIT_TEST_ROOTS,
  allocationTestArgs,
  assertCalibratedAllocationRuntime,
  buildUnitTestPlan,
  discoverUnitTestFiles,
  isCalibratedAllocationRuntime,
} from '../scripts/run-unit-tests.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/** Every `*.test.mjs` a contributor could add, found without consulting the runner. */
function testFilesOnDisk(root) {
  // Build outputs and dependencies are not places a contributor writes a test,
  // and walking them would be slow enough to matter. Everything else counts.
  const skip = new Set(['node_modules', 'dist', 'build', 'public']);
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
        found.push(path.relative(root, absolute).split(path.sep).join('/'));
      }
    }
  };
  visit(root);
  return found.sort();
}

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

test('the runner discovers every test file in the repository', () => {
  // CI's unit-test job runs `npm test`, which runs exactly what this function
  // returns. A `*.test.mjs` outside the searched roots therefore never runs
  // there, while still reading — in review and to its author — like covered
  // code. Compare the two sets rather than their sizes, so the failure names the
  // files instead of only disagreeing about a count. The final equality also
  // catches the reverse: files the runner finds that this walk skips.
  const discovered = discoverUnitTestFiles(repositoryRoot);
  const onDisk = testFilesOnDisk(repositoryRoot);
  const undiscovered = onDisk.filter((file) => !discovered.includes(file));
  assert.deepEqual(
    undiscovered,
    [],
    `test files the runner never executes: ${undiscovered.join(', ')}`,
  );
  assert.deepEqual(discovered, onDisk);
  for (const file of discovered) {
    assert.ok(
      UNIT_TEST_ROOTS.some((root) => file.startsWith(`${root}/`)),
      `${file} should sit under one of ${UNIT_TEST_ROOTS.join(', ')}`,
    );
  }
});

test('allocation runtime calibration covers both supported Node majors', () => {
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

test('npm test calibrates both supported engines while retaining off-range warnings', () => {
  // package.json wiring: `npm test` must invoke this runner, and the engines
  // range it advertises must not be narrower than what the runner tolerates.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test, 'node scripts/run-unit-tests.mjs');
  const enginesNode = String(pkg.engines?.node || '');
  assert.ok(enginesNode, 'engines.node must be declared');
  // Unsupported runtimes only skip probes without the explicit opt-in hard gate.
  // Node 26 is calibrated and runs those probes with the same budgets.
  const runner = readFileSync(new URL('../scripts/run-unit-tests.mjs', import.meta.url), 'utf8');
  assert.match(runner, /GEV_REQUIRE_ALLOCATION_GATE/);
  assert.match(runner, /SKIPPED .*allocation microbenchmarks/);
});
