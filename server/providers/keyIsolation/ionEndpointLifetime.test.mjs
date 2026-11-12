// How long the ion endpoint cache keeps each kind of document. CesiumJS asks
// for an endpoint again after ion rejects an asset token, but only for assets
// it loads through IonResource without an `externalType` (terrain): the
// external Bing imagery and Google 3D Tiles documents are read with no retry
// (IonResource.js, IonImageryProvider.js in @cesium/engine). So only
// documents without `externalType` are fetched anew after a minute; an
// external one stays until its token nears expiry, or for half an hour when
// it carries none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIonEndpointFetcher } from './ionEndpoint.js';

const TOKEN = `eyJ${'x'.repeat(30)}.${'y'.repeat(30)}.sig`;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function jwt(expSeconds) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ exp: expSeconds })}.sig`;
}

/** A fetcher on a moving clock; `document(clock)` builds ion's answer. */
function setup(document) {
  const world = { clock: 1_000_000, calls: 0, down: false };
  const fetchEndpoint = createIonEndpointFetcher({
    env: { CESIUM_ION_TOKEN: TOKEN },
    now: () => world.clock,
    fetchImpl: async () => {
      world.calls += 1;
      if (world.down) return new Response('{}', { status: 503 });
      return new Response(
        JSON.stringify({ ...document(world.clock), n: world.calls }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  return { world, fetchEndpoint };
}

const bing = () => ({
  type: 'IMAGERY',
  externalType: 'BING',
  options: { url: 'https://dev.virtualearth.net', key: 'k' },
});
const google = () => ({
  type: '3DTILES',
  externalType: '3DTILES',
  options: { url: 'https://tile.googleapis.com/v1/3dtiles/root.json' },
});
const terrain = (clock) => ({
  type: 'TERRAIN',
  url: 'https://assets.ion.cesium.com/1',
  accessToken: jwt(clock / 1000 + 3600),
});

for (const [name, document] of [
  ['Bing imagery', bing],
  ['Google 3D Tiles', google],
]) {
  test(`ion cache: an external ${name} document with no expiry is kept for thirty minutes`, async () => {
    const { world, fetchEndpoint } = setup(document);
    const first = await fetchEndpoint('2');
    world.clock += 61 * SECOND;
    assert.equal(
      await fetchEndpoint('2'),
      first,
      'not fetched anew at a minute',
    );
    world.clock += 28 * MINUTE;
    assert.equal(await fetchEndpoint('2'), first);
    assert.equal(world.calls, 1);
    world.clock += 58 * SECOND; // 29 minutes 59 seconds after the first call
    assert.equal(await fetchEndpoint('2'), first);
    world.clock += 1 * SECOND; // thirty minutes
    assert.notEqual(
      await fetchEndpoint('2'),
      first,
      'fetched anew at thirty minutes',
    );
    assert.equal(world.calls, 2);
  });
}

test('ion cache: a document past its thirty minutes is not served when ion fails', async () => {
  const { world, fetchEndpoint } = setup(bing);
  await fetchEndpoint('2');
  world.clock += 30 * MINUTE;
  world.down = true;
  await assert.rejects(fetchEndpoint('2'), { status: 502 });
});

test('ion cache: an external document that carries a token expiry is kept until the token nears it', async () => {
  const { world, fetchEndpoint } = setup((clock) => ({
    ...bing(),
    accessToken: jwt(clock / 1000 + 3600),
  }));
  const first = await fetchEndpoint('3');
  world.clock += 61 * SECOND;
  assert.equal(await fetchEndpoint('3'), first, 'not fetched anew at a minute');
  world.clock += 48 * MINUTE; // 49 minutes in: ten minutes and a bit left
  assert.equal(await fetchEndpoint('3'), first);
  assert.equal(world.calls, 1);
  world.clock += 1 * MINUTE; // 50 minutes in: under ten minutes left
  assert.notEqual(await fetchEndpoint('3'), first);
  assert.equal(world.calls, 2);
});

test('ion cache: a terrain document, which CesiumJS asks for again after a rejection, is fetched anew after a minute', async () => {
  const { world, fetchEndpoint } = setup(terrain);
  const first = await fetchEndpoint('1');
  world.clock += 59 * SECOND;
  assert.equal(await fetchEndpoint('1'), first);
  world.clock += 2 * SECOND;
  assert.notEqual(await fetchEndpoint('1'), first);
  assert.equal(world.calls, 2);
});
