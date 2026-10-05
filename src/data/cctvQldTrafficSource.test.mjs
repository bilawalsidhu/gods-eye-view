import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadQldTrafficSourcesFromOpenData,
  normalizeQldTrafficImageUrl,
  qldTrafficApiKey,
  qldTrafficApiUrl,
  qldTrafficCameraToSource,
} from '../../server/providers/cctv/sources.js';
import {
  QLDTRAFFIC_FLOODCAMS_URL,
  QLDTRAFFIC_WEBCAMS_URL,
} from '../../server/providers/cctv/constants.js';

const feature = (overrides = {}, props = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [153.026, -27.4705] },
  properties: {
    id: 5,
    url: 'https://api.qldtraffic.qld.gov.au/v1/webcams/5',
    description: 'Brisbane CBD - Riverside Expressway - North',
    direction: 'North',
    district: 'Metropolitan',
    locality: 'Brisbane City',
    postcode: '4000',
    image_url:
      'http://cameras.qldtraffic.qld.gov.au/cameras/riverside-north.jpg',
    ...props,
  },
  ...overrides,
});

test('QLDtraffic API key is server-side and sent as the documented apikey query param', () => {
  assert.equal(qldTrafficApiKey({ QLDTRAFFIC_API_KEY: '  qld-123  ' }), 'qld-123');
  const url = new URL(qldTrafficApiUrl(QLDTRAFFIC_WEBCAMS_URL, 'qld-123'));
  assert.equal(url.origin, 'https://api.qldtraffic.qld.gov.au');
  assert.equal(url.searchParams.get('apikey'), 'qld-123');
});

test('QLDtraffic image URLs are upgraded to HTTPS and pinned to the official host', () => {
  assert.equal(
    normalizeQldTrafficImageUrl(
      'http://cameras.qldtraffic.qld.gov.au/cameras/riverside.jpg',
    ),
    'https://cameras.qldtraffic.qld.gov.au/cameras/riverside.jpg',
  );
  assert.equal(
    normalizeQldTrafficImageUrl(
      'https://qldtraffic.qld.gov.au.evil.test/cameras/riverside.jpg',
    ),
    null,
  );
  assert.equal(normalizeQldTrafficImageUrl('not a url'), null);
});

test('QLDtraffic webcam feature maps to a CCTV image source', () => {
  const source = qldTrafficCameraToSource(feature(), 'webcam');
  assert.equal(source.id, 'qldtraffic-webcam-5');
  assert.equal(source.name, 'Brisbane CBD - Riverside Expressway - North');
  assert.equal(source.city, 'Brisbane City');
  assert.equal(source.provider, 'QLD Traffic');
  assert.equal(source.lat, -27.4705);
  assert.equal(source.lon, 153.026);
  assert.equal(source.headingDeg, 0);
  assert.equal(source.headingConfidence, 'high');
  assert.equal(source.sourceKind, 'qldtraffic-webcam');
  assert.match(source.license, /State of Queensland/);
  assert.equal(source.url, source.snapshotUrl);
});

test('QLDtraffic floodcam feature is namespaced separately', () => {
  const source = qldTrafficCameraToSource(
    feature({}, { id: 5, direction: '' }),
    'floodcam',
  );
  assert.equal(source.id, 'qldtraffic-floodcam-5');
  assert.equal(source.provider, 'QLD Traffic Flood Cameras');
  assert.equal(source.sourceKind, 'qldtraffic-floodcam');
  assert.equal(source.headingConfidence, 'low');
  assert.ok(Number.isFinite(source.headingDeg));
});

test('QLDtraffic mapping rejects off-host images and unusable coordinates', () => {
  assert.equal(
    qldTrafficCameraToSource(
      feature({}, { image_url: 'https://evil.example/frame.jpg' }),
      'webcam',
    ),
    null,
  );
  assert.equal(
    qldTrafficCameraToSource(
      feature({ geometry: { type: 'Point', coordinates: [151.2, -33.8] } }),
      'webcam',
    ),
    null,
  );
  assert.equal(qldTrafficCameraToSource(feature({}, { id: '' }), 'webcam'), null);
});

test('QLDtraffic loader fetches webcams and floodcams only when a key is configured', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const saved = process.env.QLDTRAFFIC_API_KEY;
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json({ type: 'FeatureCollection', features: [feature()] });
  });
  try {
    delete process.env.QLDTRAFFIC_API_KEY;
    assert.deepEqual(await loadQldTrafficSourcesFromOpenData(), []);
    assert.deepEqual(requested, []);

    process.env.QLDTRAFFIC_API_KEY = 'qld-123';
    const cameras = await loadQldTrafficSourcesFromOpenData();
    assert.deepEqual(
      requested.map((url) => new URL(url).origin + new URL(url).pathname),
      [QLDTRAFFIC_WEBCAMS_URL, QLDTRAFFIC_FLOODCAMS_URL],
    );
    assert.deepEqual(
      requested.map((url) => new URL(url).searchParams.get('apikey')),
      ['qld-123', 'qld-123'],
    );
    assert.deepEqual(
      cameras.map((camera) => camera.id).sort(),
      ['qldtraffic-floodcam-5', 'qldtraffic-webcam-5'],
    );
  } finally {
    if (saved === undefined) delete process.env.QLDTRAFFIC_API_KEY;
    else process.env.QLDTRAFFIC_API_KEY = saved;
  }
});
