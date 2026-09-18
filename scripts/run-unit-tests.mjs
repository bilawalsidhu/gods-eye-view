import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ALLOCATION_TEST_FILES = Object.freeze([
  'src/data/focusAllocations.test.mjs',
  'src/overlays/worldOverlayAllocation.test.mjs',
]);

/**
 * Tests that plain `npm test` runs but coverage measurement skips.
 *
 * `src/data/trafficTiming.test.mjs` boots a real vite dev server
 * (`createServer` + `ssrLoadModule('/src/data/traffic.js')`) to inject its
 * timing-test hooks into the traffic layer. Vite's SSR module runner compiles
 * the whole traffic import graph a SECOND time — SSR-transformed (double
 * function wrapper, `Object.defineProperty` export getters), attributed by V8
 * to the bare filesystem path instead of the `file://` URL the ESM loader
 * records. Root-caused 2026-09-17: one process's raw V8 coverage then holds
 * two entries per traffic-graph file (file:// + plain path, different block
 * counts), and c8 — which merges by resolved path — folds the transformed
 * copy's near-zero counts into every file in the graph, reporting flowMatch
 * at 42.97% and tomtomTiles at 69.07% in the batch while a solo c8 run of the
 * same files measures 100%. Skipping this one file under coverage restores
 * honest numbers; its assertions do not depend on instrumentation, and the
 * rest of the traffic graph stays covered by the other traffic test files.
 */
export const COVERAGE_EXCLUDED_TEST_FILES = Object.freeze([
  'src/data/trafficTiming.test.mjs',
]);

/**
 * Node majors on which the GC-bracketed allocation budgets are calibrated.
 * 24 is the original calibration runtime; 26 was measured 2026-09-13
 * (v26.8.2) — every world-overlay row and the focus probe landed within the
 * existing budgets (see the probe docblocks), so no per-major budget table
 * was needed. A new major (27+) must be measured before joining this set;
 * elsewhere the probes SKIP (or FAIL under GEV_REQUIRE_ALLOCATION_GATE) per
 * issue #39.
 */
export const CALIBRATED_ALLOCATION_NODE_MAJORS = Object.freeze(new Set([24, 26]));

/** Allocation major for a version string (NaN when unparseable). */
export function allocationMajor(version = process.versions.node) {
  return Number.parseInt(String(version).split('.')[0], 10);
}

/** Whether this runtime matches one the allocation budgets were calibrated on. */
export function isCalibratedAllocationRuntime(version = process.versions.node) {
  return CALIBRATED_ALLOCATION_NODE_MAJORS.has(allocationMajor(version));
}

/** Require a runtime on which allocation budgets are calibrated. */
export function assertCalibratedAllocationRuntime(version = process.versions.node) {
  if (!isCalibratedAllocationRuntime(version)) {
    throw new Error(
      `Allocation budgets require a calibrated runtime (Node `
      + `${[...CALIBRATED_ALLOCATION_NODE_MAJORS].join(' or ')}); received ${version}`,
    );
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
  // Coverage-excluded files follow the same contamination principle as the
  // allocation probes above, one level up: their architecture breaks the
  // MEASUREMENT itself (see COVERAGE_EXCLUDED_TEST_FILES), so they are
  // skipped whenever this run is wrapped by coverage tooling — both the
  // `--coverage` flag and a c8-injected NODE_V8_COVERAGE environment.
  const underCoverage = coverage || Boolean(process.env.NODE_V8_COVERAGE);
  const skippedForCoverage = underCoverage
    ? plan.parallel.filter((file) => COVERAGE_EXCLUDED_TEST_FILES.includes(file))
    : [];
  if (skippedForCoverage.length) {
    console.warn(
      `[unit] SKIPPED ${skippedForCoverage.length} test file(s) under coverage `
      + '(break coverage measurement; run plain `npm test` for them): '
      + `${skippedForCoverage.join(', ')}.`,
    );
  }
  const parallelArgs = [
    '--test',
    ...(coverage ? ['--experimental-test-coverage'] : []),
    ...plan.parallel.filter((file) => !skippedForCoverage.includes(file)),
  ];
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

  // The GC-bracketed budgets are allocator-sensitive: they are calibrated per
  // supported Node major (24 originally, 26 measured 2026-09-13 — see
  // CALIBRATED_ALLOCATION_NODE_MAJORS). A contributor's suite must stay green
  // on any supported engine (package.json permits >=24), so uncalibrated
  // runtimes skip the probes with a warning. Set GEV_REQUIRE_ALLOCATION_GATE=1
  // (pinned CI / release batteries) to make an uncalibrated runtime a hard
  // failure — CI runs the suite on every calibrated major for exactly this.
  if (!isCalibratedAllocationRuntime()) {
    if (process.env.GEV_REQUIRE_ALLOCATION_GATE === '1') {
      assertCalibratedAllocationRuntime();
    }
    console.warn(
      `[unit] SKIPPED ${ALLOCATION_TEST_FILES.length} allocation microbenchmarks: `
      + `budgets are calibrated for Node `
      + `${[...CALIBRATED_ALLOCATION_NODE_MAJORS].join(' and ')}, running `
      + `${process.versions.node}. `
      + 'Run under a calibrated Node (or set GEV_REQUIRE_ALLOCATION_GATE=1 to fail instead).',
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
