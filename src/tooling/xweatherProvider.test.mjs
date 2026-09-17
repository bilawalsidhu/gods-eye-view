import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { xweatherProxy } from 'gods-eye-view/server/providers/xweather';
import {
  DEFAULT_REFRESH_MS,
  SAMPLED_MAX_TILE_ZOOM,
  SYMBOL_MAX_TILE_ZOOM,
} from 'gods-eye-view/sources/xweather';

/** A layer the catalogue allows; the proxy refuses anything outside it. */
const LAYER = 'radar-global';
const tileUrl = (z, x, y, layer = LAYER) => `/tile/${layer}/${z}/${x}/${y}.png`;

/**
 * Mount the plugin and drive its single route directly — the harness shape
 * used by every other provider test (see environmentProviders.test.mjs).
 */
function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  assert.equal(routes.size, 1, 'a provider mounts exactly one route');
  return async (url = '/', method = 'GET') => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await [...routes.values()][0]({ url, method }, res);
    return res;
  };
}

/**
 * Env restored after the test; disk stubbed to "always empty".
 * Pass `logs` to capture warnings instead of silencing them.
 */
function isolate(t, env = {}, logs = null) {
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    process.env[name] = value;
  }
  t.mock.method(fsp, 'readFile', async () => {
    throw Error('no disk cache');
  });
  t.mock.method(fsp, 'stat', async () => {
    throw Error('no disk cache');
  });
  t.mock.method(fsp, 'readdir', async () => []);
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
  t.mock.method(fsp, 'unlink', async () => {});
  t.mock.method(console, 'warn', (...args) =>
    logs ? logs.push(args.join(' ')) : undefined,
  );
}

const json = (res) => JSON.parse(res.body);
const pngResponse = () =>
  new Response(new Uint8Array([137, 80, 78, 71]), {
    headers: { 'Content-Type': 'image/png' },
  });

const KEYED = {
  XWEATHER_CLIENT_ID: 'fixture-id',
  XWEATHER_CLIENT_SECRET: 'fixture-secret',
};

// These two run before anything else in this file on purpose: the budget
// flush is debounced, so a proxy built by an earlier test can still write
// into the shared file a second later, and both tests below assert on that
// file's exact contents.
test('two servers sharing a checkout add up instead of overwriting', async (t) => {
  // The account has one hard allowance, so the counter on disk has to be the
  // account's total rather than a copy of whichever process wrote last. The
  // flush reads it, adds only what this process has counted since its own
  // last flush, and adopts the result.
  isolate(t, KEYED);
  let now = Date.UTC(2026, 8, 15, 12, 0, 0);
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => pngResponse());

  // One file, both servers.
  let file = null;
  t.mock.method(fsp, 'readFile', async (target) => {
    if (String(target).endsWith('budget.json') && file !== null) return file;
    throw Error('no disk cache');
  });
  t.mock.method(fsp, 'writeFile', async (target, body) => {
    if (String(target).endsWith('budget.json')) file = body;
  });

  const a = install(xweatherProxy());
  const b = install(xweatherProxy());
  // Distinct tiles, so neither is answered from the other's memory cache.
  await a(tileUrl(4, 1, 1));
  await a(tileUrl(4, 2, 1));
  await b(tileUrl(4, 3, 1));

  // Each server reports its own fetches before either has flushed.
  assert.equal(json(await a('/status')).monthCount, 2);
  assert.equal(json(await b('/status')).monthCount, 1);

  // The debounce is one second; let both flushes land.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(JSON.parse(file).count, 3, `shared total, file was ${file}`);

  // And both now report the account's total, not their own share.
  assert.equal(json(await a('/status')).monthCount, 3);
  assert.equal(json(await b('/status')).monthCount, 3);
});

