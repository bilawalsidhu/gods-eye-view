import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { PbfWriter } from 'pbf';
import { mapillaryProxy } from 'gods-eye-view/server/providers/mapillary';
import {
  listTileLayers,
  stripTileLayers,
} from '../../server/providers/mapillary/trim.js';
import * as tiles from '../../server/providers/mapillary/tiles.js';
import {
  TILE_DISK_FILE_OVERHEAD_BYTES,
  TILE_MAX_BYTES,
  TILE_MEMORY_BUDGET_BYTES,
  TILE_MEMORY_ENTRY_OVERHEAD_BYTES,
  TILE_RATE_LIMIT_MAX_HOLD_MS,
  TILE_ROUTE_MAX_PER_MIN,
  TILE_UPSTREAM_CONCURRENCY,
} from '../../server/providers/mapillary/constants.js';
import {
  fetchTile,
  normalizeTileAddress,
  TileRequestError,
  _resetTileMemoryForTest,
  _setTileCacheDirForTest,
  _settleTileWritesForTest,
} from '../../server/providers/mapillary/tiles.js';

// Keep test tiles out of the developer's .gev-cache.
const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-mly-tiles-'));
_setTileCacheDirForTest(cacheDir);
// Not switched back, so a late background write can never sweep the real
// cache; writes settle before the directory is removed.
after(async () => {
  await tiles._settleTileWritesForTest();
  await fsp.rm(cacheDir, { recursive: true, force: true });
});
const tileFile = ({ z, x, y }, root = cacheDir) =>
  path.join(root, 'coverage', String(z), `${x}-${y}.pbf`);
const HOUR = 60 * 60 * 1000;

async function writeAged(file, bytes, ageMs) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, bytes);
  const at = new Date(Date.now() - ageMs);
  await fsp.utimes(file, at, at);
}

/** Poll until `check()` holds (background cache writes are not awaited). */
async function waitFor(check, what) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const exists = (file) =>
  fsp.stat(file).then(
    () => true,
    () => false,
  );

/**
 * Mount the plugin. `call` waits for the handler; `start` returns at once with
 * the response, its `close` trigger and the handler's `done` promise.
 */
function install(plugin, mode = 'configureServer') {
  const routes = new Map();
  plugin[mode]({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  const start = (
    route,
    url = '/',
    method = 'GET',
    body,
    requestHeaders = {},
  ) => {
    const handler = routes.get(route);
    assert.ok(handler, `route ${route} is mounted`);
    const headers = {};
    const resListeners = {};
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
      on(event, fn) {
        resListeners[event] = fn;
      },
    };
    const listeners = {};
    const req = {
      url,
      method,
      headers: requestHeaders,
      on(event, fn) {
        listeners[event] = fn;
      },
      [Symbol.asyncIterator]: async function* () {
        if (body) yield Buffer.from(body);
      },
    };
    const done = Promise.resolve(handler(req, res));
    return { res, headers, done, close: () => resListeners.close?.() };
  };
  const call = async (...args) => {
    const { res, headers, done } = start(...args);
    await done;
    return { ...res, headers };
  };
  return { routes, call, start };
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

/** Drive the tile route against a scripted upstream `answer(call, url)`. */
async function withUpstream(answer, run) {
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.MAPILLARY_CLIENT_TOKEN;
  process.env.MAPILLARY_CLIENT_TOKEN = 'MLY|test|token';
  _resetTileMemoryForTest();
  const calls = [];
  const inits = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    inits.push(init);
    return answer(calls.length, String(url));
  };
  try {
    const { call, start } = install(mapillaryProxy());
    await run({ calls, inits, call, start });
  } finally {
    // No background write or sweep (dated by a mocked clock) outlives the test.
    await tiles._settleTileWritesForTest();
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
    else process.env.MAPILLARY_CLIENT_TOKEN = savedToken;
    _resetTileMemoryForTest();
  }
}

for (const status of [401, 403])
  test(`an upstream ${status} is a rejected key, and misses stop asking Mapillary`, async () => {
    await withUpstream(
      () => new Response('{}', { status }),
      async ({ calls, call }) => {
        for (const tile of ['/coverage/14/5/5', '/coverage/14/6/6']) {
          const res = await call('/api/mapillary/tiles', tile);
          assert.equal(res.statusCode, 403);
          assert.deepEqual(json(res), {
            error: 'Mapillary rejected the access token',
            keyRejected: true,
          });
          assert.doesNotMatch(String(res.body), /MLY\|/);
        }
        assert.equal(calls.length, 1, 'the second miss is answered locally');
        // A new token is asked at once.
        process.env.MAPILLARY_CLIENT_TOKEN = 'MLY|new|token';
        await call('/api/mapillary/tiles', '/coverage/14/7/7');
        assert.equal(calls.length, 2);
      },
    );
  });

test('a 429 passes its Retry-After on and holds misses until it is over', async (t) => {
  await withUpstream(
    () => new Response('{}', { status: 429, headers: { 'Retry-After': '30' } }),
    async ({ calls, call }) => {
      const first = await call('/api/mapillary/tiles', '/coverage/14/5/5');
      assert.equal(first.statusCode, 429);
      assert.equal(first.headers['retry-after'], '30');
      assert.deepEqual(json(first), {
        error: 'Mapillary is rate-limiting tile requests',
        retryAfter: 30,
      });
      const held = await call('/api/mapillary/tiles', '/coverage/14/6/6');
      assert.equal(held.statusCode, 429);
      assert.equal(calls.length, 1, 'held: Mapillary is not asked again');
      const now = Date.now();
      t.mock.method(Date, 'now', () => now + 31_000);
      await call('/api/mapillary/tiles', '/coverage/14/6/6');
      assert.equal(calls.length, 2, 'asked again once the wait is over');
    },
  );
});

for (const [why, retryAfter] of [
  ['seconds', () => '999999'],
  ['an HTTP date', () => new Date(Date.now() + 365 * 24 * HOUR).toUTCString()],
])
  test(`a far-off Retry-After (${why}) holds misses for at most TILE_RATE_LIMIT_MAX_HOLD_MS`, async (t) => {
    const maxSec = TILE_RATE_LIMIT_MAX_HOLD_MS / 1000;
    await withUpstream(
      () =>
        new Response('{}', {
          status: 429,
          headers: { 'Retry-After': retryAfter() },
        }),
      async ({ calls, call }) => {
        const first = await call('/api/mapillary/tiles', '/coverage/14/5/5');
        assert.equal(first.statusCode, 429);
        assert.equal(first.headers['retry-after'], String(maxSec));
        assert.equal(json(first).retryAfter, maxSec);
        const now = Date.now();
        t.mock.method(
          Date,
          'now',
          () => now + TILE_RATE_LIMIT_MAX_HOLD_MS - 5000,
        );
        const held = await call('/api/mapillary/tiles', '/coverage/14/6/6');
        assert.equal(held.statusCode, 429);
        assert.ok(
          json(held).retryAfter <= 5,
          'the hold counts down from the cap',
        );
        assert.equal(calls.length, 1, 'held: Mapillary is not asked again');
        Date.now.mock.mockImplementation(
          () => now + TILE_RATE_LIMIT_MAX_HOLD_MS + 1000,
        );
        await call('/api/mapillary/tiles', '/coverage/14/6/6');
        assert.equal(calls.length, 2, 'asked again once the capped hold ends');
      },
    );
  });

test('normalizeTileAddress enforces layer names, zoom ranges and tile bounds', () => {
  assert.equal(
    normalizeTileAddress({ layer: 'coverage', z: 11, x: 1, y: 2 }).key,
    'coverage/11/1/2',
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
    { layer: 'coverage', z: 11, x: 2048, y: 0 },
    { layer: 'coverage', z: 11, x: 1.5, y: 0 },
    { layer: 'coverage', z: -1, x: 0, y: 0 },
  ])
    assert.throws(
      () => normalizeTileAddress(bad),
      TileRequestError,
      JSON.stringify(bad),
    );
});

