import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_DATA, packFieldManifest, unpackFieldManifest } from './packField.js';

function payload() {
  // 3 columns x 2 rows, row 0 south (lat 10), row 1 north (lat 11).
  return {
    status: 'ok',
    format: 'gev-ocean-field',
    version: 1,
    generatedAtMs: 1_760_000_000_000,
    requestedAtMs: 1_760_000_000_000,
    box: { latMin: 10, lonMin: 170, latMax: 11, lonMax: -179 },
    grid: { lat0: 10, lon0: 170, dLat: 1, dLon: 5.5, nLat: 2, nLon: 3 },
    u: [0.1, null, 0.3, 0.4, 0.5, 0.6],
    v: [0, null, 0, 0.3, 0, 0],
    stats: { cells: 6, finite: 5 },
    provenance: {
      tier: 'global',
      tierLabel: 'Global surface currents',
      validAtMs: 1_759_990_000_000,
      stale: false,
      caveats: [],
      sources: [],
    },
    attempts: [],
    reason: null,
  };
}
const options = {
  tier: 'regional',
  bbox: { latMin: 10, latMax: 11, lonMin: 170, lonMax: -179 },
  fetchedAt: 5,
  gridUrl: '/api/ocean/currents/grid/x.bin',
};

test('packFieldManifest flips rows north-first, writes the sentinel into both components and reports stats', () => {
  const { manifest, bytes } = packFieldManifest(payload(), options);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.field, 'ocean-currents');
  assert.equal(manifest.tier, 'regional');
  assert.deepEqual(manifest.grid, { nx: 3, ny: 2, lo1: 170, la1: 11, dx: 5.5, dy: 1 });
  assert.equal(manifest.noData, NO_DATA);
  assert.equal(manifest.level, 'surface');
  assert.equal(manifest.units, 'm/s');
  assert.equal(manifest.cycle.validIso, '2025-10-09T06:06:40.000Z');
  assert.equal(manifest.cycle.runIso, null);
  assert.equal(manifest.stale, false);
  assert.equal(manifest.unavailable, false);
  assert.equal(manifest.fetchedAt, 5);
  assert.equal(manifest.gridUrl, options.gridUrl);
  assert.equal(bytes.byteLength, 6 * 4 * 2);
  const values = new Float32Array(bytes.buffer, bytes.byteOffset, 12);
  // u north row first: 0.4 0.5 0.6, then the south row 0.1 NO_DATA 0.3.
  assert.ok(Math.abs(values[0] - 0.4) < 1e-6);
  assert.equal(values[4], NO_DATA);
  assert.equal(values[6 + 4], NO_DATA, 'v carries the sentinel too');
  assert.ok(Math.abs(values[6 + 0] - 0.3) < 1e-6);
  // Speeds over valid cells: 0.1 0.3 0.5 0.5 0.6; median = speeds[5 >> 1].
  assert.deepEqual(manifest.speed, {
    medianMs: 0.5,
    p95Ms: 0.6,
    maxMs: 0.6,
    validCells: 5,
    totalCells: 6,
  });
});

test('round trip reproduces the payload grid and arrays within Float32 rounding', () => {
  const { manifest, bytes } = packFieldManifest(payload(), options);
  const back = unpackFieldManifest(manifest, bytes);
  assert.deepEqual(back.grid, payload().grid);
  for (const key of ['u', 'v'])
    back[key].forEach((value, i) => {
      const expected = payload()[key][i];
      if (expected === null) assert.equal(value, null);
      else assert.ok(Math.abs(value - expected) <= 1e-6, `${key}[${i}]`);
    });
});

test('packFieldManifest refuses non-ok payloads and half-null cells', () => {
  assert.throws(
    () =>
      packFieldManifest(
        { ...payload(), status: 'unavailable', grid: null, u: null, v: null },
        options,
      ),
    /unavailable/,
  );
  const half = payload();
  half.v[1] = 0;
  assert.throws(() => packFieldManifest(half, options), /null together/);
});

test('packFieldManifest derives the bbox from the grid extent when none is given (regional own-axes grids)', () => {
  // A strided HYCOM sub-grid whose node span exceeds the requested box.
  const p = payload();
  p.grid = { lat0: -37.52, lon0: 136.48, dLat: 0.08, dLon: 0.16, nLat: 126, nLon: 42 };
  const n = 126 * 42;
  p.u = new Array(n).fill(0.1);
  p.v = new Array(n).fill(0);
  const { manifest } = packFieldManifest(p, { tier: 'regional', fetchedAt: 5, gridUrl: '/api/ocean/currents/grid/x.bin' });
  assert.deepEqual(manifest.bbox, {
    latMin: -37.52,
    latMax: -37.52 + 125 * 0.08,
    lonMin: 136.48,
    lonMax: 136.48 + 41 * 0.16,
  });
  // Across the antimeridian the eastern edge is normalized into [-180, 180).
  p.grid = { lat0: 30, lon0: 170, dLat: 1, dLon: 1, nLat: 2, nLon: 21 };
  p.u = new Array(42).fill(0.1);
  p.v = new Array(42).fill(0);
  const seam = packFieldManifest(p, { tier: 'regional', fetchedAt: 5, gridUrl: '/x.bin' });
  assert.deepEqual(seam.manifest.bbox, { latMin: 30, latMax: 31, lonMin: 170, lonMax: -170 });
  // An explicit bbox (the global lattice) is kept verbatim.
  const global = packFieldManifest(payload(), options);
  assert.deepEqual(global.manifest.bbox, options.bbox);
});
