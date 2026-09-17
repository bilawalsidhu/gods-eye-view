import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_KING_COUNTY_MAX_SOURCES,
  KING_COUNTY_CAMERAS_URL,
} from '../../server/providers/cctv/constants.js';
import { loadKingCountySourcesFromOpenData } from '../../server/providers/cctv/sources.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';

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

/** A FeatureServer GeoJSON feature carrying the fields the loader reads. */
function kingCountyFeature(id, lat, lon, overrides = {}) {
  const { properties = {}, geometry } = overrides;
  return {
    type: 'Feature',
    geometry:
      geometry === undefined
        ? { type: 'Point', coordinates: [lon, lat] }
        : geometry,
    properties: {
      AssetID: id,
      Location: `Road ${id} at Test Ave`,
      ImageURL: `http://info.kingcounty.gov/transportation/kcdot/Roads/TrafficCameras/ImageHandler/Handler.ashx?id=cam${id}.jpg`,
      Live: 1,
      Model: '3950',
      Manufacturer: 'Cohu',
      Owner: 'King County',
      CurrentStatus: 'Active',
      ...properties,
    },
  };
}

test('King County loader keeps live county cameras and upgrades frame URLs to HTTPS', async (t) => {
  quiet(t);
  withEnv(t, { CCTV_KINGCOUNTY_MAX_SOURCES: undefined });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json({
      type: 'FeatureCollection',
      features: [
        kingCountyFeature(56, 47.70059, -122.02443, {
          properties: {
            Location: 'NE Novelty Hill Road at Trilogy Parkway NE',
            // The live layer carries stray whitespace in model strings.
            Model: 'Q6135-LE\n',
            Manufacturer: 'Axis',
          },
        }),
        // City-owned camera the county hosts: kept, owner becomes the credit.
        kingCountyFeature(90, 47.674, -122.119, {
          properties: { Owner: 'City of Redmond', Model: null },
        }),
        // WSDOT-owned row: the statewide WSDOT pack is its home.
        kingCountyFeature(70, 47.6, -122.3, { properties: { Owner: 'WSDOT' } }),
        // Off-host frame, not live, retired, bad id, bad geometry, out of county.
        kingCountyFeature(71, 47.6, -122.3, {
          properties: { ImageURL: 'https://example.com/cam71.jpg' },
        }),
        kingCountyFeature(72, 47.6, -122.3, { properties: { Live: 0 } }),
        kingCountyFeature(73, 47.6, -122.3, {
          properties: { CurrentStatus: 'Retired' },
        }),
        kingCountyFeature('74', 47.6, -122.3),
        kingCountyFeature(75, 47.6, -122.3, { geometry: null }),
        kingCountyFeature(76, 34.05, -118.24),
      ],
    });
  });

  const cameras = await loadKingCountySourcesFromOpenData();

  assert.deepEqual(requested, [KING_COUNTY_CAMERAS_URL]);
  assert.deepEqual(cameras.map((camera) => camera.id).sort(), [
    'kingcounty-56',
    'kingcounty-90',
  ]);

  const novelty = cameras.find((camera) => camera.id === 'kingcounty-56');
  assert.equal(novelty.name, 'NE Novelty Hill Road at Trilogy Parkway NE');
  assert.equal(novelty.provider, 'King County Road Services');
  assert.equal(
    novelty.url,
    'https://info.kingcounty.gov/transportation/kcdot/Roads/TrafficCameras/ImageHandler/Handler.ashx?id=cam56.jpg',
  );
  assert.equal(novelty.snapshotUrl, novelty.url);
  assert.equal(novelty.feedType, 'image');
  // Published hardware model rides along, whitespace-collapsed.
  assert.equal(novelty.model, 'Q6135-LE');
  assert.equal(novelty.credit, '');
  // No facing in the layer: id-hash fallback at low confidence.
  assert.equal(novelty.headingConfidence, 'low');
  assert.equal(novelty.fovDeg, 44);
  assert.ok(novelty.headingDeg >= 0 && novelty.headingDeg < 360);

  const redmond = cameras.find((camera) => camera.id === 'kingcounty-90');
  assert.equal(redmond.credit, 'City of Redmond');
  assert.equal(redmond.model, undefined);
});

test('normalizeSourceItem passes a hardware model through and omits it otherwise', () => {
  const withModel = normalizeSourceItem({
    id: 'kingcounty-56',
    lat: 47.7,
    lon: -122.0,
    model: ' Q6135-LE ',
  });
  assert.equal(withModel.model, 'Q6135-LE');

  const withoutModel = normalizeSourceItem({
    id: 'austin-1',
    lat: 30.3,
    lon: -97.7,
  });
  assert.equal(withoutModel.model, undefined);
  assert.equal(normalizeSourceItem({ id: 'x', model: '   ' }).model, undefined);
});

test('King County loader honors the max-sources cap', async (t) => {
  quiet(t);
  withEnv(t, { CCTV_KINGCOUNTY_MAX_SOURCES: '8' });
  const features = [];
  for (let i = 0; i < 24; i += 1) {
    features.push(
      kingCountyFeature(100 + i, 47.2 + i * 0.02, -122.4 + i * 0.02),
    );
  }
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ type: 'FeatureCollection', features }),
  );

  const cameras = await loadKingCountySourcesFromOpenData();
  assert.equal(cameras.length, 8);
});

test('King County loader defaults its cap and survives upstream failure', async (t) => {
  quiet(t);
  withEnv(t, { CCTV_KINGCOUNTY_MAX_SOURCES: undefined });
  assert.equal(DEFAULT_KING_COUNTY_MAX_SOURCES, 125);

  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 503 }),
  );
  assert.deepEqual(await loadKingCountySourcesFromOpenData(), []);

  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down');
  });
  assert.deepEqual(await loadKingCountySourcesFromOpenData(), []);
});
