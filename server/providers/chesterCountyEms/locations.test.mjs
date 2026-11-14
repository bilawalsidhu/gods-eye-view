import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCountyLocationResolver,
  matchIntersection,
  normalizeRoad,
} from './locations.js';
const node = [-75.7, 40];
const road = (name, points, level = 0) => ({
  attributes: { ROAD_NAME_FULL: name, FR_ZLEV: level, TO_ZLEV: level },
  geometry: { paths: [points] },
});
const roads = [
  road('Example AV', [[-75.701, 40], node]),
  road('N Test LA', [node, [-75.7, 40.001]]),
];
const row = {
  location: 'EXAMPLE AVE & TEST LN',
  municipality: 'Example Township',
};

test('county abbreviations normalize and omitted direction can match', () => {
  assert.equal(normalizeRoad('West Example Avenue'), 'W EXAMPLE AV');
  assert.equal(normalizeRoad('Kennett WY'), normalizeRoad('KENNETT WAY'));
  assert.equal(normalizeRoad('Lincoln HW'), normalizeRoad('LINCOLN HWY'));
  assert.equal(
    matchIntersection(roads, 'EXAMPLE AVE', 'TEST LN').kind,
    'intersection',
  );
  assert.equal(matchIntersection(roads, 'EXAMPLE AVE', 'S TEST LN'), null);
});
test('projected crossings and different levels do not create fake intersections', () => {
  assert.equal(
    matchIntersection(
      [roads[0], road('Test LN', [node, [-75.7, 40.001]], 1)],
      'EXAMPLE AVE',
      'TEST LN',
    ),
    null,
  );
  assert.equal(
    matchIntersection(
      [
        road('Example AV', [
          [-75.701, 40],
          [-75.699, 40],
        ]),
        road('Test LN', [
          [-75.7, 39.999],
          [-75.7, 40.001],
        ]),
      ],
      'EXAMPLE AVE',
      'TEST LN',
    ),
    null,
  );
});
test('multiple distant junctions are ambiguous, not guessed from municipality center', () => {
  const other = [-75.72, 40];
  assert.equal(
    matchIntersection(
      [
        ...roads,
        road('Example AV', [other, [-75.721, 40]]),
        road('Test LN', [other, [-75.72, 40.001]]),
      ],
      'EXAMPLE AVE',
      'TEST LN',
    ),
    null,
  );
});
test('street queries are municipality constrained, contain no incident type, and cached', async () => {
  const requests = [];
  const resolve = createCountyLocationResolver({
    fetchImpl: async (url) => {
      requests.push(new URL(url));
      return Response.json({ features: roads });
    },
  });
  assert.deepEqual(await resolve({ ...row, type: 'MEDICAL PRIVATE' }), {
    lon: -75.7,
    lat: 40,
    kind: 'intersection',
    approximate: true,
  });
  await resolve(row);
  assert.equal(requests.length, 1);
  assert.match(requests[0].searchParams.get('where'), /EXAMPLE TWP/);
  assert.ok(!requests[0].href.includes('MEDICAL'));
});
test('numbered address uses exact number, street and municipality', async () => {
  let query;
  const resolve = createCountyLocationResolver({
    fetchImpl: async (url) => {
      query = new URL(url).searchParams.get('where');
      return Response.json({
        features: [
          {
            attributes: {
              ROAD_NAME_FULL: 'Example AV',
              ADDR_NUM: '123',
              MUNI_NAME_FULL: 'Example Township',
            },
            geometry: { x: -75.7, y: 40 },
          },
        ],
      });
    },
  });
  const result = await resolve({ ...row, location: '123 EXAMPLE AVE APT 2 &' });
  assert.equal(result.kind, 'address');
  assert.match(query, /ADDR_NUM\)='123'/);
  assert.match(query, /MUNI_NAME_FULL\)='EXAMPLE TOWNSHIP'/);
});
test('place-only input queries county places but never uses a municipal center', async () => {
  let url;
  const resolve = createCountyLocationResolver({
    fetchImpl: async (input) => {
      url = new URL(input);
      return Response.json({ features: [] });
    },
  });
  assert.deepEqual(
    await resolve.resolveDetailed({ ...row, location: 'SUMMIT HOUSE &' }),
    { position: null, status: 'unmatched' },
  );
  assert.match(url.pathname, /Common_Place\/FeatureServer\/1\/query/);
  assert.match(url.searchParams.get('where'), /Municipality_Name/);
});
test('incomplete, oversized, invalid and out-of-county results fail closed', async () => {
  for (const payload of [
    { features: roads, exceededTransferLimit: true },
    { error: 'failed' },
    {
      features: [
        road('Example AV', [
          [0, 0],
          [1, 1],
        ]),
        road('Test LN', [
          [0, 0],
          [2, 2],
        ]),
      ],
    },
  ]) {
    const resolve = createCountyLocationResolver({
      fetchImpl: async () => Response.json(payload),
    });
    assert.equal(await resolve(row), null);
  }
  const resolve = createCountyLocationResolver({
    fetchImpl: async () =>
      new Response('', { headers: { 'content-length': '3000000' } }),
  });
  assert.equal(await resolve(row), null);
});
test('failed location lookup retries after cooldown and escapes apostrophes', async () => {
  let now = 0,
    count = 0,
    where;
  const resolve = createCountyLocationResolver({
    now: () => now,
    fetchImpl: async (url) => {
      count++;
      where = new URL(url).searchParams.get('where');
      throw new Error('offline');
    },
  });
  const input = {
    location: "O'NEIL RD & TEST LN",
    municipality: 'Example Township',
  };
  await resolve(input);
  await resolve(input);
  assert.equal(count, 1);
  assert.match(where, /O''NEIL/);
  now = 300001;
  await resolve(input);
  assert.equal(count, 2);
});

