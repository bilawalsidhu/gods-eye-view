// TAK connection error sanitization: Node's raw TLS/net/fs error messages
// embed the configured host, port, or local certificate file path — this
// app promises (.env.example, SECURITY.md) the browser never sees any of
// those. Pure-function test, no network/filesystem.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTakConnectionError } from '../../vite.config.js';

test('sanitizeTakConnectionError: known error codes map to a generic, safe message', () => {
  assert.equal(sanitizeTakConnectionError({ code: 'ECONNREFUSED' }), 'TAK Server refused the connection');
  assert.equal(sanitizeTakConnectionError({ code: 'ENOTFOUND' }), 'TAK Server hostname could not be resolved');
  assert.equal(sanitizeTakConnectionError({ code: 'ENOENT' }), 'TAK certificate/key file not found on the server');
});

test('sanitizeTakConnectionError: never leaks the raw message even when a known code is present', () => {
  const err = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 10.0.0.5:8089' };
  const sanitized = sanitizeTakConnectionError(err);
  assert.ok(!sanitized.includes('10.0.0.5'));
  assert.ok(!sanitized.includes('8089'));
});

test('sanitizeTakConnectionError: an fs path never leaks even for a known ENOENT code', () => {
  const err = { code: 'ENOENT', message: "ENOENT: no such file or directory, open '/etc/tak/client-key.pem'" };
  const sanitized = sanitizeTakConnectionError(err);
  assert.ok(!sanitized.includes('/etc/tak'));
});

test('sanitizeTakConnectionError: unknown/missing codes fall back to a fixed generic message', () => {
  assert.equal(sanitizeTakConnectionError({ code: 'SOME_UNKNOWN_CODE' }), 'TAK connection error');
  assert.equal(sanitizeTakConnectionError({}), 'TAK connection error');
  assert.equal(sanitizeTakConnectionError(null), 'TAK connection error');
});