test('a failed budget write keeps the count for the next flush', async (t) => {
  // Dropping it would spend against the allowance without recording it, which
  // is the one direction the governor must never be wrong in.
  const logs = [];
  isolate(t, KEYED, logs);
  t.mock.method(globalThis, 'fetch', async () => pngResponse());
  let writable = false;
  let file = null;
  t.mock.method(fsp, 'readFile', async (target) => {
    if (String(target).endsWith('budget.json') && file !== null) return file;
    throw Error('no disk cache');
  });
  t.mock.method(fsp, 'writeFile', async (target, body) => {
    if (!String(target).endsWith('budget.json')) return;
    if (!writable) throw Error('disk full');
    file = body;
  });

  const request = install(xweatherProxy());
  await request(tileUrl(4, 4, 1));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(file, null, 'the write failed');
  assert.match(logs.join(' '), /budget write failed/);

  writable = true;
  await request(tileUrl(4, 5, 1));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(JSON.parse(file).count, 2, 'both fetches survived');
});

test('construction acquires nothing', (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('construction must not fetch');
  });
  const plugin = xweatherProxy();
  assert.equal(plugin.name, 'xweather-proxy');
  // Dev and preview must serve the same API, so both hooks share one install.
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
});

test('keyless: status is healthy, tiles 503, and upstream is never touched', async (t) => {
  isolate(t, { XWEATHER_CLIENT_ID: '', XWEATHER_CLIENT_SECRET: '' });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return pngResponse();
  });
  const request = install(xweatherProxy());

  // /status answers 200 even with no credentials — that distinction is the
  // whole degradation contract: the client can always ask.
  const status = await request('/status');
  assert.equal(status.status, 200);
  assert.equal(json(status).hasKey, false);
  assert.equal(typeof json(status).refreshMs, 'number');

  const tile = await request(tileUrl(4, 8, 5));
  assert.equal(tile.status, 503);
  assert.equal(json(tile).error, 'no_key');
  assert.equal(calls, 0, 'a keyless request must never reach upstream');
});

test('both halves of the credential are required', async (t) => {
  isolate(t, {
    XWEATHER_CLIENT_ID: 'fixture-id',
    XWEATHER_CLIENT_SECRET: '',
  });
  t.mock.method(globalThis, 'fetch', async () => {
    assert.fail('half a credential must not authenticate');
  });
  const request = install(xweatherProxy());
  assert.equal(json(await request('/status')).hasKey, false);
  assert.equal((await request(tileUrl(4, 8, 5))).status, 503);
});

test('coordinates are validated before the key is ever read', async (t) => {
  isolate(t, { XWEATHER_CLIENT_ID: '', XWEATHER_CLIENT_SECRET: '' });
  const request = install(xweatherProxy());
  // A bad coordinate is a client error, not a missing-key error — checking it
  // first also means a malformed request can never become a billable fetch.
  for (const url of [tileUrl(20, 1, 1), tileUrl(4, 99, 1)]) {
    const res = await request(url);
    assert.equal(res.status, 400, url);
    assert.equal(json(res).error, 'invalid_tile');
  }
  // Pin both ceilings. Each is where its kind of layer stops having anything
  // new to say and starts charging for it, so they are cost decisions rather
  // than arbitrary bounds — and they differ, so the check has to be made
  // against the layer asked for and not against the deepest layer offered.
  // A valid coordinate falls through to the key check (503) rather than 400.
  const SYMBOLIC = 'lightning-flash';
  assert.ok(SAMPLED_MAX_TILE_ZOOM < SYMBOL_MAX_TILE_ZOOM);
  const at = async (z, layer) =>
    (await request(tileUrl(z, 1, 1, layer))).status;

  assert.equal(await at(SAMPLED_MAX_TILE_ZOOM, LAYER), 503);
  assert.equal(
    await at(SAMPLED_MAX_TILE_ZOOM + 1, LAYER),
    400,
    'a sampled raster past its resolution must not become a billable fetch',
  );
  assert.equal(await at(SYMBOL_MAX_TILE_ZOOM, SYMBOLIC), 503);
  assert.equal(
    await at(SYMBOL_MAX_TILE_ZOOM + 1, SYMBOLIC),
    400,
    'symbols are redrawn at every level, but not without end',
  );
  assert.equal((await request('/nope')).status, 404);
});

