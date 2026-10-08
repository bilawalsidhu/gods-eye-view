import assert from 'node:assert/strict';
import test from 'node:test';
import { PbfWriter } from 'pbf';
import {
  mapillaryProxy,
  TILE_ROUTE_MAX_PER_MIN,
} from 'gods-eye-view/server/providers/mapillary';
import {
  listTileLayers,
  stripTileLayers,
} from '../../server/providers/mapillary/trim.js';
import {
  TILE_MAX_BYTES,
  TILE_MEMORY_BUDGET_BYTES,
  TILE_UPSTREAM_CONCURRENCY,
  TILE_TTL_MS,
  fetchTile,
  parseTilePath,
  _resetTileCacheForTest,
  _tileMemoryForTest,
} from '../../server/providers/mapillary/tiles.js';

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

const SEQUENCE = tile([{ name: 'sequence' }]);
const UNTRIMMED = tile([
  { name: 'sequence' },
  { name: 'image', payload: Buffer.alloc(4000, 1) },
]);

/** Mount the plugin and return `call(route, url, method, headers, onResponse)`. */
function install(mode = 'configureServer') {
  const routes = new Map();
  mapillaryProxy()[mode]({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  const call = async (
    route,
    url = '/',
    method = 'GET',
    reqHeaders = {},
    onResponse = null,
  ) => {
    const handler = routes.get(route);
    assert.ok(handler, `route ${route} is mounted`);
    const headers = {};
    const listeners = new Map();
    const res = {
      statusCode: 200,
      headers,
      on: (type, listener) => listeners.set(type, listener),
      /** The client goes away, as Node reports it. */
      close: () => listeners.get('close')?.(),
      setHeader: (name, value) => (headers[name.toLowerCase()] = value),
      getHeader: (name) => headers[name.toLowerCase()],
      writeHead(status, extra) {
        this.statusCode = status;
        Object.assign(headers, extra || {});
      },
      end(payload) {
        this.body = payload;
        this.writableEnded = true;
      },
    };
    onResponse?.(res);
    await handler({ url, method, headers: reqHeaders }, res);
    return res;
  };
  return { routes, call };
}

const json = (res) => JSON.parse(String(res.body));
/** Every header value and the body, as text, for a token-leak check. */
const leakText = (res) =>
  [
    ...Object.values(res.headers).map(String),
    Buffer.isBuffer(res.body) ? res.body.toString('latin1') : String(res.body),
  ].join('\n');

function withToken(token, run) {
  const saved = process.env.MAPILLARY_CLIENT_TOKEN;
  if (token === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
  else process.env.MAPILLARY_CLIENT_TOKEN = token;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (saved === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
      else process.env.MAPILLARY_CLIENT_TOKEN = saved;
    });
}

/** Drive the tile route against a scripted upstream `answer(n, url)`. */
async function withUpstream(answer, run) {
  const savedFetch = globalThis.fetch;
  _resetTileCacheForTest();
  const calls = [];
  const inits = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    inits.push(init);
    return answer(calls.length, String(url), init);
  };
  try {
    await withToken('MLY|test|token', () =>
      run({ calls, inits, call: install().call }),
    );
  } finally {
    globalThis.fetch = savedFetch;
    _resetTileCacheForTest();
  }
}

const ok = (body = SEQUENCE) => new Response(body, { status: 200 });

test('the plugin mounts the status and tile routes for dev and preview servers', () => {
  for (const mode of ['configureServer', 'configurePreviewServer'])
    assert.deepEqual([...install(mode).routes.keys()].sort(), [
      '/api/mapillary/status',
      '/api/mapillary/tiles',
    ]);
});

test('status reports whether a token exists, never its value', async () => {
  const { call } = install();
  await withToken(undefined, async () => {
    const res = await call('/api/mapillary/status');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(res), { configured: false });
    assert.equal(
      (await call('/api/mapillary/status', '/', 'POST')).statusCode,
      405,
    );
  });
  await withToken('MLY|secret', async () => {
    const res = await call('/api/mapillary/status');
    assert.deepEqual(json(res), { configured: true });
    assert.doesNotMatch(leakText(res), /MLY\|/);
  });
});

test('the tile route validates the path, then needs a token', async () => {
  await withUpstream(
    () => assert.fail('Mapillary is not asked'),
    async ({ call }) => {
      for (const bad of [
        '/coverage/14/1/x',
        '/signs/14/1/2',
        '/coverage/10/0/0',
        '/coverage/15/0/0',
        '/coverage/11/2048/0',
        '/coverage/11/0/2048',
        '/coverage/14/1/2/3',
      ]) {
        const res = await call('/api/mapillary/tiles', bad);
        assert.equal(res.statusCode, 400, bad);
      }
      const post = await call(
        '/api/mapillary/tiles',
        '/coverage/14/1/2',
        'POST',
      );
      assert.equal(post.statusCode, 405);
    },
  );
  await withToken(undefined, async () => {
    const res = await install().call(
      '/api/mapillary/tiles',
      '/coverage/14/1/2',
    );
    assert.equal(res.statusCode, 503);
    assert.deepEqual(json(res), { error: 'no_key', keyRequired: true });
  });
});

