import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPerfTests } from '../scripts/run-perf-tests.mjs';
import {
  discoverUnitTestFiles,
  UNIT_TEST_NODE_FLAGS,
} from '../scripts/run-unit-tests.mjs';

function temporaryDirectory(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-perf-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('npm test:perf discovers every layer benchmark, enables budgets and serializes files', (t) => {
  const root = temporaryDirectory(t);
  const benchmarks = [
    'server/providers/example.perf.test.mjs',
    'src/layers/radiosondes/renderModel.perf.test.mjs',
    'src/layers/wildlife/renderModel.perf.test.mjs',
  ];
  for (const file of [...benchmarks, 'src/ordinary.test.mjs']) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), '');
  }
  const invocations = [];
  const status = runPerfTests({
    root,
    spawn: (...args) => {
      invocations.push(args);
      return { status: 7 };
    },
  });
  assert.equal(status, 7, 'benchmark failures propagate');
  assert.equal(invocations.length, 1);
  const [command, args, options] = invocations[0];
  assert.equal(command, process.execPath);
  assert.deepEqual(args, [
    ...UNIT_TEST_NODE_FLAGS,
    '--test',
    '--test-concurrency=1',
    ...benchmarks,
  ]);
  assert.equal(options.env.GEV_PERF_BUDGETS, '1');
  assert.equal(options.cwd, root);
  assert.ok(
    discoverUnitTestFiles(root).includes(benchmarks[1]),
    'normal tests still run benchmark deterministic assertions',
  );
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(pkg.scripts['test:perf'], 'node scripts/run-perf-tests.mjs');
});

test('slow-clock benchmark passes deterministic assertions by default and fails timing budgets only when opted in', (t) => {
  const root = temporaryDirectory(t);
  const benchmark = fileURLToPath(
    new URL('./layers/radiosondes/renderModel.perf.test.mjs', import.meta.url),
  );
  const hook = path.join(root, 'slow-clock.mjs');
  // Simulate descheduling without sleeping or relying on the machine's load.
  writeFileSync(
    hook,
    `
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier === 'node:perf_hooks' && context.parentURL?.endsWith('/renderModel.perf.test.mjs'))
          return { url: 'test-clock:slow', shortCircuit: true };
        return next(specifier, context);
      },
      load(url, context, next) {
        if (url === 'test-clock:slow')
          return { format: 'module', source: 'let now = 0; export const performance = { now: () => now += 100 };', shortCircuit: true };
        return next(url, context);
      },
    });
  `,
  );
  const env = { ...process.env };
  delete env.GEV_PERF_BUDGETS;
  delete env.NODE_TEST_CONTEXT;
  const run = (environment) =>
    spawnSync(
      process.execPath,
      [`--import=${hook}`, '--test', '--test-reporter=tap', benchmark],
      { encoding: 'utf8', env: environment },
    );
  const ordinary = run(env);
  assert.equal(ordinary.status, 0, ordinary.stdout + ordinary.stderr);
  assert.match(
    ordinary.stdout,
    /SKIP.*Wall-clock budgets skipped; run npm run test:perf/,
  );
  assert.match(ordinary.stdout, /unchanged billboard writes=0/);
  const optedIn = run({ ...env, GEV_PERF_BUDGETS: '1' });
  assert.equal(optedIn.status, 1, optedIn.stdout + optedIn.stderr);
  assert.match(optedIn.stdout, /initial build 100\.000 ms exceeds/);
});
