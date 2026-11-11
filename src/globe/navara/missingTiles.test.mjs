import test from 'node:test';
import assert from 'node:assert/strict';
import { ESRI_TILE_ROOT, discardMissingEsriTiles } from './missingTiles.js';

const MISSING = new Uint8Array([1, 2, 3, 4, 5]);
const jpeg = (bytes) =>
  new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'image/jpeg',
      'content-length': String(bytes.byteLength),
    },
  });

// A window-like target whose fetch, like window.fetch, needs its `this`.
function fakeWindow(tiles, { referenceFails = false } = {}) {
  const target = { requests: [] };
  target.fetch = function (input) {
    assert.equal(this, target, 'fetch called without its window');
    const url = typeof input === 'string' ? input : input.url;
    target.requests.push(url);
    if (url === `${ESRI_TILE_ROOT}23/0/0`)
      return Promise.resolve(
        referenceFails ? new Response(null, { status: 503 }) : jpeg(MISSING),
      );
    return Promise.resolve(tiles[url] ?? new Response(null, { status: 404 }));
  };
  return target;
}

test("Esri's missing-imagery tile answers 404; real tiles and other hosts pass", async () => {
  const missingTile = `${ESRI_TILE_ROOT}18/1/2`;
  const sameLength = `${ESRI_TILE_ROOT}18/1/3`;
  const real = `${ESRI_TILE_ROOT}18/1/4`;
  const other = 'https://tile.openstreetmap.org/18/1/2.png';
  const target = fakeWindow({
    [missingTile]: jpeg(MISSING),
    [sameLength]: jpeg(new Uint8Array([1, 2, 3, 4, 6])),
    [real]: jpeg(new Uint8Array(40)),
    [other]: jpeg(MISSING),
  });
  const uninstall = discardMissingEsriTiles(target);
  assert.equal((await target.fetch(missingTile)).status, 404);
  const kept = await target.fetch(sameLength);
  assert.equal(kept.status, 200);
  assert.deepEqual(
    new Uint8Array(await kept.arrayBuffer()),
    new Uint8Array([1, 2, 3, 4, 6]),
  );
  assert.equal((await target.fetch(new Request(real))).status, 200);
  assert.equal((await target.fetch(other)).status, 200);
  assert.equal(
    target.requests.filter((url) => url.endsWith('23/0/0')).length,
    1,
    'the reference is fetched once',
  );
  uninstall();
});

test('without the reference image Esri tiles pass, and it is tried again', async () => {
  const missingTile = `${ESRI_TILE_ROOT}18/1/2`;
  const target = fakeWindow(
    { [missingTile]: jpeg(MISSING) },
    { referenceFails: true },
  );
  const uninstall = discardMissingEsriTiles(target);
  assert.equal((await target.fetch(missingTile)).status, 200);
  assert.equal((await target.fetch(missingTile)).status, 200);
  assert.equal(
    target.requests.filter((url) => url.endsWith('23/0/0')).length,
    2,
  );
  uninstall();
});

test('installs share one wrapper; the last uninstall restores fetch', () => {
  const target = fakeWindow({});
  const original = target.fetch;
  const first = discardMissingEsriTiles(target);
  const wrapped = target.fetch;
  const second = discardMissingEsriTiles(target);
  assert.equal(target.fetch, wrapped);
  first();
  first();
  assert.equal(target.fetch, wrapped);
  second();
  assert.equal(target.fetch, original);
});
