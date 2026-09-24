import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  floridaCameraId,
  floridaCameraToSource,
  loadFloridaSourcesFromOpenData,
} from '../../server/providers/cctv/sources.js';
import {
  FLORIDA_CCTV_URL,
  FLORIDA_MAX_CATALOG_BYTES,
} from '../../server/providers/cctv/constants.js';
import {
  fallbackHeadingFromId,
  isLikelyFloridaCoordinate,
} from '../../server/providers/cctv/normalize.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

const IMAGE_HOST = 'https://images-dis.divas.cloud/DGI/';

/** A response with a live body, plus a flag that flips when it is cancelled. */
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

/** One FL511 feature, shaped like the live FeatureServer payload. */
const feature = (overrides = {}) => ({
  attributes: {
    OBJECTID_1: 6,
    ID: '1220',
    DESCRIPT: 'I-75 @ MM 346.5 SB',
    COUNTY: 'Marion',
    HIGHWAY: 'I-75',
    DIRECTION: 'S',
    LATITUDE: 29.107363,
    LONGITUDE: -82.188334,
    IMAGE: `${IMAGE_HOST}chan-9431_h.jpg`,
    ...overrides,
  },
});

/** One catalog page of `count` distinct cameras, channels from `start`. */
const page = (start, count, extra = {}) => ({
  features: Array.from({ length: count }, (_, i) =>
    feature({ IMAGE: `${IMAGE_HOST}chan-${start + i}_h.jpg` }),
  ),
  ...extra,
});

const offsetOf = (url) =>
  Number(new URL(String(url)).searchParams.get('resultOffset'));

/** Lift the pack cap for one test so every loaded camera comes back. */
const uncapped = (t) => {
  const previous = process.env.CCTV_FLORIDA_MAX_SOURCES;
  process.env.CCTV_FLORIDA_MAX_SOURCES = '4200';
  t.after(() => {
    if (previous === undefined) delete process.env.CCTV_FLORIDA_MAX_SOURCES;
    else process.env.CCTV_FLORIDA_MAX_SOURCES = previous;
  });
};

test('an FL511 feature maps to a source on a pinned HTTPS frame host', () => {
  const source = floridaCameraToSource(feature());
  assert.equal(source.id, 'fl-9431');
  assert.equal(source.name, 'I-75 @ MM 346.5 SB');
  assert.equal(source.city, 'Marion County');
  assert.equal(source.cityId, 'florida');
  assert.equal(source.provider, 'FL511');
  assert.equal(source.lat, 29.107363);
  assert.equal(source.lon, -82.188334);
  assert.equal(source.headingDeg, 180);
  assert.equal(floridaCameraToSource(feature({ DIRECTION: 'E' })).headingDeg, 90);
  assert.equal(source.headingConfidence, 'high');
  assert.equal(source.feedType, 'image');
  assert.equal(source.url, `${IMAGE_HOST}chan-9431_h.jpg`);
  assert.equal(source.url, source.snapshotUrl);
  assert.equal(source.sourceKind, 'fl511-open-data');
  assert.match(source.license, /non-commercial/);
});

test('NOT DIRECTIONAL takes the id-hash fallback at low confidence', () => {
  const source = floridaCameraToSource(
    feature({ DIRECTION: 'NOT DIRECTIONAL' }),
  );
  assert.equal(source.headingConfidence, 'low');
  assert.equal(source.headingDeg, fallbackHeadingFromId('fl-9431'));
});

test('rows outside Florida, off-host frames and unusable rows are dropped', () => {
  const dropped = [
    feature({ LATITUDE: 33.749, LONGITUDE: -84.388 }), // Atlanta
    feature({ LATITUDE: 0, LONGITUDE: 0 }),
    feature({ LATITUDE: -82.188334, LONGITUDE: 29.107363 }), // swapped
    feature({ LATITUDE: '', LONGITUDE: '' }),
    feature({ IMAGE: 'https://evil.example/DGI/chan-9431_h.jpg' }),
    feature({ IMAGE: 'http://images-dis.divas.cloud/DGI/chan-9431_h.jpg' }),
    feature({
      IMAGE: 'https://user:pass@images-dis.divas.cloud/DGI/chan-9431_h.jpg',
    }),
    feature({ IMAGE: 'not a url' }),
    { attributes: null },
    null,
  ];
  for (const row of dropped) assert.equal(floridaCameraToSource(row), null);
});

test('camera ids come from the image channel, not the repeating ID column', () => {
  // FL511 reuses ID across regions: 1220 is both an I-75 and an I-95 camera.
  const marion = floridaCameraToSource(feature());
  const broward = floridaCameraToSource(
    feature({
      DESCRIPT: 'I-95 SB before E Cypress Rd',
      COUNTY: 'Broward',
      LATITUDE: 26.22006,
      LONGITUDE: -80.13676,
      IMAGE: `${IMAGE_HOST}chan-6351_h.jpg`,
    }),
  );
  assert.equal(marion.id, 'fl-9431');
  assert.equal(broward.id, 'fl-6351');
  // Any resolution suffix keys the same way.
  assert.equal(floridaCameraId(`${IMAGE_HOST}chan-77_l.jpg`), 'fl-77');
  // A filename without a channel falls back to a stable path slug.
  assert.equal(
    floridaCameraId('https://snapshots.divas.cloud/US-1%20at%20SR-5.jpg'),
    'fl-us-1-20at-20sr-5',
  );
  assert.equal(floridaCameraId('not a url'), null);
});

