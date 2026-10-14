import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadNycSourcesFromOpenData,
  nycCameraIsOnline,
  nycCameraName,
  nycCameraToSource,
} from '../../server/providers/cctv/sources.js';
import {
  DEFAULT_CCTV_MAX_SOURCES,
  DEFAULT_NYC_MAX_SOURCES,
  NYC_CAMERAS_URL,
  NYC_GROUND_ELEVATION_M,
  NYC_IMAGE_ORIGIN,
  NYC_IMAGE_URL,
  NYC_MAX_CATALOG_BYTES,
} from '../../server/providers/cctv/constants.js';
import {
  CAMERA_CODE_MAX_CHARS,
  isLikelyNycCoordinate,
} from '../../server/providers/cctv/normalize.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

/**
 * A response whose body is a live stream, plus a flag that flips when the
 * stream is cancelled. A rejection path that returns without cancelling holds
 * the transport open, so the flag is what the refusal tests actually assert.
 */
const streamingResponse = (init = {}) => {
  const state = { cancelled: false };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('['));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, init), state };
};

const MIDTOWN_ID = '8a6bc417-4877-4ebe-8052-88c1b261baf1';
const BROOKLYN_ID = '11111111-2222-3333-4444-555555555555';

/** One TMC camera row, shaped like the live `webcams.nyctmc.org` payload. */
const row = (overrides = {}) => ({
  id: MIDTOWN_ID,
  name: 'Central Park West @ 86 St',
  latitude: 40.785302,
  longitude: -73.969353,
  area: 'Manhattan',
  isOnline: 'true',
  imageUrl: NYC_IMAGE_URL(MIDTOWN_ID),
  ...overrides,
});

test('a NYC row maps to a source on the pinned HTTPS frame host', () => {
  const source = nycCameraToSource(row());
  assert.equal(source.id, `nyc-${MIDTOWN_ID}`);
  assert.equal(source.name, 'Central Park West @ 86 St');
  assert.equal(source.city, 'Manhattan');
  assert.equal(source.cityId, 'nyc');
  assert.equal(source.provider, 'NYC DOT Traffic Management Center');
  assert.equal(source.lat, 40.785302);
  assert.equal(source.lon, -73.969353);
  assert.equal(source.feedType, 'image');
  assert.equal(source.sourceKind, 'nyc-dot-tmc');
  assert.equal(
    source.license,
    'Public NYC DOT Traffic Management Center traffic camera',
  );
  assert.equal(source.groundElevationM, NYC_GROUND_ELEVATION_M);
  assert.equal(source.url, NYC_IMAGE_URL(MIDTOWN_ID));
  assert.equal(source.url, source.snapshotUrl);
  assert.ok(source.url.startsWith(NYC_IMAGE_ORIGIN));
  assert.equal(source.headingConfidence, 'low');
  assert.ok(Number.isFinite(source.headingDeg));
});

test('frame URLs are synthesized from the UUID; the payload URL is ignored', () => {
  const source = nycCameraToSource(
    row({ imageUrl: 'https://evil.example/cameras/x/image' }),
  );
  assert.equal(source.url, NYC_IMAGE_URL(MIDTOWN_ID));
  assert.equal(source.snapshotUrl, source.url);
});

test('offline cameras, off-city geometry and unusable ids are dropped', () => {
  assert.equal(nycCameraToSource(row({ isOnline: 'false' })), null);
  assert.equal(nycCameraToSource(row({ isOnline: false })), null);
  assert.equal(
    nycCameraToSource(row({ isOnline: 'TRUE' })).id,
    `nyc-${MIDTOWN_ID}`,
  );
  assert.equal(
    nycCameraToSource(row({ isOnline: true })).id,
    `nyc-${MIDTOWN_ID}`,
  );
  // Austin: a plausible lat/lon, but not a New York camera.
  assert.equal(
    nycCameraToSource(row({ latitude: 30.2672, longitude: -97.7431 })),
    null,
  );
  assert.equal(nycCameraToSource(row({ latitude: 0, longitude: 0 })), null);
  assert.equal(nycCameraToSource(row({ id: '../etc/passwd' })), null);
  assert.equal(nycCameraToSource(row({ id: 'not-a-uuid' })), null);
  assert.equal(nycCameraToSource(row({ id: `${MIDTOWN_ID}/../x` })), null);
  assert.equal(nycCameraToSource(null), null);
});

