#!/usr/bin/env node
// Exercise the shipped image with no keys, then with new runtime credentials.
// All credentials below are fixtures. These checks do not call provider APIs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/test-docker.mjs IMAGE');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim();
const volume = `gev-test-${randomUUID()}`;
const publicGoogle = 'fixture-google-runtime';
const publicCesium = 'fixture-cesium-runtime';
const privateKey = 'fixture-openai-private';
let container;

async function start(env = []) {
  container = docker('run', '--detach', '--publish', '127.0.0.1::4173',
    '--mount', `type=volume,source=${volume},target=/app/.gev-cache`,
    ...env.flatMap((value) => ['--env', value]), image);
  const address = docker('port', container, '4173/tcp').split('\n')[0];
  const base = `http://${address}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return base;
    } catch { /* The server can need time for the first dependency scan. */ }
    await delay(500);
  }
  throw new Error('The image did not start within 60 seconds');
}

async function get(base, pathname) {
  return fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(30_000) });
}

try {
  docker('volume', 'create', volume);
  let base = await start();
  assert.match(await (await get(base, '/')).text(), /God.s Eye View/i);
  const voice = await get(base, '/api/realtime/token');
  assert.equal(voice.status, 503);
  assert.match((await voice.json()).error, /OPENAI_API_KEY/);
  assert.equal((await get(base, '/api/setup/status')).status, 403);
  // A request inside the container uses loopback. ENV mode must still deny it.
  docker('exec', container, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    assert.notEqual(process.getuid(), 0);
    assert.equal(fs.existsSync('/app/.env'), false);
    fs.writeFileSync('/app/.gev-cache/docker-test', 'retained');
    fs.writeFileSync('/app/.gev-logs/docker-test', 'writable');
    for (const [path, options] of [
      ['/api/setup/status', {}],
      ['/api/setup/keys', {method:'POST', headers:{'Origin':'http://localhost:4173','Content-Type':'application/json'}, body:'{}'}],
    ]) {
      const response = await fetch('http://localhost:4173' + path, options);
      assert.equal(response.status, 403);
    }
  `);
  docker('rm', '--force', container);
  container = undefined;

  base = await start([
    `GOOGLE_MAPS_API_KEY=${publicGoogle}`,
    `CESIUM_ION_TOKEN=${publicCesium}`,
    `OPENAI_API_KEY=${privateKey}`,
  ]);
  const main = await (await get(base, '/src/main.js')).text();
  assert.ok(main.includes(publicGoogle), 'Google key must come from the new container environment');
  assert.ok(main.includes(publicCesium), 'Cesium key must come from the new container environment');
  for (const pathname of ['/src/main.js', '/src/locations.js', '/@vite/env']) {
    const code = await (await get(base, pathname)).text();
    assert.ok(!code.includes(privateKey), 'Private key must stay out of browser modules');
  }
  docker('exec', container, 'node', '-e', `
    const assert = require('node:assert/strict');
    assert.equal(require('node:fs').readFileSync('/app/.gev-cache/docker-test', 'utf8'), 'retained');
    assert.equal(process.env.OPENAI_API_KEY, ${JSON.stringify(privateKey)});
  `);
  console.log('Docker checks passed: keyless startup, runtime keys, private keys, setup denial, non-root user, and cache retention.');
} catch (error) {
  if (container) console.error(docker('logs', container));
  throw error;
} finally {
  if (container) docker('rm', '--force', container);
  docker('volume', 'rm', volume);
}
