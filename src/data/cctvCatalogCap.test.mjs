import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateSourceCap,
  resolveCatalogCap,
} from '../../server/providers/cctv/cap.js';
import * as constants from '../../server/providers/cctv/constants.js';

const { CCTV_MAX_SOURCES_CEILING, DEFAULT_CCTV_MAX_SOURCES } = constants;
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

test('default per-pack camera caps fit inside the default catalog cap', () => {
  // Every exported DEFAULT_<PACK>_MAX_SOURCES counts, so a new pack cannot
  // slip past this check by not being listed (Warendorf ships 1 curated
  // camera and has no cap constant).
  const packCaps = Object.entries(constants).filter(
    ([name]) =>
      /^DEFAULT_[A-Z_]+_MAX_SOURCES$/.test(name) &&
      name !== 'DEFAULT_CCTV_MAX_SOURCES',
  );
  assert.ok(packCaps.length >= 13, 'every pack cap constant is found');
  const total = packCaps.reduce((sum, [, cap]) => sum + cap, 0) + 1;
  assert.ok(
    total <= DEFAULT_CCTV_MAX_SOURCES,
    `default packs (${total}) would be thinned by the catalog cap (${DEFAULT_CCTV_MAX_SOURCES})`,
  );
  assert.ok(
    DEFAULT_CCTV_MAX_SOURCES <= CCTV_MAX_SOURCES_CEILING,
    'the default cap must sit inside the CCTV_MAX_SOURCES ceiling',
  );
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
