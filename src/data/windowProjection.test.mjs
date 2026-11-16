import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createWindowProjector } from './windowProjection.js';

function sceneLooking(
  lon,
  lat,
  heightM,
  pitchDeg,
  mode = Cesium.SceneMode.SCENE3D,
) {
  const scene = {
    canvas: { clientWidth: 1713, clientHeight: 941 },
    drawingBufferWidth: 1713,
    drawingBufferHeight: 941,
    mapProjection: new Cesium.GeographicProjection(),
    ellipsoid: Cesium.Ellipsoid.WGS84,
    frameState: { mode, mapProjection: new Cesium.GeographicProjection() },
    globe: undefined,
    tweens: { add() {} },
    screenSpaceCameraController: { minimumZoomDistance: 1 },
  };
  scene.camera = new Cesium.Camera(scene);
  scene.camera.frustum.aspectRatio = 1713 / 941;
  scene.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, heightM),
    orientation: {
      heading: 0.3,
      pitch: Cesium.Math.toRadians(pitchDeg),
      roll: 0,
    },
  });
  return scene;
}

function positionsAround(lon, lat, spreadDeg, count) {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: count }, () =>
    Cesium.Cartesian3.fromDegrees(
      lon + (rnd() - 0.5) * spreadDeg,
      lat + (rnd() - 0.5) * spreadDeg,
      rnd() * 50,
    ),
  );
}

test('a 3D perspective projector gives the same numbers Cesium gives', () => {
  for (const [pitch, spread, heightM] of [
    [-90, 1, 60_000],
    [-35, 4, 60_000],
    [-5, 40, 60_000],
    // Just above the sea, points near and behind the near plane.
    [-10, 0.002, 3],
  ]) {
    const scene = sceneLooking(4.1, 51.95, heightM, pitch);
    const project = createWindowProjector(scene);
    let behind = 0;
    for (const position of positionsAround(4.1, 51.95, spread, 2000)) {
      const expected = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        position,
        new Cesium.Cartesian2(),
      );
      const actual = project(position, new Cesium.Cartesian2());
      if (!expected) {
        behind++;
        assert.equal(actual, undefined);
        continue;
      }
      assert.equal(actual.x, expected.x);
      assert.equal(actual.y, expected.y);
    }
    if (pitch === -5)
      assert.ok(behind > 0, 'some positions fall behind the camera');
  }
});

test('outside a 3D scene the projector asks Cesium', () => {
  const scene = sceneLooking(
    4.1,
    51.95,
    60_000,
    -90,
    Cesium.SceneMode.COLUMBUS_VIEW,
  );
  const calls = [];
  const original = Cesium.SceneTransforms.worldToWindowCoordinates;
  Cesium.SceneTransforms.worldToWindowCoordinates = (...args) => {
    calls.push(args);
    return args[2];
  };
  try {
    const result = new Cesium.Cartesian2();
    const position = Cesium.Cartesian3.fromDegrees(4.1, 51.95);
    assert.equal(createWindowProjector(scene)(position, result), result);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], position);
  } finally {
    Cesium.SceneTransforms.worldToWindowCoordinates = original;
  }
});

test('at the eye itself, or with no position, the projector asks Cesium', () => {
  const scene = sceneLooking(4.1, 51.95, 60_000, -90);
  const original = Cesium.SceneTransforms.worldToWindowCoordinates;
  const asked = [];
  Cesium.SceneTransforms.worldToWindowCoordinates = (_scene, position) => {
    asked.push(position);
    return undefined;
  };
  try {
    const project = createWindowProjector(scene);
    const eye = Cesium.Cartesian3.clone(scene.camera.positionWC);
    assert.equal(project(eye, new Cesium.Cartesian2()), undefined);
    assert.equal(project(undefined, new Cesium.Cartesian2()), undefined);
    assert.deepEqual(asked, [eye, undefined]);
  } finally {
    Cesium.SceneTransforms.worldToWindowCoordinates = original;
  }
});
