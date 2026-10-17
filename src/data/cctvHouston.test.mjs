import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  houstonCameraName,
  houstonCameraToSource,
  loadHoustonSourcesFromOpenData,
} from '../../server/providers/cctv/sources.js';
import {
  DEFAULT_CCTV_MAX_SOURCES,
  DEFAULT_HOUSTON_MAX_SOURCES,
  HOUSTON_CAMERAS_URL,
  HOUSTON_GROUND_ELEVATION_M,
  HOUSTON_IMAGE_ORIGIN,
  HOUSTON_IMAGE_URL,
  HOUSTON_MAX_CATALOG_BYTES,
} from '../../server/providers/cctv/constants.js';
import {
  CAMERA_CODE_MAX_CHARS,
  isLikelyHoustonCoordinate,
} from '../../server/providers/cctv/normalize.js';
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

const DOWNTOWN_ID = '1002';
const GALLERIA_ID = '2001';

/** One TranStar camera row, shaped like the live `cctvSnapshots_json.js` payload. */
const row = (overrides = {}) => ({
  location: '10 EAST @ SAN JACINTO',
  id: DOWNTOWN_ID,
  lat: '29.76824',
  lng: '-95.355711',
  dir: 'South',
  fc: '6',
  fp: '300',
  url: "showWin('/layers/gc.aspx?cam=1002&loc=IH-10_East_at_SAN_JACINTO')",
  ...overrides,
});

test('a Houston row maps to a source on the pinned HTTPS frame host', () => {
  const source = houstonCameraToSource(row());
  assert.equal(source.id, `houston-${DOWNTOWN_ID}`);
  assert.equal(source.name, '10 EAST @ SAN JACINTO');
  assert.equal(source.city, 'Houston');
  assert.equal(source.cityId, 'houston');
  assert.equal(source.provider, 'Houston TranStar');
  assert.equal(source.lat, 29.76824);
  assert.equal(source.lon, -95.355711);
  assert.equal(source.feedType, 'image');
  assert.equal(source.sourceKind, 'houston-transtar');
  assert.equal(
    source.license,
    'TranStar disclaimer — redistribution and external framing need TxDOT written permission',
  );
  assert.equal(source.groundElevationM, HOUSTON_GROUND_ELEVATION_M);
  assert.equal(source.url, HOUSTON_IMAGE_URL(DOWNTOWN_ID));
  assert.equal(source.url, source.snapshotUrl);
  assert.ok(source.url.startsWith(HOUSTON_IMAGE_ORIGIN));
  assert.equal(source.headingConfidence, 'high');
  assert.equal(source.headingDeg, 180);
});

test('frame URLs are synthesized from the numeric id; the payload URL is ignored', () => {
  const source = houstonCameraToSource(
    row({ url: 'https://evil.example/cameras/x/image' }),
  );
  assert.equal(source.url, HOUSTON_IMAGE_URL(DOWNTOWN_ID));
  assert.equal(source.snapshotUrl, source.url);
});

test('zero ids, off-city geometry and unusable ids are dropped', () => {
  assert.equal(houstonCameraToSource(row({ id: '0' })), null);
  assert.equal(houstonCameraToSource(row({ id: '00' })), null);
  assert.equal(houstonCameraToSource(row({ id: '../etc/passwd' })), null);
  assert.equal(houstonCameraToSource(row({ id: '12' })), null);
  assert.equal(houstonCameraToSource(row({ id: '1002/../x' })), null);
  // Dallas: a plausible lat/lon, but not a Houston camera.
  assert.equal(
    houstonCameraToSource(row({ lat: '32.7767', lng: '-96.797' })),
    null,
  );
  assert.equal(houstonCameraToSource(row({ lat: '0', lng: '0' })), null);
  assert.equal(houstonCameraToSource(null), null);
  // 3-digit and 5-digit snapshot ids stay.
  assert.equal(houstonCameraToSource(row({ id: '102' })).id, 'houston-102');
  assert.equal(houstonCameraToSource(row({ id: '13711' })).id, 'houston-13711');
});