test('normalizeTileAddress refuses prototype keys as layer names', () => {
  for (const layer of ['constructor', '__proto__', 'toString'])
    assert.throws(
      () => normalizeTileAddress({ layer, z: 1, x: 0, y: 0 }),
      TileRequestError,
      layer,
    );
});

test('coverage zooms the app never requests (below z11) are refused with a 400', async () => {
  for (const z of [0, 3, 5, 6, 7, 8, 9, 10])
    assert.throws(
      () => normalizeTileAddress({ layer: 'coverage', z, x: 0, y: 0 }),
      TileRequestError,
      `z${z}`,
    );
  for (const z of [11, 12, 13, 14])
    assert.equal(
      normalizeTileAddress({ layer: 'coverage', z, x: 0, y: 0 }).z,
      z,
    );
  await withUpstream(
    () => new Response(null, { status: 204 }),
    async ({ calls, call }) => {
      const res = await call('/api/mapillary/tiles', '/coverage/9/5/5');
      assert.equal(res.statusCode, 400);
      assert.deepEqual(json(res), {
        error: 'Tile zoom for coverage must be 11–14',
      });
      assert.equal(calls.length, 0, 'Mapillary is not asked');
    },
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
      /tiles\.mapillary\.com\/maps\/vtp\/mly1_public\/2\/14\/0\/0\?access_token=/,
    );
    return new Response(tile, {
      status: 200,
      headers: { 'content-type': 'application/x-protobuf' },
    });
  };
  try {
    // The file is removed first so an earlier test cannot leave a disk hit.
    await fsp.rm(tileFile({ z: 14, x: 0, y: 0 }), { force: true });
    const first = await fetchTile({ layer: 'coverage', z: 14, x: 0, y: 0 });
    assert.equal(first.source, 'upstream');
    assert.deepEqual(listTileLayers(first.bytes), ['sequence']);
    assert.ok(first.bytes.length < 100, 'image layer stripped in transit');
    const second = await fetchTile({ layer: 'coverage', z: 14, x: 0, y: 0 });
    assert.equal(second.source, 'memory');
    assert.equal(upstreamCalls, 1);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
    else process.env.MAPILLARY_CLIENT_TOKEN = savedToken;
    _resetTileMemoryForTest();
  }
});

test('a tile held in memory past the 24 h TTL is fetched again', async (t) => {
  const tile = { layer: 'coverage', z: 14, x: 3, y: 3 };
  await withDeferredUpstream([tile], async ({ upstream, settle }) => {
    const first = fetchTile(tile);
    await waitFor(() => upstream.length === 1, 'the upstream fetch');
    upstream[0].release();
    assert.equal((await first).source, 'upstream');
    assert.equal((await fetchTile(tile)).source, 'memory');
    const now = Date.now();
    t.mock.method(Date, 'now', () => now + 25 * 60 * 60 * 1000);
    const again = fetchTile(tile);
    // Neither cache answers a stale tile: Mapillary is asked again.
    await waitFor(() => upstream.length === 2, 'a second upstream fetch');
    upstream[1].release();
    assert.equal((await again).source, 'upstream');
  });
});

