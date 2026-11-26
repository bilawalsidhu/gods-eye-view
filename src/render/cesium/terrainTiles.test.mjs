import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  MissingTerrainTile,
  tileFetchResource,
  trackTileRequests,
} from './terrainTiles.js';

const ROOT = 'https://terrain.invalid/mesh/';
const LAYER = JSON.stringify({
  tilejson: '2.1.0',
  format: 'quantized-mesh-1.0',
  version: '1.0.0',
  scheme: 'tms',
  tiles: ['{z}/{x}/{y}.terrain?v={version}'],
  projection: 'EPSG:4326',
  bounds: [-180, -90, 180, 90],
  minzoom: 0,
  maxzoom: 2,
  available: [
    [{ startX: 0, startY: 0, endX: 1, endY: 0 }],
    [{ startX: 0, startY: 0, endX: 3, endY: 1 }],
    [{ startX: 0, startY: 0, endX: 7, endY: 3 }],
  ],
});

/** One triangle over the tile: the smallest mesh Cesium decodes. */
function meshBytes() {
  const view = new DataView(new ArrayBuffer(160));
  let at = 88; // centre, heights, bounding sphere, horizon point: all zero
  view.setFloat64(24 + 8 + 24, 1, true); // bounding sphere radius
  const u32 = (v) => (view.setUint32(at, v, true), (at += 4));
  const u16 = (v) => (view.setUint16(at, v, true), (at += 2));
  u32(3);
  // Zig-zag deltas of u (0, 32767, 0), v (0, 0, 32767) and h (0, 0, 0).
  [0, 65534, 65533, 0, 0, 65534, 0, 0, 0].forEach(u16);
  u32(1);
  [0, 0, 0].forEach(u16); // high-water-mark indices 0, 1, 2
  (u32(2), u16(0), u16(2)); // west
  (u32(2), u16(0), u16(1)); // south
  (u32(1), u16(1)); // east
  (u32(1), u16(2)); // north
  return view.buffer.slice(0, at);
}

/** Answers `layer.json` the way a host would; tiles never reach the network. */
function serveLayer(t) {
  const fetched = [];
  t.mock.method(
    Cesium.Resource._Implementations,
    'loadWithXhr',
    (url, responseType, method, data, headers, deferred) => {
      fetched.push(url);
      if (url.startsWith(`${ROOT}layer.json`)) deferred.resolve(LAYER);
      else deferred.reject(new Error(`unexpected fetch ${url}`));
    },
  );
  return fetched;
}

async function terrain(fetchTile, timing) {
  const tiles = new WeakMap();
  const resource = tileFetchResource(
    { url: ROOT },
    fetchTile,
    (request) => (request ? tiles.get(request) : undefined),
    timing,
  );
  const provider = await Cesium.CesiumTerrainProvider.fromUrl(resource, {
    requestWaterMask: false,
  });
  return trackTileRequests(provider, tiles);
}

test('terrain fetchTile: tiles come from fetchTile, layer.json from the url', async (t) => {
  const fetched = serveLayer(t);
  const asked = [];
  const provider = await terrain(async (request) => {
    asked.push(request);
    return { bytes: meshBytes() };
  });
  const data = await provider.requestTileGeometry(
    1,
    0,
    1,
    new Cesium.Request(),
  );
  assert.ok(data instanceof Cesium.QuantizedMeshTerrainData);
  assert.deepEqual(
    fetched.map((u) => new URL(u).pathname),
    ['/mesh/layer.json'],
  );
  assert.equal(asked.length, 1);
  // Rows from the north for the tile; the URL is Cesium's, rows from the
  // south as the layer's tms scheme counts them.
  assert.deepEqual(asked[0].tile, { x: 1, y: 0, level: 1 });
  assert.equal(asked[0].url, `${ROOT}1/1/1.terrain?v=1.0.0`);
  assert.ok(asked[0].signal instanceof AbortSignal);
});

test('terrain fetchTile: a request Cesium makes without a Request still names its tile', async (t) => {
  serveLayer(t);
  const asked = [];
  const provider = await terrain(async (request) => {
    asked.push(request.tile);
    return { bytes: meshBytes() };
  });
  await provider.requestTileGeometry(3, 1, 2);
  assert.deepEqual(asked, [{ x: 3, y: 1, level: 2 }]);
});

test('terrain fetchTile: a missing tile fails, so the parent is drawn there', async (t) => {
  serveLayer(t);
  const provider = await terrain(async () => ({ missing: true }));
  await assert.rejects(
    provider.requestTileGeometry(0, 0, 0, new Cesium.Request()),
    MissingTerrainTile,
  );
});

test('terrain fetchTile: a deferred tile is asked for again', async (t) => {
  serveLayer(t);
  let calls = 0;
  const provider = await terrain(
    async () => (++calls < 3 ? { defer: true } : { bytes: meshBytes() }),
    { retryDelayMs: 1 },
  );
  const data = await provider.requestTileGeometry(
    0,
    0,
    0,
    new Cesium.Request(),
  );
  assert.ok(data instanceof Cesium.QuantizedMeshTerrainData);
  assert.equal(calls, 3);
});

test('terrain fetchTile: cancelling the request aborts the fetch', async (t) => {
  serveLayer(t);
  let signal;
  const provider = await terrain(
    (request) =>
      new Promise((resolve, reject) => {
        signal = request.signal;
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  );
  const request = new Cesium.Request();
  const pending = provider.requestTileGeometry(0, 0, 0, request);
  pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal.aborted, false);
  request.cancel();
  // Cesium's scheduler cancels on its next update.
  Cesium.RequestScheduler.update();
  assert.equal(signal.aborted, true);
});

test('terrain fetchTile: resources that are not tiles fetch as before', async (t) => {
  const fetched = serveLayer(t);
  const resource = tileFetchResource(
    { url: ROOT },
    async () => assert.fail('not a tile'),
    () => undefined,
  );
  const derived = resource.getDerivedResource({ url: 'layer.json' });
  assert.equal(derived.constructor, resource.constructor);
  assert.equal(await derived.fetchArrayBuffer(), LAYER);
  assert.equal(fetched.length, 1);
});
