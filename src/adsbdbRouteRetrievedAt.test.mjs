import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readResponseJsonCapped } from '../server/providers/common/http.js';

const source = readFileSync(
  new URL('../server/providers/aircraft/enrichment.js', import.meta.url),
  'utf8',
)
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '');

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function proxy({ readFile, fetch }) {
  const deps = {
    path,
    process: { cwd: () => '/fixture' },
    fsp: { readFile, mkdir: async () => {}, writeFile: async () => {} },
    fetch,
    setInterval: () => ({ unref() {} }),
    console: { error() {}, warn() {} },
    readResponseJsonCapped,
    ADSBDB_MAX_RESPONSE_BYTES: 1024 * 1024,
  };
  const plugin = new Function(
    ...Object.keys(deps),
    `${source.replace(/^const ADSBDB_MAX_RESPONSE_BYTES.*$/m, '')}\nreturn adsbdbProxy();`,
  )(...Object.values(deps));
  let handler;
  plugin.configureServer({
    middlewares: {
      use(_r, h) {
        handler = h;
      },
    },
  });
  return async (url) => {
    const res = {
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url }, res);
    return res;
  };
}

const flightroute = (o, d) => ({
  response: {
    flightroute: {
      airline: { name: 'X' },
      origin: { iata_code: o, municipality: o },
      destination: { iata_code: d, municipality: d },
    },
  },
});

async function race(diskRoutes) {
  const T0 = Date.now() - 3600_000;
  const disk = deferred();
  const routeFetch = deferred();
  const calls = [];
  const request = proxy({
    readFile: () => disk.promise,
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url).includes('/callsign/')) return routeFetch.promise;
      return new Response('{}', { status: 404 });
    },
  });
  const typeReq = request('/type/abcdef');
  const routeReq = request('/route/UAL123');
  await new Promise((r) => setImmediate(r));
  disk.resolve(
    JSON.stringify({
      routes: diskRoutes(T0),
      aircraft: {},
    }),
  );
  await typeReq;
  const fetchedAt = Date.now();
  routeFetch.resolve(
    new Response(JSON.stringify(flightroute('LAX', 'ORD')), { status: 200 }),
  );
  const res = await routeReq;
  return { res, T0, fetchedAt, calls };
}

test('route retrievedAtMs belongs to the same cache entry as the endpoints (disk entry present)', async () => {
  const { res, T0, calls } = await race((T0) => ({
    UAL123: {
      at: T0,
      data: {
        airline: 'X',
        origin: { code: 'SFO' },
        destination: { code: 'EWR' },
      },
    },
  }));
  // The route request waits for the disk read and answers from its entry.
  assert.equal(res.body.origin.code, 'SFO');
  assert.equal(res.body.retrievedAtMs, T0);
  assert.equal(
    calls.some((url) => url.includes('/callsign/')),
    false,
    'a fresh disk entry needs no upstream route request',
  );
});

test('route retrievedAtMs is set for a freshly fetched route at startup (no disk entry)', async () => {
  const { res, fetchedAt } = await race(() => ({}));
  assert.equal(res.body.origin.code, 'LAX');
  assert.ok(
    Number.isFinite(res.body.retrievedAtMs) &&
      res.body.retrievedAtMs >= fetchedAt,
  );
});

test('a cached route keeps the time it was first fetched', async (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  const request = proxy({
    readFile: async () => {
      throw new Error('no cache file');
    },
    fetch: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify(flightroute('LAX', 'ORD')), {
        status: 200,
      });
    },
  });
  const first = await request('/route/UAL123');
  now += 60_000;
  const second = await request('/route/UAL123');
  assert.equal(calls.length, 1);
  assert.equal(first.body.retrievedAtMs, 1_700_000_000_000);
  assert.equal(second.body.retrievedAtMs, 1_700_000_000_000);
  assert.equal(second.body.origin.code, 'LAX');
});