test('a disk tile keeps its age in memory and through a retrim rewrite', async (t) => {
  const address = { layer: 'coverage', z: 14, x: 8, y: 8 };
  const file = tileFile(address);
  const untrimmed = tile([
    { name: 'sequence' },
    { name: 'image', payload: Buffer.alloc(4000, 1) },
  ]);
  await writeAged(file, untrimmed, 23 * HOUR);
  const writtenAt = (await fsp.stat(file)).mtimeMs;
  await withUpstream(
    () => new Response(tile([{ name: 'sequence' }]), { status: 200 }),
    async ({ calls }) => {
      const first = await fetchTile(address);
      assert.equal(first.source, 'disk');
      assert.deepEqual(listTileLayers(first.bytes), ['sequence']);
      // The untrimmed file is replaced by the trimmed tile, still dated when
      // Mapillary served it.
      await tiles._settleTileWritesForTest();
      assert.equal((await fsp.stat(file)).size, first.bytes.length);
      assert.ok(
        Math.abs((await fsp.stat(file)).mtimeMs - writtenAt) < 1000,
        'the rewrite keeps the original mtime',
      );
      const now = Date.now();
      t.mock.method(Date, 'now', () => now + 2 * HOUR);
      const later = await fetchTile(address);
      assert.equal(later.source, 'upstream', '25 h old: no cache serves it');
      assert.equal(calls.length, 1);
      await tiles._settleTileWritesForTest();
      assert.ok((await fsp.stat(file)).mtimeMs > writtenAt + HOUR);
    },
  );
});

/** Point the disk cache at a fresh directory for one test. */
async function withCacheDir(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-mly-sweep-'));
  tiles._setTileCacheDirForTest(dir);
  try {
    await run(dir);
  } finally {
    await tiles._settleTileWritesForTest();
    tiles._setTileCacheDirForTest(cacheDir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('the disk sweep removes expired tiles and keeps fresh ones', async () => {
  await withCacheDir(async (dir) => {
    const expired = tileFile({ z: 14, x: 1, y: 1 }, dir);
    const fresh = tileFile({ z: 14, x: 2, y: 2 }, dir);
    await writeAged(expired, Buffer.alloc(100, 1), 25 * HOUR);
    await writeAged(fresh, Buffer.alloc(100, 2), 23 * HOUR);
    const result = await tiles.sweepTileDisk();
    assert.equal(result.removed, 1);
    assert.equal(await exists(expired), false);
    assert.equal(await exists(fresh), true);
  });
});

test('the disk sweep evicts the oldest tiles past the size cap', async () => {
  await withCacheDir(async (dir) => {
    const files = [3, 2, 1].map((age) => {
      const file = tileFile({ z: 13, x: age, y: age }, dir);
      return { file, age };
    });
    for (const { file, age } of files)
      await writeAged(file, Buffer.alloc(100, age), age * HOUR);
    const charged = 100 + TILE_DISK_FILE_OVERHEAD_BYTES;
    const result = await tiles.sweepTileDisk({ maxBytes: 2.5 * charged });
    assert.deepEqual(result, { removed: 1, bytes: 2 * charged });
    assert.equal(await exists(files[0].file), false, 'the oldest goes first');
    assert.equal(await exists(files[1].file), true);
    assert.equal(await exists(files[2].file), true);
  });
});

test('caching a tile sweeps expired files off the disk in the background', async () => {
  await withCacheDir(async (dir) => {
    const expired = tileFile({ z: 12, x: 1, y: 1 }, dir);
    const fresh = tileFile({ z: 12, x: 2, y: 2 }, dir);
    await writeAged(expired, Buffer.alloc(100, 1), 30 * HOUR);
    await writeAged(fresh, Buffer.alloc(100, 2), HOUR);
    await withUpstream(
      () => new Response(tile([{ name: 'sequence' }]), { status: 200 }),
      async () => {
        const address = { layer: 'coverage', z: 14, x: 4, y: 4 };
        assert.equal((await fetchTile(address)).source, 'upstream');
        await waitFor(() => exists(tileFile(address, dir)), 'the tile write');
        await waitFor(async () => !(await exists(expired)), 'the sweep');
        assert.equal(await exists(fresh), true);
      },
    );
  });
});

/** An upstream whose fetches wait until released and record their abort. */
async function withDeferredUpstream(tiles, run) {
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.MAPILLARY_CLIENT_TOKEN;
  process.env.MAPILLARY_CLIENT_TOKEN = 'MLY|test|token';
  _resetTileMemoryForTest();
  for (const tile of tiles) await fsp.rm(tileFile(tile), { force: true });
  const body = (() => {
    const writer = new PbfWriter();
    writer.writeMessage(
      3,
      (layer, pbf) => {
        pbf.writeVarintField(15, 2);
        pbf.writeStringField(1, layer.name);
      },
      { name: 'sequence' },
    );
    return Buffer.from(writer.finish());
  })();
  const upstream = [];
  globalThis.fetch = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      const call = { url: String(url), signal, aborted: false };
      call.release = () =>
        resolve(
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/x-protobuf' },
          }),
        );
      signal?.addEventListener(
        'abort',
        () => {
          call.aborted = true;
          reject(signal.reason);
        },
        { once: true },
      );
      upstream.push(call);
    });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  try {
    await run({ upstream, settle, body });
  } finally {
    await _settleTileWritesForTest();
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
    else process.env.MAPILLARY_CLIENT_TOKEN = savedToken;
    _resetTileMemoryForTest();
  }
}