test('isLikelyFloridaCoordinate spans the state and rejects the rest', () => {
  const inside = [
    [24.5551, -81.78], // Key West
    [30.4213, -87.2169], // Pensacola
    [30.99, -84.0], // Georgia line
    [25.7617, -80.1918], // Miami
  ];
  const outside = [
    [33.749, -84.388], // Atlanta
    [25.0443, -77.3504], // Nassau
    [0, 0],
    [-81.78, 24.5551], // swapped
    [NaN, -81],
  ];
  for (const [lat, lon] of inside)
    assert.equal(isLikelyFloridaCoordinate(lat, lon), true);
  for (const [lat, lon] of outside)
    assert.equal(isLikelyFloridaCoordinate(lat, lon), false);
});

test('the loader pages until a short page and collapses repeated rows', async (t) => {
  t.mock.method(console, 'log', () => {});
  uncapped(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.ok(String(url).startsWith(FLORIDA_CCTV_URL));
    calls.push([offsetOf(url), init.redirect]);
    if (offsetOf(url) === 0)
      return Response.json(page(0, 2000, { exceededTransferLimit: true }));
    // Short last page: two new cameras and a repeat of one already read.
    return Response.json(page(1999, 3));
  });
  const cameras = await loadFloridaSourcesFromOpenData();
  assert.deepEqual(calls, [
    [0, 'manual'],
    [2000, 'manual'],
  ]);
  assert.equal(cameras.length, 2002);
  assert.equal(new Set(cameras.map((camera) => camera.id)).size, 2002);
});

test('a redirect on any page drops the whole pack and releases it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const redirected = streamingResponse({
    status: 302,
    headers: { location: 'https://evil.example/cameras' },
  });
  t.mock.method(globalThis, 'fetch', async (url) =>
    offsetOf(url) === 0
      ? Response.json(page(0, 2000, { exceededTransferLimit: true }))
      : redirected.response,
  );
  assert.deepEqual(await loadFloridaSourcesFromOpenData(), []);
  assert.equal(
    redirected.state.cancelled,
    true,
    'the redirect body is cancelled',
  );
});

test('a failed later page keeps the pages already read', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  uncapped(t);
  const failed = streamingResponse({ status: 503 });
  t.mock.method(globalThis, 'fetch', async (url) =>
    offsetOf(url) === 0
      ? Response.json(page(0, 2000, { exceededTransferLimit: true }))
      : failed.response,
  );
  assert.equal((await loadFloridaSourcesFromOpenData()).length, 2000);
  assert.equal(failed.state.cancelled, true, 'the failed body is cancelled');

  // A network error on a later page keeps them too.
  t.mock.restoreAll();
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (offsetOf(url) === 0)
      return Response.json(page(0, 2000, { exceededTransferLimit: true }));
    throw new Error('network down');
  });
  assert.equal((await loadFloridaSourcesFromOpenData()).length, 2000);
});

test('an oversized catalog page is refused', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(JSON.stringify(page(0, 1)), {
        headers: {
          'Content-Type': 'application/json',
          'content-length': String(FLORIDA_MAX_CATALOG_BYTES + 1),
        },
      }),
  );
  assert.deepEqual(await loadFloridaSourcesFromOpenData(), []);

  // So is a body that only turns out too long while streaming.
  t.mock.restoreAll();
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    const oversized = 'x'.repeat(FLORIDA_MAX_CATALOG_BYTES + 1024);
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
  assert.deepEqual(await loadFloridaSourcesFromOpenData(), []);
});

/**
 * Serve a two-camera FL511 page to the Florida endpoint and an empty payload
 * to every other pack, so one catalog refresh exercises the registration
 * without reaching the network. Returns the URLs that were requested.
 */
const runCatalogWithMockedUpstreams = async (t) => {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    if (href.startsWith(FLORIDA_CCTV_URL)) return Response.json(page(0, 2));
    return Response.json([]);
  });
  // No curated catalogs or ground-height sidecar, so only live lanes are in play.
  const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
  return { requested, sources };
};

/** Put process.env back exactly as it was. */
const restoreEnv = (saved) => {
  for (const key of Object.keys(process.env)) {
    if (key in saved) continue;
    delete process.env[key];
  }
  Object.assign(process.env, saved);
};

test('the Florida lane is wired into the catalog and its loader runs', async (t) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    delete process.env.CCTV_FLORIDA_ENABLED;
    const { requested, sources } = await runCatalogWithMockedUpstreams(t);
    assert.ok(
      requested.some((href) => href.startsWith(FLORIDA_CCTV_URL)),
      'the catalog refresh invokes the Florida loader',
    );
    assert.deepEqual(
      sources
        .filter((s) => s.cityId === 'florida')
        .map((s) => s.id)
        .sort(),
      ['fl-0', 'fl-1'],
      'Florida cameras reach the served catalog through the registered lane',
    );
  } finally {
    restoreEnv(saved);
  }
});

test('CCTV_FLORIDA_ENABLED=0 keeps the lane from being loaded at all', async (t) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    process.env.CCTV_FLORIDA_ENABLED = '0';
    const { requested, sources } = await runCatalogWithMockedUpstreams(t);
    assert.equal(
      requested.some((href) => href.startsWith(FLORIDA_CCTV_URL)),
      false,
      'the disabled lane never reaches its upstream',
    );
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'florida'),
      [],
    );
  } finally {
    restoreEnv(saved);
  }
});