test('only catalogued layers are proxied at all', async (t) => {
  // The browser supplies the layer name, so this is a security boundary rather
  // than a convenience: forwarded on trust, the proxy would reach every
  // Xweather product on the account — including the lightning variants that
  // bill at ten times the rate and are deliberately excluded.
  isolate(t, KEYED);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return pngResponse();
  });
  const request = install(xweatherProxy());

  for (const layer of [
    'lightning-strikes', // real, allowed by the vendor, 10x — not by us
    'air-quality-pm2p5', // real, 5x
    'satellite-geocolor', // real, but a base map rather than an overlay
    'not-a-layer',
  ]) {
    const res = await request(tileUrl(4, 8, 5, layer));
    assert.equal(res.status, 400, layer);
    assert.equal(json(res).error, 'unknown_layer', layer);
  }
  assert.equal(calls, 0, 'a rejected layer must never reach upstream');

  // A catalogued layer still goes through.
  assert.equal(
    (await request(tileUrl(4, 8, 5, 'lightning-flash'))).status,
    200,
  );
  assert.equal(calls, 1);
});

test('two layers at the same tile do not share a cache slot', async (t) => {
  // Cache and budget key on the layer as well as z/x/y; keyed on coordinates
  // alone, the second layer would be served the first one's pixels.
  isolate(t, KEYED);
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (raw) => {
    asked.push(String(raw).match(/\/([a-z0-9-]+)\/4\/8\/5\//)?.[1]);
    return pngResponse();
  });
  const request = install(xweatherProxy());
  assert.equal(
    (await request(tileUrl(4, 8, 5, 'radar-global'))).headers[
      'x-xweather-cache'
    ],
    'MISS',
  );
  assert.equal(
    (await request(tileUrl(4, 8, 5, 'lightning-flash'))).headers[
      'x-xweather-cache'
    ],
    'MISS',
  );
  assert.deepEqual(asked, ['radar-global', 'lightning-flash']);
});

test('keyed: miss, hit, budget accounting, and the monthly rollover', async (t) => {
  isolate(t, {
    ...KEYED,
    XWEATHER_MONTHLY_TILE_BUDGET: '1',
    XWEATHER_TILE_TTL_MS: String(60 * 60 * 1000),
  });
  let now = Date.UTC(2026, 8, 15, 12, 0, 0);
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls += 1;
    const url = String(raw);
    assert.ok(
      url.includes('fixture-id_fixture-secret'),
      'both halves must reach upstream, joined by an underscore',
    );
    assert.ok(url.includes(`/${LAYER}/`), 'the requested layer goes upstream');
    assert.ok(url.endsWith('/current.png'));
    return pngResponse();
  });
  const request = install(xweatherProxy());

  const miss = await request(tileUrl(4, 8, 5));
  assert.equal(miss.status, 200);
  assert.equal(miss.headers['Content-Type'], 'image/png');
  assert.equal(miss.headers['x-xweather-cache'], 'MISS');
  assert.equal(calls, 1);

  // A fresh cache hit must not bill a second access.
  assert.equal(
    (await request(tileUrl(4, 8, 5))).headers['x-xweather-cache'],
    'HIT',
  );
  assert.equal(calls, 1);
  assert.equal(json(await request('/status')).monthCount, 1);

  // Past the TTL and over the one-fetch cap: last-good data beats a dead layer.
  now += 2 * 60 * 60 * 1000;
  assert.equal(
    (await request(tileUrl(4, 8, 5))).headers['x-xweather-cache'],
    'STALE-BUDGET',
  );
  // A tile with nothing cached has no stale copy to fall back to.
  const starved = await request(tileUrl(4, 9, 5));
  assert.equal(starved.status, 429);
  assert.equal(json(starved).error, 'budget');
  assert.equal(calls, 1, 'nothing more reached upstream while over budget');

  // A new UTC month resets the counter. The account has exactly one quota —
  // 15,000 a month — so the month is the only period that means anything.
  now += 32 * 24 * 60 * 60 * 1000;
  assert.equal(json(await request('/status')).monthCount, 0);
  assert.equal(
    (await request(tileUrl(4, 9, 5))).headers['x-xweather-cache'],
    'MISS',
  );
  assert.equal(calls, 2);
});

