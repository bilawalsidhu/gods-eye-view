import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ALLOCATION_TEST_FILES = Object.freeze([
  'src/data/focusAllocations.test.mjs',
  'src/overlays/worldOverlayAllocation.test.mjs',
]);

/** Whether this runtime matches the one the allocation budgets were calibrated on. */
export function isCalibratedAllocationRuntime(version = process.versions.node) {
  return Number.parseInt(String(version).split('.')[0], 10) === 24;
}

/** Require the runtime on which allocation budgets were calibrated. */
export function assertNode24AllocationRuntime(version = process.versions.node) {
  if (!isCalibratedAllocationRuntime(version)) {
    throw new Error(`Allocation budgets require the calibrated Node 24 runtime; received ${version}`);
  }
  return version;
}

/** Discover repository unit tests in stable path order. */
export function discoverUnitTestFiles(root = process.cwd()) {
  // src/ (app + co-located tests) and functions/ (Pages Functions, which run
  // in workerd in production and under plain Node here) both carry tests.
  const testRoots = ['src', 'functions'].map((dir) => path.join(root, dir));
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
  for (const testRoot of testRoots) visit(testRoot);
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

function runTests(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runUnitTests({ coverage = false, parallelOnly = false } = {}) {
  const plan = buildUnitTestPlan(discoverUnitTestFiles());
  // Coverage measurement wraps the parallel battery. The GC-bracketed
  // allocation probes never run under it: they measure allocations, not code
  // coverage, and the instrumentation's own allocations contaminate the
  // budgets they exist to protect (verified: the focus probe fails its
  // calibrated median the moment coverage is enabled).
  // `--coverage` uses Node's built-in reporter; `npm run test:coverage` wraps
  // the run in c8 instead. c8 is the honest number: the built-in reporter
  // under-reports large heavily-tested files (it credits flights.js 34.80%
  // while raw V8 coverage from the very same child processes records those
  // functions executing — c8 measures the same file at 75.1%, and agrees with
  // the built-in reporter everywhere the built-in one is not wrong).
  const parallelArgs = coverage
    ? ['--test', '--experimental-test-coverage', ...plan.parallel]
    : ['--test', ...plan.parallel];
  const parallelStatus = runTests(parallelArgs);
  if (parallelStatus !== 0) return parallelStatus;
  if (parallelOnly) {
    console.warn(
      `[unit] SKIPPED ${ALLOCATION_TEST_FILES.length} allocation microbenchmarks: `
      + 'coverage instrumentation contaminates the calibrated budgets. '
      + 'Run plain `npm test` for the allocation gate.',
    );
    return 0;
  }

  // The GC-bracketed budgets are calibrated on Node 24 and are meaningless on
  // other allocators. A contributor's suite must stay green on any supported
  // engine (package.json permits >=24), so uncalibrated runtimes skip the
  // probes with a warning. Set GEV_REQUIRE_ALLOCATION_GATE=1 (pinned CI /
  // release batteries) to make an uncalibrated runtime a hard failure.
  if (!isCalibratedAllocationRuntime()) {
    if (process.env.GEV_REQUIRE_ALLOCATION_GATE === '1') {
      assertNode24AllocationRuntime();
    }
    console.warn(
      `[unit] SKIPPED ${ALLOCATION_TEST_FILES.length} allocation microbenchmarks: `
      + `budgets are calibrated for Node 24, running ${process.versions.node}. `
      + 'Run under Node 24 (or set GEV_REQUIRE_ALLOCATION_GATE=1 to fail instead).',
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
if (import.meta.url === invokedPath) {
  process.exitCode = runUnitTests({
    coverage: process.argv.includes('--coverage'),
    parallelOnly: process.argv.includes('--parallel-only'),
  });
}
