import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRateLimiter } from './rateLimit.js';

test('injected time drives per-client and global rolling limits', () => {
  let at = 1000;
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: 2,
    globalMax: 3,
    now: () => at,
  });
  assert.equal(allow('a'), true);
  assert.equal(allow('a'), true);
  assert.equal(allow('a'), false);
  assert.equal(allow('b'), true);
  assert.equal(allow('c'), false);
  at += 59_999;
  assert.equal(allow('a'), false);
  at += 1;
  assert.equal(allow('a'), true);
  assert.equal(allow('c'), true);
});