test('pressing refresh gets new pixels, not the same ones again', async (t) => {
  // The TTL defaults to the refresh cadence, a whole day, while radar moves in
  // minutes. Without a freshness floor the Refresh button re-requested every
  // tile on screen and the proxy answered all of them from cache: the layer
  // looked refreshed, cost nothing, and showed yesterday's weather.
  isolate(t, { ...KEYED, XWEATHER_TILE_TTL_MS: String(24 * 60 * 60 * 1000) });
  let now = Date.UTC(2026, 8, 15, 12, 0, 0);
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return pngResponse();
  });
  const request = install(xweatherProxy());
  const cache = async (url) => (await request(url)).headers['x-xweather-cache'];

  assert.equal(await cache(tileUrl(4, 8, 5)), 'MISS');
  assert.equal(calls, 1);

  // An hour on, well inside the TTL: still cached, still free.
  now += 60 * 60 * 1000;
  assert.equal(await cache(tileUrl(4, 8, 5)), 'HIT');
  assert.equal(calls, 1);

  // The user asks for new data. The tile predates the request, so it is
  // refetched exactly once.
  const askedAt = now;
  assert.equal(await cache(`${tileUrl(4, 8, 5)}?t=${askedAt}`), 'MISS');
  assert.equal(calls, 2);

  // Panning afterwards must not keep bypassing the cache: the stamp stays on
  // the URL for the life of the layer, and the tile is now newer than it.
  assert.equal(await cache(`${tileUrl(4, 8, 5)}?t=${askedAt}`), 'HIT');
  assert.equal(calls, 2);

  // A stamp older than the tile is satisfied by what is already held.
  assert.equal(await cache(`${tileUrl(4, 8, 5)}?t=${askedAt - 5000}`), 'HIT');
  assert.equal(calls, 2);

  // A client clock running ahead cannot force a refetch of a current tile.
  assert.equal(await cache(`${tileUrl(4, 8, 5)}?t=${now + 86400000}`), 'HIT');
  assert.equal(calls, 2);

  // Garbage in the stamp is ignored rather than treated as "always refetch".
  assert.equal(await cache(`${tileUrl(4, 8, 5)}?t=nonsense`), 'HIT');
  assert.equal(calls, 2);
});

test('a full cache evicts the oldest tiles and leaves room before the next sweep', async (t) => {
  // Paid tiles accumulate across every zoom the camera visits, so the cache
  // has a ceiling. Trimming only back to that ceiling would put the next few
  // writes over it again and re-read every file's size and age to find out —
  // a sweep every fifty tiles, on the thread pool the fetches need.
  isolate(t, { ...KEYED, XWEATHER_DISK_CACHE_BYTES: '1000' });
  t.mock.method(globalThis, 'fetch', async () => pngResponse());

  // 20 tiles of 100 bytes against a 1,000-byte ceiling: twice over.
  const files = new Map();
  for (let i = 0; i < 20; i += 1) {
    files.set(`radar-global-4-${i}-0.png`, { size: 100, mtimeMs: 1000 + i });
  }
  t.mock.method(fsp, 'readdir', async () => [...files.keys()]);
  t.mock.method(fsp, 'stat', async (target) => {
    const entry = files.get(path.basename(String(target)));
    if (!entry) throw Error('no such file');
    return entry;
  });
  const unlinked = [];
  t.mock.method(fsp, 'unlink', async (target) => {
    const name = path.basename(String(target));
    unlinked.push(name);
    files.delete(name);
  });

  const request = install(xweatherProxy());
  // The sweep runs every fiftieth write, in the background behind the response.
  // Zoom 6, so all fifty x values are inside 2^6 and every one is a write.
  for (let i = 0; i < 50; i += 1) await request(tileUrl(6, i, 0));
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(unlinked.length > 0, 'an over-full cache must evict something');
  const remaining = [...files.values()].reduce((n, e) => n + e.size, 0);
  assert.ok(remaining <= 900, `must trim below the ceiling, left ${remaining}`);
  assert.ok(remaining > 0, 'eviction must stop, not empty the cache');

  // Oldest first: mtime is also how a tile's age is read, so the tile dropped
  // is always the least recently refreshed.
  assert.deepEqual(
    unlinked,
    unlinked
      .slice()
      .sort((a, b) => Number(a.split('-')[3]) - Number(b.split('-')[3])),
    `evicted out of order: ${unlinked.join(', ')}`,
  );
  assert.equal(unlinked[0], 'radar-global-4-0-0.png', 'the oldest goes first');
});

