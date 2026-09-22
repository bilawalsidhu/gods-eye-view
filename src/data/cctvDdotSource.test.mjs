import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ddotFeatureToSource,
  ddotCatalogId,
  loadDdotSourcesFromGis,
} from '../../server/providers/cctv/ddot.js';
import { DDOT_CCTV_FEATURE_QUERY_URL } from '../../server/providers/cctv/constants.js';

const sampleFeature = {
  attributes: {
    CameraID: 9,
    Location: '14 St Bridge',
    Description: 'Legacy Upgraded',
    Operation_Status: 1,
    Latitude: 38.88259888,
    Longitude: -77.03269958,
  },
  geometry: { x: -77.03270187720878, y: 38.882606659864386 },
};

test('ddotCatalogId prefixes stable ids', () => {
  assert.equal(ddotCatalogId(9), 'ddot:9');
  assert.equal(ddotCatalogId(''), null);
});

test('ddotFeatureToSource maps active GIS features without live media URLs', () => {
  const source = ddotFeatureToSource(sampleFeature);
  assert.ok(source);
  assert.equal(source.id, 'ddot:9');
  assert.equal(source.name, '14 St Bridge');
  assert.equal(source.provider, 'District Department of Transportation / DC GIS');
  assert.equal(source.sourceKind, 'ddot-gis-location-only');
  assert.equal(source.url, '');
  assert.equal(source.feedType, 'image');
});

test('ddotFeatureToSource rejects inactive cameras', () => {
  assert.equal(
    ddotFeatureToSource({
      ...sampleFeature,
      attributes: { ...sampleFeature.attributes, Operation_Status: 0 },
    }),
    null,
  );
});

test('ddotFeatureToSource rejects coordinates outside DC', () => {
  assert.equal(
    ddotFeatureToSource({
      ...sampleFeature,
      attributes: {
        ...sampleFeature.attributes,
        Latitude: 39.5,
        Longitude: -76.6,
      },
    }),
    null,
  );
});

test('ddot loader queries the official FeatureServer endpoint', async (t) => {
  t.mock.method(console, 'log', () => {});
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json({ features: [sampleFeature] });
  });
  const cameras = await loadDdotSourcesFromGis();
  assert.deepEqual(requested, [DDOT_CCTV_FEATURE_QUERY_URL]);
  assert.deepEqual(cameras.map((c) => c.id), ['ddot:9']);
});
