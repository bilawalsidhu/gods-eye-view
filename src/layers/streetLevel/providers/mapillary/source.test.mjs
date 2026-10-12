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

test('successful malformed image lists are errors, not zero photos', async () => {
  for (const payload of [
    null,
    {},
    { data: null },
    { data: {} },
    { error: 'unexpected' },
  ]) {
    const source = createMapillarySource({
      token: 'fixture',
      fetchImpl: async () => jsonResponse(payload),
    });
    for (const run of [
      () => source.getSequenceImages('route'),
      () => source.nearestImages({ lat: 1, lon: 2 }),
    ])
      await assert.rejects(
        run,
        (error) => error.status === 200 && /malformed/.test(error.message),
      );
  }
  const source = createMapillarySource({
    token: 'fixture',
    fetchImpl: async () => jsonResponse({ data: [] }),
  });
  assert.deepEqual(await source.getSequenceImages('route'), []);
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
  assert.equal(url.pathname, '/image_ids');
  assert.equal(url.searchParams.has('access_token'), false);
  assert.equal(calls[0].init.headers.Authorization, 'OAuth MLY|1|abc');
  assert.equal(url.searchParams.get('sequence_id'), 'seq-1');
  const metadataUrl = new URL(calls[1].url);
  assert.equal(metadataUrl.pathname, '/images');
  assert.equal(metadataUrl.searchParams.get('image_ids'), '1');
  assert.match(metadataUrl.searchParams.get('fields'), /geometry/);

  const nearest = await source.nearestImages({
    lat: 38.5,
    lon: -121.5,
    radius: 500,
    limit: 500,
  });
  assert.equal(nearest.length, 1);
  const nearestUrl = new URL(calls[2].url);
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
    () => source.getSequenceImages('123'),
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
    () => source.getSequenceImages('999'),
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

test('sequence IDs paginate safely and dedupe; metadata is restored to capture order', async () => {
  const { calls, fetchImpl } = fakeFetch((address) => {
    const url = new URL(address);
    if (url.pathname === '/image_ids') {
      return jsonResponse(
        url.searchParams.has('after')
          ? { data: [{ id: '2' }, { id: '3' }] }
          : {
              data: [{ id: '1' }, { id: '2' }],
              paging: {
                cursors: { after: 'cursor-1' },
                next: 'https://untrusted.invalid/do-not-fetch',
              },
            },
      );
    }
    return jsonResponse({
      data: [{ id: '3' }, { id: '2' }, { id: '1' }, { id: '999' }],
    });
  });
  const source = createMapillarySource({ token: 'fixture', fetchImpl });
  assert.deepEqual(
    (await source.getSequenceImages('route')).map((r) => r.id),
    ['1', '2', '3'],
  );
  assert.equal(calls.length, 3);
  assert.ok(
    calls.every((call) => new URL(call.url).host === 'graph.mapillary.com'),
  );
  assert.equal(new URL(calls[1].url).searchParams.get('after'), 'cursor-1');
  assert.equal(new URL(calls[2].url).searchParams.get('image_ids'), '1,2,3');
});

test('sequence metadata batches are bounded and stop at the requested image cap', async () => {
  const { calls, fetchImpl } = fakeFetch((address) => {
    const url = new URL(address);
    if (url.pathname === '/image_ids')
      return jsonResponse({
        data: Array.from({ length: 2500 }, (_, i) => ({ id: String(i + 1) })),
      });
    const ids = url.searchParams.get('image_ids').split(',');
    assert.ok(ids.length <= 200);
    return jsonResponse({ data: ids.reverse().map((id) => ({ id })) });
  });
  const source = createMapillarySource({ token: 'fixture', fetchImpl });
  const images = await source.getSequenceImages('route', { limit: 5000 });
  assert.equal(images.length, 2000);
  assert.equal(images[0].id, '1');
  assert.equal(images.at(-1).id, '2000');
  assert.equal(calls.length, 11);
});

test('sequence pagination rejects a missing or repeated cursor and abort stops metadata work', async () => {
  for (const paging of [
    { next: 'https://untrusted.invalid' },
    { next: 'anything', cursors: { after: 'same' } },
  ]) {
    const source = createMapillarySource({
      token: 'fixture',
      fetchImpl: async () => jsonResponse({ data: [{ id: '1' }], paging }),
    });
    await assert.rejects(
      () => source.getSequenceImages('route'),
      /invalid sequence pagination/,
    );
  }
  const controller = new AbortController();
  let calls = 0;
  const source = createMapillarySource({
    token: 'fixture',
    fetchImpl: async () => {
      calls++;
      controller.abort();
      return jsonResponse({ data: [{ id: '1' }] });
    },
  });
  await assert.rejects(
    () => source.getSequenceImages('route', { signal: controller.signal }),
    (e) => e.name === 'AbortError',
  );
  assert.equal(calls, 1);
});

test('known photo metadata uses only a validated ID and reports response mismatches', async () => {
  const { calls, fetchImpl } = fakeFetch((address) =>
    jsonResponse({
      data: [
        {
          id: new URL(address).searchParams.get('image_ids'),
          geometry: { coordinates: [2.5, 1.25] },
        },
      ],
    }),
  );
  const source = createMapillarySource({ token: 'fixture', fetchImpl });
  const record = await source.getImageMetadata('123456789012345');
  assert.equal(record.id, '123456789012345');
  assert.equal(new URL(calls[0].url).pathname, '/images');
  assert.equal(
    new URL(calls[0].url).searchParams.get('image_ids'),
    '123456789012345',
  );
  await assert.rejects(() => source.getImageMetadata('../private'), /numeric/);
  assert.equal(calls.length, 1);
  const malformed = createMapillarySource({
    token: 'fixture',
    fetchImpl: async () => jsonResponse({ data: [{ id: 'different' }] }),
  });
  await assert.rejects(
    () => malformed.getImageMetadata('223456789012345'),
    /malformed image metadata/,
  );
});

test('a valid empty metadata response names app availability, not malformed data or absent coverage', async () => {
  const source = createMapillarySource({
    token: 'fixture',
    fetchImpl: async () => jsonResponse({ data: [] }),
  });
  await assert.rejects(
    () => source.getImageMetadata('123456789012345'),
    (error) =>
      error.status === 200 &&
      /No metadata returned.*unavailable to this app/.test(error.message) &&
      !/malformed/.test(error.message),
  );
  assert.deepEqual(
    await source.getSequenceImages('empty-route'),
    [],
    'a genuinely empty ID list remains distinct',
  );
});

test('listed sequence photo IDs with empty metadata surface an integration/access error', async () => {
  const { calls, fetchImpl } = fakeFetch((address) =>
    jsonResponse(
      new URL(address).pathname === '/image_ids'
        ? { data: [{ id: '123456789012345' }, { id: '223456789012345' }] }
        : { data: [] },
    ),
  );
  const source = createMapillarySource({ token: 'fixture', fetchImpl });
  await assert.rejects(
    () => source.getSequenceImages('synthetic-sequence-a'),
    (error) =>
      error.status === 200 &&
      /listed 2 photo IDs.*no matching image metadata.*unavailable to this app/.test(
        error.message,
      ),
  );
  assert.equal(calls.length, 2);
});

test('a rejected key and a rate limit are told apart from other tile errors', async () => {
  const rejectedSource = createMapillarySource({
    token: 'MLY|1|abc',
    fetchImpl: fakeFetch(() =>
      jsonResponse(
        { error: 'Mapillary rejected the access token', keyRejected: true },
        403,
      ),
    ).fetchImpl,
  });
  await assert.rejects(
    () => rejectedSource.getTile('coverage', 14, 1, 1),
    (error) =>
      error.keyRejected === true &&
      error.keyRequired === false &&
      error.retryAfterSec === null,
  );
  const limitedSource = createMapillarySource({
    token: 'MLY|1|abc',
    fetchImpl: fakeFetch(
      () =>
        new Response(
          JSON.stringify({ error: 'rate limited', retryAfter: 45 }),
          {
            status: 429,
            headers: { 'retry-after': '30' },
          },
        ),
    ).fetchImpl,
  });
  await assert.rejects(
    () => limitedSource.getTile('coverage', 14, 1, 1),
    (error) => error.retryAfterSec === 30 && error.keyRejected === false,
    'the Retry-After header wins over the body',
  );
});
