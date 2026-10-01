import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  MAX_BYTES,
  MAX_FEATURES,
  effisBurntAreasProxy,
  normalizeEffisFeatureCollection,
} from './effis.js';

test('T1: normalizeEffisFeatureCollection maps polygon features into flat area rows', () => {
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { AREA_HA: '42', FIREDATE: '2026-09-22 00:00:00' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [10, 45],
              [10.1, 45],
              [10.1, 45.1],
              [10, 45.1],
              [10, 45],
            ],
          ],
        },
      },
    ],
  };
  const rows = normalizeEffisFeatureCollection(geojson);
  assert.equal(rows.length, 1);
  assert.ok(Number.isFinite(rows[0].lon) && Number.isFinite(rows[0].lat));
  assert.equal(rows[0].polygon.length, 5);
  assert.equal(rows[0].areaHa, 42);
  assert.equal(rows[0].fireDate, '2026-09-22 00:00:00');
  assert.deepEqual(
    Object.keys(rows[0]).sort(),
    ['id', 'lon', 'lat', 'polygon', 'areaHa', 'fireDate'].sort(),
  );
});

test('T1: normalizeEffisFeatureCollection treats a missing AREA_HA/FIREDATE as null, not a defect (both are schema-optional)', () => {
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [10, 45],
              [10.1, 45],
              [10.1, 45.1],
              [10, 45],
            ],
          ],
        },
      },
    ],
  };
  const rows = normalizeEffisFeatureCollection(geojson);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].areaHa, null);
  assert.equal(rows[0].fireDate, null);
});

test('T1: normalizeEffisFeatureCollection treats an empty-string AREA_HA as null, not zero (MapServer NULL-numeric serialization)', () => {
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { AREA_HA: '', FIREDATE: '2026-09-22 00:00:00' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [10, 45],
              [10.1, 45],
              [10.1, 45.1],
              [10, 45.1],
              [10, 45],
            ],
          ],
        },
      },
    ],
  };
  const rows = normalizeEffisFeatureCollection(geojson);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].areaHa, null);
});

test('T1: normalizeEffisFeatureCollection drops malformed features instead of throwing', () => {
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [1] },
      },
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [1, 2],
              [3, 4],
              [5, 6],
              [1, 2],
            ],
          ],
        },
      },
    ],
  };
  const rows = normalizeEffisFeatureCollection(geojson);
  assert.equal(rows.length, 1);
});

test('T1: normalizeEffisFeatureCollection returns [] for a non-FeatureCollection payload', () => {
  assert.deepEqual(normalizeEffisFeatureCollection({}), []);
  assert.deepEqual(normalizeEffisFeatureCollection(null), []);
});

test('FINAL-FIX: normalizeEffisFeatureCollection uses the upstream properties.id as a stable row id', () => {
  const ring = [
    [10, 45],
    [10.1, 45],
    [10.1, 45.1],
    [10, 45.1],
    [10, 45],
  ];
  const rows = normalizeEffisFeatureCollection({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { id: '764728' },
        geometry: { type: 'Polygon', coordinates: [ring] },
      },
      {
        type: 'Feature',
        id: 'fid-9',
        properties: { id: '111' },
        geometry: { type: 'Polygon', coordinates: [ring] },
      },
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [ring] },
      },
    ],
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    ['764728', 'fid-9', 'effis-ba-3'],
  );
});

// --- proxy middleware harness -------------------------------------------------
// The plugin computes its cache dir from process.cwd() at construction time, so
// each harness runs in a fresh temp dir (node --test runs each file in its own
// process, so chdir here cannot leak into other test files).

const VALID_RING = [
  [10, 45],
  [10.1, 45],
  [10.1, 45.1],
  [10, 45.1],
  [10, 45],
];

