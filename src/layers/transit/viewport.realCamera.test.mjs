import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { transitFeedsInView } from '../../data/transitFeeds.js';
import { createViewport } from './viewport.js';

/**
 * A real Cesium camera on a stub scene of the given canvas size, so
 * `computeViewRectangle` returns what the browser gets (four screen corners
 * picked on the ellipsoid), not a hand-written rectangle.
 */
function realCamera(width, height) {
  const scene = {
    canvas: { clientWidth: width, clientHeight: height, width, height },
    drawingBufferWidth: width,
    drawingBufferHeight: height,
    mapProjection: new Cesium.GeographicProjection(),
    globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    preRender: new Cesium.Event(),
    postUpdate: new Cesium.Event(),
    screenSpaceCameraController: { maximumZoomDistance: Infinity },
  };
  const camera = new Cesium.Camera(scene);
  scene.camera = camera;
  return { scene, camera };
}

/** Whether a ground point is inside the camera frustum and on the near side. */
function onScreen(camera, lat, lon) {
  const p = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
  const normal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
    p,
    new Cesium.Cartesian3(),
  );
  const toCamera = Cesium.Cartesian3.subtract(
    camera.positionWC,
    p,
    new Cesium.Cartesian3(),
  );
  if (Cesium.Cartesian3.dot(normal, toCamera) <= 0) return false;
  const eye = Cesium.Matrix4.multiplyByPoint(
    camera.viewMatrix,
    p,
    new Cesium.Cartesian3(),
  );
  if (eye.z >= 0) return false;
  const tanY = Math.tan(camera.frustum.fovy / 2);
  const tanX = tanY * camera.frustum.aspectRatio;
  return Math.abs(eye.x / -eye.z) <= tanX && Math.abs(eye.y / -eye.z) <= tanY;
}

/** Feeds the layer polls for a camera over (lat, lon) at `km`. */
function polledFor({ width, height, lat, lon, km, heading = 0, pitch = -90 }) {
  const { scene, camera } = realCamera(width, height);
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, km * 1000),
    orientation: {
      heading: Cesium.Math.toRadians(heading),
      pitch: Cesium.Math.toRadians(pitch),
      roll: 0,
    },
  });
  const polled = [];
  const state = {
    _enabled: true,
    _viewer: { camera, scene },
    _altitudeGateOpen: false,
    _activeFeeds: new Map(),
    _inFlight: new Map(),
    _feedStatus: new Map(),
    _generation: 0,
    _cameraRevision: 0,
  };
  createViewport({
    state,
    services: { render: { governorRequestRender() {} } },
    parts: {
      rendering: { requestVisibility() {}, syncRenderHold() {} },
      ingestion: {
        pollFeed: (feed) => polled.push(feed.id),
        removeFeedVehicles() {},
        sweepAgedVehicles() {},
      },
    },
  }).runProximityCheck();
  return { polled, camera };
}

// Mainland Norway's extremes: south, west, north and east.
const NORWAY = {
  Lindesnes: [57.98, 7.05],
  Utvær: [61.04, 4.5],
  Nordkapp: [71.17, 25.78],
  Vardø: [70.37, 31.11],
  'Grense Jakobselv': [69.79, 30.95],
};

for (const view of [
  // Centre of mainland Norway's extent, on a 16:9 desktop.
  { width: 1920, height: 1080, lat: 64.5, lon: 17.8, km: 2600 },
  { width: 1280, height: 720, lat: 64.5, lon: 17.8, km: 2600 },
  // A 16:10 laptop fits the country a little lower.
  { width: 1440, height: 900, lat: 64.5, lon: 17.8, km: 2250 },
  // Centred over the Norwegian coast.
  { width: 1920, height: 1080, lat: 65, lon: 14, km: 2600 },
]) {
  test(`a whole-Norway view on ${view.width}×${view.height} over ${view.lat}/${view.lon} at ${view.km} km polls Entur`, () => {
    const { polled, camera } = polledFor(view);
    for (const [place, [lat, lon]] of Object.entries(NORWAY)) {
      assert.ok(onScreen(camera, lat, lon), `${place} is on screen`);
    }
    assert.ok(
      polled.includes('entur-norway'),
      `polled: [${polled.join(', ')}]`,
    );
  });
}

// A close view of a neighbouring city uses the centre rule.
for (const [place, lat, lon, km] of [
  ['Karlstad', 59.38, 13.5, 200],
  ['Umeå', 63.83, 20.26, 20],
]) {
  test(`a close view of ${place} does not poll Entur`, () => {
    const { polled } = polledFor({ width: 1920, height: 1080, lat, lon, km });
    assert.equal(polled.includes('entur-norway'), false);
  });
}

test('a view that reaches the horizon keeps the centre rule', () => {
  // 1,000 km up over Utrecht, tilted 60 degrees off nadir to the south: the
  // top of the screen is sky, and the camera's view rectangle reaches Norway.
  const { polled, camera } = polledFor({
    width: 1920,
    height: 1080,
    lat: 52.09,
    lon: 5.12,
    km: 1000,
    heading: 180,
    pitch: -30,
  });
  assert.equal(
    camera.pickEllipsoid(new Cesium.Cartesian2(960, 0)),
    undefined,
    'sky at the top',
  );
  const rect = camera.computeViewRectangle(Cesium.Ellipsoid.WGS84);
  const degrees = Object.fromEntries(
    ['west', 'south', 'east', 'north'].map((k) => [
      k,
      Cesium.Math.toDegrees(rect[k]),
    ]),
  );
  assert.ok(transitFeedsInView(degrees).some((f) => f.id === 'entur-norway'));
  assert.deepEqual(polled, ['ovapi-nl']);
});