test('a tile is trimmed, served with browser caching, then from memory', async () => {
  await withUpstream(
    () => ok(UNTRIMMED),
    async ({ calls, inits, call }) => {
      const res = await call('/api/mapillary/tiles', '/coverage/14/9/9');
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-type'], 'application/x-protobuf');
      assert.equal(res.headers['cache-control'], 'public, max-age=3600');
      assert.equal(res.headers['x-gev-cache'], 'upstream');
      assert.deepEqual(res.body, SEQUENCE, 'the image layer is dropped');
      assert.doesNotMatch(leakText(res), /MLY\|/);
      assert.equal(
        calls[0],
        'https://tiles.mapillary.com/maps/vtp/mly1_public/2/14/9/9?access_token=MLY%7Ctest%7Ctoken',
      );
      assert.equal(inits[0].redirect, 'manual');
      const again = await call('/api/mapillary/tiles', '/coverage/14/9/9?v=2');
      assert.equal(again.headers['x-gev-cache'], 'memory');
      assert.deepEqual(again.body, SEQUENCE);
      assert.equal(calls.length, 1);
    },
  );
});

for (const status of [204, 404])
  test(`an empty upstream tile (${status}) is a 204 with no body, and is cached`, async () => {
    await withUpstream(
      () => new Response(null, { status }),
      async ({ calls, call }) => {
        for (const source of ['upstream', 'memory']) {
          const res = await call('/api/mapillary/tiles', '/coverage/14/10/10');
          assert.equal(res.statusCode, 204);
          assert.equal(res.body, undefined);
          assert.equal(res.headers['x-gev-cache'], source);
        }
        assert.equal(calls.length, 1);
      },
    );
  });

for (const status of [401, 403])
  test(`an upstream ${status} is a rejected key`, async () => {
    await withUpstream(
      () => new Response('{}', { status }),
      async ({ call }) => {
        const res = await call('/api/mapillary/tiles', '/coverage/14/5/5');
        assert.equal(res.statusCode, 403);
        assert.deepEqual(json(res), {
          error: 'Mapillary rejected the access token',
          keyRejected: true,
        });
        assert.doesNotMatch(leakText(res), /MLY\|/);
      },
    );
  });

for (const [sent, expected] of [
  ['30', 30],
  [null, 60],
  ['Wed, 21 Oct 2026 07:28:00 GMT', 60],
  ['999999', 600],
])
  test(`an upstream 429 (Retry-After ${sent}) is passed on as ${expected} s`, async () => {
    await withUpstream(
      () =>
        new Response('{}', {
          status: 429,
          headers: sent === null ? {} : { 'Retry-After': sent },
        }),
      async ({ calls, call }) => {
        const res = await call('/api/mapillary/tiles', '/coverage/14/5/5');
        assert.equal(res.statusCode, 429);
        assert.equal(res.headers['retry-after'], String(expected));
        assert.deepEqual(json(res), {
          error: 'Mapillary is rate-limiting tile requests',
          retryAfter: expected,
        });
        // Errors are not cached: the next request asks again.
        await call('/api/mapillary/tiles', '/coverage/14/5/5');
        assert.equal(calls.length, 2);
      },
    );
  });

for (const status of [302, 400, 410, 500])
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

test('a streamed body past the size cap is cancelled and answered 502', async () => {
  const MB = 1024 * 1024;
  let pulled = 0;
  let cancelled = false;
  // Chunked, no Content-Length: only a running count can see it is too big.
  const body = () =>
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(MB));
        pulled += MB;
        if (pulled >= TILE_MAX_BYTES + 8 * MB) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
  await withUpstream(
    () => new Response(body(), { status: 200 }),
    async ({ call }) => {
      const res = await call('/api/mapillary/tiles', '/coverage/14/19/19');
      assert.equal(res.statusCode, 502);
      assert.deepEqual(json(res), { error: 'Mapillary tile exceeds size cap' });
      assert.equal(cancelled, true);
      assert.ok(pulled <= TILE_MAX_BYTES + 2 * MB, `stopped after ${pulled}`);
    },
  );
});

