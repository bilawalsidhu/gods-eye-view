import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  discoverUnitTestFiles,
  UNIT_TEST_NODE_FLAGS,
} from './run-unit-tests.mjs';

/** Run every layer benchmark serially, outside the parallel unit-test load. */
export function runPerfTests({ root = process.cwd(), spawn = spawnSync } = {}) {
  const files = discoverUnitTestFiles(root).filter((file) =>
    file.endsWith('.perf.test.mjs'),
  );
  if (!files.length) throw new Error('No *.perf.test.mjs benchmarks found');
  const result = spawn(
    process.execPath,
    [...UNIT_TEST_NODE_FLAGS, '--test', '--test-concurrency=1', ...files],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, GEV_PERF_BUDGETS: '1' },
    },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invoked) {
  try {
    process.exitCode = runPerfTests();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
