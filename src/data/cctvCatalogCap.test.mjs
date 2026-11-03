import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateSourceCap,
  resolveCatalogCap,
} from '../../server/providers/cctv/cap.js';
import {
  CCTV_MAX_SOURCES_CEILING,
  CCTV_SOURCE_CACHE_MS,
  DEFAULT_CCTV_MAX_SOURCES,
} from '../../server/providers/cctv/constants.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

const pack = (name, count, prefix = name) => ({
  name,
  sources: Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    rank: i,
  })),
});

test('under the cap every pack is served whole, in merge order', () => {
  const { sources, packs } = allocateSourceCap(
    [pack('a', 3), pack('b', 2)],
    10,
  );
  assert.deepEqual(
    sources.map((s) => s.id),
    ['a-0', 'a-1', 'a-2', 'b-0', 'b-1'],
  );
  assert.deepEqual(packs, [
    { name: 'a', offered: 3, kept: 3 },
    { name: 'b', offered: 2, kept: 2 },
  ]);
});

test('over the cap the packs share it round-robin, and the last pack is never starved', () => {
  // The old positional slice kept the first N of [a..., b..., c...], which
  // deleted pack c entirely; the fair split thins every pack instead.
  const { sources, packs } = allocateSourceCap(
    [pack('a', 100), pack('b', 100), pack('c', 100)],
    9,
  );
  assert.equal(sources.length, 9);
  assert.deepEqual(
    packs.map((p) => p.kept),
    [3, 3, 3],
  );
  // Each pack contributes its own highest-priority cameras, in its own order.
  assert.deepEqual(
    sources.filter((s) => s.id.startsWith('c-')).map((s) => s.rank),
    [0, 1, 2],
  );
});

test('a duplicate inside one pack takes one slot, not two', () => {
  const dup = {
    name: 'file',
    sources: [{ id: 'x', v: 'old' }, { id: 'x', v: 'new' }, { id: 'y' }],
  };
  const { sources } = allocateSourceCap([dup], 2);
  assert.deepEqual(
    sources.map((s) => [s.id, s.v]),
    [
      ['x', 'new'],
      ['y', undefined],
    ],
  );
});

test('a short pack releases its turns to the others', () => {
  const { packs } = allocateSourceCap([pack('a', 2), pack('b', 50)], 10);
  assert.deepEqual(
    packs.map((p) => p.kept),
    [2, 8],
  );
});

test('duplicate ids resolve last-pack-wins and count against the winning pack', () => {
  const live = {
    name: 'live',
    sources: [{ id: 'cam-1', label: 'live' }, { id: 'cam-2' }],
  };
  const override = {
    name: 'env',
    sources: [{ id: 'cam-1', label: 'override' }],
  };
  const { sources, packs } = allocateSourceCap([live, override], 10);
  assert.deepEqual(
    sources.map((s) => [s.id, s.label]),
    [
      ['cam-2', undefined],
      ['cam-1', 'override'],
    ],
  );
  assert.deepEqual(packs, [
    { name: 'live', offered: 1, kept: 1 },
    { name: 'env', offered: 1, kept: 1 },
  ]);
});

test('resolveCatalogCap bounds the env value and falls back to the default', () => {
  assert.equal(resolveCatalogCap(undefined), DEFAULT_CCTV_MAX_SOURCES);
  assert.equal(resolveCatalogCap('nonsense'), DEFAULT_CCTV_MAX_SOURCES);
  assert.equal(resolveCatalogCap('1'), 8);
  assert.equal(resolveCatalogCap('999999'), CCTV_MAX_SOURCES_CEILING);
  assert.equal(resolveCatalogCap('120.9'), 120);
});

