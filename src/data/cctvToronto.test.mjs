import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractTorontoCoords,
  loadTorontoSourcesFromOpenData,
  normalizeTorontoImageUrl,
  torontoCameraId,
  torontoCameraName,
  torontoCameraToSource,
} from '../../server/providers/cctv/sources.js';
import {
  DEFAULT_CCTV_MAX_SOURCES,
  DEFAULT_TORONTO_ROWS_URL,
  TORONTO_DOWNTOWN,
  TORONTO_IMAGE_ORIGIN,
  TORONTO_MAX_CATALOG_BYTES,
} from '../../server/providers/cctv/constants.js';
import {
  cameraDisplayCode,
  isLikelyTorontoCoordinate,
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

/** One CKAN Datastore record, shaped like the live `824d2986-2fe0-4513-bdfb-e37e2499e7a9` payload. */
const datastoreRecord = (overrides = {}) => ({
  _id: 1,
  REC_ID: 8001,
  MAINROAD: 'YORK ST',
  CROSSROAD: 'BREMNER BLVD / RAPTORS WAY',
  IMAGEURL:
    'https://opendata.toronto.ca/transportation/tmc/rescucameraimages/CameraImages/loc8001.jpg',
  DIRECTION1: 'North',
  DIRECTION2: 'East',
  DIRECTION3: 'South',
  DIRECTION4: 'West',
  geometry: JSON.stringify({
    type: 'Point',
    coordinates: [-79.381386, 43.64312],
  }),
  ...overrides,
});

/** One GeoJSON feature, shaped like the download GeoJSON payload. */
const geojsonFeature = (overrides = {}) => ({
  type: 'Feature',
  properties: {
    _id: 1,
    REC_ID: 8001,
    MAINROAD: 'YORK ST',
    CROSSROAD: 'BREMNER BLVD / RAPTORS WAY',
    IMAGEURL:
      'https://opendata.toronto.ca/transportation/tmc/rescucameraimages/CameraImages/loc8001.jpg',
  },
  geometry: {
    type: 'MultiPoint',
    coordinates: [[-79.381386, 43.64312]],
  },
  ...overrides,
});

test('a Toronto datastore record maps to a source on the pinned HTTPS frame host', () => {
  const source = torontoCameraToSource(datastoreRecord());
  assert.equal(source.id, 'toronto-8001');
  assert.equal(source.name, 'YORK ST / BREMNER BLVD / RAPTORS WAY');
  assert.equal(source.city, 'Toronto');
  assert.equal(source.cityId, 'toronto');
  assert.equal(source.provider, 'City of Toronto');
  assert.equal(source.lat, 43.64312);
  assert.equal(source.lon, -79.381386);
  assert.equal(source.feedType, 'image');
  assert.equal(source.sourceKind, 'toronto-open-data');
  assert.equal(
    source.license,
    'Contains information provided by the City of Toronto under the City of Toronto Open Data Licence',
  );
  assert.equal(
    source.url,
    'https://opendata.toronto.ca/transportation/tmc/rescucameraimages/CameraImages/loc8001.jpg',
  );
  assert.equal(source.url, source.snapshotUrl);
  assert.ok(source.url.startsWith(TORONTO_IMAGE_ORIGIN));
  assert.equal(source.groundElevationM, 76);
  assert.equal(
    source.code,
    cameraDisplayCode('YORK ST / BREMNER BLVD / RAPTORS WAY'),
  );
});

test('a Toronto GeoJSON feature maps to a source with identical attributes', () => {
  const source = torontoCameraToSource(geojsonFeature());
  assert.equal(source.id, 'toronto-8001');
  assert.equal(source.name, 'YORK ST / BREMNER BLVD / RAPTORS WAY');
  assert.equal(source.lat, 43.64312);
  assert.equal(source.lon, -79.381386);
});

test('fallback headings are assigned with low confidence without treating cardinal directions as camera facings', () => {
  // Intersection PTZ cameras rotate; low confidence is expected so calibration gizmo applies.
  const source = torontoCameraToSource(datastoreRecord());
  assert.equal(source.headingConfidence, 'low');
  assert.ok(Number.isFinite(source.headingDeg));
});

test('rows outside Toronto, off-host frames and unusable geometry are dropped', () => {
  // Calgary coords: valid lat/lon, but not Toronto.
  assert.equal(
    torontoCameraToSource(
      datastoreRecord({
        geometry: JSON.stringify({
          type: 'Point',
          coordinates: [-114.14136, 51.0453],
        }),
      }),
    ),
    null,
  );

  // Null island [0, 0].
  assert.equal(
    torontoCameraToSource(
      datastoreRecord({
        geometry: JSON.stringify({
          type: 'Point',
          coordinates: [0, 0],
        }),
      }),
    ),
    null,
  );

  // Off-host image origin rejected by normalizeTorontoImageUrl.
  assert.equal(
    torontoCameraToSource(
      datastoreRecord({
        IMAGEURL: 'https://evil.example.com/loc8001.jpg',
      }),
    ),
    null,
  );

  // Missing coordinates entirely.
  assert.equal(
    torontoCameraToSource(
      datastoreRecord({
        geometry: null,
      }),
    ),
    null,
  );
});

test('normalizeTorontoImageUrl upgrades http to https and enforces the official origin', () => {
  assert.equal(
    normalizeTorontoImageUrl(
      'http://opendata.toronto.ca/transportation/tmc/rescucameraimages/CameraImages/loc8001.jpg',
    ),
    'https://opendata.toronto.ca/transportation/tmc/rescucameraimages/CameraImages/loc8001.jpg',
  );
  assert.equal(
    normalizeTorontoImageUrl('https://otherhost.org/camera.jpg'),
    null,
  );
  assert.equal(normalizeTorontoImageUrl('javascript:alert(1)'), null);
  assert.equal(normalizeTorontoImageUrl(''), null);
  assert.equal(normalizeTorontoImageUrl(null), null);
});

test('torontoCameraId extracts stable ID from frame filename or record REC_ID', () => {
  assert.equal(
    torontoCameraId(
      'https://opendata.toronto.ca/transportation/tmc/rescucameraimages/CameraImages/loc8001.jpg',
    ),
    'toronto-8001',
  );
  assert.equal(torontoCameraId('', { REC_ID: 8055 }), 'toronto-8055');
  assert.equal(torontoCameraId('', {}), null);
});

test('torontoCameraName formats arterial intersections and falls back gracefully', () => {
  assert.equal(
    torontoCameraName(
      { MAINROAD: 'YORK ST', CROSSROAD: 'BREMNER BLVD' },
      'toronto-8001',
    ),
    'YORK ST / BREMNER BLVD',
  );
  assert.equal(
    torontoCameraName({ MAINROAD: 'BLOOR ST W' }, 'toronto-8002'),
    'BLOOR ST W',
  );
  assert.equal(
    torontoCameraName({ location: 'Nathan Phillips Square' }, 'toronto-8003'),
    'Nathan Phillips Square',
  );
  assert.equal(torontoCameraName({}, 'toronto-8004'), 'Toronto Camera 8004');
});

test('extractTorontoCoords parses various geometry encodings', () => {
  // Stringified Point
  assert.deepEqual(
    extractTorontoCoords({
      geometry: JSON.stringify({
        type: 'Point',
        coordinates: [-79.38, 43.65],
      }),
    }),
    { lon: -79.38, lat: 43.65 },
  );

  // Object MultiPoint
  assert.deepEqual(
    extractTorontoCoords({
      geometry: { type: 'MultiPoint', coordinates: [[-79.38, 43.65]] },
    }),
    { lon: -79.38, lat: 43.65 },
  );

  // Direct lat/lon properties
  assert.deepEqual(
    extractTorontoCoords({ latitude: 43.65, longitude: -79.38 }),
    { lat: 43.65, lon: -79.38 },
  );

  // Malformed input
  assert.ok(Number.isNaN(extractTorontoCoords(null).lat));
});

test('loadTorontoSourcesFromOpenData discards streams on HTTP redirect', async () => {
  const { response, state } = streamingResponse({
    status: 302,
    headers: { Location: 'https://evil.example.com/' },
  });
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => response;
  try {
    const res = await loadTorontoSourcesFromOpenData();
    assert.deepEqual(res, []);
    assert.equal(state.cancelled, true);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('loadTorontoSourcesFromOpenData discards streams on HTTP error', async () => {
  const { response, state } = streamingResponse({ status: 500 });
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => response;
  try {
    const res = await loadTorontoSourcesFromOpenData();
    assert.deepEqual(res, []);
    assert.equal(state.cancelled, true);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('loadTorontoSourcesFromOpenData parses and prioritizes sources around downtown Toronto', async () => {
  const sampleRecords = Array.from({ length: 12 }, (_, i) =>
    datastoreRecord({
      REC_ID: 8000 + i,
      MAINROAD: `STREET ${i}`,
      CROSSROAD: `AVENUE ${i}`,
      IMAGEURL: `https://opendata.toronto.ca/transportation/tmc/rescucameraimages/CameraImages/loc${8000 + i}.jpg`,
      geometry: JSON.stringify({
        type: 'Point',
        // i = 0..7 are close to downtown, i = 8..11 are further out
        coordinates: [
          TORONTO_DOWNTOWN.lon + (i < 8 ? i * 0.001 : 0.15 + i * 0.01),
          TORONTO_DOWNTOWN.lat + (i < 8 ? i * 0.001 : 0.15 + i * 0.01),
        ],
      }),
    }),
  );

  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        success: true,
        result: { records: sampleRecords },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  const savedEnv = process.env.CCTV_TORONTO_MAX_SOURCES;
  process.env.CCTV_TORONTO_MAX_SOURCES = '8';
  try {
    const sources = await loadTorontoSourcesFromOpenData();
    assert.equal(sources.length, 8);
    // Nearest cameras (the 8 downtown ones) should be selected first
    assert.deepEqual(
      sources.map((s) => s.id),
      Array.from({ length: 8 }, (_, i) => `toronto-${8000 + i}`),
    );
  } finally {
    globalThis.fetch = savedFetch;
    if (savedEnv !== undefined) {
      process.env.CCTV_TORONTO_MAX_SOURCES = savedEnv;
    } else {
      delete process.env.CCTV_TORONTO_MAX_SOURCES;
    }
  }
});

test('catalog honors CCTV_TORONTO_ENABLED kill switch', async () => {
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json([]);
  try {
    process.env.CCTV_TORONTO_ENABLED = '0';
    process.env.CCTV_SOURCES_FILE = '/nonexistent/cctv.json';
    process.env.CCTV_SOURCES_JSON = '[]';

    const getSources = createCctvCatalog({ sourceRoot: '/nonexistent' });
    const sources = await getSources();
    assert.equal(
      sources.some((s) => s.id?.startsWith('toronto-')),
      false,
    );
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});