const place = (name = 'SUMMIT HOUSE CONDOS', lon = -75.7) => ({
  attributes: {
    Common_Place_Name: name,
    Municipality_Name: 'Example Township',
    Primary_YN: 'Y',
    Sensitive_YN: 'N',
  },
  geometry: { x: lon, y: 40 },
});
test('county common place supplies labeled named-place precision and provenance', async () => {
  const resolve = createCountyLocationResolver({
    fetchImpl: async () => Response.json({ features: [place()] }),
  });
  const result = await resolve.resolveDetailed({
    ...row,
    location: 'SUMMIT HOUSE &',
  });
  assert.equal(result.status, 'matched');
  assert.equal(result.position.kind, 'place');
  assert.equal(result.position.matchedLocation, 'SUMMIT HOUSE CONDOS');
  assert.equal(result.position.method, 'county-common-place');
});
test('common places reject ambiguity, different municipalities and nonpublic flags', async () => {
  for (const features of [
    [place(), place('SUMMIT HOUSE APARTMENTS')],
    [place(), place('SUMMIT HOUSE CONDOS', -75.8)],
    [
      {
        ...place(),
        attributes: {
          ...place().attributes,
          Municipality_Name: 'Other Township',
        },
      },
    ],
    [{ ...place(), attributes: { ...place().attributes, Sensitive_YN: 'Y' } }],
  ]) {
    const resolve = createCountyLocationResolver({
      fetchImpl: async () => Response.json({ features }),
    });
    assert.equal(await resolve({ ...row, location: 'SUMMIT HOUSE &' }), null);
  }
});
test('documented junction alias is pair-specific and only runs after an exact miss', async () => {
  const urls = [];
  const resolve = createCountyLocationResolver({
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      const corrected = new URL(url).searchParams
        .get('where')
        .includes('VALLEY CREEK');
      return Response.json({
        features: corrected
          ? [
              road('Valley Creek RD', [node, [-75.701, 40]]),
              road('Yellow Springs RD', [node, [-75.7, 40.001]]),
            ]
          : [],
      });
    },
  });
  const input = {
    location: 'VALLEY FORGE RD & YELLOW SPRINGS RD',
    municipality: 'Tredyffrin Township',
  };
  const match = await resolve(input);
  assert.equal(match.method, 'documented-junction-alias');
  assert.equal(match.matchedLocation, 'VALLEY CREEK RD & YELLOW SPRINGS RD');
  assert.equal(urls.length, 2);
  assert.equal(
    await resolve({ ...input, municipality: 'Other Township' }),
    null,
  );
  assert.equal(urls.length, 3);
  assert.equal(
    await resolve({ ...input, location: 'VALLEY FORGE RD & OTHER RD' }),
    null,
  );
  assert.equal(urls.length, 4);
});
test('successful misses differ from transport errors; errors retry after a minute', async () => {
  let calls = 0,
    clock = 0,
    offline = true;
  const resolve = createCountyLocationResolver({
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      if (offline) throw new TypeError('network');
      return Response.json({ features: [] });
    },
  });
  assert.equal((await resolve.resolveDetailed(row)).status, 'unavailable');
  offline = false;
  clock = 59999;
  assert.equal((await resolve.resolveDetailed(row)).status, 'unavailable');
  assert.equal(calls, 1);
  clock = 60001;
  assert.equal((await resolve.resolveDetailed(row)).status, 'unmatched');
  assert.equal(calls, 2);
});