test('bare cardinal dirs are high-confidence; None uses the id-hash fallback', () => {
  assert.equal(directionToHeading('South', true), 180);
  assert.equal(directionToHeading('None', true), NaN);

  const south = houstonCameraToSource(row({ dir: 'South' }));
  assert.equal(south.headingConfidence, 'high');
  assert.equal(south.headingDeg, 180);

  const none = houstonCameraToSource(row({ dir: 'None' }));
  assert.equal(none.headingConfidence, 'low');
  assert.ok(Number.isFinite(none.headingDeg));
  assert.equal(
    none.headingDeg,
    houstonCameraToSource(row({ dir: '' })).headingDeg,
  );
});

test('a nameless row still gets a label', () => {
  assert.equal(
    houstonCameraName({ location: '  45 GULF @ WEST DALLAS ' }, 'houston-102'),
    '45 GULF @ WEST DALLAS',
  );
  assert.equal(houstonCameraName({}, 'houston-102'), 'Houston Camera 102');
  assert.equal(houstonCameraName({}, ''), 'Houston Camera');
});

test('the unselected label is the interchange, trimmed to the code width', () => {
  assert.equal(houstonCameraToSource(row()).code, '10 EAST @ SAN JACINTO');
  const long = houstonCameraToSource(
    row({
      location:
        'IH-10 Katy Managed Lanes Eastbound at a very long interchange name that must truncate',
    }),
  );
  assert.equal(long.code.length, CAMERA_CODE_MAX_CHARS);
  assert.ok(long.code.endsWith('…'));
});

test('the loader reads the keyless catalog and collapses duplicate ids', async (t) => {
  t.mock.method(console, 'log', () => {});
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requested.push([String(url), init.headers.Accept, init.redirect]);
    return Response.json({
      cameras: [
        row(),
        row({ location: '10 EAST @ SAN JACINTO (duplicate)' }),
        row({
          id: GALLERIA_ID,
          location: '610 WEST LOOP @ SAN FELIPE',
          lat: '29.749',
          lng: '-95.461',
          dir: 'North',
        }),
        row({ url: 'https://evil.example/x.jpg', id: '0' }),
      ],
    });
  });
  const cameras = await loadHoustonSourcesFromOpenData();
  assert.deepEqual(requested, [[HOUSTON_CAMERAS_URL, '*/*', 'manual']]);
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    [`houston-${GALLERIA_ID}`, `houston-${DOWNTOWN_ID}`],
    'nearest-to-anchor first: Uptown sits closer to its pin than downtown does',
  );
  assert.equal(cameras[1].name, '10 EAST @ SAN JACINTO');
});

test('an upstream failure yields an empty pack and releases the response', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const failed = streamingResponse({ status: 503 });
  t.mock.method(globalThis, 'fetch', async () => failed.response);
  assert.deepEqual(await loadHoustonSourcesFromOpenData(), []);
  assert.equal(failed.state.cancelled, true, 'the failed body is cancelled');

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down');
  });
  assert.deepEqual(await loadHoustonSourcesFromOpenData(), []);
});

test('the catalog fetch refuses redirects and oversized bodies', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const seen = [];
  const redirected = streamingResponse({
    status: 302,
    headers: { location: 'https://evil.example/cameras.js' },
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push([String(url), init.redirect]);
    return redirected.response;
  });
  assert.deepEqual(await loadHoustonSourcesFromOpenData(), []);
  assert.deepEqual(seen, [[HOUSTON_CAMERAS_URL, 'manual']]);
  assert.equal(
    redirected.state.cancelled,
    true,
    'the redirect body is cancelled',
  );

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    const body = JSON.stringify({ cameras: [row()] });
    return new Response(body, {
      headers: {
        'Content-Type': 'application/javascript',
        'content-length': String(HOUSTON_MAX_CATALOG_BYTES + 1),
      },
    });
  });
  assert.deepEqual(await loadHoustonSourcesFromOpenData(), []);

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    const oversized = 'x'.repeat(HOUSTON_MAX_CATALOG_BYTES + 1024);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversized));
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'application/javascript' } },
    );
  });
  assert.deepEqual(await loadHoustonSourcesFromOpenData(), []);
});

