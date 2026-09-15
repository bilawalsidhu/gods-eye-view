// src/data/tapAddress.test.mjs
// Contract tests for the shared receiver-tap address check. Pure — no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalIpv4, parseTapAddress, tapUrl } from './tapAddress.js';

test('parseTapAddress: accepts loopback and every RFC1918 range', () => {
  for (const address of [
    '127.0.0.1:8080',
    '10.0.0.5:1234',
    '172.16.0.1:80',
    '172.31.255.254:65535',
    '192.168.1.1:8080',
    'localhost:8080',
    'rayhunter.local:8080',
    'dump1090.lan.local:30003',
  ]) {
    assert.ok(parseTapAddress(address), `${address} should be accepted`);
  }
});

test('parseTapAddress: rejects public addresses — a tap reads your own network', () => {
  for (const address of [
    '8.8.8.8:80',
    '1.1.1.1:443',
    '93.184.216.34:80',
    'example.com:80',
    'api.wigle.net:443',
    // 172.15 and 172.32 sit just outside 172.16/12.
    '172.15.0.1:80',
    '172.32.0.1:80',
    // 192.167/192.169 bracket 192.168/16.
    '192.167.1.1:80',
    '192.169.1.1:80',
  ]) {
    assert.equal(
      parseTapAddress(address),
      null,
      `${address} should be rejected`,
    );
  }
});

test('parseTapAddress: rejects link-local, so the cloud metadata address cannot be reached', () => {
  assert.equal(parseTapAddress('169.254.169.254:80'), null);
  assert.equal(parseTapAddress('169.254.1.1:80'), null);
});

test('parseTapAddress: malformed dotted-quads are rejected, not treated as private', () => {
  // The trap this module exists to avoid: a classifier that reports garbage as
  // "not public" would let these through under an is-it-local test.
  for (const address of [
    '999.1.1.1:80',
    '10.0.0:80',
    '10.0.0.1.5:80',
    '10.0.0.256:80',
    '-1.0.0.1:80',
  ]) {
    assert.equal(
      parseTapAddress(address),
      null,
      `${address} should be rejected`,
    );
  }
});

test('parseTapAddress: rejects anything shaped like a URL rather than repairing it', () => {
  for (const address of [
    'http://127.0.0.1:8080',
    '127.0.0.1:8080/api/status',
    '127.0.0.1:8080?x=1',
    '127.0.0.1:8080#f',
    'user@127.0.0.1:8080',
    '127.0.0.1:8080\\x',
  ]) {
    assert.equal(
      parseTapAddress(address),
      null,
      `${address} should be rejected`,
    );
  }
});

test('parseTapAddress: rejects a missing, empty, or out-of-range port', () => {
  for (const address of [
    '127.0.0.1',
    '127.0.0.1:',
    '127.0.0.1:0',
    '127.0.0.1:65536',
    '127.0.0.1:abc',
    ':8080',
  ]) {
    assert.equal(
      parseTapAddress(address),
      null,
      `${address} should be rejected`,
    );
  }
});

test('parseTapAddress: rejects IPv6 explicitly rather than half-supporting it', () => {
  assert.equal(parseTapAddress('[::1]:8080'), null);
  assert.equal(parseTapAddress('::1:8080'), null);
  assert.equal(parseTapAddress('[fe80::1%eth0]:8080'), null);
});

test('parseTapAddress: handles non-string and absent input without throwing', () => {
  for (const value of [null, undefined, 0, {}, [], NaN, true]) {
    assert.equal(parseTapAddress(value), null);
  }
});

test('parseTapAddress: normalizes case and surrounding whitespace', () => {
  const parsed = parseTapAddress('  RayHunter.LOCAL:8080  ');
  assert.deepEqual(parsed, {
    host: 'rayhunter.local',
    port: 8080,
    origin: 'http://rayhunter.local:8080',
  });
});

test('isLocalIpv4: boundaries of each allowed range', () => {
  assert.ok(isLocalIpv4('127.255.255.255'));
  assert.ok(isLocalIpv4('10.255.255.255'));
  assert.ok(isLocalIpv4('172.16.0.0'));
  assert.ok(isLocalIpv4('172.31.255.255'));
  assert.ok(!isLocalIpv4('172.15.255.255'));
  assert.ok(!isLocalIpv4('172.32.0.0'));
  assert.ok(!isLocalIpv4('126.255.255.255'));
  assert.ok(!isLocalIpv4('128.0.0.1'));
});

test('tapUrl: joins a parsed address with a module-supplied path', () => {
  const address = parseTapAddress('192.168.1.1:8080');
  assert.equal(
    tapUrl(address, '/api/qmdl-manifest'),
    'http://192.168.1.1:8080/api/qmdl-manifest',
  );
});

test('tapUrl: refuses an unparsed address or a relative path', () => {
  const address = parseTapAddress('192.168.1.1:8080');
  assert.throws(() => tapUrl(null, '/x'), TypeError);
  assert.throws(() => tapUrl({ origin: '' }, '/x'), TypeError);
  assert.throws(() => tapUrl(address, 'api/status'), TypeError);
  assert.throws(() => tapUrl(address, ''), TypeError);
});
