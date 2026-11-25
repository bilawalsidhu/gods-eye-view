import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryHandler } from './proxy.js';
import { libraryEntry } from './catalog.js';
import {
  libraryViewBox,
  parseLibraryViewBox,
  validateLibraryCatalog,
} from './manifest.js';

const base = {
  family: 'imagery',
  provider: 'Fixture',
  description: 'Fixture entry.',
  maintainer: 'test',
  coverage: { global: true },
  licence: { name: 'Public domain', url: 'https://example.org/licence' },
  attribution: { text: 'Fixture' },
  status: 'community',
};
const { entries, errors } = validateLibraryCatalog([
  {
    ...base,
    id: 'direct-tiles',
    kind: 'tiles',
    title: 'Direct tiles',
    source: {
      format: 'bbox',
      url: 'https://maps.example.org/export?bbox={bbox-epsg-3857}&f=image',
      fetch: 'browser-direct',
      cacheSeconds: 900,
    },
  },
  {
    ...base,
    id: 'hidden-tiles',
    kind: 'tiles',
    title: 'Hidden tiles',
    source: {
      format: 'xyz',
      url: 'https://tiles.example.org/{z}/{x}/{y}.png',
      fetch: 'browser-direct',
    },
  },
  {
    ...base,
    id: 'direct-points',
    kind: 'dataset',
    family: 'events',
    title: 'Direct points',
    source: {
      format: 'geojson',
      url: 'https://data.example.org/points.json',
      fetch: 'browser-direct',
    },
  },
]);
assert.deepEqual(errors, []);
const view = libraryEntry('fema-usa-structures');

const png = () =>
  new Response(new Uint8Array([137, 80, 78, 71]), {
    headers: { 'content-type': 'image/png' },
  });
const get = (handle, path) =>
  handle(new Request(`https://app.example/api/library${path}`));

test('a hidden entry is listed as not offered and no route serves it', async () => {
  let calls = 0;
  const handle = createLibraryHandler({
    entries,
    listed: (entry) => entry.id !== 'hidden-tiles',
    proxied: () => true,
    fetchImpl: async () => {
      calls++;
      return png();
    },
  });
  const catalog = await (await get(handle, '/catalog')).json();
  assert.deepEqual(
    catalog.entries.find(({ id }) => id === 'hidden-tiles'),
    {
      id: 'hidden-tiles',
      available: false,
      reason: 'operator-disabled',
      listed: false,
    },
  );
  assert.equal((await get(handle, '/tile/hidden-tiles/1/0/0')).status, 404);
  assert.equal(calls, 0);
});

test('a routed browser-direct entry is served from its manifest and cacheable for cacheSeconds', async () => {
  const calls = [];
  const handle = createLibraryHandler({
    entries,
    proxied: (entry) => entry.id === 'direct-tiles',
    keep: false,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return png();
    },
  });
  const catalog = await (await get(handle, '/catalog')).json();
  assert.equal(
    catalog.entries.find(({ id }) => id === 'direct-tiles').fetch,
    'proxied',
  );
  assert.equal(
    catalog.entries.find(({ id }) => id === 'direct-points').fetch,
    undefined,
  );
  const tile = await get(handle, '/tile/direct-tiles/1/1/0?url=https://evil');
  assert.equal(tile.status, 200);
  assert.equal(tile.headers.get('content-type'), 'image/png');
  assert.equal(tile.headers.get('cache-control'), 'public, max-age=900');
  assert.equal(calls.length, 1);
  assert.match(
    calls[0].url,
    /^https:\/\/maps\.example\.org\/export\?bbox=0\.000,0\.000,20037508\.343,20037508\.343&f=image$/,
  );
  assert.equal(calls[0].options.redirect, 'error');
  // Not kept in memory: a shared cache in front holds it.
  await get(handle, '/tile/direct-tiles/1/1/0');
  assert.equal(calls.length, 2);
  // An entry the server does not route stays the browser's to fetch.
  assert.equal((await get(handle, '/data/direct-points')).status, 404);
});

