import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadNe511SourcesFromGraphQL,
  ne511CameraToSource,
  normalizeNe511ImageUrl,
} from '../../server/providers/cctv/sources.js';
import {
  NE511_GRAPHQL_URL,
  NE511_GROUND_ELEVATION_M,
} from '../../server/providers/cctv/constants.js';

const camera = (overrides = {}) => ({
  __typename: 'Camera',
  uri: 'camera/1',
  title: 'I-80: Scale E of Lincoln',
  active: true,
  bbox: [-96.44925, 40.92796, -96.44925, 40.92796],
  views: [
    {
      uri: 'camera/1/1292639934',
      category: 'IMAGE',
      url: 'https://dot511.nebraska.gov/images/vid-001080416-00.jpg?1789376100000',
    },
  ],
  ...overrides,
});

const graphqlBody = (mapFeatures, error = null) =>
  Response.json({ data: { mapFeaturesQuery: { mapFeatures, error } } });

test('Nebraska 511 frame URLs drop the cache-buster and stay on the NDOT image host', () => {
  assert.equal(
    normalizeNe511ImageUrl(
      'https://dot511.nebraska.gov/images/vid-001080416-00.jpg?1789376100000',
    ),
    'https://dot511.nebraska.gov/images/vid-001080416-00.jpg',
  );
  // Off-host, wrong scheme, traversal and non-frame paths are all refused.
  assert.equal(normalizeNe511ImageUrl('https://evil.example/x.jpg'), '');
  assert.equal(
    normalizeNe511ImageUrl('http://dot511.nebraska.gov/images/x.jpg'),
    '',
  );
  assert.equal(
    normalizeNe511ImageUrl(
      'https://dot511.nebraska.gov/images/../secret/x.jpg',
    ),
    '',
  );
  assert.equal(
    normalizeNe511ImageUrl('https://dot511.nebraska.gov/images/index.html'),
    '',
  );
  assert.equal(normalizeNe511ImageUrl(null), '');
});

test('a Nebraska 511 camera maps to a source grouped by route', () => {
  const source = ne511CameraToSource(camera());
  assert.equal(source.id, 'ne511-1');
  assert.equal(source.name, 'I-80: Scale E of Lincoln');
  assert.equal(source.city, 'I-80');
  assert.equal(source.cityId, 'nebraska');
  assert.equal(source.provider, 'Nebraska 511');
  assert.equal(source.lat, 40.92796);
  assert.equal(source.lon, -96.44925);
  assert.equal(source.feedType, 'image');
  assert.equal(source.sourceKind, 'ne511-graphql');
  assert.equal(source.groundElevationM, NE511_GROUND_ELEVATION_M);
  assert.equal(source.url, source.snapshotUrl);
  assert.equal(
    source.url,
    'https://dot511.nebraska.gov/images/vid-001080416-00.jpg',
  );
  assert.match(source.license, /Nebraska Department of Transportation/);
});

test('positional titles never become headings', () => {
  // "E of Lincoln" says where the camera is, not where it looks, so every
  // camera declares a low-confidence fallback.
  const east = ne511CameraToSource(camera());
  const west = ne511CameraToSource(
    camera({ uri: 'camera/2', title: 'I-80: 3 Mi W of Kimball' }),
  );
  for (const source of [east, west]) {
    assert.equal(source.headingConfidence, 'low');
    assert.ok(Number.isFinite(source.headingDeg));
  }
  // Deterministic per id, and distinct so co-sited gizmos fan apart.
  assert.equal(east.headingDeg, ne511CameraToSource(camera()).headingDeg);
  assert.notEqual(east.headingDeg, west.headingDeg);
});

test('the first usable view wins on a multi-angle mast', () => {
  const source = ne511CameraToSource(
    camera({
      views: [
        { category: 'IMAGE', url: null },
        {
          category: 'IMAGE',
          url: 'https://dot511.nebraska.gov/images/vid-005080000-07.jpg?1',
        },
        {
          category: 'IMAGE',
          url: 'https://dot511.nebraska.gov/images/vid-005080000-03.jpg?1',
        },
      ],
    }),
  );
  assert.equal(
    source.url,
    'https://dot511.nebraska.gov/images/vid-005080000-07.jpg',
  );
});

