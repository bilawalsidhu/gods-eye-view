import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ALLOCATION_TEST_FILES = Object.freeze([
  'src/data/focusAllocations.test.mjs',
  'src/overlays/worldOverlayAllocation.test.mjs',
]);

/** Whether this runtime matches a supported major the allocation budgets are calibrated on. */
export function isCalibratedAllocationRuntime(version = process.versions.node) {
  const major = Number.parseInt(String(version).split('.')[0], 10);
  return major === 24 || major === 26;
}

/** Require a runtime on which allocation budgets are calibrated. */
export function assertCalibratedAllocationRuntime(version = process.versions.node) {
  if (!isCalibratedAllocationRuntime(version)) {
    throw new Error(`Allocation budgets require calibrated Node 24 or 26; received ${version}`);
  }
  return version;
}

/**
 * Directories this runner searches for `*.test.mjs`, in stable order.
 *
 * `server/` belongs here because provider modules own tests of their own: a
 * suite placed beside the module it covers must run, and CI's unit-test job runs
 * `npm test`, so a directory missing from this list is a suite that never runs
 * there. `unitTestRunner.test.mjs` asserts the list covers every `*.test.mjs`
 * outside dependencies, build output and dot-directories, so adding a tree
 * without adding it here fails.
 */
export const UNIT_TEST_ROOTS = Object.freeze(['src', 'server']);

/** Discover repository unit tests in stable path order. */
export function discoverUnitTestFiles(root = process.cwd()) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
        files.push(path.relative(root, absolute).split(path.sep).join('/'));
      }
    }
  };
  for (const testRoot of UNIT_TEST_ROOTS) visit(path.join(root, testRoot));
  return files.sort();
}

/** Partition ordinary parallel tests from the two GC-bracketed probes. */
export function buildUnitTestPlan(files) {
  const known = new Set(files);
  const missingAllocationTests = ALLOCATION_TEST_FILES.filter((file) => !known.has(file));
  if (missingAllocationTests.length) {
    throw new Error(`Missing allocation microbenchmarks: ${missingAllocationTests.join(', ')}`);
  }
  const allocationSet = new Set(ALLOCATION_TEST_FILES);
  return {
    parallel: files.filter((file) => !allocationSet.has(file)).sort(),
    serializedAllocations: [...ALLOCATION_TEST_FILES],
  };
}

/** Build the isolated Node invocation for one GC-bracketed allocation probe. */
export function allocationTestArgs(file) {
  if (!ALLOCATION_TEST_FILES.includes(file)) {
    throw new Error(`Not an allocation microbenchmark: ${file}`);
  }
  return ['--expose-gc', '--test', '--test-concurrency=1', file];
}

/** Node flags every unit-test process receives. */
export const UNIT_TEST_NODE_FLAGS = Object.freeze([
  // Single-file components compile on import.
  '--import=./build/registerVue.js',
]);

/**
 * Character budget for one spawned command line (#1631). Windows refuses to
 * start a process whose command line exceeds 32,767 characters, and the
 * parallel suite is ~950 paths — over 33k characters on a single `node
 * --test <files...>`, which died with ENAMETOOLONG before any test ran. The
 * budget counts the executable, the shared flags, one separating space per
 * argument and two quoting characters per path (spawnSync quotes arguments
 * containing spaces, e.g. a checkout under `Mobile Documents`), then keeps a
 * wide margin under the platform limit.
 */
export const UNIT_TEST_ARGV_CHAR_BUDGET = 24_000;

/**
 * Partition the parallel test files into batches whose spawned command line
 * stays under `argvCharBudget` (#1631). Order is preserved, so flattening
 * the batches reproduces the input exactly; a single path longer than the
 * budget still gets its own batch rather than being dropped. An empty input
 * yields no batches, so callers never spawn a bare `node --test` (which
 * would fall back to Node's default test discovery instead of this list).
 */
export function batchUnitTestFiles(files, argvCharBudget = UNIT_TEST_ARGV_CHAR_BUDGET) {
  const overhead =
    process.execPath.length + 1 +
    UNIT_TEST_NODE_FLAGS.join(' ').length + 1 +
    '--test'.length;
  const batches = [];
  let current = [];
  let currentChars = overhead;
  for (const file of files) {
    // Space separator plus the two quotes spawnSync adds around a path that
    // contains spaces; counted unconditionally so the budget holds anywhere.
    const added = file.length + 3;
    if (current.length > 0 && currentChars + added > argvCharBudget) {
      batches.push(current);
      current = [];
      currentChars = overhead;
    }
    current.push(file);
    currentChars += added;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function runTests(args) {
  const result = spawnSync(process.execPath, [...UNIT_TEST_NODE_FLAGS, ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Run all parallel batches and preserve the first non-zero exit status. */
export function runParallelTestBatches(
  files,
  { argvCharBudget = UNIT_TEST_ARGV_CHAR_BUDGET, runBatch = runTests } = {},
) {
  let firstFailure = 0;
  for (const batch of batchUnitTestFiles(files, argvCharBudget)) {
    const status = runBatch(['--test', ...batch]);
    if (firstFailure === 0 && status !== 0) firstFailure = status;
  }
  return firstFailure;
}

export function runUnitTests() {
  const plan = buildUnitTestPlan(discoverUnitTestFiles());
  const parallelStatus = runParallelTestBatches(plan.parallel);
  if (parallelStatus !== 0) return parallelStatus;

  // The GC-bracketed budgets are calibrated on every supported Node major.
  // Unsupported runtimes may still run ordinary tests, so uncalibrated runtimes skip the
  // probes with a warning. Set GEV_REQUIRE_ALLOCATION_GATE=1 (pinned CI /
  // release batteries) to make an uncalibrated runtime a hard failure.
  if (!isCalibratedAllocationRuntime()) {
    if (process.env.GEV_REQUIRE_ALLOCATION_GATE === '1') {
      assertCalibratedAllocationRuntime();
    }
    console.warn(
      `[unit] SKIPPED ${ALLOCATION_TEST_FILES.length} allocation microbenchmarks: `
      + `budgets are calibrated for Node 24 and 26, running ${process.versions.node}. `
      + 'Run under Node 24 or 26 (or set GEV_REQUIRE_ALLOCATION_GATE=1 to fail instead).',
    );
    return 0;
  }
  for (const file of plan.serializedAllocations) {
    const status = runTests(allocationTestArgs(file));
    if (status !== 0) return status;
  }
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) process.exitCode = runUnitTests();
