import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  coloradoCameraId,
  coloradoCameraName,
  coloradoFeatureToSources,
  loadColoradoSourcesFromOpenData,
  normalizeColoradoImageUrl,
} from '../../server/providers/cctv/sources.js';
import {
  COLORADO_IMAGE_ORIGIN,
  COLORADO_MAX_CATALOG_BYTES,
  DEFAULT_COLORADO_ROWS_URL,
  DEFAULT_CCTV_MAX_SOURCES,
} from '../../server/providers/cctv/constants.js';
import { CAMERA_CODE_MAX_CHARS } from '../../server/providers/cctv/normalize.js';
import { allocateSourceCap } from '../../server/providers/cctv/cap.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import { directionToHeading } from './directionText.js';

/**
 * A response whose body is a live stream, plus a flag that flips when the
 * stream is cancelled. A rejection path that returns without cancelling holds
 * the transport open, so the flag is what the refusal tests actually assert.
 */
const streamingResponse = (init = {}) => {
  const state = { cancelled: false };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, init), state };
};

/** One COtrip GeoJSON feature, shaped like the live `/cameras/map-features`
 * payload: a `WMP` view streams HLS and carries its still separately. */
const feature = (overrides = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-104.99332, 39.753423] },
  properties: {
    type: 'cameras',
    id: 12986,
    name: 'I-25 MP 212.10 NB at 20th St',
    public: true,
    route: 'I-25',
    cameraOwner: 'Colorado DOT',
    views: [
      {
        name: 'I-25 MP 212.10 NB at 20th St',
        type: 'WMP',
        url: 'https://publicstreamer2.cotrip.org:443/rtplive/025N21210CAM1SEC/playlist.m3u8',
        videoPreviewUrl:
          'https://cocam.carsprogram.org/Snapshots/025N21210CAM1SEC.flv.png',
        broken: false,
      },
    ],
    ...(overrides.properties || {}),
  },
  ...(overrides.geometry ? { geometry: overrides.geometry } : {}),
});

/** A `STILL_IMAGE` view: no preview, the still is the `url` itself. */
const stillFeature = () =>
  feature({
    properties: {
      name: 'I-70 MP 192.10 WB : Vail Pass',
      public: true,
      cameraOwner: 'Colorado DOT',
      views: [
        {
          name: 'I-70 MP 192.10 WB : Vail Pass',
          type: 'STILL_IMAGE',
          url: 'https://cocam.carsprogram.org/Snapshots/070W19210CAM1ML2.flv.png',
          broken: false,
        },
      ],
    },
  });

test('a WMP feature maps to a source on the pinned still host, not its stream', () => {
  const [source] = coloradoFeatureToSources(feature());
  assert.equal(source.id, 'colorado-025n21210cam1sec');
  assert.equal(source.name, 'I-25 MP 212.10 NB at 20th St');
  assert.equal(source.cityId, 'colorado');
  assert.equal(source.provider, 'Colorado DOT');
  assert.equal(source.lat, 39.753423);
  assert.equal(source.lon, -104.99332);
  assert.equal(source.feedType, 'image');
  assert.equal(source.sourceKind, 'colorado-cotrip');
  assert.equal(
    source.license,
    'Colorado Department of Transportation / COtrip public feed',
  );
  // The HLS playlist must never reach an image pipeline.
  assert.ok(!source.url.includes('.m3u8'));
  assert.equal(
    source.url,
    'https://cocam.carsprogram.org/Snapshots/025N21210CAM1SEC.flv.png',
  );
  assert.equal(source.url, source.snapshotUrl);
  assert.ok(source.url.startsWith(COLORADO_IMAGE_ORIGIN));
});

test('a STILL_IMAGE view registers its own url as the frame', () => {
  const [source] = coloradoFeatureToSources(stillFeature());
  assert.equal(source.id, 'colorado-070w19210cam1ml2');
  assert.equal(
    source.url,
    'https://cocam.carsprogram.org/Snapshots/070W19210CAM1ML2.flv.png',
  );
});

