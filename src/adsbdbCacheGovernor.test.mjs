// ADSBDB ENRICHMENT — the keyspace the cache used to remember forever.
//
// `/api/adsbdb` answers `route/<callsign>` and `type/<hex>`. Both keys come
// from the caller: a callsign is 2-8 of [A-Z0-9], a hex is six of [0-9a-f].
// Every distinct key that reached upstream was cached — 404s included — and
// nothing ever removed one, so a caller walking the keyspace grew both the
// in-memory maps and `.gev-cache/adsbdb.json` without bound, at one live
// request to the free community API per new key.
//
// These cases drive the real exported route handler. No network: `fetch` is
// stubbed per test and restored afterwards, so a case that reaches upstream
// fails loudly rather than making a request.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { adsbdbProxy } from '../server/providers/aircraft/enrichment.js';

/** Collect a plugin's routes into a path → handler map. */
function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(routePath, handler) {
        routes.set(routePath, handler);
      },
    },
  });
  return routes;
}

function request(handler, { url = '/', remoteAddress = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = new Map();
    const req = { method: 'GET', url, headers: {}, socket: { remoteAddress } };
    const res = {
      statusCode: 200,
      writeHead(status, hdrs = {}) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(hdrs))
          headers.set(String(name).toLowerCase(), String(value));
      },
      end(body = '') {
        let parsed = null;
        try {
          parsed = body ? JSON.parse(String(body)) : null;
        } catch {
          parsed = String(body);
        }
        resolve({
          statusCode: this.statusCode,
          headers: Object.fromEntries(headers),
          body: parsed,
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

/**
 * Replace global fetch for the duration of one test, counting the calls the
 * cache failed to absorb. Every hex answers with the same aircraft, so a
 * second live call for a key we already asked about is a cache miss, nothing
 * else.
 */
function stubUpstream(t) {
  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return new Response(
      JSON.stringify({
        response: {
          aircraft: {
            icao_type: 'B738',
            manufacturer: 'Boeing',
            type: '737-800',
            registration: 'N-FIXTURE',
          },
        },
      }),
      { status: 200 },
    );
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return asked;
}

/** A cache path inside the OS temp dir: these cases never load or write it. */
const scratchCachePath = () =>
  path.join(os.tmpdir(), `gev-adsbdb-fixture-${process.pid}-absent.json`);

const hex = (i) => i.toString(16).padStart(6, '0');

test('an enrichment lookup still answers, and is cached', async (t) => {
  const asked = stubUpstream(t);
  const routes = install(
    adsbdbProxy({ cachePath: scratchCachePath(), cacheMaxEntries: 10 }),
  );
  const handler = routes.get('/api/adsbdb');

  const first = await request(handler, { url: '/type/abc123' });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.found, true);
  assert.equal(first.body.typeCode, 'B738');
  assert.equal(asked.length, 1);

  const second = await request(handler, { url: '/type/abc123' });
  assert.equal(second.body.typeCode, 'B738');
  assert.equal(asked.length, 1, 'a warm key costs no upstream request');
});

test('the cache stops growing, and an evicted key is simply re-fetched', async (t) => {
  const asked = stubUpstream(t);
  // A ceiling of 3 exercises the same path 20,000 does, in four keys.
  const routes = install(
    adsbdbProxy({ cachePath: scratchCachePath(), cacheMaxEntries: 3 }),
  );
  const handler = routes.get('/api/adsbdb');

  for (let i = 1; i <= 4; i += 1)
    await request(handler, { url: `/type/${hex(i)}` });
  assert.equal(asked.length, 4, 'four distinct keys, four upstream requests');

  // The newest is still warm...
  await request(handler, { url: `/type/${hex(4)}` });
  assert.equal(asked.length, 4);

  // ...and the oldest was evicted, so it costs exactly one re-fetch, and
  // still answers correctly.
  const again = await request(handler, { url: `/type/${hex(1)}` });
  assert.equal(asked.length, 5);
  assert.match(asked[4], new RegExp(`/aircraft/${hex(1)}$`));
  assert.equal(again.body.typeCode, 'B738');
});

test('route and aircraft keys are held to the ceiling independently', async (t) => {
  const asked = stubUpstream(t);
  const routes = install(
    adsbdbProxy({ cachePath: scratchCachePath(), cacheMaxEntries: 2 }),
  );
  const handler = routes.get('/api/adsbdb');

  await request(handler, { url: '/type/aaaaaa' });
  await request(handler, { url: '/type/bbbbbb' });
  // Two callsigns must not push the two hexes out — they are separate stores.
  await request(handler, { url: '/route/BAW1' });
  await request(handler, { url: '/route/DLH2' });
  assert.equal(asked.length, 4);

  await request(handler, { url: '/type/aaaaaa' });
  assert.equal(asked.length, 4, 'the aircraft store kept its own two keys');
});

test('a caller enumerating the keyspace is refused, and refusal costs nothing', async (t) => {
  const asked = stubUpstream(t);
  const routes = install(adsbdbProxy({ cachePath: scratchCachePath() }));
  const handler = routes.get('/api/adsbdb');

  let refused = null;
  let served = 0;
  // The browser cannot exceed 300/min (ENRICH_DISPATCH_GAP_MS is 200 ms), so
  // an enumerating caller runs out well before a real session would.
  for (let i = 0; i < 400 && !refused; i += 1) {
    const res = await request(handler, { url: `/type/${hex(i)}` });
    if (res.statusCode === 429) refused = res;
    else served += 1;
  }

  assert.ok(refused, 'an unbounded sweep is eventually refused');
  assert.equal(refused.body.error, 'Rate limit exceeded');
  assert.equal(refused.headers['retry-after'], '10');
  assert.ok(
    served >= 300,
    `a real session's ceiling of 300/min must fit; served ${served}`,
  );
  assert.equal(
    asked.length,
    served,
    'a refused request never reaches api.adsbdb.com',
  );
});

test('a different client keeps its own budget', async (t) => {
  stubUpstream(t);
  const routes = install(adsbdbProxy({ cachePath: scratchCachePath() }));
  const handler = routes.get('/api/adsbdb');

  let noisy = 0;
  for (let i = 0; i < 400; i += 1) {
    const res = await request(handler, {
      url: `/type/${hex(i)}`,
      remoteAddress: '10.0.0.1',
    });
    if (res.statusCode === 200) noisy += 1;
  }
  assert.ok(noisy > 0 && noisy < 400, 'the noisy client was throttled');

  const quiet = await request(handler, {
    url: '/type/ffffff',
    remoteAddress: '10.0.0.2',
  });
  assert.equal(quiet.statusCode, 200, 'a quiet client is not collateral');
});
