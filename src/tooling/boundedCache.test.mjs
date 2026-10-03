// THE BOUNDED ANSWER CACHE — memory and disk bounds for the Nominatim area
// and OSM routes. Every memory insertion is bounded (disk hits included), and
// the disk keeps to its entry and byte quotas, removing expired files first.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createBoundedCache } from '../../server/providers/common/boundedCache.js';

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'gev-bounded-cache-'));
}

test('disk hits are bounded in memory like fresh answers', async () => {
  const dir = await tempDir();
  const writer = createBoundedCache({
    dir,
    ttlMs: 60_000,
    maxMemoryEntries: 100,
    maxDiskEntries: 200,
  });
  for (let i = 0; i < 75; i += 1) await writer.set(`k${i}`, `v${i}`);
  const reader = createBoundedCache({
    dir,
    ttlMs: 60_000,
    maxMemoryEntries: 10,
    maxDiskEntries: 200,
  });
  for (let i = 0; i < 75; i += 1)
    assert.equal(await reader.get(`k${i}`), `v${i}`);
  assert.equal(reader.memorySize, 10);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('the disk keeps to its entry and byte quotas and drops expired files', async () => {
  const dir = await tempDir();
  let clock = 1_000_000;
  const cache = createBoundedCache({
    dir,
    ttlMs: 10_000,
    maxDiskEntries: 5,
    maxDiskBytes: 10_000,
    now: () => clock,
  });
  for (let i = 0; i < 12; i += 1) await cache.set(`k${i}`, 'x'.repeat(100));
  let files = await fsp.readdir(dir);
  assert.ok(files.length <= 5, `${files.length} files`);
  await cache.set('big', 'y'.repeat(20_000));
  const sizes = await Promise.all(
    (await fsp.readdir(dir)).map(
      async (name) => (await fsp.stat(path.join(dir, name))).size,
    ),
  );
  assert.ok(sizes.reduce((a, b) => a + b, 0) <= 10_000, 'byte quota holds');
  // Age every file past the TTL, then write once more: the old files go.
  const past = new Date(Date.now() - 3_600_000);
  for (const name of await fsp.readdir(dir))
    await fsp.utimes(path.join(dir, name), past, past);
  clock = Date.now();
  await cache.set('fresh', 'z');
  files = await fsp.readdir(dir);
  assert.equal(files.length, 1);
  assert.equal(await cache.get('k0'), undefined);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('an expired entry is not served', async () => {
  let clock = 0;
  const cache = createBoundedCache({ dir: null, ttlMs: 100, now: () => clock });
  await cache.set('a', 1);
  clock = 50;
  assert.equal(await cache.get('a'), 1);
  clock = 500;
  assert.equal(await cache.get('a'), undefined);
});