test('every view of a multi-view feature becomes its own camera', () => {
  const sources = coloradoFeatureToSources(
    feature({
      properties: {
        name: 'I-25 MP 212.10',
        public: true,
        views: [
          {
            name: 'I-25 MP 212.10 NB',
            type: 'STILL_IMAGE',
            url: 'https://cocam.carsprogram.org/Snapshots/025N21210CAM1SEC.flv.png',
          },
          {
            name: 'I-25 MP 212.10 SB',
            type: 'STILL_IMAGE',
            url: 'https://cocam.carsprogram.org/Snapshots/025S21210CAM2SEC.flv.png',
          },
        ],
      },
    }),
  );
  // Keying on the feature id would collapse these two into one camera.
  assert.deepEqual(
    sources.map((s) => s.id),
    ['colorado-025n21210cam1sec', 'colorado-025s21210cam2sec'],
  );
  assert.deepEqual(
    sources.map((s) => s.name),
    ['I-25 MP 212.10 NB', 'I-25 MP 212.10 SB'],
  );
});

test('no heading is derived from the roadway direction in the name', () => {
  // "NB"/"WB" parses as a confident bearing and would be wrong for most
  // cameras: it is the direction of the ROAD being watched, not the camera's
  // facing. Nobody may "fix" this by wiring the name or route up.
  assert.equal(directionToHeading('NB', true), 0);
  assert.equal(directionToHeading('WB', true), 270);

  for (const name of ['I-25 NB at 20th', 'I-70 WB Vail', 'US-6 EB', 'SH-2 SB']) {
    const [source] = coloradoFeatureToSources(
      feature({
        properties: {
          name,
          public: true,
          views: [
            {
              name,
              type: 'STILL_IMAGE',
              url: 'https://cocam.carsprogram.org/Snapshots/025N21210CAM1SEC.flv.png',
            },
          ],
        },
      }),
    );
    assert.equal(source.headingConfidence, 'low');
    assert.ok(Number.isFinite(source.headingDeg));
    // Same id, same fallback heading, whatever the direction token says.
    assert.equal(source.headingDeg, coloradoFeatureToSources(feature())[0].headingDeg);
  }
});

test('non-public, broken, off-state and off-host records are dropped', () => {
  // A camera the feed marks private stays out of the catalog.
  assert.deepEqual(
    coloradoFeatureToSources(feature({ properties: { public: false } })),
    [],
  );
  // Salt Lake City: a plausible lat/lon, but not a Colorado camera.
  assert.deepEqual(
    coloradoFeatureToSources(
      feature({ geometry: { type: 'Point', coordinates: [-111.891, 40.7608] } }),
    ),
    [],
  );
  // Null island, and unusable geometry.
  assert.deepEqual(
    coloradoFeatureToSources(
      feature({ geometry: { type: 'Point', coordinates: [0, 0] } }),
    ),
    [],
  );
  assert.deepEqual(
    coloradoFeatureToSources(
      feature({ geometry: { type: 'Point', coordinates: [-104.99] } }),
    ),
    [],
  );

  const withView = (view) =>
    coloradoFeatureToSources(
      feature({ properties: { public: true, views: [view] } }),
    );
  // A view the feed itself flags as broken is not registered.
  assert.deepEqual(
    withView({
      type: 'STILL_IMAGE',
      url: 'https://cocam.carsprogram.org/Snapshots/x.flv.png',
      broken: true,
    }),
    [],
  );
  // A catalog edit cannot steer the frame proxy off the CARS host.
  assert.deepEqual(
    withView({ type: 'STILL_IMAGE', url: 'https://evil.example/x.png' }),
    [],
  );
  assert.deepEqual(
    withView({
      type: 'STILL_IMAGE',
      url: 'https://cocam.carsprogram.org.evil.test/x.png',
    }),
    [],
  );
  assert.deepEqual(
    withView({ type: 'STILL_IMAGE', url: 'file:///etc/passwd' }),
    [],
  );
  // A WMP view with only a stream and no still has no frame to register.
  assert.deepEqual(
    withView({
      type: 'WMP',
      url: 'https://publicstreamer2.cotrip.org/rtplive/x/playlist.m3u8',
    }),
    [],
  );
  assert.deepEqual(coloradoFeatureToSources(null), []);
  assert.deepEqual(coloradoFeatureToSources({ properties: null }), []);
});

