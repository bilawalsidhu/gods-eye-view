import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('opacity QA reports launch failures without echoing executable paths', () => {
  const secret = 'synthetic-api-key-PRIVATE-SUFFIX123';
  const result = spawnSync(process.execPath, ['scripts/qa-layer-opacity.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PUPPETEER_EXECUTABLE_PATH: `/nonexistent/${secret}`,
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /synthetic-api-key|SUFFIX123/,
  );
  assert.match(result.stderr, /opacity QA failed/i);
});
