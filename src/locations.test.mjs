import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  CANCELLED_SEARCH,
  GLOBE_VIEW,
  flyToGlobeView,
  geocodeNavigationMode,
  regionFramingPlan,
  searchAndFlyTo,
} from './locations.js';

function viewer() {
  const flights = [];
  return {
    flights,
    scene: { globe: null },
    camera: {
      positionCartographic: {
        longitude: Cesium.Math.toRadians(24.94),
        latitude: Cesium.Math.toRadians(60.17),
        height: 1_200,
      },
      cancelFlight() {},
      flyTo(options) { flights.push(options); },
      flyToBoundingSphere(sphere, options) { flights.push({ sphere, ...options }); },
      lookAt() {},
      lookAtTransform() {},
    },
  };
}

async function withAzureSearch(body, action) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    return { result: await action(), calls };
  } finally {
    globalThis.fetch = previous;
  }
}

test('normalized Azure result types retain navigation modes', () => {
  assert.equal(geocodeNavigationMode(['country']), 'region-overview');
  assert.equal(geocodeNavigationMode(['locality']), 'city-overview');
  assert.equal(geocodeNavigationMode(['neighborhood']), 'neighborhood-close');
  assert.equal(geocodeNavigationMode(['route']), 'street-corridor');
  assert.equal(geocodeNavigationMode(['point_of_interest']), 'precise-place');
});

test('place search uses the same-origin Azure Maps BFF and flies to the result', async () => {
  const map = viewer();
  const { result, calls } = await withAzureSearch({
    results: [{
      id: 'helsinki',
      type: 'Geography',
      name: 'Helsinki',
      position: { latitude: 60.1699, longitude: 24.9384 },
      address: { freeformAddress: 'Helsinki, Finland', entityType: 'Municipality' },
    }],
  }, () => searchAndFlyTo(map, 'Helsinki'));
  assert.equal(new URL(calls[0].url, 'https://satview.test').pathname, '/api/azure/maps/search');
  assert.equal(result.label, 'Helsinki, Finland');
  assert.equal(result.navigationMode, 'city-overview');
  assert.equal(map.flights.length, 1);
});

test('navigation authority can cancel before camera mutation', async () => {
  const map = viewer();
  const { result } = await withAzureSearch({
    results: [{
      id: 'helsinki',
      type: 'Street',
      name: 'Aleksanterinkatu',
      position: { latitude: 60.1704, longitude: 24.9522 },
    }],
  }, () => searchAndFlyTo(map, 'Aleksanterinkatu', { beforeFly: () => false }));
  assert.equal(result, CANCELLED_SEARCH);
  assert.equal(map.flights.length, 0);
});

test('natural region framing caps very large bounds', () => {
  const plan = regionFramingPlan({
    southwest: { lat: 20, lng: -120 },
    northeast: { lat: 60, lng: -80 },
  });
  assert.equal(plan.mode, 'swath');
  assert.ok(plan.rangeM < 1_000_000);
});

test('globe view uses the absolute full-earth height', () => {
  const map = viewer();
  const result = flyToGlobeView(map);
  assert.equal(result.heightM, GLOBE_VIEW.heightM);
  assert.equal(map.flights.length, 1);
});