test('frame URLs upgrade to HTTPS and ids stay stable', () => {
  assert.equal(
    normalizeColoradoImageUrl({
      url: 'http://cocam.carsprogram.org/Snapshots/A1.flv.png',
    }),
    'https://cocam.carsprogram.org/Snapshots/A1.flv.png',
  );
  // The preview wins over the stream url, whichever order they appear in.
  assert.equal(
    normalizeColoradoImageUrl({
      url: 'https://publicstreamer2.cotrip.org/rtplive/A1/playlist.m3u8',
      videoPreviewUrl: 'https://cocam.carsprogram.org/Snapshots/A1.flv.png',
    }),
    'https://cocam.carsprogram.org/Snapshots/A1.flv.png',
  );
  assert.equal(normalizeColoradoImageUrl({}), null);
  assert.equal(normalizeColoradoImageUrl({ url: 'not a url' }), null);
  assert.equal(normalizeColoradoImageUrl(null), null);

  // The full ".flv.png" double extension is stripped, leaving CDOT's code.
  assert.equal(
    coloradoCameraId('https://cocam.carsprogram.org/Snapshots/025N21210CAM1SEC.flv.png'),
    'colorado-025n21210cam1sec',
  );
  // A filename-scheme change degrades to a still-stable slug, not a dropped camera.
  assert.equal(
    coloradoCameraId('https://cocam.carsprogram.org/Snapshots/us6_clear_creek.jpg'),
    'colorado-us6-clear-creek',
  );
  assert.equal(coloradoCameraId(''), null);
});

test('a nameless view still gets a label', () => {
  assert.equal(
    coloradoCameraName({ properties: { name: 'Feature name' } }, { name: '  View name ' }, 'colorado-a1'),
    'View name',
  );
  assert.equal(
    coloradoCameraName({ properties: { name: 'Feature name' } }, {}, 'colorado-a1'),
    'Feature name',
  );
  assert.equal(
    coloradoCameraName({}, {}, 'colorado-a1'),
    'Colorado Camera a1',
  );
});

test('the loader reads the keyless feed and collapses duplicate ids', async (t) => {
  t.mock.method(console, 'log', () => {});
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json({
      features: [
        feature(),
        // The same frame file twice: one camera, not two.
        feature({ properties: { name: 'I-25 MP 212.10 NB (duplicate)' } }),
        // Grand Junction: far from both anchors, so it sorts last.
        feature({
          geometry: { type: 'Point', coordinates: [-108.5506, 39.0639] },
          properties: {
            name: 'I-70 MP 026 WB Grand Junction',
            public: true,
            views: [
              {
                name: 'I-70 MP 026 WB Grand Junction',
                type: 'STILL_IMAGE',
                url: 'https://cocam.carsprogram.org/Snapshots/070W02600CAM1ML2.flv.png',
              },
            ],
          },
        }),
        feature({
          properties: {
            public: true,
            views: [{ type: 'STILL_IMAGE', url: 'https://evil.example/x.png' }],
          },
        }),
      ],
    });
  });
  const cameras = await loadColoradoSourcesFromOpenData();
  assert.deepEqual(requested, [DEFAULT_COLORADO_ROWS_URL]);
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    // Nearest a Front Range anchor first: Denver before Grand Junction.
    ['colorado-025n21210cam1sec', 'colorado-070w02600cam1ml2'],
  );
});

test('an upstream failure yields an empty pack and releases the response', async (t) => {
  t.mock.method(console, 'warn', () => {});
  // A 503 can still arrive with a streaming body; returning without cancelling
  // it would hold the connection until the socket times out.
  const failed = streamingResponse({ status: 503 });
  t.mock.method(globalThis, 'fetch', async () => failed.response);
  assert.deepEqual(await loadColoradoSourcesFromOpenData(), []);
  assert.equal(failed.state.cancelled, true, 'the failed body is cancelled');

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down');
  });
  assert.deepEqual(await loadColoradoSourcesFromOpenData(), []);
});

test('a payload that is not a feature collection yields nothing', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async () =>
    // The bare health-check body this host answers unrecognised paths with.
    Response.json({ healthy: true }),
  );
  assert.deepEqual(await loadColoradoSourcesFromOpenData(), []);
});

test('the unselected label is the camera name, trimmed to the code width', () => {
  const long = coloradoFeatureToSources(
    feature({
      properties: {
        public: true,
        views: [
          {
            name: 'I-70 MP 192.10 WB : 1.8 miles East of Vail Pass Summit',
            type: 'STILL_IMAGE',
            url: 'https://cocam.carsprogram.org/Snapshots/070W19210CAM1ML2.flv.png',
          },
        ],
      },
    }),
  )[0];
  assert.equal(long.code.length, CAMERA_CODE_MAX_CHARS);
  assert.ok(long.code.endsWith('…'));
  assert.ok(long.code.startsWith('I-70 MP 192.10'));
});

