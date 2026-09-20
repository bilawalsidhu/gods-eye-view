// src/data/flowTiles.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeFlowTile,
  fetchFlowForBounds,
  tilesForBounds,
  getFlowSessionStats,
  resetFlowTileCache,
} from './flowTiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Real TomTom flow tile, downtown Austin z12 x935 y1686 (probed live 2026-07-16).
const FIXTURE = path.join(__dirname, 'fixtures', 'tomtom-flow-austin-12-935-1686.pbf');
const FIXTURE_TILE = { z: 12, x: 935, y: 1686 };

function loadFixture() {
  return fs.readFileSync(FIXTURE);
}

// ── decodeFlowTile against the real fixture ─────────────────

test('fixture decode: more than 50 flow segments', () => {
  const segments = decodeFlowTile(loadFixture(), FIXTURE_TILE.z, FIXTURE_TILE.x, FIXTURE_TILE.y);
  assert.ok(segments.length > 50, `got ${segments.length}`);
});

test('fixture decode: every trafficLevel is within [0, 1]', () => {
  const segments = decodeFlowTile(loadFixture(), FIXTURE_TILE.z, FIXTURE_TILE.x, FIXTURE_TILE.y);
  for (const s of segments) {
    assert.ok(Number.isFinite(s.trafficLevel), `non-finite level: ${s.trafficLevel}`);
    assert.ok(s.trafficLevel >= 0 && s.trafficLevel <= 1, `level out of range: ${s.trafficLevel}`);
  }
});

test('fixture decode: all coordinates land in downtown Austin', () => {
  const segments = decodeFlowTile(loadFixture(), FIXTURE_TILE.z, FIXTURE_TILE.x, FIXTURE_TILE.y);
  for (const s of segments) {
    assert.ok(Array.isArray(s.coords) && s.coords.length >= 2, 'polyline too short');
    for (const [lon, lat] of s.coords) {
      assert.ok(lon >= -98.0 && lon <= -97.5, `lon out of Austin range: ${lon}`);
      assert.ok(lat >= 30.0 && lat <= 30.5, `lat out of Austin range: ${lat}`);
    }
  }
});

test('fixture decode: congestion exists (at least one trafficLevel < 1)', () => {
  const segments = decodeFlowTile(loadFixture(), FIXTURE_TILE.z, FIXTURE_TILE.x, FIXTURE_TILE.y);
  assert.ok(segments.some((s) => s.trafficLevel < 1), 'no congested segment found');
});

test('fixture decode: segment shape is {coords, trafficLevel, roadType, closure}', () => {
  const segments = decodeFlowTile(loadFixture(), FIXTURE_TILE.z, FIXTURE_TILE.x, FIXTURE_TILE.y);
  for (const s of segments) {
    assert.equal(typeof s.roadType, 'string');
    assert.equal(typeof s.closure, 'boolean');
  }
  // The fixture carries real closures — closure decoding is exercised, not vacuous.
  assert.ok(segments.some((s) => s.closure === true), 'expected at least one closure in fixture');
});

test('decode of a non-MVT buffer returns [] (defensive)', () => {
  assert.deepEqual(decodeFlowTile(Buffer.from('not a protobuf tile'), 12, 935, 1686), []);
});

// ── tilesForBounds (re-exported slippy math) ────────────────

test('tilesForBounds: 30.2672,-97.7431 @ z12 -> covers x935 y1686', () => {
  const tiles = tilesForBounds({
    south: 30.2672 - 0.001, north: 30.2672 + 0.001,
    west: -97.7431 - 0.001, east: -97.7431 + 0.001,
  }, 12);
  assert.ok(
    tiles.some((t) => t.z === 12 && t.x === 935 && t.y === 1686),
    `fixture tile missing: ${JSON.stringify(tiles)}`
  );
});

// ── fetchFlowForBounds (stubbed fetch: cache + abort) ───────

/** Bounds fully inside the fixture tile. */
const FIXTURE_BOUNDS = { south: 30.24, north: 30.26, west: -97.76, east: -97.74 };

function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

test('fetchFlowForBounds: fetches covering tiles via /api/tomtom and decodes', async () => {
  resetFlowTileCache();
  const calls = [];
  const restore = stubFetch(async (url) => {
    calls.push(String(url));
    return new Response(loadFixture(), {
      status: 200,
      headers: { 'Content-Type': 'application/x-protobuf' },
    });
  });
  try {
    const segments = await fetchFlowForBounds(FIXTURE_BOUNDS);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^\/api\/tomtom\/flow\/12\/935\/1686\.pbf$/);
    assert.ok(segments.length > 50);
    assert.ok(getFlowSessionStats().tilesFetched >= 1);
  } finally {
    restore();
  }
});

// ── hand-encoded MVT: a corrupt feature inside an otherwise valid tile ──────
//
// The real fixture is well-formed, so the per-feature try/catch in
// decodeFlowTile never runs against it. These helpers build a minimal
// Mapbox Vector Tile protobuf by hand so a malformed feature can be placed
// NEXT TO a good one — the contract under test is that the good feature
// still decodes.

const varintBytes = (value) => {
  const out = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    out.push(byte);
  } while (rest > 0);
  return out;
};
const sVarintBytes = (value) => varintBytes((value << 1) ^ (value >> 31));
const tagBytes = (fieldNumber, wireType) => varintBytes((fieldNumber << 3) | wireType);
const varintField = (fieldNumber, value) => [...tagBytes(fieldNumber, 0), ...varintBytes(value)];
const bytesField = (fieldNumber, bytes) => [...tagBytes(fieldNumber, 2), ...varintBytes(bytes.length), ...bytes];
const stringField = (fieldNumber, text) => bytesField(fieldNumber, [...Buffer.from(text, 'utf8')]);