test('a VIDEO view with no stream is still served as a still', () => {
  // Views marked VIDEO leave the HLS `src` empty and the `url` is a JPEG, so
  // category is advisory and the frame decides.
  const source = ne511CameraToSource(
    camera({
      views: [
        {
          category: 'VIDEO',
          url: 'https://dot511.nebraska.gov/images/vid-005071110-01.jpg?1',
          sources: [{ type: 'application/x-mpegURL', src: '' }],
        },
      ],
    }),
  );
  assert.equal(source.feedType, 'image');
  assert.equal(
    source.url,
    'https://dot511.nebraska.gov/images/vid-005071110-01.jpg',
  );
});

test('unusable Nebraska 511 features are dropped', () => {
  assert.equal(ne511CameraToSource({ __typename: 'Cluster' }), null);
  assert.equal(ne511CameraToSource(camera({ active: false })), null);
  assert.equal(ne511CameraToSource(camera({ uri: 'event/CARSx-34' })), null);
  // Out of state, null island, and no usable frame.
  assert.equal(
    ne511CameraToSource(camera({ bbox: [-122.4, 37.8, -122.4, 37.8] })),
    null,
  );
  assert.equal(ne511CameraToSource(camera({ bbox: [0, 0, 0, 0] })), null);
  assert.equal(ne511CameraToSource(camera({ views: [] })), null);
  assert.equal(
    ne511CameraToSource(
      camera({ views: [{ url: 'https://evil.example/x.jpg' }] }),
    ),
    null,
  );
});

test('the loader posts one keyless GraphQL query and refuses redirects', async (t) => {
  t.mock.method(console, 'log', () => {});
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return graphqlBody([
      camera(),
      camera({
        uri: 'camera/9',
        views: [{ url: 'https://evil.example/x.jpg' }],
      }),
    ]);
  });

  const cameras = await loadNe511SourcesFromGraphQL();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, NE511_GRAPHQL_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.ok(!('Authorization' in calls[0].init.headers));
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent.variables.input.layerSlugs, ['normalCameras']);
  // Zoom 7 collapses dense areas into Clusters carrying no camera.
  assert.ok(sent.variables.input.zoom >= 11);
  assert.deepEqual(
    cameras.map((entry) => entry.id),
    ['ne511-1'],
  );
});

test('the loader fails soft on transport, GraphQL, and query errors', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});

  const responses = [
    () => new Response('nope', { status: 503 }),
    // GraphQL reports failure in the body with HTTP 200, two different ways.
    () => Response.json({ errors: [{ message: 'Server error.' }] }),
    () => graphqlBody(null, { message: 'bad bbox', type: 'INPUT' }),
    () => {
      throw new Error('network down');
    },
  ];
  for (const respond of responses) {
    t.mock.method(globalThis, 'fetch', async () => respond());
    assert.deepEqual(await loadNe511SourcesFromGraphQL(), []);
    t.mock.restoreAll();
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'log', () => {});
  }
});

test('CCTV_NE511_MAX_SOURCES bounds the pack', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async () =>
    graphqlBody([
      camera(),
      camera({
        uri: 'camera/2',
        title: 'I-80: Sidney Exit',
        bbox: [-102.9783, 41.1428, -102.9783, 41.1428],
        views: [
          {
            category: 'IMAGE',
            url: 'https://dot511.nebraska.gov/images/vid-005080100-00.jpg?1',
          },
        ],
      }),
    ]),
  );
  const previous = process.env.CCTV_NE511_MAX_SOURCES;
  process.env.CCTV_NE511_MAX_SOURCES = '8'; // floor: the loader clamps to >= 8
  try {
    const cameras = await loadNe511SourcesFromGraphQL();
    assert.equal(cameras.length, 2);
    // Each camera is its own nearest anchor, so both survive.
    assert.deepEqual(
      [...new Set(cameras.map((entry) => entry.cityId))],
      ['nebraska'],
    );
  } finally {
    if (previous === undefined) delete process.env.CCTV_NE511_MAX_SOURCES;
    else process.env.CCTV_NE511_MAX_SOURCES = previous;
  }
});
