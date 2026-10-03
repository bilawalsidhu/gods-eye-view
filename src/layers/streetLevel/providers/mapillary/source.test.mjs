import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapillarySource, MapillarySourceError } from './source.js';

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { calls, fetchImpl };
}

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('tiles go through the local proxy and never carry the token', async () => {
  const { calls, fetchImpl } = fakeFetch(
    () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
  );
  const source = createMapillarySource({ token: 'MLY|1|abc', fetchImpl });
  const bytes = await source.getTile('coverage', 14, 2662, 6285);
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.equal(calls[0].url, '/api/mapillary/tiles/coverage/14/2662/6285');
  assert.doesNotMatch(calls[0].url, /MLY/);
});

test('an empty tile (204) is an empty byte array, not an error', async () => {
  const { fetchImpl } = fakeFetch(() => new Response(null, { status: 204 }));
  const source = createMapillarySource({ token: 'MLY|1|abc', fetchImpl });
  assert.equal((await source.getTile('coverage', 14, 1, 1)).length, 0);
});

test('a missing key on the proxy surfaces as keyRequired', async () => {
  const { fetchImpl } = fakeFetch(() =>
    jsonResponse({ error: 'no_key', keyRequired: true }, 503),
  );
  const source = createMapillarySource({ token: '', fetchImpl });
  assert.equal(source.hasToken(), false);
  await assert.rejects(
    () => source.getTile('coverage', 14, 1, 1),
    (error) =>
      error instanceof MapillarySourceError &&
      error.status === 503 &&
      error.keyRequired === true,
  );
});

test('graph lookups call graph.mapillary.com with the client token and requested fields', async () => {
  const { calls, fetchImpl } = fakeFetch(() =>
    jsonResponse({ data: [{ id: '1', geometry: { coordinates: [1, 2] } }] }),
  );
  const source = createMapillarySource({ token: 'MLY|1|abc', fetchImpl });
  const images = await source.getSequenceImages('seq-1');
  assert.equal(images.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.host, 'graph.mapillary.com');
  assert.equal(url.pathname, '/images');
  assert.equal(url.searchParams.get('access_token'), 'MLY|1|abc');
  assert.equal(url.searchParams.get('sequence_ids'), 'seq-1');
  assert.match(url.searchParams.get('fields'), /geometry/);

  const nearest = await source.nearestImages({
    lat: 38.5,
    lon: -121.5,
    radius: 500,
    limit: 500,
  });
  assert.equal(nearest.length, 1);
  const nearestUrl = new URL(calls[1].url);
  assert.equal(
    nearestUrl.searchParams.get('radius'),
    '50',
    'radius is clamped to the API maximum',
  );
  assert.equal(nearestUrl.searchParams.get('limit'), '100');
});

test('graph calls without a token fail fast as keyRequired without a request', async () => {
  const { calls, fetchImpl } = fakeFetch(() => jsonResponse({}));
  const source = createMapillarySource({ token: '', fetchImpl });
  await assert.rejects(
    () => source.getImage('123'),
    (error) =>
      error instanceof MapillarySourceError && error.keyRequired === true,
  );
  assert.equal(calls.length, 0);
});

test('graph API errors carry the upstream message and status', async () => {
  const { fetchImpl } = fakeFetch(() =>
    jsonResponse({ error: { message: 'Invalid OAuth 2.0 Access Token' } }, 400),
  );
  const source = createMapillarySource({ token: 'MLY|1|abc', fetchImpl });
  await assert.rejects(
    () => source.getImage('999'),
    (error) =>
      error instanceof MapillarySourceError &&
      error.status === 400 &&
      /Invalid OAuth/.test(error.message),
  );
});

test('the source exposes only imagery lookups', () => {
  const source = createMapillarySource({ token: 'MLY|1|abc' });
  for (const gone of ['queryFeatures', 'plan', 'geocode', 'spriteUrl'])
    assert.equal(source[gone], undefined, gone);
});