test('the catalog applies the fair cap to configured packs end to end', async () => {
  const saved = { ...process.env };
  try {
    process.env.CCTV_PREFER_AUSTIN = '0';
    process.env.CCTV_SOURCES_FILE = '/nonexistent/cctv.json';
    process.env.CCTV_SOURCES_JSON = JSON.stringify(
      Array.from({ length: 12 }, (_, i) => ({
        id: `env-${i}`,
        name: `Env ${i}`,
        lat: 30 + i * 0.01,
        lon: -97,
        url: `https://example.test/${i}.jpg`,
      })),
    );
    process.env.CCTV_MAX_SOURCES = '9';
    const getSources = createCctvCatalog({ sourceRoot: '/nonexistent' });
    const sources = await getSources();
    assert.equal(sources.length, 9);
    assert.deepEqual(
      sources.slice(0, 3).map((s) => s.id),
      ['env-0', 'env-1', 'env-2'],
    );
    assert.equal(sources[0].pack, 'env');
    const [trimmed] = getSources.trimmedPacks();
    assert.deepEqual(
      { ...trimmed, region: undefined },
      { pack: 'env', available: 12, served: 9, region: undefined },
    );
    assert.equal(trimmed.region.south, 30);
    assert.ok(Math.abs(trimmed.region.north - 30.11) < 1e-9);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

test('a pack trimmed to its nearest cameras reports how many it offered', async () => {
  const { prioritizeSources } =
    await import('../../server/providers/cctv/normalize.js');
  const cameras = Array.from({ length: 5 }, (_, i) => ({
    id: `c${i}`,
    lat: i,
    lon: 0,
  }));
  const kept = prioritizeSources(cameras, 2, [{ lat: 0, lon: 0 }]);
  assert.deepEqual(
    kept.map((camera) => camera.id),
    ['c0', 'c1'],
  );
  assert.equal(kept.available, 5);
  assert.deepEqual(kept.region, { west: 0, south: 0, east: 0, north: 4 });
});

/** A CCTV_SOURCES_JSON value with `count` cameras named `<prefix>-<i>`. */
const envSources = (prefix, count = 3) =>
  JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      id: `${prefix}-${i}`,
      name: `${prefix} ${i}`,
      lat: 30 + i * 0.01,
      lon: -97,
      url: `https://example.test/${prefix}-${i}.jpg`,
    })),
  );

/** Let a background refresh that needs no timers run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Restore process.env to a snapshot taken with `{ ...process.env }`. */
const restoreEnv = (saved) => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
};

test('an expired catalog is served at once while a slow pack refreshes in the background', async (t) => {
  const saved = { ...process.env };
  try {
    // Live packs run alongside the env pack, so one slow upstream can hold
    // the refresh open.
    process.env.CCTV_FORCE_AUSTIN = '1';
    process.env.CCTV_SOURCES_FILE = '/nonexistent/cctv.json';
    process.env.CCTV_SOURCES_JSON = envSources('old');
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'log', () => {});
    const hung = [];
    let hang = false;
    t.mock.method(globalThis, 'fetch', () =>
      hang
        ? new Promise((_, reject) => {
            hung.push(() => reject(new Error('upstream gave up')));
          })
        : Promise.reject(new Error('offline')),
    );
    const getSources = createCctvCatalog({ sourceRoot: '/nonexistent' });
    assert.deepEqual(
      (await getSources()).map((s) => s.id),
      ['old-0', 'old-1', 'old-2'],
    );

    // Past the TTL, with every live pack's upstream hanging.
    now += CCTV_SOURCE_CACHE_MS + 1;
    hang = true;
    process.env.CCTV_SOURCES_JSON = envSources('new');
    let timer;
    const served = await Promise.race([
      getSources(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('waited'), 200);
      }),
    ]);
    clearTimeout(timer);
    assert.notEqual(
      served,
      'waited',
      'a stale request waited for the background refresh',
    );
    assert.deepEqual(
      served.map((s) => s.id),
      ['old-0', 'old-1', 'old-2'],
    );

    // Requests during the refresh share it rather than starting another.
    const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
    await pause();
    const inFlight = hung.length;
    assert.ok(inFlight > 0, 'the refresh reached the hanging upstreams');
    await getSources();
    await getSources();
    await pause();
    assert.equal(hung.length, inFlight, 'only one refresh ran');

    // When the slow pack gives up, the refreshed catalog replaces the old one.
    hang = false;
    for (const giveUp of hung) giveUp();
    for (let i = 0; i < 50; i += 1) {
      const ids = (await getSources()).map((s) => s.id);
      if (ids[0] === 'new-0') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(
      (await getSources()).map((s) => s.id),
      ['new-0', 'new-1', 'new-2'],
    );
  } finally {
    restoreEnv(saved);
  }
});

