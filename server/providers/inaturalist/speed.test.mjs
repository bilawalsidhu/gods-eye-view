import test from 'node:test';
import assert from 'node:assert/strict';
import { createInatClient } from './client.js';
import { installInatProxy, NOW } from './proxy.fixture.mjs';
import { syntheticGrid } from './grid.fixture.mjs';
import { INAT_GRID_DECODE_MEASURE } from './grid.js';

const gridUrl = '/grid?z=2&x=1&y=1&taxa=Aves';
const params = {
  scope: 'global',
  taxa: 'all',
  observedD1: '2026-11-02',
};
const tick = () => new Promise(setImmediate);

const install = (options, hook) => installInatProxy(gridUrl, options, hook);

test('tile cache lasts fifteen minutes, then returns stale before revalidation finishes', async () => {
  let at = NOW;
  let calls = 0;
  let release;
  const request = install({
    now: () => at,
    fetchImpl: () => {
      calls += 1;
      return calls === 1
        ? Response.json(syntheticGrid())
        : new Promise((resolve) => {
            release = resolve;
          });
    },
  });
  const first = await request();
  at += 899_999;
  const freshPromise = request();
  await tick();
  assert.equal(calls, 1, 'a fresh tile never spends another upstream attempt');
  assert.deepEqual((await freshPromise).body, first.body);
  at += 1;
  const stalePromise = request();
  let resolved = false;
  void stalePromise.then(() => {
    resolved = true;
  });
  await tick();
  try {
    assert.equal(
      resolved,
      true,
      'stale cells publish while refresh is pending',
    );
    const stale = await stalePromise;
    assert.equal(stale.body.stale, true);
    assert.equal(stale.body.fetchedAt, NOW);
    assert.deepEqual(stale.body.cells, first.body.cells);
    await request();
    assert.equal(calls, 2, 'all stale consumers share one background refresh');
    const refreshPromise = request(`${gridUrl}&refresh=wait`);
    let refreshed = false;
    void refreshPromise.then(() => {
      refreshed = true;
    });
    await tick();
    assert.equal(
      refreshed,
      false,
      'a background consumer can await the same refresh',
    );
    release(Response.json(syntheticGrid()));
    const fresh = await refreshPromise;
    assert.equal(fresh.body.stale, undefined);
    assert.equal(fresh.body.fetchedAt, at);
    assert.equal(
      calls,
      2,
      'waiting for fresh cells never duplicates upstream work',
    );
    release = null;
  } finally {
    release?.(Response.json(syntheticGrid()));
  }
});

test('more than sixteen queued views and thirty local requests never report local rate limiting', async () => {
  let release;
  let calls = 0;
  const request = install({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1)
        await new Promise((resolve) => {
          release = resolve;
        });
      return Response.json(syntheticGrid());
    },
  });
  const pending = Array.from({ length: 40 }, (_, x) =>
    request(`/grid?z=6&x=${x}&y=1`),
  );
  await tick();
  release();
  const results = await Promise.all(pending);
  assert.ok(results.every((result) => result.status === 200));
  assert.equal(calls, 40);
});

test('only real upstream 429 or 5xx failures start cooldown', async () => {
  for (const bad of [
    () => Promise.reject(new Error('network')),
    () => Response.json({ malformed: true }),
    () => new Response('', { status: 404 }),
  ]) {
    let calls = 0;
    const client = createInatClient({
      now: () => NOW,
      cacheDir: null,
      queueOptions: { intervalMs: 0, windowMs: 0 },
      warn() {},
      fetchImpl: () => {
        calls += 1;
        return calls === 1
          ? bad()
          : Response.json({ results: [], total_results: 0 });
      },
    });
    await assert.rejects(client.getObservations(params), { status: 502 });
    await client.getObservations(params);
    assert.equal(
      calls,
      2,
      'a non-cooldown failure must not hold the next attempt',
    );
  }
});

test('actual upstream cooldown is marked separately from a local budget stop', async () => {
  for (const upstream of [429, 503]) {
    let calls = 0;
    const request = install({
      fetchImpl: () => {
        calls += 1;
        return new Response('', {
          status: upstream,
          headers: { 'Retry-After': '120' },
        });
      },
    });
    const first = await request();
    assert.equal(first.headers['X-Upstream-Status'], String(upstream));
    assert.equal(first.headers['Retry-After'], '120');
    await request();
    assert.equal(calls, 1);
  }
});

test('upstream Retry-After zero survives the HTTP response and permits an immediate next request', async () => {
  for (const upstream of [429, 503]) {
    let calls = 0;
    const request = install({
      fetchImpl: () => {
        calls += 1;
        return calls === 1
          ? new Response('', {
              status: upstream,
              headers: { 'Retry-After': '0' },
            })
          : Response.json(syntheticGrid());
      },
    });
    const first = await request();
    assert.equal(first.headers['X-Upstream-Status'], String(upstream));
    assert.equal(first.headers['Retry-After'], '0');
    assert.equal((await request()).status, 200);
    assert.equal(calls, 2);
  }
});

test('a local daily budget stop has a distinct code and no upstream cooldown marker', async (t) => {
  const before = process.env.INATURALIST_DAILY_BUDGET;
  process.env.INATURALIST_DAILY_BUDGET = '1';
  t.after(() => {
    if (before === undefined) delete process.env.INATURALIST_DAILY_BUDGET;
    else process.env.INATURALIST_DAILY_BUDGET = before;
  });
  let calls = 0;
  const request = install({
    fetchImpl: () => {
      calls += 1;
      return Response.json(syntheticGrid());
    },
  });
  assert.equal((await request()).status, 200);
  const stopped = await request('/grid?z=2&x=0&y=1');
  assert.equal(stopped.status, 503);
  assert.equal(stopped.body.error, 'inaturalist_budget_exhausted');
  assert.equal(stopped.headers['X-Upstream-Status'], undefined);
  assert.equal((await request()).status, 200, 'cached data remains available');
  assert.equal(calls, 1);
});

test('cached tiles avoid UTFGrid decode and decode timing entries stay bounded', async () => {
  const request = install({
    fetchImpl: () => Response.json(syntheticGrid()),
  });
  await request();
  const sample = performance.getEntriesByName(INAT_GRID_DECODE_MEASURE)[0];
  assert.ok(sample.duration >= 0);
  for (let i = 0; i < 10; i += 1) await request();
  assert.equal(
    performance.getEntriesByName(INAT_GRID_DECODE_MEASURE)[0],
    sample,
  );
  for (let x = 0; x < 4; x += 1) await request(`/grid?z=3&x=${x}&y=1`);
  assert.equal(
    performance.getEntriesByName(INAT_GRID_DECODE_MEASURE).length,
    1,
  );
});
