import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOCATION_TEST_FILES,
  UNIT_TEST_ARGV_CHAR_BUDGET,
  UNIT_TEST_NODE_FLAGS,
  UNIT_TEST_ROOTS,
  allocationTestArgs,
  assertCalibratedAllocationRuntime,
  batchUnitTestFiles,
  buildUnitTestPlan,
  discoverUnitTestFiles,
  isCalibratedAllocationRuntime,
  runParallelTestBatches,
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

test('parallel batches stay under the Windows command-line limit (#1631)', () => {
  // Windows caps a spawned command line at 32,767 characters; the parallel
  // suite is ~950 paths and crossed that on a single `node --test` spawn, so
  // `npm test` died with ENAMETOOLONG before running anything. The runner now
  // shards the parallel files — these assertions pin the sharding contract
  // against the real suite, not a fixture, so growth past another batch
  // boundary stays covered.
  const plan = buildUnitTestPlan(discoverUnitTestFiles(repositoryRoot));
  const batches = batchUnitTestFiles(plan.parallel);

  // Nothing lost, nothing reordered, nothing duplicated.
  assert.deepEqual(batches.flat(), plan.parallel);
  assert.ok(batches.length > 0);

  const overhead =
    process.execPath.length + 1 +
    UNIT_TEST_NODE_FLAGS.join(' ').length + 1 +
    '--test'.length;
  for (const batch of batches) {
    // Space per argument plus the two quotes spawnSync adds around a path
    // containing spaces, counted for every path so the bound holds from a
    // checkout under a spaced directory too.
    const chars = overhead + batch.reduce((sum, file) => sum + file.length + 3, 0);
    assert.ok(
      chars <= UNIT_TEST_ARGV_CHAR_BUDGET,
      `batch of ${batch.length} files needs ${chars} characters (budget ${UNIT_TEST_ARGV_CHAR_BUDGET})`,
    );
    assert.ok(
      chars < 32_767,
      `batch of ${batch.length} files needs ${chars} characters, over the Windows limit`,
    );
  }
});

test('batching kicks in for an oversized suite (#1631)', () => {
  // Fixed synthetic input, independent of the repository's suite size and
  // of process.execPath: 500 fixed-length paths need ~41k characters, over
  // the Windows 32,767 limit on any machine, so the guard must split them.
  const synthetic = Array.from(
    { length: 500 },
    (_, index) => `src/${'m'.repeat(60)}/module-${index}.test.mjs`,
  );
  const overhead =
    process.execPath.length + 1 +
    UNIT_TEST_NODE_FLAGS.join(' ').length + 1 +
    '--test'.length;
  const singleChars = overhead + synthetic.reduce((sum, file) => sum + file.length + 3, 0);
  assert.ok(
    singleChars > 32_767,
    `expected the synthetic suite (${singleChars} chars) to exceed the Windows limit`,
  );

  const batches = batchUnitTestFiles(synthetic);
  assert.ok(batches.length > 1, 'synthetic oversized suite must need several batches');
  assert.deepEqual(batches.flat(), synthetic);
  for (const batch of batches) {
    const chars = overhead + batch.reduce((sum, file) => sum + file.length + 3, 0);
    assert.ok(
      chars <= UNIT_TEST_ARGV_CHAR_BUDGET,
      `batch of ${batch.length} files needs ${chars} characters (budget ${UNIT_TEST_ARGV_CHAR_BUDGET})`,
    );
  }
});

test('batching degenerates safely (#1631)', () => {
  // Empty input yields no batches, so the runner never spawns a bare
  // `node --test` (which would rediscover tests outside the plan).
  assert.deepEqual(batchUnitTestFiles([]), []);

  // A single path longer than the whole budget is kept, not dropped.
  const longFile = `src/${'x'.repeat(300)}/solo.test.mjs`;
  assert.deepEqual(batchUnitTestFiles([longFile], 100), [[longFile]]);

  // A tiny budget splits a short list into singles, order preserved.
  const files = ['src/a.test.mjs', 'src/b.test.mjs', 'src/c.test.mjs'];
  const batches = batchUnitTestFiles(files, 1);
  assert.deepEqual(batches, files.map((file) => [file]));
});

test('failing parallel batches still execute later files (#1631)', () => {
  const files = ['src/a.test.mjs', 'src/b.test.mjs', 'src/c.test.mjs'];
  const overhead =
    process.execPath.length + 1 +
    UNIT_TEST_NODE_FLAGS.join(' ').length + 1 +
    '--test'.length;
  const argvCharBudget = overhead + files[0].length + 3;
  const calls = [];
  const statuses = [7, 0, 2];
  const status = runParallelTestBatches(files, {
    argvCharBudget,
    runBatch(args) {
      calls.push(args);
      return statuses[calls.length - 1];
    },
  });

  assert.equal(status, 7, 'first failed batch determines the exit status');
  assert.deepEqual(calls, files.map((file) => ['--test', file]));
  assert.equal(
    runParallelTestBatches([], { runBatch: () => { throw new Error('unexpected spawn'); } }),
    0,
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
