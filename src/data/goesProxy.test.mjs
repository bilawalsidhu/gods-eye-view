import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { goesProxy } from '../../server/providers/goes.js';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8]);

/**
 * Boot a provider plugin's middleware without a real server. `goesProxy`
 * registers one GLOBAL middleware (no mount path), so `use` is called with a
 * single handler argument and the handler receives the full request URL.
 */
function install(plugin) {
  let handler = null;
  plugin.configureServer({
    middlewares: {
      use(fn) {
        handler = fn;
      },
    },
  });
  assert.equal(
    typeof handler,
    'function',
    'goes proxy registered a middleware',
  );
  return async (pathname, method = 'GET') => {
    const res = {
      statusCode: 200,
      headers: {},
      headersSent: false,
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      writeHead(status, headers) {
        this.statusCode = status;
        Object.assign(this.headers, headers || {});
        this.headersSent = true;
      },
      end(body) {
        this.body = body;
        this.headersSent = true;
      },
    };
    let nextCalled = false;
    await handler({ url: pathname, method }, res, () => {
      nextCalled = true;
    });
    res.nextCalled = nextCalled;
    return res;
  };
}

async function makeStarJpeg() {
  return sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  })
    .jpeg()
    .toBuffer();
}

/** A fetch double that serves the STAR JPEG with a Last-Modified header. */
function makeFetch(jpeg, { fail = false } = {}) {
  return async () => {
    if (fail) throw new Error('star upstream down');
    return new Response(jpeg, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Last-Modified': 'Mon, 14 Sep 2026 14:45:15 GMT',
      },
    });
  };
}

test('GOES manifest describes both satellites with geographic parts', async () => {
  const jpeg = await makeStarJpeg();
  const request = install(
    goesProxy({ fetchImpl: makeFetch(jpeg), outputHeight: 32 }),
  );
  const res = await request('/api/goes/manifest');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  const body = JSON.parse(res.body);
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.family, 'goes');
  assert.equal(body.sources.length, 2);
  for (const source of body.sources) {
    assert.equal(source.unavailable, false);
    assert.equal(source.requestedWidth, 5424);
    assert.equal(source.requestedHeight, 5424);
    assert.equal(source.sourceWidth, 64);
    assert.equal(source.sourceHeight, 64);
    assert.ok(source.frameId);
    assert.equal(source.parts.length >= 1, true);
    for (const part of source.parts) {
      assert.match(part.url, /^\/api\/goes\/frames\/[^/]+\/\d+\.png$/);
      assert.ok(
        part.rectangle.south < part.rectangle.north,
        'rectangle is not inverted',
      );
      assert.ok(
        part.rectangle.west < part.rectangle.east,
        'rectangle is not inverted',
      );
      assert.ok(part.rectangle.west >= -180 && part.rectangle.east <= 180);
    }
  }
});

test('GOES frame route serves the reprojected PNG bytes', async () => {
  const jpeg = await makeStarJpeg();
  const request = install(
    goesProxy({ fetchImpl: makeFetch(jpeg), outputHeight: 32 }),
  );
  const manifest = JSON.parse((await request('/api/goes/manifest')).body);
  const url = manifest.sources[0].parts[0].url;
  const res = await request(url);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.deepEqual(
    Buffer.from(res.body).subarray(0, 2),
    Buffer.from([0x89, 0x50]),
  );
});

test('GOES status summarizes sources without the frame payload', async () => {
  const jpeg = await makeStarJpeg();
  const request = install(
    goesProxy({ fetchImpl: makeFetch(jpeg), outputHeight: 32 }),
  );
  await request('/api/goes/manifest');
  const res = await request('/api/goes/status');
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.sources.length, 2);
  assert.equal('flashes' in body, false);
  for (const source of body.sources) {
    assert.ok(
      'satelliteId' in source && 'frameId' in source && 'unavailable' in source,
    );
  }
});

test('GOES manifest is cached within its TTL', async () => {
  const jpeg = await makeStarJpeg();
  let calls = 0;
  let clock = Date.UTC(2026, 8, 14, 12);
  const request = install(
    goesProxy({
      now: () => clock,
      outputHeight: 32,
      fetchImpl: async () => {
        calls += 1;
        return new Response(jpeg, {
          headers: { 'Last-Modified': 'Mon, 14 Sep 2026 14:45:15 GMT' },
        });
      },
    }),
  );
  await request('/api/goes/manifest');
  const first = calls;
  assert.equal(first, 2, 'one STAR fetch per satellite');
  await request('/api/goes/manifest');
  assert.equal(
    calls,
    first,
    'a second request inside the TTL must not refetch',
  );
  clock += 6 * 60_000;
  await request('/api/goes/manifest');
  assert.equal(calls, first + 2, 'a request past the TTL refetches');
});

test('GOES keeps last-good frames and marks sources unavailable on upstream failure', async () => {
  const jpeg = await makeStarJpeg();
  let clock = Date.UTC(2026, 8, 14, 12);
  let failing = false;
  const request = install(
    goesProxy({
      now: () => clock,
      outputHeight: 32,
      fetchImpl: async () => {
        if (failing) throw new Error('star upstream down');
        return new Response(jpeg, {
          headers: { 'Last-Modified': 'Mon, 14 Sep 2026 14:45:15 GMT' },
        });
      },
    }),
  );
  const good = JSON.parse((await request('/api/goes/manifest')).body);
  const frameId = good.sources[0].frameId;
  failing = true;
  clock += 6 * 60_000;
  const degraded = JSON.parse((await request('/api/goes/manifest')).body);
  assert.equal(
    degraded.sources.every((source) => source.unavailable),
    true,
  );
  assert.equal(degraded.sources[0].reason, 'star upstream down');
  // The last-good frame bytes remain addressable for the client.
  const frame = await request(`/api/goes/frames/${frameId}/0.png`);
  assert.equal(frame.statusCode, 200);
});

test('GOES serves a JSON 404 for an unknown frame', async () => {
  const jpeg = await makeStarJpeg();
  const request = install(
    goesProxy({ fetchImpl: makeFetch(jpeg), outputHeight: 32 }),
  );
  const res = await request('/api/goes/frames/nope-000000000000/0.png');
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'unknown_frame' });
});

test('GOES leaves unrelated paths to the next middleware', async () => {
  const jpeg = await makeStarJpeg();
  const request = install(
    goesProxy({ fetchImpl: makeFetch(jpeg), outputHeight: 32 }),
  );
  const res = await request('/api/something-else');
  assert.equal(res.nextCalled, true);
  assert.equal(res.headersSent, false);
});

test('GOES validates the STAR JPEG magic', async () => {
  const request = install(
    goesProxy({
      outputHeight: 32,
      fetchImpl: async () =>
        new Response(Buffer.from('not a jpeg'), { headers: {} }),
    }),
  );
  const body = JSON.parse((await request('/api/goes/manifest')).body);
  assert.equal(
    body.sources.every((source) => source.unavailable),
    true,
  );
  assert.ok(JPEG_MAGIC.length === 2);
});
