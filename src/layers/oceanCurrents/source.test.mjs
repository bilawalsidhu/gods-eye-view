import test from 'node:test';
import assert from 'node:assert/strict';
import { createOceanCurrentsSource } from './source.js';

const manifest = {
  schemaVersion: 1,
  field: 'ocean-currents',
  tier: 'regional',
  cycle: { validIso: '2026-10-16T00:00:00.000Z', runIso: null, forecastHour: null },
  fetchedAt: 1,
  level: 'surface',
  units: 'm/s',
  grid: { nx: 2, ny: 2, lo1: 170, la1: 40, dx: 15, dy: 10 },
  bbox: { latMin: 30, latMax: 40, lonMin: 170, lonMax: -175 },
  noData: -9999,
  speed: { medianMs: 0.2, p95Ms: 0.5, maxMs: 1, validCells: 3, totalCells: 4 },
  provenance: { tier: 'global' },
  stale: false,
  unavailable: false,
  reason: null,
  gridUrl:
    '/api/ocean/currents/grid/currents-regional-20261016T000000Z-30.0,170.0,40.0,-175.0-2x2.bin',
};
const body = () =>
  new Uint8Array(Float32Array.from([1, 2, 3, -9999, 5, 6, 7, -9999]).buffer);
const response = (value) =>
  new Response(value instanceof Uint8Array ? value : JSON.stringify(value));

test('ocean source sends the box, validates the manifest and decodes both components', async () => {
  const urls = [];
  const source = createOceanCurrentsSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return response(url.includes('manifest') ? manifest : body());
    },
  });
  const snapshot = await source.getSnapshot({
    box: { latMin: 30, latMax: 40, lonMin: 170, lonMax: -175 },
  });
  assert.equal(
    urls[0],
    '/api/ocean/currents/manifest?latMin=30&latMax=40&lonMin=170&lonMax=-175',
  );
  assert.equal(urls[1], manifest.gridUrl);
  assert.deepEqual([...snapshot.u], [1, 2, 3, -9999]);
  assert.deepEqual([...snapshot.v], [5, 6, 7, -9999]);
  assert.equal(snapshot.noData, -9999);
  assert.equal(snapshot.tier, 'regional');
  const whole = createOceanCurrentsSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return response(
        url.includes('manifest') ? { ...manifest, unavailable: true } : body(),
      );
    },
  });
  assert.equal((await whole.getSnapshot({ box: null })).unavailable, true);
  assert.equal(
    urls.at(-1),
    '/api/ocean/currents/manifest?latMin=-90&latMax=90&lonMin=-180&lonMax=180',
  );
});

test('ocean source rejects foreign grid urls, wrong field, inconsistent bbox, NaN and short bodies', async () => {
  const bad = [
    { ...manifest, gridUrl: 'https://example.com/x.bin' },
    { ...manifest, gridUrl: '/api/wind/grid/gfs-x.bin' },
    { ...manifest, field: 'wind' },
    { ...manifest, grid: { ...manifest.grid, nx: 1e9 } },
    { ...manifest, noData: NaN },
    { ...manifest, bbox: { ...manifest.bbox, latMax: 80 } },
    { ...manifest, bbox: { ...manifest.bbox, lonMin: 100 } },
    { ...manifest, speed: null },
  ];
  for (const variant of bad) {
    let calls = 0;
    const source = createOceanCurrentsSource({
      fetchImpl: async () => {
        calls++;
        return response(variant);
      },
    });
    await assert.rejects(
      source.getSnapshot({ box: null }),
      /Malformed/,
      JSON.stringify(variant.bbox ?? variant.gridUrl),
    );
    assert.equal(calls, 1);
  }
  for (const bytes of [
    new Uint8Array(Float32Array.from([NaN, 2, 3, 4, 5, 6, 7, 8]).buffer),
    new Uint8Array(28),
  ]) {
    const source = createOceanCurrentsSource({
      fetchImpl: async (url) =>
        response(url.includes('manifest') ? manifest : bytes),
    });
    await assert.rejects(source.getSnapshot({ box: null }), /Malformed/);
  }
});

test('ocean source timeout aborts the fetch', async () => {
  const source = createOceanCurrentsSource({
    timeoutMs: 5,
    fetchImpl: (_, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      ),
  });
  await assert.rejects(source.getSnapshot({ box: null }), /timed out/);
});

test('ocean source accepts own-axes regional grids whose node span covers the box, and the global lattice', async () => {
  // Reviewer reproduction: a strided HYCOM sub-grid served on its own axes.
  const strided = {
    ...manifest,
    grid: { nx: 42, ny: 126, lo1: 136.48, la1: -27.52, dx: 0.16, dy: 0.08 },
    bbox: { latMin: -27.52 - 125 * 0.08, latMax: -27.52, lonMin: 136.48, lonMax: 136.48 + 41 * 0.16 },
    gridUrl: '/api/ocean/currents/grid/currents-regional-20261016T000000Z-x-42x126.bin',
  };
  const global = {
    ...manifest,
    tier: 'global',
    grid: { nx: 360, ny: 181, lo1: -180, la1: 90, dx: 1, dy: 1 },
    bbox: { latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 },
    gridUrl: '/api/ocean/currents/grid/currents-global-20261016T000000Z-global-360x181.bin',
  };
  for (const variant of [strided, global]) {
    const count = variant.grid.nx * variant.grid.ny;
    const source = createOceanCurrentsSource({
      fetchImpl: async (url) =>
        response(
          url.includes('manifest')
            ? variant
            : new Uint8Array(new Float32Array(count * 2).fill(0.1).buffer),
        ),
    });
    const snapshot = await source.getSnapshot({ box: null });
    assert.equal(snapshot.u.length, count);
  }
  // A grid that stops a full cell short of the box, or starts a cell away, is still malformed.
  for (const bad of [
    { ...strided, bbox: { ...strided.bbox, lonMax: strided.bbox.lonMax + 0.5 } },
    { ...strided, bbox: { ...strided.bbox, latMin: strided.bbox.latMin - 0.5 } },
  ]) {
    const source = createOceanCurrentsSource({ fetchImpl: async () => response(bad) });
    await assert.rejects(source.getSnapshot({ box: null }), /Malformed/);
  }
});