test('every tile goes to one upstream host, so the connection is reused', async (t) => {
  // The vendor offers maps1..maps4 so a browser can exceed its per-host
  // connection limit. This is a single server-side client: spreading requests
  // across four names costs a DNS lookup and a TLS handshake per tile instead
  // of reusing one warm connection, and both land on libuv's thread pool —
  // which this process shares with the dev server's file watching. Measured at
  // roughly ten times the upstream latency when it was spread.
  isolate(t, KEYED);
  const hosts = new Set();
  t.mock.method(globalThis, 'fetch', async (raw) => {
    hosts.add(new URL(String(raw)).host);
    return pngResponse();
  });
  const request = install(xweatherProxy());
  for (const y of [1, 2, 3, 4, 5, 6]) await request(tileUrl(4, 8, y));
  assert.equal(hosts.size, 1, `spread across ${[...hosts].join(', ')}`);
});

test('a tile is served without waiting for it to reach disk', async (t) => {
  // The disk copy only has to survive a restart, and a thread-pool write was
  // measured adding half a second to a response that already had the bytes.
  isolate(t, KEYED);
  let releaseWrite;
  const written = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  t.mock.method(fsp, 'writeFile', async (file) => {
    // Let the budget file through; only the tile write is held open.
    if (String(file).endsWith('.png')) await written;
  });
  t.mock.method(globalThis, 'fetch', async () => pngResponse());
  const request = install(xweatherProxy());
  const res = await request(tileUrl(4, 8, 5));
  assert.equal(
    res.status,
    200,
    'the tile is served while the write is pending',
  );
  assert.equal(res.headers['x-xweather-cache'], 'MISS');
  releaseWrite();
});

test('an upstream error body is never cached as a tile', async (t) => {
  isolate(t, KEYED);
  // Xweather reports quota and auth failures as a 200 carrying JSON. Caching
  // one would pin an error page over the globe for a whole TTL.
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response('{"error":{"code":"invalid_client"}}', {
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  const request = install(xweatherProxy());
  const res = await request(tileUrl(4, 8, 5));
  assert.equal(res.status, 502);
  assert.equal(json(res).error, 'upstream');
});

test('a credential never reaches the client or the log, even via upstream text', async (t) => {
  // Both exits have to be checked, and they fail differently. The client sees
  // only fixed strings, so that half is easy. The log is the real hazard: this
  // provider's secret sits in the URL *path*, and a DNS or TLS failure quotes
  // the request it attempted — so the raw message is radioactive.
  const logged = [];
  isolate(t, KEYED, logged);
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error(
      'request to https://maps2.api.xweather.com/fixture-id_fixture-secret' +
        '/radar-global/4/8/5/current.png failed',
    );
  });
  const request = install(xweatherProxy());

  for (const url of ['/status', tileUrl(4, 8, 5)]) {
    const res = await request(url);
    const seen = JSON.stringify([res.body, res.headers]);
    assert.ok(!seen.includes('fixture-secret'), `${url} leaked the secret`);
    assert.ok(!seen.includes('fixture-id'), `${url} leaked the client id`);
    assert.ok(!seen.includes('xweather.com'), `${url} echoed the upstream URL`);
  }

  const log = logged.join('\n');
  assert.ok(log.length > 0, 'the fixture must actually produce a log line');
  assert.ok(!log.includes('fixture-secret'), `secret in log: ${log}`);
  assert.ok(!log.includes('fixture-id'), `client id in log: ${log}`);
  // The scrub must keep the message useful rather than dropping it wholesale.
  assert.ok(log.includes('***'), 'the credential should be masked, not erased');
  assert.ok(log.includes('4/8/5'), 'the failing tile should still be named');
});

test('the refresh cadence is configurable and floored', async (t) => {
  isolate(t, { ...KEYED, XWEATHER_REFRESH_MS: '300000' });
  const request = install(xweatherProxy());
  assert.equal(json(await request('/status')).refreshMs, 300000);

  // A stray zero must not turn into a hot loop against a billable upstream.
  process.env.XWEATHER_REFRESH_MS = '0';
  assert.equal(json(await request('/status')).refreshMs, DEFAULT_REFRESH_MS);
  process.env.XWEATHER_REFRESH_MS = '1';
  assert.equal(json(await request('/status')).refreshMs, 60 * 1000);
});
