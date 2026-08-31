import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ALLOWED_HOSTS, resolveAllowedHosts } from './allowedHosts.js';

test('uses the restricted local host allowlist by default', () => {
  assert.deepEqual(resolveAllowedHosts(), DEFAULT_ALLOWED_HOSTS);
  assert.equal(resolveAllowedHosts().includes(true), false);
});

test('adds explicitly configured LAN hostnames without widening the allowlist', () => {
  assert.deepEqual(
    resolveAllowedHosts('globe.lan, globe.internal ,globe.lan'),
    ['localhost', '127.0.0.1', 'globe.lan', 'globe.internal']
  );
});

test('ignores empty configured host entries', () => {
  assert.deepEqual(
    resolveAllowedHosts(' , , globe.lan, '),
    ['localhost', '127.0.0.1', 'globe.lan']
  );
});

test('rejects suffix and wildcard entries so every LAN hostname is explicit', () => {
  assert.deepEqual(
    resolveAllowedHosts('.local,*.example,globe.lan'),
    ['localhost', '127.0.0.1', 'globe.lan']
  );
});
