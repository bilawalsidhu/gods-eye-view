// src/data/gbfsPolicy.test.mjs
// The GBFS policy is the shared dev/prod contract (ADR 0003): one allowlist,
// one path gate, one cache-control table for BOTH runtimes. These tests pin
// the contract directly — the runtime handlers only wire it into fetch/Response.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GBFS_ALLOWED_HOSTS,
  GBFS_MAX_BODY_BYTES,
  GBFS_PROXY_TIMEOUT_MS,
  gbfsCacheControl,
  isAllowedGbfsHost,
  isAllowedGbfsPath,
} from './gbfsPolicy.js';

test('the allowlist carries the five operator hosts plus the three publicbikesystem cities', () => {
  assert.deepEqual([...GBFS_ALLOWED_HOSTS].sort(), [
    'austin.publicbikesystem.net',
    'chat.publicbikesystem.net',
    'gbfs.bcycle.com',
    'gbfs.biketownpdx.com',
    'gbfs.bluebikes.com',
    'gbfs.cogobikeshare.com',
    'gbfs.lyft.com',
    'hon.publicbikesystem.net',
  ]);
});

test('host gate: exact allowlist members pass, case and whitespace tolerated', () => {
  assert.equal(isAllowedGbfsHost('gbfs.lyft.com'), true);
  assert.equal(isAllowedGbfsHost('  GBFS.BlueBikes.COM  '), true, 'trim + lowercase before the Set check');
});

test('host gate: any publicbikesystem.net subdomain passes, not just the seeded cities', () => {
  assert.equal(isAllowedGbfsHost('metro.publicbikesystem.net'), true, 'future city subdomains need no code change');
  assert.equal(isAllowedGbfsHost('a.b.publicbikesystem.net'), true, 'deep subdomains are still that domain');
});

test('host gate: lookalikes, bare domains and empties all fail closed', () => {
  const rejects = [
    'publicbikesystem.net', // bare domain — a subdomain suffix is required
    'evil.publicbikesystem.net.evil.io', // suffix smuggling
    'gbfs.lyft.com.evil.io',
    'gbfs-fake.lyft.com',
    'lyft.com',
    '',
    null,
    undefined,
    0,
  ];
  for (const host of rejects) {
    assert.equal(isAllowedGbfsHost(host), false, `must reject: ${String(host)}`);
  }
});

test('path gate: only the two station endpoints relay, any prefix, any case', () => {
  assert.equal(isAllowedGbfsPath('/v2/gbfs/austin/station_information.json'), true);
  assert.equal(isAllowedGbfsPath('/station_status.json'), true);
  assert.equal(isAllowedGbfsPath('/STATION_INFORMATION.JSON'), true, 'upstream case variance tolerated');
});

test('path gate: sibling endpoints, prefixes-only and junk all fail', () => {
  const rejects = [
    '/v2/gbfs/system_information.json',
    '/v2/gbfs/station_information', // no .json suffix
    '/station_information.jsonx',
    'station_information.json', // the suffix test anchors on /
    '/free_bike_status.json',
    '',
    null,
  ];
  for (const p of rejects) {
    assert.equal(isAllowedGbfsPath(p), false, `must reject: ${String(p)}`);
  }
});

test('cache control: station_information is semi-static, everything else no-store', () => {
  assert.equal(gbfsCacheControl('/v2/gbfs/austin/station_information.json'), 'public, max-age=300');
  assert.equal(gbfsCacheControl('/v2/gbfs/austin/station_status.json'), 'no-store', 'real-time feed never caches');
  assert.equal(gbfsCacheControl(''), 'no-store', 'unknown paths fail closed to no-store');
  assert.equal(gbfsCacheControl(null), 'no-store');
});

test('relay limits are exported for both runtimes to share', () => {
  assert.equal(GBFS_PROXY_TIMEOUT_MS, 12000);
  assert.equal(GBFS_MAX_BODY_BYTES, 5 * 1024 * 1024);
});
