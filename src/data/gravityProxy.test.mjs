import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gravityProxy } from '../../server/providers/gravity.js';
import {
  GRAVITY_GRID,
  encodeLandMaskRuns,
  quantizeGravity,
} from '../../server/providers/gravity/grid.js';

const CELLS = GRAVITY_GRID.nx * GRAVITY_GRID.ny;
const SOLUTIONS = [
  { id: '2026-07-01', start: '2026-07-01', end: '2026-08-01' },
  { id: '2026-08-01', start: '2026-08-01', end: '2026-09-01' },
];

function fakeCube(offset = 0) {
  const cube = new Int16Array(SOLUTIONS.length * CELLS);
  // Cell (row 21, col 162) holds 68.5N 17.5W.
  cube[21 * 360 + 162] = quantizeGravity(-12 + offset);
  cube[CELLS + 21 * 360 + 162] = quantizeGravity(-14.5 + offset);
  return cube;
}

const MASK_URL = 'https://example.test/LandMask.nc';

/** A mask whose first row is land from column 4. */
function fakeMask() {
  const mask = new Uint8Array(1440 * 720);
  mask.fill(1, 4, 1440);
  return mask;
}

async function harness({
  status = 200,
  convert = async () => ({ solutions: SOLUTIONS, cube: fakeCube() }),
  maskStatus = 200,
} = {}) {
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-gravity-'));
  const calls = [];
  const maskCalls = [];
  let time = 1_000_000;
  let handler;
  const options = {
    cacheDir,
    now: () => time,
    warn: () => {},
    convertImpl: async (file) => {
      assert.ok((await fsp.stat(file)).size > 0, 'the download is on disk');
      return convert(file);
    },
    landMaskUrl: MASK_URL,
    convertMaskImpl: async (file) => {
      assert.ok((await fsp.stat(file)).size > 0, 'the mask is on disk');
      return fakeMask();
    },
    fetchImpl: async (url, init) => {
      if (url === MASK_URL) {
        maskCalls.push(url);
        return new Response(maskStatus === 200 ? new Uint8Array([9]) : null, {
          status: maskStatus,
        });
      }
      calls.push(init.headers);
      if (typeof status === 'function') return status(init);
      return new Response(status === 200 ? new Uint8Array([1, 2, 3]) : null, {
        status,
        headers: { 'last-modified': 'Wed, 07 Oct 2026 19:28:43 GMT' },
      });
    },
  };
  const make = () => {
    gravityProxy(options).configureServer({
      middlewares: { use: (_path, fn) => (handler = fn) },
    });
    return handler;
  };
  const request = async (fn, url, method = 'GET') => {
    const res = {
      headers: {},
      writeHead(code, headers) {
        this.status = code;
        Object.assign(this.headers, headers);
      },
      end(body) {
        this.body = body;
      },
    };
    await fn(
      { url, method, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      res,
    );
    return res;
  };
  return {
    cacheDir,
    calls,
    maskCalls,
    make,
    request,
    advance: (ms) => (time += ms),
    settle: () => new Promise((resolve) => setTimeout(resolve, 100)),
  };
}

test('the first request starts one download and answers retryably until it is ready', async () => {
  const h = await harness();
  const handler = h.make();
  const first = await h.request(handler, '/index');
  assert.equal(first.status, 503);
  assert.equal(JSON.parse(first.body).code, 'GRAVITY_LOADING');
  await h.request(handler, '/index');
  await h.settle();
  assert.equal(h.calls.length, 1, 'concurrent requests share one download');
  const ready = await h.request(handler, '/index');
  assert.equal(ready.status, 200);
  const index = JSON.parse(ready.body);
  assert.deepEqual(index.solutions, SOLUTIONS);
  assert.equal(index.lastModified, 'Wed, 07 Oct 2026 19:28:43 GMT');
  assert.equal(index.grid.nx, 360);
  assert.match(index.source.doi, /^10\.15781/);
  const files = await fsp.readdir(h.cacheDir);
  assert.deepEqual(
    files.sort(),
    ['cube.i16', 'index.json', 'landmask.bin'],
    'the NetCDF downloads are removed',
  );
});

test('a field is one solution as little-endian int16, and a cell is its history', async () => {
  const h = await harness();
  const handler = h.make();
  await h.request(handler, '/index');
  await h.settle();
  const field = await h.request(handler, '/field?id=2026-08-01');
  assert.equal(field.status, 200);
  assert.equal(field.headers['Content-Type'], 'application/octet-stream');
  assert.equal(field.body.length, CELLS * 2);
  assert.equal(
    field.body.readInt16LE((21 * 360 + 162) * 2),
    quantizeGravity(-14.5),
  );
  assert.equal((await h.request(handler, '/field?id=2026-09-01')).status, 404);
  const cell = JSON.parse(
    (await h.request(handler, '/cell?lat=68.2&lon=-17.4')).body,
  );
  assert.deepEqual(cell, {
    lat: 68.5,
    lon: -17.5,
    units: 'cm',
    values: [-12, -14.5],
  });
  assert.equal((await h.request(handler, '/cell?lat=95&lon=0')).status, 400);
  assert.equal((await h.request(handler, '/index', 'POST')).status, 405);
});

test('a restart serves the disk cache, and a daily check that finds no change downloads nothing', async () => {
  const h = await harness({
    status: (init) =>
      new Response(
        init.headers['If-Modified-Since'] ? null : new Uint8Array([1]),
        {
          status: init.headers['If-Modified-Since'] ? 304 : 200,
          headers: { 'last-modified': 'Wed, 07 Oct 2026 19:28:43 GMT' },
        },
      ),
  });
  const first = h.make();
  await h.request(first, '/index');
  await h.settle();
  const restarted = h.make();
  assert.equal(
    (await h.request(restarted, '/index')).status,
    200,
    'served from disk',
  );
  assert.equal(h.calls.length, 1, 'no new download after a restart');
  h.advance(25 * 3600_000);
  await h.request(restarted, '/index');
  await h.settle();
  assert.equal(h.calls.length, 2);
  assert.equal(
    h.calls[1]['If-Modified-Since'],
    'Wed, 07 Oct 2026 19:28:43 GMT',
  );
  const index = JSON.parse((await h.request(restarted, '/index')).body);
  assert.equal(
    index.checkedAt,
    1_000_000 + 25 * 3600_000,
    'the check is recorded',
  );
  assert.equal(index.generatedAt, 1_000_000, 'the record itself is unchanged');
});

test('a failed refresh keeps the last record and waits before trying again', async () => {
  let fail = false;
  const h = await harness({
    convert: async () => {
      if (fail) throw new Error('bad file');
      return { solutions: SOLUTIONS, cube: fakeCube() };
    },
  });
  const handler = h.make();
  await h.request(handler, '/index');
  await h.settle();
  fail = true;
  h.advance(25 * 3600_000);
  await h.request(handler, '/index');
  await h.settle();
  const after = await h.request(handler, '/index');
  assert.equal(after.status, 200, 'still serving the previous record');
  await h.request(handler, '/index');
  assert.equal(h.calls.length, 2, 'no retry inside the backoff window');
});

test('with nothing cached and the source down, the answer says so', async () => {
  const h = await harness({ status: 500 });
  const handler = h.make();
  await h.request(handler, '/index');
  await h.settle();
  const res = await h.request(handler, '/index');
  assert.equal(res.status, 503);
  assert.equal(JSON.parse(res.body).code, 'GRAVITY_UNAVAILABLE');
});

test('the land mask is fetched once, packed, served, and kept across restarts', async () => {
  const h = await harness();
  const first = h.make();
  // The mask does not wait for the monthly record.
  const early = await h.request(first, '/landmask');
  assert.equal(early.status, 503);
  assert.equal(JSON.parse(early.body).code, 'GRAVITY_MASK_UNAVAILABLE');
  await h.settle();
  const served = await h.request(first, '/landmask');
  assert.equal(served.status, 200);
  assert.equal(served.headers['Content-Type'], 'application/octet-stream');
  assert.deepEqual(
    [...served.body],
    [...encodeLandMaskRuns(fakeMask())],
    'run-length packed',
  );
  assert.ok(served.body.length < 2_000);
  assert.equal(
    JSON.parse((await h.request(first, '/index')).body).landMask,
    true,
  );
  const restarted = h.make();
  assert.equal((await h.request(restarted, '/landmask')).status, 200);
  assert.equal(h.maskCalls.length, 1, 'never fetched twice');
});

test('a failed land mask leaves the monthly record working and retries later', async () => {
  const h = await harness({ maskStatus: 500 });
  const handler = h.make();
  await h.request(handler, '/index');
  await h.settle();
  assert.equal((await h.request(handler, '/index')).status, 200);
  assert.equal((await h.request(handler, '/landmask')).status, 503);
  assert.equal(h.maskCalls.length, 1, 'no retry inside the backoff window');
  h.advance(3600_000);
  await h.request(handler, '/landmask');
  await h.settle();
  assert.equal(h.maskCalls.length, 2);
});