test('a joined tile request survives the first caller abandoning it', async () => {
  const tile = { layer: 'coverage', z: 14, x: 1, y: 1 };
  await withDeferredUpstream([tile], async ({ upstream, settle }) => {
    const first = new AbortController();
    const second = new AbortController();
    const a = fetchTile(tile, { signal: first.signal });
    await waitFor(() => upstream.length === 1, 'the upstream fetch');
    const b = fetchTile(tile, { signal: second.signal });
    await settle();
    assert.equal(upstream.length, 1, 'one upstream request for both');
    first.abort();
    await assert.rejects(a, { name: 'AbortError' });
    assert.equal(upstream[0].aborted, false, 'the shared fetch keeps going');
    upstream[0].release();
    const joined = await b;
    assert.equal(joined.source, 'inflight');
    assert.deepEqual(listTileLayers(joined.bytes), ['sequence']);
    assert.equal(upstream.length, 1);
  });
});

test('a joined caller that aborts leaves at once and the first still gets the tile', async () => {
  const tile = { layer: 'coverage', z: 14, x: 2, y: 2 };
  await withDeferredUpstream([tile], async ({ upstream, settle }) => {
    const first = new AbortController();
    const second = new AbortController();
    const a = fetchTile(tile, { signal: first.signal });
    await waitFor(() => upstream.length === 1, 'the upstream fetch');
    const b = fetchTile(tile, { signal: second.signal });
    await settle();
    second.abort();
    await assert.rejects(b, { name: 'AbortError' });
    assert.equal(upstream[0].aborted, false);
    upstream[0].release();
    assert.equal((await a).source, 'upstream');
  });
});

test('the upstream tile fetch is cancelled once every waiter has left', async () => {
  const tile = { layer: 'coverage', z: 14, x: 3, y: 3 };
  await withDeferredUpstream([tile], async ({ upstream, settle }) => {
    const first = new AbortController();
    const second = new AbortController();
    const a = fetchTile(tile, { signal: first.signal });
    await waitFor(() => upstream.length === 1, 'the upstream fetch');
    const b = fetchTile(tile, { signal: second.signal });
    await settle();
    first.abort();
    await assert.rejects(a, { name: 'AbortError' });
    assert.equal(upstream[0].aborted, false, 'one waiter is still there');
    second.abort();
    await assert.rejects(b, { name: 'AbortError' });
    assert.equal(upstream[0].aborted, true, 'the last waiter cancels it');
    // A later request for the same tile starts a fresh fetch.
    const again = fetchTile(tile);
    await waitFor(() => upstream.length === 2, 'a fresh fetch');
    upstream[1].release();
    assert.equal((await again).source, 'upstream');
  });
});

test('a request arriving before a cancelled fetch has wound down starts a fresh one', async () => {
  const tile = { layer: 'coverage', z: 13, x: 130, y: 100 };
  await withDeferredUpstream([tile], async ({ body, settle }) => {
    // A real fetch rejects some time after its abort; until then the
    // cancelled flight is still registered for its tile.
    const upstream = [];
    globalThis.fetch = (url, { signal } = {}) =>
      new Promise((resolve, reject) => {
        const call = { aborted: false };
        call.release = () => resolve(new Response(body, { status: 200 }));
        call.windDown = () => reject(signal.reason);
        signal?.addEventListener('abort', () => (call.aborted = true), {
          once: true,
        });
        upstream.push(call);
      });
    const first = new AbortController();
    const a = fetchTile(tile, { signal: first.signal });
    await waitFor(() => upstream.length === 1, 'the upstream fetch');
    first.abort();
    await assert.rejects(a, { name: 'AbortError' });
    assert.equal(upstream[0].aborted, true, 'the last waiter cancelled it');
    // Joining the cancelled flight would end in its AbortError (a 502).
    const b = fetchTile(tile);
    await waitFor(() => upstream.length === 2, 'a fresh upstream fetch');
    // The cancelled flight winding down must not unregister the fresh one.
    upstream[0].windDown();
    await settle();
    const c = fetchTile(tile);
    await settle();
    assert.equal(upstream.length, 2, 'a third request joins the fresh fetch');
    upstream[1].release();
    const fresh = await b;
    assert.equal(fresh.source, 'upstream');
    assert.deepEqual(listTileLayers(fresh.bytes), ['sequence']);
    assert.equal((await c).source, 'inflight');
  });
});

// ── Route: success path, refusals, gate and limiter ──

/** Every header value and the body, as text, for a token-leak check. */
const leakText = (res) =>
  [
    ...Object.values(res.headers).map(String),
    Buffer.isBuffer(res.body) ? res.body.toString('latin1') : String(res.body),
  ].join('\n');