test('ids lower-case the UUID and unknown boroughs fall back to New York', () => {
  const mixed = nycCameraToSource(
    row({ id: MIDTOWN_ID.toUpperCase(), area: 'Long Island' }),
  );
  assert.equal(mixed.id, `nyc-${MIDTOWN_ID}`);
  assert.equal(mixed.city, 'New York');
  assert.equal(
    mixed.url,
    NYC_IMAGE_URL(MIDTOWN_ID.toUpperCase()),
    'the registered frame path keeps the catalog UUID spelling',
  );
});

test('a nameless row still gets a label', () => {
  assert.equal(
    nycCameraName({ name: '  FDR Drive @ 23 St ' }, 'nyc-x'),
    'FDR Drive @ 23 St',
  );
  assert.equal(nycCameraName({}, `nyc-${MIDTOWN_ID}`), 'NYC Camera 8a6bc417');
  assert.equal(nycCameraIsOnline('true'), true);
  assert.equal(nycCameraIsOnline('false'), false);
});

test('the unselected label is the intersection, trimmed to the code width', () => {
  assert.equal(nycCameraToSource(row()).code, 'CENTRAL PARK WEST @ 86 ST');
  const long = nycCameraToSource(
    row({
      name: 'Brooklyn Queens Expressway @ Atlantic Avenue / Flatbush Avenue Extension',
    }),
  );
  assert.ok(long.code.length <= CAMERA_CODE_MAX_CHARS);
  assert.ok(long.code.endsWith('…'));
  assert.ok(long.code.startsWith('BROOKLYN'));
});

test('the loader reads the keyless catalog and collapses duplicate ids', async (t) => {
  t.mock.method(console, 'log', () => {});
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requested.push([String(url), init.redirect]);
    return Response.json([
      row({ latitude: 40.758, longitude: -73.9855 }),
      row({
        name: 'Central Park West @ 86 St (duplicate)',
        latitude: 40.758,
        longitude: -73.9855,
      }),
      row({
        id: BROOKLYN_ID,
        name: 'Atlantic Ave @ Flatbush Ave',
        latitude: 40.65,
        longitude: -73.96,
        area: 'Brooklyn',
        imageUrl: NYC_IMAGE_URL(BROOKLYN_ID),
      }),
      row({ isOnline: 'false', name: 'Offline camera' }),
      row({ id: 'https://evil.example/x' }),
    ]);
  });
  const cameras = await loadNycSourcesFromOpenData();
  assert.deepEqual(requested, [[NYC_CAMERAS_URL, 'manual']]);
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    // Nearest to a borough anchor first: the Times Square camera before Brooklyn.
    [`nyc-${MIDTOWN_ID}`, `nyc-${BROOKLYN_ID}`],
  );
  assert.equal(cameras[0].name, 'Central Park West @ 86 St');
  assert.equal(cameras[1].city, 'Brooklyn');
});

test('an upstream failure yields an empty pack and releases the response', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const failed = streamingResponse({ status: 503 });
  t.mock.method(globalThis, 'fetch', async () => failed.response);
  assert.deepEqual(await loadNycSourcesFromOpenData(), []);
  assert.equal(failed.state.cancelled, true, 'the failed body is cancelled');

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down');
  });
  assert.deepEqual(await loadNycSourcesFromOpenData(), []);
});

test('the catalog fetch refuses redirects and oversized bodies', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const seen = [];
  const redirected = streamingResponse({
    status: 302,
    headers: { location: 'https://evil.example/cameras.json' },
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push([String(url), init.redirect]);
    return redirected.response;
  });
  assert.deepEqual(await loadNycSourcesFromOpenData(), []);
  assert.deepEqual(seen, [[NYC_CAMERAS_URL, 'manual']]);
  assert.equal(
    redirected.state.cancelled,
    true,
    'the redirect body is cancelled',
  );

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    const body = JSON.stringify([row()]);
    return new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        'content-length': String(NYC_MAX_CATALOG_BYTES + 1),
      },
    });
  });
  assert.deepEqual(await loadNycSourcesFromOpenData(), []);

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    const oversized = 'x'.repeat(NYC_MAX_CATALOG_BYTES + 1024);
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
  assert.deepEqual(await loadNycSourcesFromOpenData(), []);
});