async function withProxy(fn, { disk } = {}) {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'effis-proxy-'));
  process.chdir(dir);
  try {
    if (disk) {
      await mkdir(path.join(dir, '.gev-cache'), { recursive: true });
      await writeFile(
        path.join(dir, '.gev-cache', 'effis-burnt-areas.json'),
        JSON.stringify(disk),
        'utf8',
      );
    }
    let handler = null;
    effisBurntAreasProxy().configureServer({
      middlewares: {
        use: (_route, routeHandler) => {
          handler = routeHandler;
        },
      },
    });
    const request = () =>
      new Promise((resolve) => {
        const res = {
          statusCode: 200,
          setHeader() {},
          end(body) {
            resolve({ status: this.statusCode, body: JSON.parse(body) });
          },
        };
        handler({ method: 'GET' }, res);
      });
    await fn({
      request,
      stubFetch: (impl) => {
        globalThis.fetch = impl;
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
}

// A real WHATWG Response, so the proxy's streamed, byte-capped body read is
// exercised exactly as it would be against the upstream.
const jsonResponse = (body, init) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

const polygonFeature = (id) => ({
  type: 'Feature',
  properties: { id: String(id) },
  geometry: { type: 'Polygon', coordinates: [VALID_RING] },
});

test('FINAL-FIX: a 200 response that is not a FeatureCollection is an upstream failure, not an empty result', async () => {
  await withProxy(async ({ request, stubFetch }) => {
    stubFetch(async () => jsonResponse({ error: 'mapserver exploded' }));
    const response = await request();
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'upstream_unavailable' });
  });
});

test('FINAL-FIX: a malformed 200 response keeps serving the previous cache as stale instead of overwriting it', async () => {
  const oldArea = {
    id: '1',
    lon: 10,
    lat: 45,
    polygon: VALID_RING,
    areaHa: 5,
    fireDate: null,
  };
  await withProxy(
    async ({ request, stubFetch }) => {
      stubFetch(async () => jsonResponse({ type: 'ExceptionReport' }));
      const response = await request();
      assert.equal(response.status, 200);
      assert.equal(response.body.stale, true);
      assert.equal(response.body.count, 1);
      assert.deepEqual(response.body.areas, [oldArea]);
    },
    { disk: { at: Date.now() - 2 * 60 * 60_000, areas: [oldArea] } },
  );
});

test('FINAL-FIX: a valid empty FeatureCollection is a healthy zero-area result', async () => {
  await withProxy(async ({ request, stubFetch }) => {
    stubFetch(async () =>
      jsonResponse({ type: 'FeatureCollection', features: [] }),
    );
    const response = await request();
    assert.equal(response.status, 200);
    assert.equal(response.body.stale, false);
    assert.equal(response.body.count, 0);
  });
});

test('FINAL-FIX: concurrent cold-start requests share one disk read and do not refetch a fresh disk cache', async () => {
  const diskArea = {
    id: '2',
    lon: 10,
    lat: 45,
    polygon: VALID_RING,
    areaHa: 7,
    fireDate: null,
  };
  await withProxy(
    async ({ request, stubFetch }) => {
      let fetchCalls = 0;
      stubFetch(async () => {
        fetchCalls += 1;
        return jsonResponse({ type: 'FeatureCollection', features: [] });
      });
      const [first, second] = await Promise.all([request(), request()]);
      assert.equal(fetchCalls, 0);
      assert.deepEqual(first.body.areas, [diskArea]);
      assert.deepEqual(second.body.areas, [diskArea]);
    },
    { disk: { at: Date.now(), areas: [diskArea] } },
  );
});

test('T1: the proxy bounds the upstream request with WFS COUNT=MAX_FEATURES', async () => {
  assert.equal(MAX_FEATURES, 2000);
  await withProxy(async ({ request, stubFetch }) => {
    let requestedUrl = null;
    stubFetch(async (url) => {
      requestedUrl = String(url);
      return jsonResponse({ type: 'FeatureCollection', features: [] });
    });
    await request();
    assert.ok(requestedUrl, 'upstream must be fetched on a cold cache');
    assert.equal(new URL(requestedUrl).searchParams.get('COUNT'), '2000');
  });
});

test('T1: an upstream body over MAX_BYTES is rejected (503 on a cold cache), never parsed or cached', async () => {
  assert.equal(MAX_BYTES, 8 * 1024 * 1024);
  await withProxy(async ({ request, stubFetch }) => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let pulled = 0;
    stubFetch(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulled += 1;
              // Unbounded stream: only a byte cap stops it.
              if (pulled > 64) controller.close();
              else controller.enqueue(chunk);
            },
          }),
          { status: 200 },
        ),
    );
    const response = await request();
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'upstream_unavailable' });
    assert.ok(pulled <= 10, `read stopped near the cap, pulled ${pulled} MiB`);
  });
});

test('T1: an over-cap Content-Length is rejected before reading and the stale cache is served', async () => {
  const oldArea = {
    id: '1',
    lon: 10,
    lat: 45,
    polygon: VALID_RING,
    areaHa: 5,
    fireDate: null,
  };
  await withProxy(
    async ({ request, stubFetch }) => {
      stubFetch(async () =>
        jsonResponse(
          { type: 'FeatureCollection', features: [] },
          { headers: { 'content-length': String(MAX_BYTES + 1) } },
        ),
      );
      const response = await request();
      assert.equal(response.status, 200);
      assert.equal(response.body.stale, true);
      assert.deepEqual(response.body.areas, [oldArea]);
    },
    { disk: { at: Date.now() - 2 * 60 * 60_000, areas: [oldArea] } },
  );
});

test('T1: rows are capped at MAX_FEATURES and the response is flagged truncated', async () => {
  await withProxy(async ({ request, stubFetch }) => {
    const features = Array.from({ length: MAX_FEATURES + 5 }, (_, i) =>
      polygonFeature(i + 1),
    );
    stubFetch(async () => jsonResponse({ type: 'FeatureCollection', features }));
    const response = await request();
    assert.equal(response.status, 200);
    assert.equal(response.body.count, MAX_FEATURES);
    assert.equal(response.body.areas.length, MAX_FEATURES);
    assert.equal(response.body.truncated, true);
  });
});

test('T1: an upstream page that hits exactly the COUNT cap is flagged truncated', async () => {
  await withProxy(async ({ request, stubFetch }) => {
    const features = Array.from({ length: MAX_FEATURES }, (_, i) =>
      polygonFeature(i + 1),
    );
    stubFetch(async () => jsonResponse({ type: 'FeatureCollection', features }));
    const response = await request();
    assert.equal(response.body.count, MAX_FEATURES);
    assert.equal(response.body.truncated, true);
  });
});

test('T1: a small upstream snapshot is reported as not truncated', async () => {
  await withProxy(async ({ request, stubFetch }) => {
    stubFetch(async () =>
      jsonResponse({
        type: 'FeatureCollection',
        features: [polygonFeature(1), polygonFeature(2)],
      }),
    );
    const response = await request();
    assert.equal(response.body.count, 2);
    assert.equal(response.body.truncated, false);
  });
});