test('the tile route serves a trimmed protobuf tile, then from memory', async () => {
  const address = { layer: 'coverage', z: 14, x: 9, y: 9 };
  await fsp.rm(tileFile(address), { force: true });
  const upstream = tile([
    { name: 'sequence' },
    { name: 'image', payload: Buffer.alloc(4000, 1) },
  ]);
  await withUpstream(
    () =>
      new Response(upstream, {
        status: 200,
        headers: { 'content-type': 'application/x-protobuf' },
      }),
    async ({ calls, call }) => {
      const res = await call('/api/mapillary/tiles', '/coverage/14/9/9');
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-type'], 'application/x-protobuf');
      assert.equal(res.headers['cache-control'], 'public, max-age=3600');
      assert.equal(res.headers['x-gev-cache'], 'upstream');
      assert.ok(Buffer.isBuffer(res.body));
      assert.deepEqual(listTileLayers(res.body), ['sequence']);
      assert.deepEqual(res.body, tile([{ name: 'sequence' }]));
      assert.doesNotMatch(leakText(res), /MLY\|/);
      const again = await call('/api/mapillary/tiles', '/coverage/14/9/9');
      assert.equal(again.statusCode, 200);
      assert.equal(again.headers['x-gev-cache'], 'memory');
      assert.deepEqual(again.body, res.body);
      assert.equal(calls.length, 1);
    },
  );
});

for (const status of [204, 404])
  test(`an empty upstream tile (${status}) is a 204 with no body`, async () => {
    const address = { layer: 'coverage', z: 14, x: 10, y: status };
    await fsp.rm(tileFile(address), { force: true });
    await withUpstream(
      () => new Response(null, { status }),
      async ({ call }) => {
        const res = await call(
          '/api/mapillary/tiles',
          `/coverage/14/10/${status}`,
        );
        assert.equal(res.statusCode, 204);
        assert.equal(res.body, undefined);
        assert.equal(res.headers['content-type'], 'application/x-protobuf');
        assert.equal(res.headers['x-gev-cache'], 'upstream');
        assert.doesNotMatch(leakText(res), /MLY\|/);
      },
    );
  });

test('closing the response mid-flight aborts the upstream fetch', async () => {
  const address = { layer: 'coverage', z: 14, x: 11, y: 11 };
  await withDeferredUpstream([address], async ({ upstream }) => {
    const { start } = install(mapillaryProxy());
    const pending = start('/api/mapillary/tiles', '/coverage/14/11/11');
    await waitFor(() => upstream.length === 1, 'the upstream fetch');
    assert.equal(upstream[0].aborted, false);
    pending.close();
    await pending.done;
    assert.equal(upstream[0].aborted, true, 'the last waiter left');
    assert.equal(pending.res.writableEnded, false, 'nothing is written');
  });
});

for (const status of [400, 410, 422])
  test(`an upstream ${status} is a 502, not the client's fault`, async () => {
    await withUpstream(
      () => new Response('{}', { status }),
      async ({ call }) => {
        const res = await call('/api/mapillary/tiles', '/coverage/14/12/12');
        assert.equal(res.statusCode, 502);
        assert.deepEqual(json(res), {
          error: `Mapillary tiles HTTP ${status}`,
        });
      },
    );
  });

const redirect = (location) =>
  new Response(null, {
    status: 302,
    headers: location === null ? {} : { location },
  });

test('a redirect within the Mapillary tile origin is followed by hand', async () => {
  await fsp.rm(tileFile({ z: 14, x: 13, y: 13 }), { force: true });
  await withUpstream(
    (n) =>
      n === 1
        ? redirect('/maps/vtp/mly1_public/2/14/13/13?moved=1')
        : new Response(tile([{ name: 'sequence' }]), { status: 200 }),
    async ({ calls, inits, call }) => {
      const res = await call('/api/mapillary/tiles', '/coverage/14/13/13');
      assert.equal(res.statusCode, 200);
      assert.deepEqual(listTileLayers(res.body), ['sequence']);
      assert.equal(calls.length, 2);
      assert.equal(
        calls[1],
        'https://tiles.mapillary.com/maps/vtp/mly1_public/2/14/13/13?moved=1',
      );
      for (const init of inits)
        assert.equal(init.redirect, 'manual', 'fetch never follows itself');
      assert.doesNotMatch(leakText(res), /MLY\|/);
    },
  );
});

for (const [why, location] of [
  ['another host', 'https://evil.example/collect'],
  ['a look-alike host', 'https://tiles.mapillary.com.evil.example/t'],
  ['another port', 'https://tiles.mapillary.com:8443/t'],
  ['plain HTTP', 'http://tiles.mapillary.com/maps/vtp/t'],
  ['credentials in the URL', 'https://user:pw@tiles.mapillary.com/t'],
  ['a scheme-relative host', '//evil.example/t'],
  ['no Location', null],
])
  test(`a redirect off the tile origin (${why}) is a 502, and the token stays home`, async () => {
    await withUpstream(
      (n) =>
        n === 1
          ? redirect(location)
          : new Response(tile([{ name: 'sequence' }]), { status: 200 }),
      async ({ calls, inits, call }) => {
        const res = await call('/api/mapillary/tiles', '/coverage/14/14/14');
        assert.equal(res.statusCode, 502);
        assert.deepEqual(json(res), {
          error: 'Mapillary tile redirect left the tile origin',
        });
        assert.equal(calls.length, 1, 'the redirect was not followed');
        assert.equal(inits[0].redirect, 'manual');
        assert.doesNotMatch(leakText(res), /MLY\|/);
      },
    );
  });

test('an endless same-origin redirect stops after a few hops', async () => {
  await withUpstream(
    (n) => redirect(`/maps/vtp/mly1_public/2/14/15/15?hop=${n}`),
    async ({ calls, call }) => {
      const res = await call('/api/mapillary/tiles', '/coverage/14/15/15');
      assert.equal(res.statusCode, 502);
      assert.deepEqual(json(res), {
        error: 'Mapillary tile redirected too often',
      });
      assert.equal(calls.length, tiles.TILE_MAX_REDIRECTS + 1);
    },
  );
});

