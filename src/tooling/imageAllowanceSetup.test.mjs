import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createBrowserViteConfig } from '../../build/vite.js';

const source = fileURLToPath(new URL('../../', import.meta.url));
test('documented allowance command defaults to the checkout private directory, never the first flag', (t) => {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gev-allowance-setup-'),
  );
  assert.ok(
    path.resolve(fixture).startsWith(path.resolve(os.tmpdir()) + path.sep),
  );
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}');
  for (const name of [
    'scripts/approve-image-allowance.mjs',
    'server/providers/openai/reconstruction-budget.js',
    'server/providers/openai/camera-reconstruction.js',
    'server/providers/common/http.js',
    'src/sources/httpBody.js',
    '.gitignore',
  ]) {
    const target = path.join(fixture, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, name), target);
  }
  // Run exactly the documented setup command with no optional path flag.
  const result = spawnSync(
    process.execPath,
    [
      'scripts/approve-image-allowance.mjs',
      '--approve-cost',
      '--limit-usd',
      '1',
    ],
    { cwd: fixture, encoding: 'utf8', env: {} },
  );
  assert.equal(result.status, 0, result.stderr);
  const policyPath = path.join(
    fixture,
    '.gev-private/image-generation-policy.json',
  );
  const ledgerPath = path.join(fixture, '.gev-private/image-allowance.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.equal(policy.approved, true);
  assert.equal(policy.limitMicros, 1000000);
  assert.equal(policy.priorSpendMicros, 0);
  assert.equal(policy.ledger, 'image-allowance.json');
  assert.equal(ledger.entries.length, 0);
  assert.equal(ledger.limitMicros, policy.limitMicros);
  assert.equal(fs.existsSync(path.join(fixture, '--approve-cost')), false);
  assert.equal(
    fs.existsSync(path.join(fixture, 'image-allowance.json')),
    false,
  );
  assert.match(
    fs.readFileSync(path.join(fixture, '.gitignore'), 'utf8'),
    /^\.gev-private\/$/m,
  );
  assert.ok(
    createBrowserViteConfig().server.fs.deny.includes('**/.gev-private/**'),
  );
  const repeat = spawnSync(
    process.execPath,
    [
      'scripts/approve-image-allowance.mjs',
      '--approve-cost',
      '--limit-usd',
      '1',
    ],
    { cwd: fixture, encoding: 'utf8', env: {} },
  );
  assert.notEqual(repeat.status, 0);
  assert.match(repeat.stderr, /Existing policy preserved/);
  assert.deepEqual(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')), ledger);
});
