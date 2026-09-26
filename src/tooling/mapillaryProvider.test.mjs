import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PbfWriter } from 'pbf';
import { mapillaryProxy } from 'gods-eye-view/server/providers/mapillary';
import {
  listTileLayers,
  stripTileLayers,
} from '../../server/providers/mapillary/trim.js';
import {
  fetchTile,
  normalizeTileAddress,
  TileRequestError,
  _resetTileMemoryForTest,
} from '../../server/providers/mapillary/tiles.js';

/** Mount the plugin and return a caller keyed by route. */
function install(plugin, mode = 'configureServer') {
  const routes = new Map();
  plugin[mode]({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  const call = async (route, url = '/', method = 'GET', body) => {
    const handler = routes.get(route);
    assert.ok(handler, `route ${route} is mounted`);
    const headers = {};
    const res = {
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      setHeader(name, value) {
        headers[name.toLowerCase()] = value;
      },
      getHeader(name) {
        return headers[name.toLowerCase()];
      },
      writeHead(status, extra) {
        this.statusCode = status;
        Object.assign(headers, extra || {});
      },
      end(payload) {
        this.body = payload;
        this.writableEnded = true;
      },
      on() {},
    };
    const listeners = {};
    const req = {
      url,
      method,
      headers: {},
      on(event, fn) {
        listeners[event] = fn;
      },
      [Symbol.asyncIterator]: async function* () {
        if (body) yield Buffer.from(body);
      },
    };
    await handler(req, res);
    return { ...res, headers };
  };
  return { routes, call };
}

const json = (res) => JSON.parse(String(res.body));

test('the plugin mounts the status and tile routes for dev and preview servers', () => {
  for (const mode of ['configureServer', 'configurePreviewServer']) {
    const { routes } = install(mapillaryProxy(), mode);
    assert.deepEqual([...routes.keys()].sort(), [
      '/api/mapillary/status',
      '/api/mapillary/tiles',
    ]);
  }
});

test('status reports whether a token exists, never its value, and rejects non-GET', async () => {
  const saved = { MAPILLARY_CLIENT_TOKEN: process.env.MAPILLARY_CLIENT_TOKEN };
  delete process.env.MAPILLARY_CLIENT_TOKEN;
  try {
    const { call } = install(mapillaryProxy());
    const res = await call('/api/mapillary/status');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(res), { configured: false });
    assert.doesNotMatch(String(res.body), /MLY\||planner/);
    const post = await call('/api/mapillary/status', '/', 'POST');
    assert.equal(post.statusCode, 405);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test('tile route validates the path and refuses to proxy without a token', async () => {
  const saved = process.env.MAPILLARY_CLIENT_TOKEN;
  delete process.env.MAPILLARY_CLIENT_TOKEN;
  try {
    const { call } = install(mapillaryProxy());
    const bad = await call('/api/mapillary/tiles', '/coverage/14/1/x');
    assert.equal(bad.statusCode, 400);
    const signs = await call('/api/mapillary/tiles', '/signs/14/1/2');
    assert.equal(signs.statusCode, 400, 'only coverage tiles are proxied');
    const noKey = await call('/api/mapillary/tiles', '/coverage/14/1/2');
    assert.equal(noKey.statusCode, 503);
    assert.deepEqual(json(noKey), { error: 'no_key', keyRequired: true });
    const post = await call('/api/mapillary/tiles', '/coverage/14/1/2', 'POST');
    assert.equal(post.statusCode, 405);
  } finally {
    if (saved === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
    else process.env.MAPILLARY_CLIENT_TOKEN = saved;
  }
});

test('normalizeTileAddress enforces layer names, zoom ranges and tile bounds', () => {
  assert.equal(
    normalizeTileAddress({ layer: 'coverage', z: 3, x: 1, y: 2 }).key,
    'coverage/3/1/2',
  );
  assert.deepEqual(
    normalizeTileAddress({ layer: 'coverage', z: '14', x: '5', y: '6' })
      .dropLayers,
    ['image'],
  );
  for (const bad of [
    { layer: 'image', z: 14, x: 1, y: 1 },
    { layer: 'points', z: 14, x: 1, y: 1 },
    { layer: 'signs', z: 14, x: 1, y: 1 },
    { layer: 'coverage', z: 15, x: 1, y: 1 },
    { layer: 'coverage', z: 2, x: 4, y: 0 },
    { layer: 'coverage', z: 2, x: 1.5, y: 0 },
    { layer: 'coverage', z: -1, x: 0, y: 0 },
  ])
    assert.throws(
      () => normalizeTileAddress(bad),
      TileRequestError,
      JSON.stringify(bad),
    );
});

test('fetchTile serves from memory after one upstream fetch and strips the image layer', async () => {
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.MAPILLARY_CLIENT_TOKEN;
  process.env.MAPILLARY_CLIENT_TOKEN = 'MLY|test|token';
  _resetTileMemoryForTest();
  const tile = (() => {
    const writer = new PbfWriter();
    for (const name of ['sequence', 'image']) {
      writer.writeMessage(
        3,
        (layer, pbf) => {
          pbf.writeVarintField(15, 2);
          pbf.writeStringField(1, layer.name);
          if (layer.name === 'image')
            pbf.writeBytesField(4, Buffer.alloc(4000, 1));
        },
        { name },
      );
    }
    return Buffer.from(writer.finish());
  })();
  let upstreamCalls = 0;
  globalThis.fetch = async (url) => {
    upstreamCalls++;
    assert.match(
      String(url),
      /tiles\.mapillary\.com\/maps\/vtp\/mly1_public\/2\/10\/0\/0\?access_token=/,
    );
    return new Response(tile, {
      status: 200,
      headers: { 'content-type': 'application/x-protobuf' },
    });
  };
  try {
    // z10 is never requested by the app (overview z0–5, sequences z11–14), and
    // the file is removed first so an earlier test run cannot leave a disk hit.
    await fsp
      .rm(
        path.join(
          process.cwd(),
          '.gev-cache/mapillary/tiles/coverage/10/0-0.pbf',
        ),
      )
      .catch(() => {});
    const first = await fetchTile({ layer: 'coverage', z: 10, x: 0, y: 0 });
    assert.equal(first.source, 'upstream');
    assert.deepEqual(listTileLayers(first.bytes), ['sequence']);
    assert.ok(first.bytes.length < 100, 'image layer stripped in transit');
    const second = await fetchTile({ layer: 'coverage', z: 10, x: 0, y: 0 });
    assert.equal(second.source, 'memory');
    assert.equal(upstreamCalls, 1);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
    else process.env.MAPILLARY_CLIENT_TOKEN = savedToken;
    _resetTileMemoryForTest();
  }
});

// ── Tile trimming (relocated from server/providers/mapillary/trim.test.mjs) ──
/** Build a minimal MVT: layers with a name, a version and one opaque feature. */
function tile(layers) {
  const writer = new PbfWriter();
  for (const { name, payload } of layers) {
    writer.writeMessage(
      3,
      (layer, pbf) => {
        pbf.writeVarintField(15, 2); // version
        pbf.writeStringField(1, layer.name);
        pbf.writeMessage(2, (_f, p) => p.writeVarintField(1, 7), null); // feature
        pbf.writeVarintField(5, 4096); // extent
        if (layer.payload) pbf.writeBytesField(4, layer.payload); // a big key
      },
      { name, payload },
    );
  }
  return Buffer.from(writer.finish());
}

test('dropping a layer keeps the others byte-for-byte', () => {
  const big = Buffer.alloc(50_000, 7);
  const bytes = tile([
    { name: 'sequence' },
    { name: 'image', payload: big },
    { name: 'overview' },
  ]);
  const trimmed = stripTileLayers(bytes, ['image']);
  assert.deepEqual(listTileLayers(trimmed), ['sequence', 'overview']);
  assert.ok(trimmed.length < 200, `trimmed to ${trimmed.length} bytes`);
  assert.deepEqual(trimmed, tile([{ name: 'sequence' }, { name: 'overview' }]));
});

test('a tile without the layer is returned untouched', () => {
  const bytes = tile([{ name: 'sequence' }]);
  assert.equal(stripTileLayers(bytes, ['image']), bytes);
  assert.equal(stripTileLayers(bytes, []), bytes);
  assert.equal(stripTileLayers(Buffer.alloc(0), ['image']).length, 0);
});

test('layer names are read without decoding features', () => {
  assert.deepEqual(listTileLayers(tile([{ name: 'a' }, { name: 'b' }])), [
    'a',
    'b',
  ]);
});
