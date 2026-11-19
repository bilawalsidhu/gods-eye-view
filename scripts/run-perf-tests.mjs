import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  discoverUnitTestFiles,
  UNIT_TEST_NODE_FLAGS,
} from './run-unit-tests.mjs';

/** Discover every layer/provider benchmark, including those added by other branches. */
export function discoverPerfTestFiles(root = process.cwd()) {
  return discoverUnitTestFiles(root).filter((file) =>
    file.endsWith('.perf.test.mjs'),
  );
}

/** Shared by benchmarks so normal unit runs visibly skip timing assertions. */
export function perfBudgetTestOptions(env = process.env) {
  return {
    skip:
      env.GEV_PERF_BUDGETS === '1'
        ? false
        : 'Timing budgets are opt-in; run npm run test:perf (GEV_PERF_BUDGETS=1). Deterministic delta/write checks still run in the normal suite.',
  };
}

/** Build a serial invocation so benchmarks do not compete for CPU time. */
export function perfTestArgs(files) {
  // A single serial test process keeps benchmark files from competing with
  // each other; the normal suite still discovers them and reports their skips.
  return [
    ...UNIT_TEST_NODE_FLAGS,
    '--test',
    '--test-concurrency=1',
    '--test-isolation=none',
    ...files,
  ];
}

/** Run discovered benchmarks with wall-clock budgets enabled. */
export function runPerfTests({
  root = process.cwd(),
  env = process.env,
  run = spawnSync,
} = {}) {
  const files = discoverPerfTestFiles(root);
  if (!files.length) throw new Error('No *.perf.test.mjs benchmarks found');
  const result = run(process.execPath, perfTestArgs(files), {
    cwd: root,
    stdio: 'inherit',
    env: { ...env, GEV_PERF_BUDGETS: '1' },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invoked) process.exitCode = runPerfTests();
