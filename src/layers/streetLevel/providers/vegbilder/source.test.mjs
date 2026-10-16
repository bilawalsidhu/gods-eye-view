import assert from 'node:assert/strict';
import test from 'node:test';
import { createVegbilderSource } from './source.js';
import { RATE_LIMITED_MESSAGE, VEGBILDER_WFS } from './policy.js';

function response(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function recordingFetch(reply) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(new URL(url));
    return reply(url);
  };
  return { urls, fetchImpl };
}

const feature = {
  type: 'Feature',
  id: 'Vegbilder_2025.a',
  geometry: { coordinates: [10, 60] },
};

test('a box asks one feature type in EPSG:4326, latitude first, without the long photo addresses', async () => {
  const { urls, fetchImpl } = recordingFetch(() =>
    response({ type: 'FeatureCollection', features: [feature] }),
  );
  const source = createVegbilderSource({ fetchImpl });
  const features = await source.imagesInBox('vegbilder_1_0:Vegbilder_2025', {
    west: 10.7,
    south: 59.9,
    east: 10.8,
    north: 59.95,
  });
  assert.deepEqual(features, [feature]);
  const url = urls[0];
  assert.equal(`${url.origin}${url.pathname}`, VEGBILDER_WFS);
  assert.equal(
    url.searchParams.get('typeNames'),
    'vegbilder_1_0:Vegbilder_2025',
  );
  assert.equal(
    url.searchParams.get('bbox'),
    '59.9,10.7,59.95,10.8,urn:ogc:def:crs:EPSG::4326',
  );
  assert.equal(url.searchParams.get('outputFormat'), 'application/json');
  assert.ok(!url.searchParams.get('propertyName').includes('URL'));

  await source.imagesInBox(
    'vegbilder_1_0:Vegbilder_2025',
    { west: 0, south: 0, east: 1, north: 1 },
    { withUrls: true },
  );
  assert.equal(
    urls[1].searchParams.get('propertyName'),
    null,
    'a nearest search wants the addresses',
  );
});

test('a photo by id asks its own feature type by resource id', async () => {
  const { urls, fetchImpl } = recordingFetch(() =>
    response({ features: [feature] }),
  );
  const source = createVegbilderSource({ fetchImpl });
  assert.deepEqual(await source.getImage('Vegbilder_2025.a'), feature);
  assert.equal(
    urls[0].searchParams.get('typeNames'),
    'vegbilder_1_0:Vegbilder_2025',
  );
  assert.equal(urls[0].searchParams.get('resourceId'), 'Vegbilder_2025.a');
  assert.equal(await source.getImage('not-a-photo'), null);
  assert.equal(urls.length, 1, 'a malformed id asks nothing');
});

test('a drive asks by CQL, sorted by metre', async () => {
  const { urls, fetchImpl } = recordingFetch(() => response({ features: [] }));
  const source = createVegbilderSource({ fetchImpl });
  await source.driveImages('vegbilder_1_0:Vegbilder_2025', "FELTKODE = '1'");
  assert.equal(urls[0].searchParams.get('CQL_FILTER'), "FELTKODE = '1'");
  assert.equal(urls[0].searchParams.get('sortBy'), 'METER');
});

test('a year Vegvesen has not published yet is empty; other errors say so', async () => {
  const unknown = createVegbilderSource({
    fetchImpl: async () =>
      response(
        '<?xml version="1.0"?><ows:ExceptionReport><ows:ExceptionText>Feature type vegbilder_1_0:Vegbilder_2027 unknown</ows:ExceptionText></ows:ExceptionReport>',
        { status: 400 },
      ),
  });
  assert.deepEqual(
    await unknown.imagesInBox('vegbilder_1_0:Vegbilder_2027', {
      west: 0,
      south: 0,
      east: 1,
      north: 1,
    }),
    [],
  );

  const broken = createVegbilderSource({
    fetchImpl: async () => response('<html>oops</html>', { status: 502 }),
  });
  await assert.rejects(
    broken.imagesInBox('vegbilder_1_0:Vegbilder_2025', {
      west: 0,
      south: 0,
      east: 1,
      north: 1,
    }),
    /Vegbilder answered 502/,
  );

  const limited = createVegbilderSource({
    fetchImpl: async () =>
      response('', { status: 429, headers: { 'Retry-After': '7' } }),
  });
  await assert.rejects(
    limited.getImage('Vegbilder_2025.a'),
    (error) =>
      error.message === RATE_LIMITED_MESSAGE && error.retryAfterSec === 7,
  );

  const offline = createVegbilderSource({
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await assert.rejects(
    offline.getImage('Vegbilder_2025.a'),
    /could not be reached/,
  );
});

test('at most four requests run at once; an aborted one rejects without asking', async () => {
  let running = 0;
  let peak = 0;
  const release = [];
  const source = createVegbilderSource({
    fetchImpl: async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => release.push(resolve));
      running--;
      return response({ features: [] });
    },
  });
  const box = { west: 0, south: 0, east: 1, north: 1 };
  const all = Array.from({ length: 6 }, () =>
    source.imagesInBox('vegbilder_1_0:Vegbilder_2025', box),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(peak, 4);
  while (release.length) {
    release.shift()();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await Promise.all(all);
  assert.equal(peak, 4);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    source.imagesInBox('vegbilder_1_0:Vegbilder_2025', box, {
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
});
