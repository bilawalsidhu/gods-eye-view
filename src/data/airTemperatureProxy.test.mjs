import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { START, snapshot, install } from './airTemperatureProxy.fixtures.mjs';
const json = (response) => JSON.parse(response.body);

test('serves the manifest and little-endian scalar binary through real HTTP', async (t) => {
  // Given
  const { handler } = install();
  const server = createServer((req, res) => {
    req.url = req.url.replace('/api/air-temperature', '') || '/';
    handler(req, res).catch((error) => res.destroy(error));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  // When
  const response = await fetch(`${origin}/api/air-temperature`);
  const manifest = await response.json();
  const binary = await fetch(`${origin}${manifest.gridUrl}`);
  const bytes = Buffer.from(await binary.arrayBuffer());
  // Then
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    model: 'gfs',
    cycle: snapshot().cycle,
    level: '2 m above ground',
    units: '°C',
    grid: { nx: 2, ny: 2, lo1: 0, la1: 90, dx: 180, dy: 180, scale: 0.01 },
    gridUrl: manifest.gridUrl,
    fetchedAt: START,
    stale: false,
    unavailable: false,
    reason: null,
  });
  assert.equal(binary.headers.get('content-type'), 'application/octet-stream');
  assert.match(binary.headers.get('cache-control'), /immutable/);
  assert.deepEqual([...bytes], [0x2e, 0xfb, 0, 0, 0x58, 0x02, 0xd7, 0x11]);
});

test('coalesces concurrent loads and caches within the TTL', async () => {
  // Given
  let calls = 0;
  const { request } = install({
    loadImpl: async () => {
      calls++;
      return snapshot();
    },
  });
  // When
  const results = await Promise.all([
    request('/'),
    request('/manifest'),
    request('/status'),
  ]);
  await request('/');
  // Then
  assert.equal(calls, 1);
  assert.deepEqual(json(results[0]), json(results[1]));
  assert.equal(json(results[2]).gridUrl, undefined);
});

test('retains last-good bytes and backs off when a refresh fails', async () => {
  // Given
  let clock = START;
  let calls = 0;
  const { request } = install({
    now: () => clock,
    loadImpl: async () => {
      if (++calls > 1) throw new Error('secret upstream credentials');
      return snapshot();
    },
  });
  const good = json(await request());
  clock += 3600_000;
  // When
  const stale = json(await request());
  await request();
  const binary = await request(good.gridUrl);
  // Then
  assert.equal(stale.stale, true);
  assert.equal(stale.unavailable, false);
  assert.equal(stale.reason, 'Air temperature upstream unavailable');
  assert.equal(stale.gridUrl, good.gridUrl);
  assert.equal(stale.fetchedAt, good.fetchedAt);
  assert.equal(binary.status, 200);
  assert.equal(calls, 2);
});

test('returns sanitized unavailable status and retries after failure backoff', async () => {
  // Given
  let clock = START;
  let calls = 0;
  const { request } = install({
    now: () => clock,
    loadImpl: async () => {
      if (++calls === 1) throw new Error('private host details');
      return snapshot();
    },
  });
  // When
  const failed = json(await request());
  await request();
  clock += 60_000;
  const recovered = json(await request());
  // Then
  assert.equal(failed.unavailable, true);
  assert.equal(failed.stale, true);
  assert.equal(failed.gridUrl, undefined);
  assert.equal(failed.reason, 'Air temperature upstream unavailable');
  assert.equal(recovered.unavailable, false);
  assert.equal(calls, 2);
});

test('retains only two issued binaries and refreshes expired snapshots', async () => {
  // Given
  let clock = START;
  let step = 6;
  const { request } = install({
    now: () => clock,
    loadImpl: async () => snapshot(step++),
  });
  const first = json(await request());
  clock += 3600_000;
  const second = json(await request());
  assert.equal((await request(first.gridUrl)).status, 200);
  clock += 3600_000;
  // When
  const third = json(await request());
  // Then
  assert.notEqual(third.gridUrl, second.gridUrl);
  assert.equal((await request(first.gridUrl)).status, 404);
  assert.equal((await request(second.gridUrl)).status, 200);
});

