import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readDotenvValue } from '../scripts/read-dotenv-value.mjs';

test('dotenv reader preserves values without executing shell metacharacters', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-dotenv-'));
  const marker = path.join(root, 'must-not-exist');
  try {
    await fs.writeFile(path.join(root, '.env'), [
      'PLAIN_KEY=plain-value',
      'QUOTED_KEY="quoted value"',
      `SHELL_PAYLOAD=$(touch ${marker})`,
      'BACKTICK_PAYLOAD=`printf owned`',
    ].join('\n'));
    assert.equal(readDotenvValue('PLAIN_KEY', root), 'plain-value');
    assert.equal(readDotenvValue('QUOTED_KEY', root), 'quoted value');
    assert.equal(readDotenvValue('SHELL_PAYLOAD', root), `$(touch ${marker})`);
    // dotenv treats backticks as quote delimiters, but never executes them.
    assert.equal(readDotenvValue('BACKTICK_PAYLOAD', root), 'printf owned');
    await assert.rejects(fs.access(marker));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an inherited export never masks the value written in the file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-dotenv-'));
  const had = Object.prototype.hasOwnProperty.call(process.env, 'GEV_INHERIT_PROBE');
  const previous = process.env.GEV_INHERIT_PROBE;
  try {
    await fs.writeFile(path.join(root, '.env'), 'GEV_INHERIT_PROBE=from-dotenv\n');

    // An empty export is how a shell says "unset" to the launcher's `:-`
    // fallbacks, and Vite's loadEnv otherwise lets process.env win — which is
    // exactly how a configured key went missing.
    process.env.GEV_INHERIT_PROBE = '';
    assert.equal(readDotenvValue('GEV_INHERIT_PROBE', root), 'from-dotenv');

    // A non-empty inherited value must not win either: this reader answers for
    // the files, and the caller decides precedence.
    process.env.GEV_INHERIT_PROBE = 'from-shell';
    assert.equal(readDotenvValue('GEV_INHERIT_PROBE', root), 'from-dotenv');

    // The caller's own environment survives the read unchanged.
    assert.equal(process.env.GEV_INHERIT_PROBE, 'from-shell');

    delete process.env.GEV_INHERIT_PROBE;
    assert.equal(readDotenvValue('GEV_INHERIT_PROBE', root), 'from-dotenv');
    assert.equal(Object.prototype.hasOwnProperty.call(process.env, 'GEV_INHERIT_PROBE'), false);
  } finally {
    if (had) process.env.GEV_INHERIT_PROBE = previous;
    else delete process.env.GEV_INHERIT_PROBE;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dev-fresh gives explicit or dotenv Google configuration precedence over Keychain', async () => {
  const source = await fs.readFile(new URL('../scripts/dev-fresh.sh', import.meta.url), 'utf8');
  const precedence = source.indexOf('if [[ -n "${GOOGLE_MAPS_API_KEY_ENV}" ]]');
  const keychainFallback = source.indexOf('elif [[ -n "${GOOGLE_MAPS_API_KEY_KEYCHAIN}" ]]');
  assert.ok(precedence >= 0 && keychainFallback > precedence);
});

test('dev-fresh passes names-only boot provenance before resolving file fallbacks', async () => {
  const source = await fs.readFile(new URL('../scripts/dev-fresh.sh', import.meta.url), 'utf8');
  const capture = source.indexOf('KEY_SETUP_EXTERNAL_KEYS=()');
  const dotenvResolution = source.indexOf('GOOGLE_MAPS_API_KEY_ENV="${GOOGLE_MAPS_API_KEY:-}"');
  assert.ok(capture >= 0 && capture < dotenvResolution, 'parent-shell provenance must be captured first');
  for (const name of [
    'GOOGLE_MAPS_API_KEY', 'CESIUM_ION_TOKEN', 'OPENAI_API_KEY', 'AISSTREAM_API_KEY',
    'FIRMS_MAP_KEY', 'TOMTOM_API_KEY', 'OPENSKY_CLIENT_ID',
    'OPENSKY_CLIENT_SECRET', 'LL2_API_TOKEN',
  ]) {
    assert.match(source, new RegExp(`KEY_SETUP_EXTERNAL_KEYS\\+=\\(${name}\\)`));
  }
  assert.match(source, /put_env GEV_LAUNCHER "dev-fresh"/);
  assert.match(source, /put_env GEV_KEY_SETUP_EXTERNAL_KEYS "\$\{KEY_SETUP_EXTERNAL_KEYS_CSV\}"/);
});


// Stock macOS ships bash 3.2, where expanding an EMPTY array under `set -u`
// is a fatal "unbound variable" — the `:-` guard on the provenance CSV is what
// keeps the keyless `dev-fresh.sh` launch alive there. Newer bash never fails
// this way, so the idiom itself is asserted textually and the block's behavior
// is exercised for both the keyless and the populated case.
const bashTest = process.platform === 'win32' ? test.skip : test;
bashTest('the external-keys provenance block survives set -u keyless and joins names when keys are exported', async () => {
  const script = await fs.readFile(new URL('../scripts/dev-fresh.sh', import.meta.url), 'utf8');
  const start = script.indexOf('KEY_SETUP_EXTERNAL_KEYS=()');
  const csvAt = script.indexOf('KEY_SETUP_EXTERNAL_KEYS_CSV=');
  const end = script.indexOf('\n', csvAt);
  assert.ok(start > 0 && csvAt > start && end > csvAt, 'provenance block not found in dev-fresh.sh');
  const block = script.slice(start, end);
  assert.match(block, /\$\{KEY_SETUP_EXTERNAL_KEYS\[\*\]:-\}/);

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const probe = `set -u\n${block}\nprintf '%s' "$KEY_SETUP_EXTERNAL_KEYS_CSV"`;
  const keyless = await run('bash', ['-c', probe], { env: { PATH: process.env.PATH } });
  assert.equal(keyless.stdout, '');
  const keyed = await run('bash', ['-c', probe], {
    env: { PATH: process.env.PATH, FIRMS_MAP_KEY: 'x', TOMTOM_API_KEY: 'y' },
  });
  assert.equal(keyed.stdout, 'FIRMS_MAP_KEY,TOMTOM_API_KEY');
});