test('cross-site requests are refused on both routes; the app itself passes', async () => {
  await withUpstream(
    () => new Response(tile([{ name: 'sequence' }]), { status: 200 }),
    async ({ calls, call }) => {
      const host = 'localhost:5173';
      const refused = [
        { host, 'sec-fetch-site': 'cross-site' }, // <img>, navigation
        { host, 'sec-fetch-site': 'same-site' },
        { host, origin: 'https://evil.example' }, // fetch from another page
        { host, origin: 'null' }, // sandboxed frame
        { host, 'x-forwarded-for': '203.0.113.9' }, // through a proxy
      ];
      for (const headers of refused)
        for (const [route, url] of [
          ['/api/mapillary/status', '/'],
          ['/api/mapillary/tiles', '/coverage/14/13/13'],
        ]) {
          const res = await call(route, url, 'GET', undefined, headers);
          assert.equal(
            res.statusCode,
            403,
            `${route} ${JSON.stringify(headers)}`,
          );
        }
      assert.equal(calls.length, 0, 'Mapillary is never asked');
      const app = {
        host,
        origin: `http://${host}`,
        'sec-fetch-site': 'same-origin',
      };
      const status = await call(
        '/api/mapillary/status',
        '/',
        'GET',
        undefined,
        app,
      );
      assert.equal(status.statusCode, 200);
      assert.deepEqual(json(status), { configured: true });
      const res = await call(
        '/api/mapillary/tiles',
        '/coverage/14/13/14',
        'GET',
        undefined,
        { host, 'sec-fetch-site': 'same-origin' }, // a same-origin GET has no Origin
      );
      assert.notEqual(res.statusCode, 403);
      assert.equal(calls.length, 1);
    },
  );
});

