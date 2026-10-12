import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cmrSearchUrl,
  fetchCmrPages,
  parseCmrUmm,
  searchHls,
} from './catalog.js';
import { BOX, response } from './testDoubles.mjs';

function ummItem({
  conceptId = 'G1-LPCLOUD',
  begin = '2026-09-18T17:12:01.000Z',
  end = '2026-09-18T17:12:31.000Z',
  cloud = '12',
  polygon = [
    [-98, 30],
    [-97, 30],
    [-97, 31],
    [-98, 31],
  ],
  rectangle = null,
} = {}) {
  const Geometry = {};
  if (polygon)
    Geometry.GPolygons = [
      {
        Boundary: {
          Points: polygon.map(([Longitude, Latitude]) => ({
            Longitude,
            Latitude,
          })),
        },
      },
    ];
  if (rectangle)
    Geometry.BoundingRectangles = [
      {
        WestBoundingCoordinate: rectangle[0],
        SouthBoundingCoordinate: rectangle[1],
        EastBoundingCoordinate: rectangle[2],
        NorthBoundingCoordinate: rectangle[3],
      },
    ];
  return {
    meta: { 'concept-id': conceptId },
    umm: {
      TemporalExtent: {
        RangeDateTime: { BeginningDateTime: begin, EndingDateTime: end },
      },
      AdditionalAttributes: [
        { Name: 'SPATIAL_COVERAGE', Values: ['100'] },
        ...(cloud === undefined
          ? []
          : [{ Name: 'CLOUD_COVERAGE', Values: [cloud] }]),
      ],
      SpatialExtent: { HorizontalSpatialDomain: { Geometry } },
    },
  };
}

test('umm_json granules carry id, times, scene cloud and a footprint ring', () => {
  const { granules, hits } = parseCmrUmm(
    {
      hits: 9,
      items: [
        ummItem(),
        ummItem({
          conceptId: 'G2',
          cloud: '3.5',
          polygon: null,
          rectangle: [-98.5, 29.5, -97.5, 30.5],
        }),
        {
          meta: {},
          umm: {
            GranuleUR: 'HLS.L30.only-ur',
            TemporalExtent: {
              RangeDateTime: { BeginningDateTime: '2026-09-01T16:00:00Z' },
            },
          },
        },
        ummItem({ conceptId: 'G-bad-cloud', cloud: 'n/a' }),
        ummItem({
          conceptId: 'G-two-points',
          polygon: [
            [0, 0],
            [1, 1],
          ],
        }),
        { meta: { 'concept-id': 'G-no-time' }, umm: {} },
        {
          meta: { 'concept-id': 'G-bad-time' },
          umm: {
            TemporalExtent: { RangeDateTime: { BeginningDateTime: 'soon' } },
          },
        },
        null,
      ],
    },
    'S30',
  );
  assert.equal(hits, 9);
  assert.deepEqual(granules[0], {
    id: 'G1-LPCLOUD',
    product: 'S30',
    timeStart: '2026-09-18T17:12:01.000Z',
    timeEnd: '2026-09-18T17:12:31.000Z',
    cloud: 12,
    footprint: [
      [-98, 30],
      [-97, 30],
      [-97, 31],
      [-98, 31],
    ],
  });
  assert.equal(granules[1].cloud, 3.5);
  assert.deepEqual(granules[1].footprint, [
    [-98.5, 29.5],
    [-97.5, 29.5],
    [-97.5, 30.5],
    [-98.5, 30.5],
  ]);
  assert.deepEqual(
    granules.slice(2).map((g) => [g.id, g.cloud, g.footprint]),
    [
      ['HLS.L30.only-ur', null, null],
      ['G-bad-cloud', null, granules[0].footprint],
      ['G-two-points', 12, null],
    ],
    'missing fields stay unknown; granules without a start time are dropped',
  );
  assert.equal(granules[2].timeEnd, '2026-09-01T16:00:00Z');
  assert.deepEqual(parseCmrUmm(null, 'S30'), { granules: [], hits: 0 });
});

test('the CMR query names the collection, box, window and page size with literal commas', () => {
  assert.equal(
    cmrSearchUrl({
      product: 'S30',
      box: BOX,
      startIso: '2026-08-23T00:00:00Z',
      endIso: '2026-09-21T12:00:00.000Z',
    }),
    'https://cmr.earthdata.nasa.gov/search/granules.umm_json?collection_concept_id=C2021957295-LPCLOUD&bounding_box=-97.8,30.2,-97.7,30.3&temporal=2026-08-23T00:00:00Z,2026-09-21T12:00:00.000Z&sort_key=-start_date&page_size=200',
  );
  assert.match(
    cmrSearchUrl({ product: 'L30', box: BOX, startIso: 'a', endIso: 'b' }),
    /collection_concept_id=C2021957657-LPCLOUD/,
  );
  assert.throws(
    () => cmrSearchUrl({ product: 'VIIRS', box: BOX }),
    /No CMR collection/,
  );
});

