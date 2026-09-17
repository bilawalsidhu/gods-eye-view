import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WSDOT_MAX_SOURCES,
  WSDOT_CAMERAS_URL,
} from '../../server/providers/cctv/constants.js';
import {
  loadWsdotSourcesFromOpenData,
  webMercatorToWgs84,
} from '../../server/providers/cctv/sources.js';

/** Set (or, for `undefined`, delete) environment variables for one test. */
function withEnv(t, env) {
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** Silence the loaders' progress and failure logging. */
function quiet(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
}

/** Web Mercator metres for a WGS84 coordinate (inverse of the loader's math). */
function mercator(lat, lon) {
  const R = 6378137;
  return {
    x: (lon * Math.PI * R) / 180,
    y: R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
  };
}

/** A `Cameras.json` point feature carrying the fields the loader reads. */
function wsdotFeature(id, lat, lon, overrides = {}) {
  const { attributes = {}, geometry } = overrides;
  return {
    attributes: {
      CameraID: id,
      CameraTitle: `Camera ${id}`,
      CompassDirection: 'N',
      ImageURL: `https://images.wsdot.wa.gov/nw/${id}.jpg`,
      ...attributes,
    },
    geometry: geometry === undefined ? mercator(lat, lon) : geometry,
  };
}

/** Serialize a payload for the mocked fetch as raw Windows-1252 bytes. */
function cp1252Response(payload) {
  const text = JSON.stringify(payload);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    // U+2013 EN DASH is 0x96 in Windows-1252 — the byte the live feed ships.
    bytes[i] = code === 0x2013 ? 0x96 : code;
  }
  return new Response(bytes, {
    headers: { 'Content-Type': 'application/json' },
  });
}

test('webMercatorToWgs84 recovers WGS84 degrees from layer geometry', () => {
  // Real feature from the live layer: I-5 at the Interstate Bridge.
  const { lat, lon } = webMercatorToWgs84(-13656007.102, 5719738.545);
  assert.ok(Math.abs(lat - 45.62) < 0.05, `lat ${lat}`);
  assert.ok(Math.abs(lon - -122.675) < 0.05, `lon ${lon}`);
});

test('WSDOT loader keeps official-host cameras and maps compass directions', async (t) => {
  quiet(t);
  withEnv(t, { CCTV_WSDOT_MAX_SOURCES: undefined });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return cp1252Response({
      features: [
        wsdotFeature(1001, 47.6097, -122.3331, {
          attributes: {
            // The 0x2013 below is serialized as the feed's 0x96 byte.
            CameraTitle: 'I-5 – Seattle, looking south',
            CompassDirection: 'S',
          },
        }),
        wsdotFeature(9059, 47.66, -117.43, {
          attributes: { CompassDirection: 'B' },
        }),
        // Partner-hosted frame (Oregon DOT): skipped, never proxied.
        wsdotFeature(1002, 45.62, -122.675, {
          attributes: {
            ImageURL: 'https://www.tripcheck.com/RoadCams/cams/bridge.jpg',
          },
        }),
        // Bad rows: non-integer id, missing geometry, out-of-state point.
        wsdotFeature('1003', 47.6, -122.3),
        wsdotFeature(1004, 47.6, -122.3, { geometry: null }),
        wsdotFeature(1005, 34.05, -118.24),
      ],
    });
  });

  const cameras = await loadWsdotSourcesFromOpenData();

  assert.deepEqual(requested, [WSDOT_CAMERAS_URL]);
  // Exactly the two valid official-host cameras survive; the partner-hosted
  // frame and the malformed rows are dropped.
  assert.deepEqual(cameras.map((camera) => camera.id).sort(), [
    'wsdot-1001',
    'wsdot-9059',
  ]);

  const seattle = cameras.find((camera) => camera.id === 'wsdot-1001');
  assert.equal(seattle.name, 'I-5 – Seattle, looking south');
  assert.equal(seattle.provider, 'WSDOT');
  assert.equal(seattle.url, 'https://images.wsdot.wa.gov/nw/1001.jpg');
  assert.equal(seattle.snapshotUrl, seattle.url);
  assert.equal(seattle.feedType, 'image');
  assert.equal(seattle.headingDeg, 180);
  assert.equal(seattle.headingConfidence, 'high');
  assert.equal(seattle.fovDeg, 56);
  assert.ok(Math.abs(seattle.lat - 47.6097) < 0.001);
  assert.ok(Math.abs(seattle.lon - -122.3331) < 0.001);

  // "Both directions" carries no single facing: id-hash fallback at low
  // confidence, with the low-confidence pose personality.
  const spokane = cameras.find((camera) => camera.id === 'wsdot-9059');
  assert.equal(spokane.headingConfidence, 'low');
  assert.equal(spokane.fovDeg, 44);
  assert.ok(spokane.headingDeg >= 0 && spokane.headingDeg < 360);
});

test('WSDOT loader honors the max-sources cap', async (t) => {
  quiet(t);
  withEnv(t, { CCTV_WSDOT_MAX_SOURCES: '8' });
  const features = [];
  for (let i = 0; i < 24; i += 1) {
    features.push(wsdotFeature(2000 + i, 47.0 + i * 0.05, -122.9 + i * 0.05));
  }
  t.mock.method(globalThis, 'fetch', async () => cp1252Response({ features }));

  const cameras = await loadWsdotSourcesFromOpenData();
  assert.equal(cameras.length, 8);
});

test('WSDOT loader defaults its cap and survives upstream failure', async (t) => {
  quiet(t);
  withEnv(t, { CCTV_WSDOT_MAX_SOURCES: undefined });
  assert.equal(DEFAULT_WSDOT_MAX_SOURCES, 250);

  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 503 }),
  );
  assert.deepEqual(await loadWsdotSourcesFromOpenData(), []);

  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down');
  });
  assert.deepEqual(await loadWsdotSourcesFromOpenData(), []);
});
