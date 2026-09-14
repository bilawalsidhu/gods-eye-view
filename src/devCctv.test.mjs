import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const bashTest = process.platform === 'win32' ? test.skip : test;

async function launch(overrides = {}, dotenv = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-cctv-launch-'));
  try {
    await fs.mkdir(path.join(root, 'scripts'));
    await fs.mkdir(path.join(root, 'bin'));
    await fs.mkdir(path.join(root, 'src', 'data'), { recursive: true });
    await fs.copyFile(new URL('./data/cctv.js', import.meta.url), path.join(root, 'src', 'data', 'cctv.js'));
    for (const name of ['dev-cctv.sh', 'dev-fresh.sh', 'read-dotenv-value.mjs']) {
      await fs.copyFile(new URL(`../scripts/${name}`, import.meta.url), path.join(root, 'scripts', name));
    }
    await fs.mkdir(path.join(root, 'src', 'standalone'), { recursive: true });
    await fs.copyFile(new URL('./standalone/data.js', import.meta.url), path.join(root, 'src', 'standalone', 'data.js'));
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.symlink(fileURLToPath(new URL('../node_modules/vite', import.meta.url)), path.join(root, 'node_modules', 'vite'), 'dir');
    await fs.writeFile(path.join(root, '.env'), dotenv);
    // Stub only external programs; both production launchers and dotenv parsing run.
    for (const command of ['security', 'pkill', 'lsof']) {
      await fs.writeFile(path.join(root, 'bin', command), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    }
    await fs.writeFile(path.join(root, 'bin', 'npm'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.CCTV_TEST_CAPTURE, JSON.stringify({ args: process.argv.slice(2), env: process.env, cwd: process.cwd() }));
`, { mode: 0o755 });
    const capture = path.join(root, 'capture.json');
    const result = await run('bash', [path.join(root, 'scripts', 'dev-cctv.sh')], {
      cwd: os.tmpdir(),
      env: { PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`, CCTV_TEST_CAPTURE: capture, ...overrides },
      timeout: 30_000,
    });
    return { ...JSON.parse(await fs.readFile(capture, 'utf8')), output: result.stdout + result.stderr, root };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

bashTest('CCTV preset starts keyless on localhost through the normal launcher', async () => {
  const result = await launch();
  assert.deepEqual(result.args, ['run', 'dev', '--', '--host', 'localhost', '--port', '4173', '--force']);
  assert.equal(result.cwd, result.root);
  assert.equal(result.env.CCTV_SOURCES_FILE, 'config/cctv_sources.austin.json');
  assert.equal(result.env.CCTV_PREFER_AUSTIN, '1');
  assert.equal(result.env.CCTV_AUSTIN_MAX_SOURCES, '36');
  assert.equal(result.env.CCTV_MAX_SOURCES, '48');
  assert.equal(result.env.GEV_LAUNCHER, 'dev-fresh');
  assert.equal(result.env.GEV_KEY_SETUP_EXTERNAL_KEYS, '');
  assert.equal(result.env.GOOGLE_MAPS_API_KEY, undefined);
  assert.match(result.output, /Startup map: Esri World Imagery/);
  assert.doesNotMatch(result.output, /!! WARNING/);
});

bashTest('CCTV preset preserves explicit LAN and source overrides with a warning', async () => {
  const result = await launch({ HOST: '0.0.0.0', PORT: '4999', CCTV_SOURCES_FILE: 'config/custom.json', CCTV_PREFER_AUSTIN: '0', CCTV_AUSTIN_MAX_SOURCES: '5', CCTV_MAX_SOURCES: '9', CCTV_CALTRANS_DISTRICTS: '', CCTV_TFL_ENABLED: '0' });
  assert.deepEqual(result.args.slice(-5), ['--host', '0.0.0.0', '--port', '4999', '--force']);
  assert.equal(result.env.CCTV_SOURCES_FILE, 'config/custom.json');
  assert.equal(result.env.CCTV_PREFER_AUSTIN, '0');
  assert.equal(result.env.CCTV_AUSTIN_MAX_SOURCES, '5');
  assert.equal(result.env.CCTV_MAX_SOURCES, '9');
  assert.equal(result.env.CCTV_CALTRANS_DISTRICTS, '');
  assert.equal(result.env.CCTV_TFL_ENABLED, '0');
  assert.match(result.output, /!! WARNING: HOST=0\.0\.0\.0/);
});

bashTest('CCTV preset shares dotenv precedence and names-only credential provenance', async () => {
  const result = await launch({ GOOGLE_MAPS_API_KEY: 'fixture-shell-maps' }, 'GOOGLE_MAPS_API_KEY=fixture-file-maps\nOPENAI_API_KEY=fixture-file-voice\n');
  assert.equal(result.env.GOOGLE_MAPS_API_KEY, 'fixture-shell-maps');
  assert.equal(result.env.OPENAI_API_KEY, 'fixture-file-voice');
  assert.equal(result.env.GEV_KEY_SETUP_EXTERNAL_KEYS, 'GOOGLE_MAPS_API_KEY');
  assert.doesNotMatch(result.output, /fixture-shell-maps|fixture-file-maps|fixture-file-voice/);
});