/** Route a CMR request to the S30 or L30 handler by collection id. */
function cmrFetch(handlers, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const handler = handlers[url.includes('C2021957295') ? 'S30' : 'L30'];
    return typeof handler === 'function'
      ? handler()
      : response({ json: handler });
  };
}

test('both HLS collections fold with the VIIRS days; one failing product is reported, not fatal', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const result = await searchHls({
    box: BOX,
    now: new Date('2026-09-21T12:00:00Z'),
    signal,
    fetchImpl: cmrFetch(
      {
        S30: {
          hits: 2,
          items: [
            ummItem(),
            ummItem({ conceptId: 'G-old', begin: '2026-09-08T17:12:01Z' }),
          ],
        },
        L30: () => response({ ok: false, status: 503 }),
      },
      calls,
    ),
  });
  assert.deepEqual(result.errors, [
    { product: 'L30', message: 'HTTP 503 from CMR' },
  ]);
  assert.equal(result.truncated, false);
  assert.equal(calls[0].init.signal, signal);
  assert.match(
    calls[0].url,
    /temporal=2026-08-23T00:00:00Z,2026-09-21T12:00:00\.000Z/,
    '30 UTC days ending now',
  );
  const keys = result.candidates.map((c) => c.key);
  assert.equal(keys.length, 32);
  assert.deepEqual(keys.slice(2, 5), [
    'VIIRS:2026-09-19',
    'S30:2026-09-18',
    'VIIRS:2026-09-18',
  ]);
  assert.ok(keys.includes('S30:2026-09-08'));
  assert.equal(
    result.candidates.find((c) => c.key === 'S30:2026-09-18').coverage,
    'full',
    'coverage is computed against the box',
  );

  const thrown = await searchHls({
    box: BOX,
    days: 2,
    now: '2026-09-21T00:00:00Z',
    fetchImpl: cmrFetch({
      S30: () => {
        throw new Error('network down');
      },
      L30: { hits: 500, items: [ummItem({ conceptId: 'G-L30' })] },
    }),
  });
  assert.deepEqual(thrown.errors, [
    { product: 'S30', message: 'network down' },
  ]);
  assert.equal(thrown.truncated, true, 'CMR has more hits than were read');
  assert.deepEqual(
    thrown.candidates.map((c) => c.key),
    ['VIIRS:2026-09-21', 'VIIRS:2026-09-20', 'L30:2026-09-18'],
  );
});

test('an invalid box or clock is refused before any request', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
  };
  await assert.rejects(
    searchHls({
      box: { west: 179, south: 0, east: -179, north: 1 },
      fetchImpl,
    }),
    /dateline/,
  );
  await assert.rejects(
    searchHls({ box: BOX, now: 'never', fetchImpl }),
    /clock/,
  );
  assert.equal(called, false);
});

test('CMR pages follow the CMR-Search-After cursor up to 2,000 records and truncation stays honest', async () => {
  const items = (count) =>
    Array.from({ length: count }, (_, i) => ummItem({ conceptId: `G-${i}` }));
  const cursors = [];
  const paged = await fetchCmrPages({
    product: 'S30',
    url: 'https://cmr/x',
    fetchImpl: async (url, init) => {
      const page = cursors.push(init.headers?.['CMR-Search-After'] ?? null);
      return response({
        headers: { 'CMR-Search-After': `cursor-${page}` },
        json: { hits: 450, items: items(page < 3 ? 200 : 50) },
      });
    },
  });
  assert.equal(paged.granules.length, 450);
  assert.equal(paged.truncated, false);
  assert.deepEqual(cursors, [null, 'cursor-1', 'cursor-2']);

  let pages = 0;
  const capped = await fetchCmrPages({
    product: 'L30',
    url: 'https://cmr/y',
    fetchImpl: async () => {
      pages += 1;
      return response({
        headers: { 'cmr-search-after': 'more' },
        json: { hits: 5000, items: items(200) },
      });
    },
  });
  assert.equal(pages, 10);
  assert.equal(capped.granules.length, 2000);
  assert.equal(capped.truncated, true);

  const noCursor = await fetchCmrPages({
    product: 'S30',
    url: 'u',
    fetchImpl: async () => response({ json: { hits: 900, items: items(200) } }),
  });
  assert.equal(noCursor.granules.length, 200);
  assert.equal(noCursor.truncated, true);
});