test('rejects unknown routes, models and methods before upstream acquisition', async () => {
  // Given
  let calls = 0;
  const { request } = install({
    loadImpl: async () => {
      calls++;
      return snapshot();
    },
  });
  // When / Then
  for (const [path, method, status] of [
    ['/?model=ifs', 'GET', 400],
    ['/private', 'GET', 404],
    ['/', 'POST', 405],
    ['/grid/nope.bin', 'GET', 404],
  ])
    assert.equal((await request(path, method)).status, status);
  assert.equal(calls, 0);
});

test('rejects invalid provider output without publishing a grid', async () => {
  // Given
  for (const mutate of [
    (v) => {
      v.grid.scalar[1] = NaN;
    },
    (v) => {
      v.grid.scalar = new Float32Array(1);
    },
    (v) => {
      v.units = 'K';
    },
    (v) => {
      v.grid.dx = 0;
    },
  ]) {
    const value = snapshot();
    mutate(value);
    const { request } = install({ loadImpl: async () => value });
    // When
    const manifest = json(await request());
    // Then
    assert.equal(manifest.unavailable, true);
    assert.equal(manifest.gridUrl, undefined);
  }
});

test('aborts upstream only when the final waiting client disconnects', async () => {
  // Given
  let signal;
  const { handler } = install({
    loadImpl: ({ signal: active }) => {
      signal = active;
      return new Promise((resolve, reject) =>
        active.addEventListener('abort', () => reject(active.reason)),
      );
    },
  });
  const first = new EventEmitter();
  const second = new EventEmitter();
  const a = handler({ url: '/', method: 'GET' }, first);
  const b = handler({ url: '/', method: 'GET' }, second);
  first.emit('close');
  assert.equal(signal.aborted, false);
  // When
  second.emit('close');
  await Promise.all([a, b]);
  // Then
  assert.equal(signal.aborted, true);
  assert.equal(first.listenerCount('close'), 0);
  assert.equal(second.listenerCount('close'), 0);
});

test('returns unavailable when the upstream deadline aborts a fetch', async () => {
  // Given
  let signal;
  const { request } = install({
    timeoutMs: 5,
    loadImpl: ({ signal: active }) => {
      signal = active;
      return new Promise((resolve, reject) =>
        active.addEventListener('abort', () => reject(active.reason)),
      );
    },
  });
  // When
  const manifest = json(await request());
  // Then
  assert.equal(signal.aborted, true);
  assert.equal(manifest.unavailable, true);
  assert.equal(manifest.reason, 'Air temperature upstream unavailable');
});

test('runs the default GFS loader from inventory to quantized binary', async () => {
  // Given
  const calls = [];
  const { request } = install({
    loadImpl: undefined,
    targetDx: 90,
    fetchImpl: async (url, options) => {
      calls.push(options.headers?.Range ?? 'idx');
      return url.endsWith('.idx')
        ? new Response(
            '1:2:d=x:TMP:2 m above ground:anl:\n2:5:d=x:RH:2 m above ground:anl:',
          )
        : new Response(Uint8Array.of(1, 2, 3), { status: 206 });
    },
    decodeImpl: async () => ({
      ni: 4,
      nj: 3,
      lo1: 0,
      la1: 90,
      di: 90,
      dj: 90,
      units: 'K',
      values: new Float64Array(12).fill(253.15),
    }),
  });
  // When
  const manifest = json(await request());
  const binary = await request(manifest.gridUrl);
  // Then
  assert.deepEqual(calls, ['idx', 'bytes=2-4']);
  assert.equal(binary.body.length, manifest.grid.nx * manifest.grid.ny * 2);
  assert.equal(binary.body.readInt16LE(0), -2000);
});