test('a failed background refresh keeps the catalog, warns once, and waits a TTL to retry', async (t) => {
  const saved = { ...process.env };
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    process.env.CCTV_PREFER_AUSTIN = '0';
    process.env.CCTV_SOURCES_FILE = '/nonexistent/cctv.json';
    process.env.CCTV_SOURCES_JSON = envSources('old', 9);
    process.env.CCTV_MAX_SOURCES = '8';
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    // Nine cameras over a cap of eight make every refresh warn; throwing from
    // that warning is how this test makes a refresh reject.
    let failRefresh = false;
    let failedRefreshes = 0;
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => {
      const text = args.join(' ');
      if (failRefresh && text.includes('exceeds cap')) {
        failedRefreshes += 1;
        throw new Error('refresh broke');
      }
      warnings.push(text);
    });
    const getSources = createCctvCatalog({ sourceRoot: '/nonexistent' });
    const old = await getSources();
    assert.equal(old.length, 8);

    // Past the TTL the refresh throws: the old catalog is still served.
    now += CCTV_SOURCE_CACHE_MS + 1;
    failRefresh = true;
    assert.equal(await getSources(), old);
    await settle();
    assert.equal(failedRefreshes, 1);
    assert.equal(
      warnings.filter((w) => w.includes('background catalog refresh failed'))
        .length,
      1,
    );

    // The failure is not retried on every request until the next TTL.
    assert.equal(await getSources(), old);
    assert.equal(await getSources(), old);
    await settle();
    assert.equal(failedRefreshes, 1, 'a failed refresh was retried at once');

    // After it, a refresh that works replaces the catalog. With no live packs
    // the refresh finishes before the request that started it returns.
    now += CCTV_SOURCE_CACHE_MS + 1;
    failRefresh = false;
    process.env.CCTV_SOURCES_JSON = envSources('new');
    await getSources();
    await settle();
    const fresh = await getSources();
    assert.deepEqual(
      fresh.map((s) => s.id),
      ['new-0', 'new-1', 'new-2'],
    );
    // Trim notes stay with the list they describe, so a request served the
    // old list during the refresh never reports the new list's notes.
    assert.deepEqual(
      getSources.trimmedPacks(old).map((p) => [p.pack, p.available, p.served]),
      [['env', 9, 8]],
    );
    assert.deepEqual(getSources.trimmedPacks(fresh), []);
    assert.deepEqual(getSources.trimmedPacks(), []);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    restoreEnv(saved);
  }
});

test('an empty background refresh keeps the catalog and waits a TTL before fetching again', async (t) => {
  const saved = { ...process.env };
  try {
    process.env.CCTV_FORCE_AUSTIN = '1';
    process.env.CCTV_SOURCES_FILE = '/nonexistent/cctv.json';
    process.env.CCTV_SOURCES_JSON = envSources('old');
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(console, 'log', () => {});
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
    let fetches = 0;
    t.mock.method(globalThis, 'fetch', () => {
      fetches += 1;
      return Promise.reject(new Error('offline'));
    });
    const getSources = createCctvCatalog({ sourceRoot: '/nonexistent' });
    const old = await getSources();

    // Past the TTL every pack comes back empty, as in an upstream outage.
    now += CCTV_SOURCE_CACHE_MS + 1;
    process.env.CCTV_SOURCES_JSON = '[]';
    assert.equal(await getSources(), old);
    for (let i = 0; i < 50; i += 1) {
      if (warnings.some((w) => w.includes('source refresh returned empty')))
        break;
      await settle();
    }
    assert.ok(
      warnings.some((w) => w.includes('serving 3 stale cameras')),
      'the empty refresh kept the old catalog',
    );

    // Until the next TTL, requests are served without touching any upstream.
    const fetchesAfterRefresh = fetches;
    assert.equal(await getSources(), old);
    assert.equal(await getSources(), old);
    await settle();
    assert.equal(
      fetches,
      fetchesAfterRefresh,
      'an empty refresh reran at once',
    );
  } finally {
    restoreEnv(saved);
  }
});
