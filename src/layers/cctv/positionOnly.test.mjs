// Client-side half of the position-only contract: a camera whose operator
// publishes no imagery must never enter the frame-fetch rotation, and must
// never be handed a frame/media URL. The server refuses these requests with a
// 409 (see src/data/cctvPositionOnly.test.mjs); these pin that the layer does
// not make them in the first place.
//
// Run with: npm test   (node --test)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog } from './catalog.js';
import { createModel } from './model.js';

const POSITION_ONLY_SOURCE = {
  id: 'ams-fixture',
  name: 'Nassaukade (ANPR — S100 ring)',
  city: 'Amsterdam',
  provider: 'Gemeente Amsterdam',
  lat: 52.3786,
  lon: 4.8779,
  headingDeg: 90,
  feedType: 'image',
  mediaAvailability: 'position-only',
};

const PUBLIC_SOURCE = {
  id: 'public-fixture',
  name: 'Public fixture',
  city: 'Austin',
  provider: 'Austin Transportation & Public Works',
  lat: 30.27,
  lon: -97.74,
  headingDeg: 90,
  feedType: 'image',
  url: 'https://upstream.invalid/frame.jpg',
};

/** The slice of `parts.model` that buildCatalogFromSources actually uses. */
function catalogModelStub() {
  return {
    safeNumber: (value, fallback = NaN) =>
      Number.isFinite(Number(value)) ? Number(value) : fallback,
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    normalizeHeading: (deg) => ((deg % 360) + 360) % 360,
    headingFromId: () => 0,
    normalizeFeedType: (value) => String(value || 'image'),
    ensureCameraPose: () => {},
  };
}

function buildCatalog(sources) {
  const catalog = createCatalog({
    state: {},
    services: { locations: { CITY_POIS: {} } },
    parts: { model: catalogModelStub() },
    source: {},
  });
  return catalog.buildCatalogFromSources(sources);
}

test('the catalog carries media availability onto the camera record', () => {
  const cameras = buildCatalog([POSITION_ONLY_SOURCE, PUBLIC_SOURCE]);
  const byId = new Map(cameras.map((camera) => [camera.id, camera]));
  assert.equal(byId.get('ams-fixture').mediaAvailability, 'position-only');
  // Every existing pack is untouched and keeps the live-frame fallback.
  assert.equal(byId.get('public-fixture').mediaAvailability, 'public');
});

test('an unknown media-availability value is read as public, not position-only', () => {
  // Fail-safe direction: a typo must never blind a pack that has frames.
  const [camera] = buildCatalog([
    { ...PUBLIC_SOURCE, mediaAvailability: 'no-public-media' },
  ]);
  assert.equal(camera.mediaAvailability, 'public');
});

/**
 * Drive the real card-frame pacer over a fixed set of cameras and report
 * which one, if any, it chose to fetch.
 */
function runCardFrameTick(cameras) {
  const records = cameras.map((camera) => ({ camera }));
  const layerState = {
    _enabled: true,
    _cardIds: new Set(cameras.map((camera) => camera.id)),
    _recordById: new Map(records.map((record) => [record.camera.id, record])),
    _cardFetchPendingIds: new Set(),
    _cardFetchImages: new Set(),
    _activeCameraCardEnabled: false,
    _activeCameraId: null,
    _geoLoading: false,
    _cardFetchInFlightCount: 0,
    _cardLastFetchAt: 0,
    _cardFetchMode: 'steady',
    _viewer: null,
  };
  const fetched = [];
  const model = createModel({
    state: layerState,
    services: { focus: { focusPassIsNeeded: () => false, getFocusTarget: () => null } },
    parts: {
      cards: {
        // A slot that has never held a frame — the strongest pull on the
        // pacer, so a position-only camera that is merely deprioritized
        // rather than excluded would still be picked here.
        ensureCardFrameSlot: () => ({ stamp: 0, failures: 0, nextAttemptAt: 0 }),
        fetchCardFrame: (record) => fetched.push(record.camera.id),
      },
      calibration: { normalizeCalibration: (value) => value },
    },
    source: {},
  });
  model.cardFrameTick();
  return fetched;
}

test('the card pacer never requests a frame for a position-only camera', () => {
  const cameras = buildCatalog([POSITION_ONLY_SOURCE]);
  assert.deepEqual(runCardFrameTick(cameras), []);
});

test('the card pacer still requests frames for ordinary cameras', () => {
  // Regression guard: the skip must be scoped to the declaration rather than
  // quietly stalling the whole rotation.
  const cameras = buildCatalog([PUBLIC_SOURCE]);
  assert.deepEqual(runCardFrameTick(cameras), ['public-fixture']);
});

test('a position-only camera does not starve its neighbours in the rotation', () => {
  const cameras = buildCatalog([POSITION_ONLY_SOURCE, PUBLIC_SOURCE]);
  assert.deepEqual(runCardFrameTick(cameras), ['public-fixture']);
});