test('cross-site requests are refused on both routes; the app itself passes', async () => {
  await withUpstream(
    () => ok(),
    async ({ calls, call }) => {
      const host = 'localhost:5173';
      for (const headers of [
        { host, 'sec-fetch-site': 'cross-site' }, // <img>, navigation
        { host, 'sec-fetch-site': 'same-site' },
        { host, origin: 'https://evil.example' }, // fetch from another page
        { host, origin: 'null' }, // sandboxed frame
        { host, 'x-forwarded-for': '203.0.113.9' }, // through a proxy
      ])
        for (const [route, url] of [
          ['/api/mapillary/status', '/'],
          ['/api/mapillary/tiles', '/coverage/14/13/13'],
        ]) {
          const res = await call(route, url, 'GET', headers);
          assert.equal(
            res.statusCode,
            403,
            `${route} ${JSON.stringify(headers)}`,
          );
        }
      assert.equal(calls.length, 0, 'Mapillary is never asked');
      const app = { host, 'sec-fetch-site': 'same-origin' };
      const status = await call('/api/mapillary/status', '/', 'GET', {
        ...app,
        origin: `http://${host}`,
      });
      assert.deepEqual(json(status), { configured: true });
      const res = await call(
        '/api/mapillary/tiles',
        '/coverage/14/13/14',
        'GET',
        app,
      );
      assert.equal(res.statusCode, 200);
    },
  );
});

test('the tile route answers 429 past its per-IP budget', async () => {
  await withToken(undefined, async () => {
    const { call } = install();
    for (let i = 0; i < TILE_ROUTE_MAX_PER_MIN; i++)
      assert.equal(
        (await call('/api/mapillary/tiles', '/coverage/14/1/2')).statusCode,
        503,
      );
    const over = await call('/api/mapillary/tiles', '/coverage/14/1/2');
    assert.equal(over.statusCode, 429);
    assert.equal(over.headers['retry-after'], '5');
    assert.deepEqual(json(over), {
      error: 'Too many tile requests',
      retryAfter: 5,
    });
    const status = await call('/api/mapillary/status');
    assert.equal(status.statusCode, 200, 'the status route is not limited');
  });
});

test('identical concurrent tile requests share one upstream fetch', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  await withUpstream(
    async (n) =>
      n === 1 ? (await gate, ok()) : new Response('{}', { status: 500 }),
    async ({ calls, call }) => {
      const pending = [1, 2, 3].map(() =>
        call('/api/mapillary/tiles', '/coverage/14/1/1'),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(calls.length, 1);
      release();
      const sources = (await Promise.all(pending)).map((res) => {
        assert.deepEqual(res.body, SEQUENCE);
        return res.headers['x-gev-cache'];
      });
      assert.deepEqual(sources, ['upstream', 'inflight', 'inflight']);
      // A failed flight is not reused either.
      const failed = await call('/api/mapillary/tiles', '/coverage/14/2/2');
      assert.equal(failed.statusCode, 502);
      await call('/api/mapillary/tiles', '/coverage/14/2/2');
      assert.equal(calls.length, 3);
    },
  );
});

test('at most a few upstream fetches run at once; the rest wait their turn', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  await withUpstream(
    async () => (await gate, ok()),
    async ({ calls, call }) => {
      const tiles = TILE_UPSTREAM_CONCURRENCY + 4;
      const pending = Array.from({ length: tiles }, (_, i) =>
        call('/api/mapillary/tiles', `/coverage/14/${i}/3`),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(calls.length, TILE_UPSTREAM_CONCURRENCY);
      release();
      const done = await Promise.all(pending);
      assert.ok(done.every((res) => res.statusCode === 200));
      assert.equal(calls.length, tiles, 'the waiting ones ran too');
    },
  );
});

/** An upstream that answers when released, and fails as a fetch does when aborted. */
function heldUpstream() {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const answer = (n, url, init) =>
    new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
      gate.then(() => resolve(ok()));
    });
  return { answer, release };
}

const settleSoon = () => new Promise((resolve) => setTimeout(resolve, 10));

test(
  'a queued fetch whose client left never reaches Mapillary',
  { timeout: 5000 },
  async () => {
    const upstream = heldUpstream();
    await withUpstream(upstream.answer, async ({ calls }) => {
      const busy = Array.from({ length: TILE_UPSTREAM_CONCURRENCY }, (_, i) =>
        fetchTile(parseTilePath(`/coverage/14/${i}/5`)),
      );
      const client = new AbortController();
      const queued = fetchTile(parseTilePath('/coverage/14/99/5'), {
        signal: client.signal,
      });
      await settleSoon();
      assert.equal(calls.length, TILE_UPSTREAM_CONCURRENCY, 'the 7th waits');
      client.abort();
      await assert.rejects(queued, { name: 'AbortError' });
      upstream.release();
      await Promise.all(busy);
      await settleSoon();
      assert.equal(calls.length, TILE_UPSTREAM_CONCURRENCY, 'and never ran');
      // The freed slots still serve a live request.
      await fetchTile(parseTilePath('/coverage/14/98/5'));
      assert.equal(calls.length, TILE_UPSTREAM_CONCURRENCY + 1);
    });
  },
);