/** MVT geometry stream for one 2+ point line: moveTo + lineTo command words. */
const encodeLine = (points) => {
  const out = [...varintBytes((1 << 3) | 1), ...sVarintBytes(points[0][0]), ...sVarintBytes(points[0][1])];
  let [prevX, prevY] = points[0];
  out.push(...varintBytes(((points.length - 1) << 3) | 2));
  for (const [x, y] of points.slice(1)) {
    out.push(...sVarintBytes(x - prevX), ...sVarintBytes(y - prevY));
    prevX = x; prevY = y;
  }
  return out;
};

/** Feature message: packed tags (2), geometry type (3), packed geometry (4). */
const encodeFeature = ({ type, tags = [], geometry = null }) => {
  const out = [];
  if (tags.length > 0) out.push(...bytesField(2, tags.flatMap(([key, value]) => [...varintBytes(key), ...varintBytes(value)])));
  out.push(...varintField(3, type));
  if (geometry) out.push(...bytesField(4, geometry));
  return out;
};

/** A 'Traffic flow' layer carrying one key (traffic_level) and one value (1). */
const encodeFlowLayer = (features) => {
  const out = [
    ...stringField(1, 'Traffic flow'),
    ...varintField(15, 2),
    ...varintField(5, 4096),
    ...stringField(3, 'traffic_level'),
    ...bytesField(4, varintField(5, 1)),
  ];
  for (const feature of features) out.push(...bytesField(2, feature));
  return out;
};

const encodeTile = (layers) => Uint8Array.from(layers.flatMap((layer) => bytesField(3, layer)));

test('a malformed feature inside a valid tile is skipped, not fatal', () => {
  const tile = encodeTile([encodeFlowLayer([
    // Good LineString carrying traffic_level=1 → decodes to one segment.
    encodeFeature({ type: 2, tags: [[0, 0]], geometry: encodeLine([[100, 200], [300, 400]]) }),
    // Feature with a type but NO geometry → toGeoJSON throws 'feature has no geometry'.
    encodeFeature({ type: 2 }),
    // Geometry type 7 is not in the MVT spec → toGeoJSON throws 'unknown feature type'.
    encodeFeature({ type: 7, geometry: encodeLine([[0, 0], [10, 10]]) }),
  ])]);

  const segments = decodeFlowTile(tile, FIXTURE_TILE.z, FIXTURE_TILE.x, FIXTURE_TILE.y);
  assert.equal(segments.length, 1, 'the one decodable feature survives its broken siblings');
  assert.equal(segments[0].trafficLevel, 1);
  assert.equal(segments[0].coords.length, 2);
  assert.equal(segments[0].closure, false);
});

test('fetchFlowForBounds: decode cache serves repeat calls within TTL (no refetch)', async () => {
  resetFlowTileCache();
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    return new Response(loadFixture(), { status: 200 });
  });
  try {
    const first = await fetchFlowForBounds(FIXTURE_BOUNDS);
    const second = await fetchFlowForBounds(FIXTURE_BOUNDS);
    assert.equal(calls, 1, 'second call must be served from the decode cache');
    assert.equal(second.length, first.length);
  } finally {
    restore();
  }
});

test('fetchFlowForBounds: aborted signal rejects (AbortSignal-aware)', async () => {
  resetFlowTileCache();
  const restore = stubFetch(async (url, opts) => {
    // Mimic real fetch abort semantics.
    if (opts?.signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    return new Response(loadFixture(), { status: 200 });
  });
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      fetchFlowForBounds(FIXTURE_BOUNDS, { signal: controller.signal }),
      (err) => err.name === 'AbortError'
    );
  } finally {
    restore();
  }
});

test('fetchFlowForBounds: non-OK tile responses reject when nothing succeeds', async () => {
  resetFlowTileCache();
  const restore = stubFetch(async () => new Response(JSON.stringify({ error: 'no_key' }), { status: 503 }));
  try {
    await assert.rejects(fetchFlowForBounds(FIXTURE_BOUNDS));
  } finally {
    restore();
  }
});

/** Bounds guaranteed to sit inside exactly one z12 tile: 1e-6° past its SW corner. */
function singleTileBounds(lat, lon, zoom = 12) {
  const n = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2) * n);
  const west = (x / n) * 360 - 180;
  const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return { south: south + 1e-6, north: south + 2e-6, west: west + 1e-6, east: west + 2e-6 };
}

test('fetchFlowForBounds: decoding past the cache ceiling evicts the oldest tile only', async () => {
  resetFlowTileCache();
  const calls = [];
  const restore = stubFetch(async (url) => {
    calls.push(String(url));
    return new Response(loadFixture(), { status: 200 });
  });
  try {
    // One distinct tile per call; 70 exceeds the 64-entry decode cache, so the
    // earliest entries must be evicted while the newest survive.
    const boundsList = Array.from({ length: 70 }, (_, i) => singleTileBounds(28 + i * 0.5, -100 + i * 0.5));
    for (const bounds of boundsList) await fetchFlowForBounds(bounds);
    const fetched = calls.length;

    const evicted = await fetchFlowForBounds(boundsList[0]);
    assert.equal(calls.length, fetched + 1, 'the oldest tile was evicted and had to be re-fetched');
    assert.ok(evicted.length > 50, 'the re-fetched tile decodes again, not to an empty shell');

    await fetchFlowForBounds(boundsList[10]);
    await fetchFlowForBounds(boundsList.at(-1));
    assert.equal(calls.length, fetched + 1, 'newer entries stay cached after the eviction');
  } finally {
    restore();
    resetFlowTileCache();
  }
});
