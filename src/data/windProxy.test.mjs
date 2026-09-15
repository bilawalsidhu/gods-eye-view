import test from 'node:test';
import assert from 'node:assert/strict';

import { windProxy } from '../../server/providers/wind.js';

/** Boot a mounted provider middleware without a real server. */
function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  assert.equal(routes.size, 1);
  const handler = [...routes.values()][0];
  return async (url = '/', method = 'GET') => {
    const res = {
      statusCode: 200,
      headers: {},
      headersSent: false,
      writeHead(status, headers) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(headers || {}))
          this.headers[name.toLowerCase()] = value;
        this.headersSent = true;
      },
      end(body) {
        this.body = body;
        this.headersSent = true;
      },
    };
    await handler({ url, method }, res);
    return res;
  };
}

const IDX = [
  '1:0:d=2026091400:UGRD:10 m above ground:anl:',
  '2:5:d=2026091400:VGRD:10 m above ground:anl:',
  '3:10:d=2026091400:HGT:surface:anl:',
].join('\n');

const DECODED_U = {
  ni: 4,
  nj: 3,
  lo1: 0,
  la1: 90,
  di: 90,
  dj: 90,
  values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
};
const DECODED_V = { ...DECODED_U, values: [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32] };

/** Fetch double: `.idx` text, and range bodies of the requested length. */
function makeFetch({ fail = false, counter } = {}) {
  return async (url, options = {}) => {
    if (counter) counter.calls += 1;
    if (fail) throw new Error('gfs upstream down');
    if (String(url).endsWith('.idx')) return new Response(IDX, { status: 200 });
    const match = /bytes=(\d+)-(\d+)/.exec(options.headers?.Range || '');
    const length = Number(match[2]) - Number(match[1]) + 1;
    return new Response(new Uint8Array(length), { status: 206 });
  };
}

function proxy(options = {}) {
  return windProxy({
    now: () => Date.UTC(2026, 8, 14, 12),
    targetDx: 90,
    fetchImpl: makeFetch(),
    decodeImpl: async (buffer) =>
      buffer[0] === undefined ? DECODED_U : DECODED_U,
    ...options,
  });
}

test('wind manifest describes the GFS cycle and resampled grid', async () => {
  const request = install(proxy());
  const res = await request('/');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.model, 'gfs');
  assert.equal(body.cycle.hour, 6);
  assert.equal(body.cycle.date, '20260914');
  assert.equal(body.units, 'm/s');
  assert.deepEqual(body.grid, { nx: 4, ny: 3, lo1: 0, la1: 90, dx: 90, dy: 90 });
  assert.match(body.gridUrl, /^\/api\/wind\/grid\/20260914-6-90\.bin$/);
  assert.equal(body.stale, false);
});

test('wind grid route returns Float32 U then V', async () => {
  let u = 0;
  const request = install(
    proxy({
      decodeImpl: async () => {
        u += 1;
        return u === 1 ? DECODED_U : DECODED_V;
      },
    }),
  );
  const manifest = JSON.parse((await request('/')).body);
  const res = await request(manifest.gridUrl.replace('/api/wind', ''));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.equal(res.body.length, 4 * 3 * 4 * 2);
  const floats = new Float32Array(
    res.body.buffer,
    res.body.byteOffset,
    res.body.length / 4,
  );
  assert.deepEqual([...floats.slice(0, 12)], DECODED_U.values);
  assert.deepEqual([...floats.slice(12)], DECODED_V.values);
});

test('wind status omits the grid url', async () => {
  const request = install(proxy());
  await request('/');
  const body = JSON.parse((await request('/status')).body);
  assert.equal('gridUrl' in body, false);
  assert.equal(body.model, 'gfs');
});

test('wind refresh is cached within the TTL and refetches after it', async () => {
  const counter = { calls: 0 };
  let clock = Date.UTC(2026, 8, 14, 12);
  const request = install(
    proxy({ now: () => clock, fetchImpl: makeFetch({ counter }) }),
  );
  await request('/');
  const afterFirst = counter.calls;
  assert.equal(afterFirst, 3, 'one idx plus two range fetches');
  await request('/');
  assert.equal(counter.calls, afterFirst, 'a second request inside the TTL must not refetch');
  clock += 2 * 3600_000;
  await request('/');
  assert.equal(counter.calls, afterFirst + 3, 'a request past the TTL refetches');
});

test('wind serves last-good with stale on upstream failure', async () => {
  let failing = false;
  let clock = Date.UTC(2026, 8, 14, 12);
  const request = install(
    proxy({
      now: () => clock,
      fetchImpl: async (...args) => {
        if (failing) throw new Error('gfs upstream down');
        return makeFetch()(...args);
      },
    }),
  );
  const good = JSON.parse((await request('/')).body);
  failing = true;
  clock += 2 * 3600_000;
  const degraded = JSON.parse((await request('/')).body);
  assert.equal(degraded.stale, true);
  assert.equal(degraded.reason, 'gfs upstream down');
  const frame = await request(good.gridUrl.replace('/api/wind', ''));
  assert.equal(frame.statusCode, 200, 'last-good grid stays addressable');
});

test('wind returns a JSON 404 for an unknown grid', async () => {
  const request = install(proxy());
  await request('/');
  const res = await request('/grid/nope.bin');
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'unknown_grid' });
});
