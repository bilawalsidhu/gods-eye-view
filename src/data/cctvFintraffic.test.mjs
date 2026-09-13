import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFintrafficSourcesFromOpenData } from '../../server/providers/cctv/sources.js';
import {
  fintrafficCameraName,
  isLikelyFinlandCoordinate,
} from '../../server/providers/cctv/normalize.js';
import {
  FINTRAFFIC_GROUND_ELEVATION_M,
  FINTRAFFIC_IMAGE_ORIGIN,
  FINTRAFFIC_STATIONS_URL,
  FINTRAFFIC_SURFACE_POSE,
} from '../../server/providers/cctv/constants.js';

/** One station feature in the shape tie.digitraffic.fi actually returns. */
function station(
  id,
  {
    name = `vt4_${id}`,
    status = 'GATHERING',
    lon = 24.9384,
    lat = 60.1699,
    altitude = 0,
    presets = [],
  } = {},
) {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [lon, lat, altitude] },
    properties: {
      id,
      name,
      collectionStatus: status,
      dataUpdatedTime: '2026-09-13T03:25:36Z',
      presets,
      state: null,
    },
  };
}

/** Run the loader against a canned station list, restoring global fetch after. */
async function loadWith(features, { env = {}, capture = {} } = {}) {
  const originalFetch = globalThis.fetch;
  const originalEnv = {};
  for (const [key, value] of Object.entries(env)) {
    originalEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = async (url, options) => {
    capture.url = String(url);
    capture.options = options;
    return new Response(
      JSON.stringify({
        type: 'FeatureCollection',
        dataUpdatedTime: '2026-09-13T05:31:58Z',
        features,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  try {
    return await loadFintrafficSourcesFromOpenData();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('Fintraffic loader turns every in-collection preset into one camera', async () => {
  const cameras = await loadWith([
    station('C01503', {
      name: 'kt51_Inkoo',
      lon: 23.99616,
      lat: 60.05374,
      presets: [
        { id: 'C0150301', inCollection: true },
        { id: 'C0150302', inCollection: true },
      ],
    }),
  ]);

  assert.equal(cameras.length, 2);
  const [first, second] = cameras;
  assert.equal(first.id, 'fi-c0150301');
  assert.equal(first.name, 'kt51 Inkoo (view 01)');
  assert.equal(second.name, 'kt51 Inkoo (view 02)');
  assert.equal(first.provider, 'Fintraffic');
  assert.equal(first.city, 'Finland');
  assert.equal(first.cityId, 'finland');
  assert.equal(first.sourceKind, 'fintraffic-open-data');
  assert.equal(first.license, 'Fintraffic / digitraffic.fi (CC BY 4.0)');
  assert.equal(first.feedType, 'image');
  // Presets of one station share the station position...
  assert.equal(first.lat, 60.05374);
  assert.equal(second.lat, first.lat);
  assert.equal(second.lon, first.lon);
  // ...so the id-hash fallback heading is what keeps their gizmos apart.
  assert.notEqual(first.headingDeg, second.headingDeg);
  assert.equal(first.headingConfidence, 'low');
});

test('Fintraffic frame URLs are built on the official image origin', async () => {
  const cameras = await loadWith([
    station('C01503', { presets: [{ id: 'C0150301', inCollection: true }] }),
  ]);

  assert.equal(cameras[0].url, `${FINTRAFFIC_IMAGE_ORIGIN}C0150301.jpg`);
  assert.equal(cameras[0].snapshotUrl, cameras[0].url);
  assert.ok(cameras[0].url.startsWith('https://weathercam.digitraffic.fi/'));
});

test('Fintraffic loader drops dead stations, uncollected presets and bad ids', async () => {
  const cameras = await loadWith([
    // Station off collection: every preset goes, live or not.
    station('C01601', {
      status: 'REMOVED_TEMPORARILY',
      presets: [{ id: 'C0160101', inCollection: true }],
    }),
    station('C01503', {
      presets: [
        { id: 'C0150301', inCollection: true },
        { id: 'C0150302', inCollection: false },
        { id: 'C0150303' },
        // Ids that would escape the synthesized frame path, or belong to
        // another station, never become a camera.
        { id: '../../etc/passwd', inCollection: true },
        { id: 'C9999901', inCollection: true },
      ],
    }),
    // Coordinates nowhere near Finland (swapped lat/lon).
    station('C01504', {
      lon: 60.1699,
      lat: 24.9384,
      presets: [{ id: 'C0150401', inCollection: true }],
    }),
  ]);

  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['fi-c0150301'],
  );
});

test('Fintraffic ground elevation uses a reported altitude and falls back otherwise', async () => {
  const cameras = await loadWith([
    station('C08508', {
      altitude: 136,
      presets: [{ id: 'C0850801', inCollection: true }],
    }),
    station('C01503', {
      altitude: 0,
      presets: [{ id: 'C0150301', inCollection: true }],
    }),
    station('C03506', {
      altitude: 99_000,
      presets: [{ id: 'C0350601', inCollection: true }],
    }),
  ]);

  const byId = new Map(cameras.map((camera) => [camera.id, camera]));
  assert.equal(byId.get('fi-c0850801').groundElevationM, 136);
  // 0 is "not reported", not sea level.
  assert.equal(
    byId.get('fi-c0150301').groundElevationM,
    FINTRAFFIC_GROUND_ELEVATION_M,
  );
  // A garbage upstream value cannot fling a camera kilometres up.
  assert.equal(byId.get('fi-c0350601').groundElevationM, 1400);
});

test('Fintraffic loader identifies itself to Digitraffic and refuses redirects', async () => {
  const capture = {};
  await loadWith(
    [station('C01503', { presets: [{ id: 'C0150301', inCollection: true }] })],
    { capture },
  );

  assert.equal(capture.url, FINTRAFFIC_STATIONS_URL);
  assert.equal(capture.options.headers['Digitraffic-User'], 'gods-eye-view');
  assert.equal(capture.options.headers['Accept-Encoding'], 'gzip');
  assert.equal(capture.options.redirect, 'manual');
  assert.ok(capture.options.signal instanceof AbortSignal);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(null, {
      status: 302,
      headers: { Location: 'https://example.com/stations' },
    });
  try {
    assert.deepEqual(await loadFintrafficSourcesFromOpenData(), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Fintraffic pack caps itself and fails to an empty list, never a throw', async () => {
  const presets = Array.from({ length: 40 }, (_, index) => ({
    id: `C01503${String(index).padStart(2, '0')}`,
    inCollection: true,
  }));
  const capped = await loadWith([station('C01503', { presets })], {
    env: { CCTV_FINTRAFFIC_MAX_SOURCES: '8' },
  });
  assert.equal(capped.length, 8);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  try {
    assert.deepEqual(await loadFintrafficSourcesFromOpenData(), []);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async () => new Response('nope', { status: 503 });
  try {
    assert.deepEqual(await loadFintrafficSourcesFromOpenData(), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fintrafficCameraName unpacks the machine station name and the view number', () => {
  assert.equal(
    fintrafficCameraName('vt3_Hyvinkää_Noppo', 'C01234', 'C0123402'),
    'vt3 Hyvinkää Noppo (view 02)',
  );
  // Nameless station still gets a usable label.
  assert.equal(
    fintrafficCameraName('', 'C01234', 'C0123409'),
    'Fintraffic C01234 (view 09)',
  );
  // A preset id that is just the station id has no view suffix to add.
  assert.equal(
    fintrafficCameraName('vt4_Mäntsälä', 'C01234', 'C01234'),
    'vt4 Mäntsälä',
  );
});

test('isLikelyFinlandCoordinate spans the catalog extent and rejects the rest', () => {
  assert.equal(isLikelyFinlandCoordinate(60.1699, 24.9384), true); // Helsinki
  assert.equal(isLikelyFinlandCoordinate(70.088512, 27.0), true); // Utsjoki, the northern extreme
  assert.equal(isLikelyFinlandCoordinate(59.856454, 19.618722), true); // the southwestern extreme
  assert.equal(isLikelyFinlandCoordinate(51.5074, -0.1278), false); // London
  assert.equal(isLikelyFinlandCoordinate(0, 0), false); // null island
  assert.equal(isLikelyFinlandCoordinate(NaN, 24.9384), false);
});

test('Fintraffic road-surface presets look down, road presets look out', async () => {
  const cameras = await loadWith([
    station('C01503', {
      presets: [
        { id: 'C0150301', inCollection: true }, // road view
        { id: 'C0150309', inCollection: true }, // "Tienpinta" — road surface
      ],
    }),
  ]);

  const byId = new Map(cameras.map((camera) => [camera.id, camera]));
  const road = byId.get('fi-c0150301');
  const surface = byId.get('fi-c0150309');

  assert.equal(road.pitchDeg, -18);
  assert.equal(road.rangeM, 145);
  assert.equal(road.mountHeightM, 8);

  assert.equal(surface.pitchDeg, FINTRAFFIC_SURFACE_POSE.pitchDeg);
  assert.equal(surface.rangeM, FINTRAFFIC_SURFACE_POSE.rangeM);
  assert.equal(surface.mountHeightM, FINTRAFFIC_SURFACE_POSE.mountHeightM);
  assert.ok(
    surface.pitchDeg < road.pitchDeg,
    'the surface pose must be the steeper of the two',
  );
  // Both stay inside the pose clamps src/data/cctv.js applies to every source,
  // so nothing here is silently rewritten on the client.
  for (const camera of [road, surface]) {
    assert.ok(camera.pitchDeg >= -55 && camera.pitchDeg <= -2);
    assert.ok(camera.mountHeightM >= 6 && camera.mountHeightM <= 120);
    assert.ok(camera.fovDeg >= 20 && camera.fovDeg <= 125);
  }
});