test('the catalog fetch refuses redirects and oversized bodies', async (t) => {
  t.mock.method(console, 'warn', () => {});
  // A redirect is never followed: the list host cannot be steered. Its body is
  // a live stream, so the test also proves the refusal releases the transport.
  const seen = [];
  const redirected = streamingResponse({
    status: 302,
    headers: { location: 'https://evil.example/cameras.json' },
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push([String(url), init.redirect]);
    return redirected.response;
  });
  assert.deepEqual(await loadColoradoSourcesFromOpenData(), []);
  assert.deepEqual(seen, [[DEFAULT_COLORADO_ROWS_URL, 'manual']]);
  assert.equal(
    redirected.state.cancelled,
    true,
    'the redirect body is cancelled',
  );

  // A body over the cap is refused rather than buffered.
  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ features: [feature()] }), {
      headers: {
        'Content-Type': 'application/json',
        'content-length': String(COLORADO_MAX_CATALOG_BYTES + 1),
      },
    }),
  );
  assert.deepEqual(await loadColoradoSourcesFromOpenData(), []);

  // So is a body that only declares its size once it is already too long.
  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    const oversized = 'x'.repeat(COLORADO_MAX_CATALOG_BYTES + 1024);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversized));
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  });
  assert.deepEqual(await loadColoradoSourcesFromOpenData(), []);
});

test('a reduced catalog cap thins every pack instead of dropping Colorado', () => {
  // Colorado merges last in LIVE_PACKS, so a positional slice would delete it
  // outright. The round-robin allocation must give it its share.
  const lane = (name, count) => ({
    name,
    sources: Array.from({ length: count }, (_, i) => ({ id: `${name}-${i}` })),
  });
  const { sources, packs } = allocateSourceCap(
    [lane('austin', 250), lane('calgary', 215), lane('colorado', 300)],
    30,
  );
  assert.equal(sources.length, 30);
  assert.deepEqual(
    packs.map((p) => [p.name, p.kept]),
    [
      ['austin', 10],
      ['calgary', 10],
      ['colorado', 10],
    ],
  );
  // Colorado contributes its own highest-priority cameras, in its own order.
  assert.deepEqual(
    sources.filter((s) => s.id.startsWith('colorado-')).map((s) => s.id),
    Array.from({ length: 10 }, (_, i) => `colorado-${i}`),
  );
});

/**
 * Serve the Colorado feed to the Colorado endpoint and an empty payload to
 * every other pack, so one catalog refresh exercises the registration without
 * reaching the network. Returns the URLs that were requested.
 */
const runCatalogWithMockedUpstreams = async (t) => {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    if (href.startsWith('https://api-511x-co.carsprogram.org/')) {
      return Response.json({ features: [feature(), stillFeature()] });
    }
    return Response.json([]);
  });
  // A source root with no curated catalogs or ground-height sidecar, so the
  // file-based packs contribute nothing and only the live lanes are in play.
  const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
  return { requested, sources };
};

test('the Colorado lane is wired into the catalog and its loader runs', async (t) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    delete process.env.CCTV_COLORADO_ENABLED;
    const { requested, sources } = await runCatalogWithMockedUpstreams(t);
    assert.ok(
      requested.includes(DEFAULT_COLORADO_ROWS_URL),
      'the catalog refresh invokes the Colorado loader',
    );
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'colorado').map((s) => s.id),
      ['colorado-025n21210cam1sec', 'colorado-070w19210cam1ml2'],
      'Colorado cameras reach the served catalog through the registered lane',
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

test('CCTV_COLORADO_ENABLED=0 keeps the lane from being loaded at all', async (t) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    process.env.CCTV_COLORADO_ENABLED = '0';
    const { requested, sources } = await runCatalogWithMockedUpstreams(t);
    assert.equal(
      requested.includes(DEFAULT_COLORADO_ROWS_URL),
      false,
      'the disabled lane never reaches its upstream',
    );
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'colorado'),
      [],
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

test('the shipped catalog ceiling is not raised to make room for this pack', () => {
  assert.equal(DEFAULT_CCTV_MAX_SOURCES, 4000);
});