test('a reduced pack cap keeps cameras nearest the metro anchors', async (t) => {
  t.mock.method(console, 'log', () => {});
  const saved = process.env.CCTV_HOUSTON_MAX_SOURCES;
  t.after(() => {
    if (saved === undefined) delete process.env.CCTV_HOUSTON_MAX_SOURCES;
    else process.env.CCTV_HOUSTON_MAX_SOURCES = saved;
  });
  process.env.CCTV_HOUSTON_MAX_SOURCES = '8';
  const rows = [
    ...[29.32, 29.322, 29.324, 29.326, 29.328, 29.33].map((lat, i) =>
      row({
        id: String(3000 + i),
        lat: String(lat),
        lng: '-94.80',
        location: `Galveston ${i}`,
        dir: 'East',
      }),
    ),
    ...[29.76, 29.759, 29.758, 29.757, 29.756, 29.755].map((lat, i) =>
      row({
        id: String(4000 + i),
        lat: String(lat),
        lng: '-95.3698',
        location: `Downtown ${i}`,
        dir: 'North',
      }),
    ),
  ];
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ cameras: rows }),
  );
  const cameras = await loadHoustonSourcesFromOpenData();
  assert.equal(cameras.length, 8);
  assert.deepEqual(
    cameras.map((camera) => camera.name.slice(0, 8)),
    [
      'Downtown',
      'Downtown',
      'Downtown',
      'Downtown',
      'Downtown',
      'Downtown',
      'Galvesto',
      'Galvesto',
    ],
    'downtown fills first; the Galveston anchor still keeps a share',
  );
});

/**
 * Serve the Houston catalog to the Houston endpoint and an empty payload to
 * every other pack, so one catalog refresh exercises the registration without
 * reaching the network.
 */
const runCatalogWithMockedUpstreams = async (t) => {
  const requested = [];
  t.mock.restoreAll();
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    if (href === HOUSTON_CAMERAS_URL) {
      return Response.json({
        cameras: [
          row(),
          row({
            id: GALLERIA_ID,
            location: '610 WEST LOOP @ SAN FELIPE',
            lat: '29.749',
            lng: '-95.461',
            dir: 'West',
          }),
        ],
      });
    }
    return Response.json([]);
  });
  const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
  return { requested, sources };
};

test('the Houston lane is wired into the catalog and its loader runs', async (t) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    process.env.CCTV_HOUSTON_ENABLED = '1';
    const { requested, sources } = await runCatalogWithMockedUpstreams(t);
    assert.ok(
      requested.includes(HOUSTON_CAMERAS_URL),
      'the catalog refresh invokes the Houston loader',
    );
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'houston').map((s) => s.id),
      [`houston-${GALLERIA_ID}`, `houston-${DOWNTOWN_ID}`],
      'Houston cameras reach the served catalog through the registered lane',
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

test('Houston stays unloaded unless CCTV_HOUSTON_ENABLED=1', async (t) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    for (const value of [undefined, '0']) {
      if (value === undefined) delete process.env.CCTV_HOUSTON_ENABLED;
      else process.env.CCTV_HOUSTON_ENABLED = value;
      const { requested, sources } = await runCatalogWithMockedUpstreams(t);
      assert.equal(
        requested.includes(HOUSTON_CAMERAS_URL),
        false,
        'the pack reaches TranStar only after an explicit opt-in',
      );
      assert.deepEqual(
        sources.filter((s) => s.cityId === 'houston'),
        [],
      );
    }
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

test('the shipped catalog ceiling is not raised to make room for this pack', () => {
  assert.equal(DEFAULT_CCTV_MAX_SOURCES, 4000);
  assert.equal(DEFAULT_HOUSTON_MAX_SOURCES, 250);
});

test('isLikelyHoustonCoordinate spans the metro and rejects the rest', () => {
  assert.equal(isLikelyHoustonCoordinate(29.7604, -95.3698), true); // Downtown
  assert.equal(isLikelyHoustonCoordinate(29.3013, -94.7977), true); // Galveston
  assert.equal(isLikelyHoustonCoordinate(29.9902, -95.3368), true); // IAH
  assert.equal(isLikelyHoustonCoordinate(32.7767, -96.797), false); // Dallas
  assert.equal(isLikelyHoustonCoordinate(30.2672, -97.7431), false); // Austin
  assert.equal(isLikelyHoustonCoordinate(0, 0), false);
  assert.equal(isLikelyHoustonCoordinate(NaN, -95.37), false);
});
