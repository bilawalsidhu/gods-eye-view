import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffMs,
  createMissLoader,
  fetchTile,
  tileCacheFile,
} from '../../scripts/qa/tileCache.mjs';

test('only the free tile hosts are cached, per URL and Accept header', () => {
  const osm = 'https://tile.openstreetmap.org/12/1205/1539.png';
  const file = tileCacheFile(osm, 'image/png', '/c');
  assert.match(file, /^\/c\/tile\.openstreetmap\.org-[0-9a-f]{32}$/);
  assert.equal(tileCacheFile(osm, 'image/png', '/c'), file, 'stable');
  assert.notEqual(tileCacheFile(osm, 'image/webp', '/c'), file);
  assert.match(
    tileCacheFile('https://terrain.reearth.land/1/2/3.terrain', null, '/c'),
    /^\/c\/terrain\.reearth\.land-/,
  );
  for (const url of [
    'https://tile.googleapis.com/v1/3dtiles/root.json?key=x',
    'http://tile.openstreetmap.org/1/2/3.png',
    'not a url',
  ])
    assert.equal(tileCacheFile(url, null, '/c'), null, url);
});

test('429 backs off by Retry-After (at most 30 s) or 1, 2, 4, 8 s', () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((attempt) => backoffMs(attempt, null)),
    [1000, 2000, 4000, 8000],
  );
  assert.equal(backoffMs(0, '5'), 5000);
  assert.equal(backoffMs(0, '600'), 30000);
});

const response = (status, headers = {}) => ({
  status,
  headers: { get: (name) => headers[name] ?? null },
  arrayBuffer: async () => new Uint8Array([status % 256]).buffer,
});

test('a tile fetch retries 429s, stops after four retries, keeps Accept', async () => {
  const waits = [];
  const seen = [];
  const replies = [
    response(429, { 'retry-after': '2' }),
    response(429),
    response(200, { 'content-type': 'image/png' }),
  ];
  const tile = await fetchTile('u', {
    accept: 'application/vnd.quantized-mesh',
    fetchImpl: async (url, init) => (
      seen.push(init.headers.Accept),
      replies.shift()
    ),
    wait: async (ms) => waits.push(ms),
  });
  assert.equal(tile.status, 200);
  assert.equal(tile.contentType, 'image/png');
  assert.deepEqual(waits, [2000, 2000]);
  assert.ok(
    seen.every((accept) => accept === 'application/vnd.quantized-mesh'),
  );
  let calls = 0;
  const limited = await fetchTile('u', {
    fetchImpl: async () => (calls++, response(429)),
    wait: async () => {},
  });
  assert.equal(limited.status, 429);
  assert.equal(calls, 5);
});

test('misses: at most two fetches in flight, identical ones merged, a contact UA', async () => {
  let inFlight = 0;
  let most = 0;
  const calls = [];
  const releases = [];
  const loader = createMissLoader({
    fetchImpl: (url, init) => {
      calls.push([url, init.headers['User-Agent']]);
      inFlight++;
      most = Math.max(most, inFlight);
      return new Promise((resolve) =>
        releases.push(() => {
          inFlight--;
          resolve(response(200, { 'content-type': 'image/png' }));
        }),
      );
    },
    wait: async () => {},
  });
  const loads = [
    loader.load('a', null),
    loader.load('a', null),
    loader.load('b', null),
    loader.load('c', null),
    loader.load('a', 'image/webp'),
  ];
  for (let round = 0; round < 10 && releases.length; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    releases.splice(0).forEach((release) => release());
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const tiles = await Promise.all(loads);
  assert.ok(tiles.every((tile) => tile.status === 200));
  assert.equal(tiles[0], tiles[1], 'one fetch for two identical misses');
  assert.equal(calls.length, 4, 'a, b, c and a with another Accept');
  assert.ok(most <= 2, `${most} fetches in flight`);
  assert.ok(
    calls.every(([, agent]) =>
      agent.includes('https://github.com/bilawalsidhu/gods-eye-view'),
    ),
  );
});
