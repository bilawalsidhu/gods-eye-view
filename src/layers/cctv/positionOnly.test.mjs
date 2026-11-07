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
import { createCards } from './cards.js';
import { createHover } from './hover.js';
import { createProjection } from './projection.js';
import { createPresentation } from './presentation.js';
import * as Cesium from 'cesium';

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


test('position-only video declarations never create a video player or media request', (t) => {
  const priorDocument = globalThis.document;
  const priorImage = globalThis.Image;
  const created = [];
  globalThis.document = { createElement(tag) {
    created.push(tag);
    assert.equal(tag, 'canvas', 'no video player for a position-only source');
    return { getContext: () => ({}) };
  } };
  globalThis.Image = class {};
  t.after(() => { globalThis.document = priorDocument; globalThis.Image = priorImage; });
  const projection = createProjection({
    state: { _viewer: { entities: { add: (entry) => entry } } },
    services: { render: {} },
    parts: {
      model: { normalizeFeedType: (value) => value, isVideoFeedType: () => true, planeOrientationFor: () => Cesium.Quaternion.IDENTITY },
      frames: { paintProjectionPlaceholder() {}, mediaUrlFor() { assert.fail('no media URL'); } },
    }, source: {},
  });
  for (const feedType of ['mp4', 'webm', 'hls']) {
    const runtime = projection.createProjectionRuntime({
      camera: { ...POSITION_ONLY_SOURCE, feedType },
      frustumGeometry: { halfW: 1, halfH: 1 },
      frustumPositions: { capCenter: Cesium.Cartesian3.ZERO, label: Cesium.Cartesian3.ZERO },
    });
    assert.equal(runtime.mode, 'image');
    assert.equal(runtime.video, null);
  }
  assert.deepEqual(created, ['canvas', 'canvas', 'canvas']);
});

test('public camera state declares position-only before the first health poll', () => {
  const presentation = createPresentation({
    state: { _healthById: new Map() }, services: {}, source: {},
    parts: {
      selection: { getActiveRecord: () => null },
      model: { isVideoFeedType: () => true },
      calibration: { normalizeCalibration: () => ({}), deriveCalBadge: () => 'raw-prior' },
      frames: { frameUrlFor() { assert.fail('no frame URL'); }, mediaUrlFor() { assert.fail('no media URL'); } },
    },
  });
  const camera = presentation.getPublicCameraState({ camera: { ...POSITION_ONLY_SOURCE, feedType: 'hls' } });
  assert.equal(camera.sourceStatus, 'position-only');
  assert.equal(camera.sourceKind, 'position-only');
  assert.equal(camera.isVideo, false);
  assert.equal(camera.frameUrl, null);
  assert.equal(camera.mediaUrl, null);
});


test('position-only markers never allocate ambient or hover thumbnails', () => {
  const camera = POSITION_ONLY_SOURCE;
  const record = { camera, position: Cesium.Cartesian3.fromDegrees(camera.lon, camera.lat) };
  const published = [];
  const state = {
    _enabled: true, _records: [record], _viewRecords: [record], _recordById: new Map([[camera.id, record]]),
    _cardIds: new Set(), _cardGraceState: new Map(), _cardFrameSlots: new Map(),
    _hoverLastPickAt: 0, _hoverCardId: null,
    _viewer: { isDestroyed: () => false,
      camera: { positionWC: Cesium.Cartesian3.fromDegrees(camera.lon, camera.lat, 1000), positionCartographic: { latitude: camera.lat * Math.PI / 180, longitude: camera.lon * Math.PI / 180, height: 1000 } },
      scene: { canvas: { width: 1280, height: 800 }, cartesianToCanvasCoordinates: () => ({ x: 640, y: 400 }), pick: () => ({}) },
    },
    _cctvOverlayHost: { setEntries: (_, entries) => published.push(entries) },
  };
  const parts = {
    model: { haversineKm: () => 0, normalizeFeedType: (v) => v, isVideoFeedType: () => false },
    selection: { extractPickedCameraId: () => camera.id },
  };
  parts.cards = createCards({ state, services: {}, parts, source: {} });
  parts.cards.refreshAmbientCards();
  assert.equal(state._cardIds.size, 0);
  const hover = createHover({ state, services: {}, parts, source: {} });
  hover.handleHoverMove({ x: 640, y: 400 });
  assert.equal(state._hoverCardId, null);
  // Even stale/pinned selection state cannot publish an empty card.
  state._cardIds.add(camera.id);
  state._hoverCardId = camera.id;
  parts.cards.pushAmbientCardEntries();
  assert.deepEqual(published.flat(), []);
  assert.equal(state._cardFrameSlots.size, 0);
});