test('a reduced pack cap keeps cameras nearest the borough anchors', async (t) => {
  t.mock.method(console, 'log', () => {});
  const saved = process.env.CCTV_NYC_MAX_SOURCES;
  t.after(() => {
    if (saved === undefined) delete process.env.CCTV_NYC_MAX_SOURCES;
    else process.env.CCTV_NYC_MAX_SOURCES = saved;
  });
  process.env.CCTV_NYC_MAX_SOURCES = '8';
  const rows = [
    // Far southern Staten Island, listed first so only distance can keep them.
    ...[40.5, 40.505, 40.51, 40.515, 40.52, 40.525].map((lat, i) =>
      row({
        id: `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, '0')}`,
        latitude: lat,
        longitude: -74.24,
        area: 'Staten Island',
        name: `SI ${i}`,
      }),
    ),
    ...[40.758, 40.757, 40.756, 40.755, 40.754, 40.753].map((lat, i) =>
      row({
        id: `bbbbbbbb-cccc-dddd-eeee-${String(i).padStart(12, '0')}`,
        latitude: lat,
        longitude: -73.9855,
        area: 'Manhattan',
        name: `Midtown ${i}`,
      }),
    ),
  ];
  t.mock.method(globalThis, 'fetch', async () => Response.json(rows));
  const cameras = await loadNycSourcesFromOpenData();
  assert.equal(cameras.length, 8);
  assert.deepEqual(
    cameras.map((camera) => camera.city),
    [
      'Manhattan',
      'Manhattan',
      'Manhattan',
      'Manhattan',
      'Manhattan',
      'Manhattan',
      'Staten Island',
      'Staten Island',
    ],
    'Midtown fills first; the Staten Island anchor still keeps a share',
  );
});

/**
 * Serve the NYC catalog to the NYC endpoint and an empty payload to every
 * other pack, so one catalog refresh exercises the registration without
 * reaching the network.
 */
const runCatalogWithMockedUpstreams = async (t) => {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    if (href === NYC_CAMERAS_URL) {
      return Response.json([
        row({ latitude: 40.758, longitude: -73.9855 }),
        row({
          id: BROOKLYN_ID,
          name: 'Atlantic Ave @ Flatbush Ave',
          latitude: 40.65,
          longitude: -73.96,
          area: 'Brooklyn',
        }),
      ]);
    }
    return Response.json([]);
  });
  const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
  return { requested, sources };
};

/** Run one catalog refresh with CCTV_NYC_ENABLED set to `flag` (undefined
 * leaves it unset), restoring the environment afterwards. */
const runCatalogWithNycFlag = async (t, flag) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    if (flag === undefined) delete process.env.CCTV_NYC_ENABLED;
    else process.env.CCTV_NYC_ENABLED = flag;
    return await runCatalogWithMockedUpstreams(t);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
};

test('CCTV_NYC_ENABLED=1 wires the NYC lane into the catalog', async (t) => {
  const { requested, sources } = await runCatalogWithNycFlag(t, '1');
  assert.ok(
    requested.includes(NYC_CAMERAS_URL),
    'the catalog refresh invokes the NYC loader',
  );
  assert.deepEqual(
    sources.filter((s) => s.cityId === 'nyc').map((s) => s.id),
    [`nyc-${MIDTOWN_ID}`, `nyc-${BROOKLYN_ID}`],
    'NYC cameras reach the served catalog through the registered lane',
  );
});

// NYC DOT requires a data-sharing agreement for this feed, so an install that
// has not opted in must never contact it.
for (const [label, flag] of [
  ['an unset CCTV_NYC_ENABLED', undefined],
  ['an empty CCTV_NYC_ENABLED', ''],
  ['CCTV_NYC_ENABLED=0', '0'],
  ['CCTV_NYC_ENABLED=true', 'true'],
]) {
  test(`${label} makes no NYC request`, async (t) => {
    const { requested, sources } = await runCatalogWithNycFlag(t, flag);
    assert.ok(requested.length > 0, 'the other packs still refreshed');
    assert.equal(
      requested.some((href) => href.includes('nyctmc.org')),
      false,
      'the lane never reaches its upstream',
    );
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'nyc'),
      [],
    );
  });
}

test('the shipped catalog ceiling is not raised to make room for this pack', () => {
  assert.equal(DEFAULT_CCTV_MAX_SOURCES, 4000);
  assert.equal(DEFAULT_NYC_MAX_SOURCES, 250);
});

test('isLikelyNycCoordinate spans the five boroughs and rejects the rest', () => {
  assert.equal(isLikelyNycCoordinate(40.758, -73.9855), true); // Times Square
  assert.equal(isLikelyNycCoordinate(40.5795, -74.1502), true); // Staten Island
  assert.equal(isLikelyNycCoordinate(40.8448, -73.8648), true); // Bronx
  assert.equal(isLikelyNycCoordinate(40.5077, -74.2304), true); // southern SI slack
  assert.equal(isLikelyNycCoordinate(30.2672, -97.7431), false); // Austin
  assert.equal(isLikelyNycCoordinate(0, 0), false);
  assert.equal(isLikelyNycCoordinate(NaN, -73.98), false);
});
