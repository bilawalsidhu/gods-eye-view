import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT = fileURLToPath(
  new URL('../../../scripts/build-land-sea-mask.mjs', import.meta.url),
);

function invokeWithInvalidSource(t, flags = []) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gev-mask-source-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'gshhs_i.b');
  // A single byte cannot form a GSHHG header. Even with the digest override,
  // parsing must stop before the generator can write its repository output.
  writeFileSync(input, new Uint8Array([0]));
  const result = spawnSync(process.execPath, [SCRIPT, input, ...flags], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /wrote .*land-sea-mask\.bin/);
  return result;
}

test('mask builder rejects an unexpected source digest before parsing', (t) => {
  const result = invokeWithInvalidSource(t);
  assert.match(
    result.stderr,
    /source SHA-256 .* does not match GSHHG v2\.3\.7/,
  );
  assert.doesNotMatch(result.stderr, /parseGshhg: truncated header/);
});

test('mask builder explicit source override reaches parsing and reports the mismatch', (t) => {
  const result = invokeWithInvalidSource(t, ['--allow-source-mismatch']);
  assert.match(result.stderr, /override accepted/);
  assert.match(result.stderr, /parseGshhg: truncated header/);
});

test('mask builder rejects an unknown flag', (t) => {
  const result = invokeWithInvalidSource(t, ['--allow-source-missmatch']);
  assert.match(result.stderr, /usage: node scripts\/build-land-sea-mask\.mjs/);
  assert.doesNotMatch(result.stderr, /override accepted/);
});
