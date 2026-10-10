// Smoke test for the staged payload: start the local server exactly as the
// desktop shell does (bundled Node runtime, payload root, per-user state
// directory) and request the pages the window loads. Run after `npm run stage`.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parseReadyUrl, pickPort } = require('../lib/server.cjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const stage = path.join(here, '..', '.stage');
const payload = path.join(stage, 'payload');
const nodeBinary = path.join(
  stage,
  'runtime',
  process.platform === 'win32' ? 'node.exe' : 'node',
);
const state = mkdtempSync(path.join(tmpdir(), 'gev-smoke-'));
const port = await pickPort(47900);

const child = spawn(nodeBinary, [path.join(payload, 'desktop-serve.mjs')], {
  cwd: payload,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    GEV_LAUNCHER: 'desktop',
    GEV_PAYLOAD_ROOT: payload,
    GEV_STATE_DIR: path.join(state, 'config'),
    GEV_CACHE_DIR: path.join(state, 'cache'),
  },
});

let output = '';
const collect = (chunk) => {
  output = (output + chunk).slice(-8000);
};
child.stdout.on('data', collect);
child.stderr.on('data', collect);

let finished = false;
const stop = () => {
  finished = true;
  child.kill();
  rmSync(state, { recursive: true, force: true });
};
const fail = (message) => {
  console.error(`[smoke] FAIL: ${message}\n--- server output ---\n${output}`);
  stop();
  process.exit(1);
};

const url = await new Promise((resolve) => {
  const timer = setTimeout(
    () => fail('server did not report ready in 120 s'),
    120_000,
  );
  child.stdout.on('data', () => {
    const ready = parseReadyUrl(output);
    if (ready) {
      clearTimeout(timer);
      resolve(ready);
    }
  });
  child.once('exit', (code) => {
    if (!finished) fail(`server exited early (code ${code})`);
  });
});
console.log(`[smoke] server ready at ${url}`);

const checks = [
  ['/', 'text/html', /God's Eye View|<div id="/i],
  ['/src/main.js', 'javascript', /import/],
  ['/api/setup/status', 'application/json', /./],
];
for (const [route, type, pattern] of checks) {
  const response = await fetch(new URL(route, url), {
    signal: AbortSignal.timeout(300_000),
  });
  const body = await response.text();
  if (response.status !== 200) fail(`${route} answered ${response.status}`);
  if (!(response.headers.get('content-type') ?? '').includes(type))
    fail(`${route} content-type ${response.headers.get('content-type')}`);
  if (!pattern.test(body)) fail(`${route} body did not match ${pattern}`);
  console.log(`[smoke] ok ${route}`);
}
stop();
console.log('[smoke] passed');
