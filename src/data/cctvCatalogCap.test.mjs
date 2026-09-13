import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateSourceCap,
  resolveCatalogCap,
} from '../../server/providers/cctv/cap.js';
import {
  CCTV_MAX_SOURCES_CEILING,
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
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});