test(
  'a client that disconnects cancels its tile fetch and gets no answer',
  { timeout: 5000 },
  async () => {
    const upstream = heldUpstream();
    await withUpstream(upstream.answer, async ({ inits, call }) => {
      let res;
      const done = call(
        '/api/mapillary/tiles',
        '/coverage/14/8/8',
        'GET',
        {},
        (r) => (res = r),
      );
      await settleSoon();
      res.close();
      await done;
      assert.equal(inits[0].signal.aborted, true, 'the upstream fetch stopped');
      assert.equal(res.body, undefined, 'nothing written to a closed socket');
    });
  },
);

test(
  'a shared fetch is cancelled only when its last client leaves',
  { timeout: 5000 },
  async () => {
    const upstream = heldUpstream();
    await withUpstream(upstream.answer, async ({ calls, inits }) => {
      const address = parseTilePath('/coverage/14/7/7');
      const first = new AbortController();
      const second = new AbortController();
      const a = fetchTile(address, { signal: first.signal });
      const b = fetchTile(address, { signal: second.signal });
      await settleSoon();
      assert.equal(calls.length, 1, 'one fetch for both');
      first.abort();
      await assert.rejects(a, { name: 'AbortError' });
      assert.equal(inits[0].signal.aborted, false, 'the other still waits');
      second.abort();
      await assert.rejects(b, { name: 'AbortError' });
      assert.equal(inits[0].signal.aborted, true, 'the last one left');
      // A new request starts afresh rather than joining the cancelled fetch.
      upstream.release();
      const again = await fetchTile(address);
      assert.equal(again.source, 'upstream');
      assert.equal(calls.length, 2);
    });
  },
);

test('a tile held in memory past its TTL is fetched again', async (t) => {
  await withUpstream(
    () => ok(),
    async ({ calls, call }) => {
      await call('/api/mapillary/tiles', '/coverage/14/3/3');
      await call('/api/mapillary/tiles', '/coverage/14/3/3');
      assert.equal(calls.length, 1);
      const now = Date.now();
      t.mock.method(Date, 'now', () => now + TILE_TTL_MS + 1000);
      const res = await call('/api/mapillary/tiles', '/coverage/14/3/3');
      assert.equal(res.headers['x-gev-cache'], 'upstream');
      assert.equal(calls.length, 2);
    },
  );
});

test('the memory cache evicts the least recently used tile past its budget', async () => {
  const MB = 1024 * 1024;
  // Three 30 MB tiles fit in the budget, a fourth does not.
  const big = tile([{ name: 'sequence', payload: Buffer.alloc(30 * MB) }]);
  assert.ok(3 * big.length < TILE_MEMORY_BUDGET_BYTES);
  assert.ok(4 * big.length > TILE_MEMORY_BUDGET_BYTES);
  await withUpstream(
    () => ok(big),
    async ({ calls, call }) => {
      const get = async (x) =>
        (await call('/api/mapillary/tiles', `/coverage/14/${x}/20`)).headers[
          'x-gev-cache'
        ];
      for (const x of [20, 21, 22]) assert.equal(await get(x), 'upstream');
      assert.equal(await get(20), 'memory', 'A is used again');
      assert.equal(await get(23), 'upstream');
      assert.equal(_tileMemoryForTest().entries, 3);
      for (const x of [20, 22, 23]) assert.equal(await get(x), 'memory');
      assert.equal(await get(21), 'upstream', 'B was evicted');
      assert.equal(calls.length, 5);
    },
  );
});

// ── Tile trimming ──

test('dropping a layer keeps the others byte-for-byte', () => {
  const bytes = tile([
    { name: 'sequence' },
    { name: 'image', payload: Buffer.alloc(50_000, 7) },
    { name: 'overview' },
  ]);
  const trimmed = stripTileLayers(bytes, ['image']);
  assert.deepEqual(listTileLayers(trimmed), ['sequence', 'overview']);
  assert.deepEqual(trimmed, tile([{ name: 'sequence' }, { name: 'overview' }]));
});

test('a tile without the layer is returned untouched', () => {
  assert.equal(stripTileLayers(SEQUENCE, ['image']), SEQUENCE);
  assert.equal(stripTileLayers(SEQUENCE, []), SEQUENCE);
  assert.equal(stripTileLayers(Buffer.alloc(0), ['image']).length, 0);
});