test('a routed view-bounded entry needs a snapped box and queries only it', async () => {
  const calls = [];
  const handle = createLibraryHandler({
    entries: [view],
    proxied: () => true,
    fetchImpl: async (url) => {
      calls.push(new URL(url));
      return new Response(
        JSON.stringify({ type: 'FeatureCollection', features: [] }),
      );
    },
  });
  assert.equal((await get(handle, '/data/fema-usa-structures')).status, 400);
  assert.equal(
    (await get(handle, '/data/fema-usa-structures?bbox=-77.03,38.89,-77,38.9'))
      .status,
    400,
  );
  assert.equal(calls.length, 0);
  const box = libraryViewBox([-77.031, 38.889, -77.02, 38.9]);
  const ok = await get(handle, `/data/fema-usa-structures?bbox=${box}`);
  assert.equal(ok.status, 200);
  assert.equal(
    ok.headers.get('cache-control'),
    `public, max-age=${view.source.cacheSeconds}`,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].searchParams.get('geometry'),
    box.map((value) => value.toFixed(6)).join(','),
  );
});

test('a view box snaps out to two grid cells a side, with one spelling', () => {
  const asked = [-77.031, 38.889, -77.02, 38.9];
  const box = libraryViewBox(asked);
  assert.ok(box[0] <= asked[0] && box[1] <= asked[1]);
  assert.ok(box[2] >= asked[2] && box[3] >= asked[3]);
  assert.equal(box[2] - box[0], box[3] - box[1]);
  // Nearby views name the same box.
  assert.deepEqual(libraryViewBox([-77.0305, 38.8895, -77.0205, 38.8995]), box);
  assert.deepEqual(parseLibraryViewBox(box.join(',')), box);
  assert.equal(
    parseLibraryViewBox(box.map((v) => v.toFixed(8)).join(',')),
    null,
  );
  assert.equal(parseLibraryViewBox('-77,38,-76,39.5'), null);
  assert.equal(parseLibraryViewBox('0,0,4,4'), null);
  assert.equal(libraryViewBox([0, 0, 3, 3]), null);
});

test('a tile path has one spelling: no leading zeros, no empty segments, inside the grid', async () => {
  const calls = [];
  const xyz = entries.find(({ id }) => id === 'hidden-tiles');
  const handle = createLibraryHandler({
    entries: [xyz],
    proxied: () => true,
    keep: false,
    fetchImpl: async (url) => {
      calls.push(url);
      return png();
    },
  });
  for (const path of [
    '/tile/hidden-tiles/02/1/1',
    '/tile/hidden-tiles/2/01/1',
    '/tile/hidden-tiles/2/1/4',
    '/tile/hidden-tiles/2/1/1.5',
    '/tile/hidden-tiles/23/1/1',
  ])
    assert.equal((await get(handle, path)).status, 400, path);
  for (const path of [
    '/tile/hidden-tiles//2/1/1',
    '/tile/hidden-tiles/2/1/1/',
    '//tile/hidden-tiles/2/1/1',
  ])
    assert.equal((await get(handle, path)).status, 404, path);
  assert.equal(calls.length, 0);
  assert.equal((await get(handle, '/tile/hidden-tiles/2/1/3')).status, 200);
  assert.equal(calls.length, 1);
});

test('a partitioned dataset reads its index from the given fetch, never builds one, and stays under the subrequest limit', async () => {
  const epc = libraryEntry('epc-england-wales');
  const box = libraryViewBox(epc.source.view.sample);
  const upstream = [];
  const indexes = [];
  const handler = (fetchIndex, subrequestLimit = Infinity) =>
    createLibraryHandler({
      entries: [epc],
      proxied: () => true,
      keep: false,
      fetchIndex,
      subrequestLimit,
      fetchImpl: async (url) => {
        upstream.push(String(url));
        return new Response('', { status: 500 });
      },
    });

  // No index to be had: refused clearly, the publisher never asked.
  const missing = await get(
    handler(async (entry) => {
      indexes.push(entry.id);
      return new Response('', { status: 404 });
    }),
    `/data/epc-england-wales?bbox=${box}`,
  );
  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), { error: 'index_unavailable' });
  assert.deepEqual(indexes, ['epc-england-wales']);
  assert.deepEqual(upstream, []);

  // An index naming partitions in view: reading them would pass the limit.
  const partitions = Array.from({ length: 8 }, (_, i) => ({
    url: `${epc.source.partitions.keyBase}addresscloud/epc/geoparquet-local-authority/p${i}.parquet`,
    bbox: box,
  }));
  const over = await get(
    handler(async () => Response.json({ partitions, complete: true }), 3),
    `/data/epc-england-wales?bbox=${box}`,
  );
  assert.equal(over.status, 503);
  assert.deepEqual(await over.json(), { error: 'subrequest_limit' });
  // The index fetch and two upstream reads; the third read was refused.
  assert.equal(upstream.length, 2);
});
