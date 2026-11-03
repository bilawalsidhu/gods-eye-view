import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockPaidQaMaps,
  KEYLESS_PROBES,
  probePattern,
  strictBlockPatterns,
} from './qa-map-policy.mjs';

test('routine QA blocks direct Google tiles, hosted Google assets and token fallback', async () => {
  const calls = [];
  const page = {
    createCDPSession: async () => ({
      send: async (...args) => calls.push(args),
    }),
  };
  await blockPaidQaMaps(page);
  assert.equal(calls[0][0], 'Network.enable');
  assert.equal(calls[1][0], 'Network.setBlockedURLs');
  assert.ok(calls[1][1].urls.includes('*://tile.googleapis.com/*'));
  assert.ok(
    calls[1][1].urls.includes('*://api.cesium.com/v1/assets/2275207/*'),
  );
  assert.ok(calls[1][1].urls.includes('*/api/google/tiles*'));
});

test('a necessary 3D-specific check must explicitly opt out of the request block', async () => {
  await blockPaidQaMaps(
    { createCDPSession: () => assert.fail('unexpected block') },
    { allowPaidMaps: true },
  );
});

test('the strict policy blocks paid hosts and routes first and everything unlisted last', () => {
  const patterns = strictBlockPatterns('http://127.0.0.1:4208', {
    fixtures: ['https://tiles.dontgetflocked.com/*'],
  });
  const decide = (url) =>
    patterns.find(({ urlPattern }) => new URLPattern(urlPattern).test(url))
      ?.block;
  for (const url of [
    'https://tile.googleapis.com/v1/3dtiles/root.json',
    'https://maps.googleapis.com/maps/api/js',
    'https://fonts.gstatic.com/s/inter.woff2',
    'https://api.cesium.com/v1/assets/1/endpoint',
    'https://assets.ion.cesium.com/google-credit.png',
    'http://127.0.0.1:4208/api/openai/hud-summary',
    'http://127.0.0.1:4208/api/realtime/token',
    'http://127.0.0.1:4208/api/google/nearby-places?lat=1',
    'https://example.com/anything',
    'wss://example.com/socket',
  ])
    assert.equal(decide(url), true, url);
  for (const url of [
    'http://127.0.0.1:4208/assets/index.js',
    'http://127.0.0.1:4208/api/flights',
    'https://tiles.dontgetflocked.com/cameras-us-hourly/1/2/3.mvt',
    'https://tile.openstreetmap.org/1/2/3.png',
    'https://terrain.reearth.land/cesium-mesh/layer.json',
    'https://tiles.maps.eox.at/wmts/1.0.0/s2/1/2/3.jpg',
  ])
    assert.equal(decide(url), false, url);
});

test('the keyless probes are let through only to their exact routes', () => {
  const patterns = strictBlockPatterns('http://127.0.0.1:4208');
  const decide = (url) =>
    patterns.find(({ urlPattern }) => new URLPattern(urlPattern).test(url))
      ?.block;
  for (const probe of KEYLESS_PROBES) {
    const url = probePattern('http://127.0.0.1:4208', probe).replace(
      /\*$/,
      '?family=Inter',
    );
    assert.equal(decide(url), false, url);
  }
  assert.equal(
    decide('http://127.0.0.1:4208/api/openai/hud-summary'),
    true,
    'the paid summary itself stays blocked',
  );
  assert.equal(decide('https://fonts.googleapis.com/icon?family=x'), true);
});