test('the tile route answers 429 past its per-IP budget', async () => {
  const saved = process.env.MAPILLARY_CLIENT_TOKEN;
  delete process.env.MAPILLARY_CLIENT_TOKEN;
  try {
    const { call } = install(mapillaryProxy());
    for (let i = 0; i < TILE_ROUTE_MAX_PER_MIN; i++) {
      const res = await call('/api/mapillary/tiles', '/coverage/14/1/2');
      assert.equal(res.statusCode, 503, `request ${i + 1} is within budget`);
    }
    const over = await call('/api/mapillary/tiles', '/coverage/14/1/2');
    assert.equal(over.statusCode, 429);
    assert.equal(over.headers['retry-after'], '5');
    assert.deepEqual(json(over), {
      error: 'Too many tile requests',
      retryAfter: 5,
    });
    const status = await call('/api/mapillary/status');
    assert.equal(status.statusCode, 200, 'the status route is not limited');
  } finally {
    if (saved === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
    else process.env.MAPILLARY_CLIENT_TOKEN = saved;
  }
});

// ── Tile cache and upstream bounds ──

test('concurrent disk hits on an untrimmed tile rewrite it once, keeping its age', async (t) => {
  const address = { layer: 'coverage', z: 14, x: 14, y: 14 };
  const file = tileFile(address);
  await writeAged(
    file,
    tile([
      { name: 'sequence' },
      { name: 'image', payload: Buffer.alloc(4000, 1) },
    ]),
    23 * HOUR,
  );
  const writtenAt = (await fsp.stat(file)).mtimeMs;
  const writeFile = fsp.writeFile;
  const writes = [];
  t.mock.method(fsp, 'writeFile', (target, ...rest) => {
    if (String(target).startsWith(file)) writes.push(String(target));
    return writeFile.call(fsp, target, ...rest);
  });
  const warn = t.mock.method(console, 'warn', () => {});
  await withUpstream(
    () => assert.fail('a disk hit never asks Mapillary'),
    async () => {
      const hits = await Promise.all([1, 2, 3].map(() => fetchTile(address)));
      for (const hit of hits) {
        assert.equal(hit.source, 'disk');
        assert.deepEqual(listTileLayers(hit.bytes), ['sequence']);
      }
      await tiles._settleTileWritesForTest();
    },
  );
  assert.equal(writes.length, 1, 'one rewrite for three hits');
  assert.equal(warn.mock.callCount(), 0);
  const stat = await fsp.stat(file);
  assert.equal(stat.size, tile([{ name: 'sequence' }]).length);
  assert.ok(Math.abs(stat.mtimeMs - writtenAt) < 1000, 'no fresh 24 h of life');
});

test('a rewrite overtaken by a fresh tile write steps aside cleanly', async (t) => {
  const address = { layer: 'coverage', z: 14, x: 15, y: 15 };
  const file = tileFile(address);
  await writeAged(
    file,
    tile([
      { name: 'sequence' },
      { name: 'image', payload: Buffer.alloc(4000, 1) },
    ]),
    23 * HOUR,
  );
  const writtenAt = (await fsp.stat(file)).mtimeMs;
  // Hold the retrim's re-dating step until the fresh write has landed.
  const utimes = fsp.utimes;
  let held = null;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  t.mock.method(fsp, 'utimes', async (target, ...rest) => {
    if (String(target).startsWith(file)) {
      held = String(target);
      await gate;
    }
    return utimes.call(fsp, target, ...rest);
  });
  const warn = t.mock.method(console, 'warn', () => {});
  const fresh = tile([{ name: 'sequence' }, { name: 'overview' }]);
  await withUpstream(
    () => new Response(fresh, { status: 200 }),
    async ({ calls }) => {
      assert.equal((await fetchTile(address)).source, 'disk');
      await waitFor(() => held, 'the retrim write');
      // Two hours on, the disk copy is past its 24 h: Mapillary is asked.
      _resetTileMemoryForTest();
      const now = Date.now();
      t.mock.method(Date, 'now', () => now + 2 * HOUR);
      assert.equal((await fetchTile(address)).source, 'upstream');
      assert.equal(calls.length, 1);
      await waitFor(
        async () => (await fsp.stat(file)).mtimeMs > writtenAt + HOUR,
        'the fresh tile write',
      );
      release();
      await tiles._settleTileWritesForTest();
    },
  );
  assert.equal(warn.mock.callCount(), 0, 'no ENOENT from a shared temp file');
  assert.deepEqual(await fsp.readFile(file), fresh, 'the fresh tile stays');
  assert.ok((await fsp.stat(file)).mtimeMs > writtenAt + HOUR);
  const left = await fsp.readdir(path.dirname(file));
  assert.deepEqual(
    left.filter((name) => name.endsWith('.tmp')),
    [],
    'no temporary file is left behind',
  );
});

test('at most a few upstream fetches run at once; a queued abort never fetches', async () => {
  const addresses = Array.from(
    { length: TILE_UPSTREAM_CONCURRENCY + 2 },
    (_, i) => ({
      layer: 'coverage',
      z: 13,
      x: 100 + i,
      y: 100,
    }),
  );
  await withDeferredUpstream(addresses, async ({ upstream, settle }) => {
    const controllers = addresses.map(() => new AbortController());
    const begin = (i) =>
      fetchTile(addresses[i], { signal: controllers[i].signal });
    // Fill every slot first, so the two extra misses are the ones that wait.
    const results = [];
    for (let i = 0; i < TILE_UPSTREAM_CONCURRENCY; i++) results.push(begin(i));
    await waitFor(
      () => upstream.length === TILE_UPSTREAM_CONCURRENCY,
      'every slot in use',
    );
    const queued = TILE_UPSTREAM_CONCURRENCY;
    const aborted = queued + 1;
    results.push(begin(queued), begin(aborted));
    await settle();
    assert.equal(upstream.length, TILE_UPSTREAM_CONCURRENCY, 'the rest wait');
    controllers[aborted].abort();
    await assert.rejects(results[aborted], { name: 'AbortError' });
    upstream[0].release();
    await waitFor(
      () => upstream.length === TILE_UPSTREAM_CONCURRENCY + 1,
      'the queued miss taking the freed slot',
    );
    assert.match(upstream.at(-1).url, new RegExp(`/13/${100 + queued}/100\\?`));
    for (const call of upstream) call.release();
    for (const result of results.slice(0, aborted))
      assert.equal((await result).source, 'upstream');
    await settle();
    assert.equal(
      upstream.length,
      TILE_UPSTREAM_CONCURRENCY + 1,
      'the aborted miss never reached Mapillary',
    );
  });
});

test('a caller gone while the disk cache is read starts no upstream fetch', async () => {
  const address = { layer: 'coverage', z: 13, x: 120, y: 100 };
  await withDeferredUpstream([address], async ({ upstream, settle }) => {
    const controller = new AbortController();
    const pending = fetchTile(address, { signal: controller.signal });
    controller.abort(); // fetchTile is still reading the disk cache
    await assert.rejects(pending, { name: 'AbortError' });
    await settle();
    assert.equal(upstream.length, 0, 'Mapillary is not asked');
  });
});

test('empty tiles are charged against the memory budget', async () => {
  const addresses = [16, 17, 18].map((x) => ({
    layer: 'coverage',
    z: 14,
    x,
    y: 16,
  }));
  for (const address of addresses)
    await fsp.rm(tileFile(address), { force: true });
  await withUpstream(
    () => new Response(null, { status: 204 }),
    async () => {
      for (const address of addresses)
        assert.equal((await fetchTile(address)).bytes.length, 0);
      assert.deepEqual(tiles._tileMemoryForTest(), {
        entries: 3,
        bytes: 3 * TILE_MEMORY_ENTRY_OVERHEAD_BYTES,
      });
    },
  );
});

/** A one-layer tile of exactly `size` bytes. */
function tileOfSize(size) {
  const probe = tile([{ name: 'sequence', payload: Buffer.alloc(size) }]);
  const bytes = tile([
    { name: 'sequence', payload: Buffer.alloc(2 * size - probe.length) },
  ]);
  assert.equal(bytes.length, size);
  return bytes;
}

/** Disk writes are off, so a tile memory dropped comes back from Mapillary. */
async function withBigTiles(t, bodies, run) {
  for (const address of bodies.keys())
    await fsp.rm(tileFile(address), { force: true });
  t.mock.method(fsp, 'writeFile', async () => {
    throw new Error('disk writes are off in this test');
  });
  t.mock.method(console, 'warn', () => {});
  const byPath = new Map(
    [...bodies].map(([{ z, x, y }, body]) => [`/2/${z}/${x}/${y}?`, body]),
  );
  await withUpstream(
    (_n, url) => {
      const [, body] = [...byPath].find(([key]) => url.includes(key));
      return new Response(body, { status: 200 });
    },
    ({ calls }) => {
      const fetched = (address) =>
        calls.filter((url) =>
          url.includes(`/2/${address.z}/${address.x}/${address.y}?`),
        ).length;
      return run({ fetched });
    },
  );
}

test('the memory cache evicts the least recently used tile, not the oldest fetched', async (t) => {
  const MB = 1024 * 1024;
  // Three fit in the budget, a fourth does not.
  const size = 30 * MB;
  const cost = size + TILE_MEMORY_ENTRY_OVERHEAD_BYTES;
  assert.ok(3 * cost <= TILE_MEMORY_BUDGET_BYTES);
  assert.ok(4 * cost > TILE_MEMORY_BUDGET_BYTES);
  const body = tileOfSize(size);
  const [a, b, c, d] = [20, 21, 22, 23].map((x) => ({
    layer: 'coverage',
    z: 14,
    x,
    y: 20,
  }));
  await withBigTiles(
    t,
    new Map([a, b, c, d].map((address) => [address, body])),
    async ({ fetched }) => {
      for (const address of [a, b, c])
        assert.equal((await fetchTile(address)).source, 'upstream');
      assert.deepEqual(tiles._tileMemoryForTest(), {
        entries: 3,
        bytes: 3 * cost,
      });
      // A is used again, so B is now the least recently used.
      assert.equal((await fetchTile(a)).source, 'memory');
      assert.equal((await fetchTile(d)).source, 'upstream');
      assert.deepEqual(tiles._tileMemoryForTest(), {
        entries: 3,
        bytes: 3 * cost,
      });
      for (const address of [a, c, d])
        assert.equal(
          (await fetchTile(address)).source,
          'memory',
          `${address.x} kept`,
        );
      // B was evicted; asking for it again goes back to Mapillary.
      assert.equal((await fetchTile(b)).source, 'upstream');
      assert.equal(fetched(b), 2);
      assert.equal(fetched(a), 1);
    },
  );
});

test('a tile costing more than half the memory budget is served but not kept', async (t) => {
  const half = TILE_MEMORY_BUDGET_BYTES / 2;
  // At exactly half the budget a tile is kept; one byte more and it is not.
  const fits = tileOfSize(half - TILE_MEMORY_ENTRY_OVERHEAD_BYTES);
  const tooBig = tileOfSize(half - TILE_MEMORY_ENTRY_OVERHEAD_BYTES + 1);
  assert.ok(tooBig.length <= TILE_MAX_BYTES, 'within the upstream size cap');
  const small = { layer: 'coverage', z: 14, x: 24, y: 20 };
  const kept = { layer: 'coverage', z: 14, x: 25, y: 20 };
  const big = { layer: 'coverage', z: 14, x: 26, y: 20 };
  await withBigTiles(
    t,
    new Map([
      [small, tile([{ name: 'sequence' }])],
      [kept, fits],
      [big, tooBig],
    ]),
    async ({ fetched }) => {
      await fetchTile(small);
      const before = tiles._tileMemoryForTest();
      const served = await fetchTile(big);
      assert.equal(served.source, 'upstream');
      assert.equal(served.bytes.length, tooBig.length, 'served in full');
      assert.deepEqual(
        tiles._tileMemoryForTest(),
        before,
        'nothing evicted to make room',
      );
      assert.equal((await fetchTile(small)).source, 'memory');
      assert.equal((await fetchTile(big)).source, 'upstream', 'not kept');
      assert.equal(fetched(big), 2);
      assert.equal((await fetchTile(kept)).source, 'upstream');
      assert.equal((await fetchTile(kept)).source, 'memory', 'half fits');
    },
  );
});

test('empty tile files count toward the disk cap', async () => {
  await withCacheDir(async (dir) => {
    const files = [3, 2, 1].map((age) => ({
      file: tileFile({ z: 13, x: age, y: age }, dir),
      age,
    }));
    for (const { file, age } of files)
      await writeAged(file, Buffer.alloc(0), age * HOUR);
    const result = await tiles.sweepTileDisk({
      maxBytes: 2 * TILE_DISK_FILE_OVERHEAD_BYTES,
    });
    assert.deepEqual(result, {
      removed: 1,
      bytes: 2 * TILE_DISK_FILE_OVERHEAD_BYTES,
    });
    assert.equal(await exists(files[0].file), false, 'the oldest goes first');
    assert.equal(await exists(files[2].file), true);
  });
});

test('a body past the size cap aborts the upstream request as it streams', async () => {
  const address = { layer: 'coverage', z: 14, x: 19, y: 19 };
  await fsp.rm(tileFile(address), { force: true });
  const MB = 1024 * 1024;
  const chunk = new Uint8Array(MB);
  let pulled = 0;
  let cancelled = false;
  let upstreamSignal = null;
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.MAPILLARY_CLIENT_TOKEN;
  process.env.MAPILLARY_CLIENT_TOKEN = 'MLY|test|token';
  _resetTileMemoryForTest();
  // Chunked, no Content-Length: only a running count can see it is too big.
  globalThis.fetch = async (_url, { signal } = {}) => {
    upstreamSignal = signal;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(chunk);
        pulled += chunk.byteLength;
        if (pulled >= TILE_MAX_BYTES + 8 * MB) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, { status: 200 });
  };
  try {
    await assert.rejects(fetchTile(address), {
      name: 'TileUpstreamError',
      status: 502,
      message: 'Mapillary tile exceeds size cap',
    });
    assert.equal(upstreamSignal.aborted, true, 'the request is aborted');
    assert.equal(cancelled, true, 'the body is cancelled');
    assert.ok(
      pulled <= TILE_MAX_BYTES + 2 * MB,
      `stopped after ${pulled} bytes`,
    );
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
    else process.env.MAPILLARY_CLIENT_TOKEN = savedToken;
    _resetTileMemoryForTest();
  }
});

// ── Tile trimming ──
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
