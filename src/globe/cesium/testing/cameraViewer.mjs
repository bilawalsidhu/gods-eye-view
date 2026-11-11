// A Cesium viewer around a real Cesium.Camera on a stub scene (no renderer,
// GPU or providers), with the Cesium engine over it: for tests that check
// what the globe contract does to Cesium's own camera geometry. The scene's
// primitives are a real PrimitiveCollection, so mover sets and lines build
// their Cesium collections (they draw nothing).

import * as Cesium from 'cesium';
import { createCesiumEngine } from '../createCesiumEngine.js';

/**
 * @param {{ width?: number, height?: number, engineOptions?: object }} [options]
 *   The canvas size; `engineOptions` go to createCesiumEngine.
 * @returns {{ viewer: object, scene: object, camera: Cesium.Camera,
 *   canvas: EventTarget, engine: import('../../contract.js').GlobeEngine,
 *   frame: () => void }} `frame()` runs one turn of CesiumWidget's loop: the
 *   viewer clock's tick, then the scene's frame events.
 */
export function createCameraViewer({
  width = 1280,
  height = 800,
  engineOptions = {},
} = {}) {
  const canvas = Object.assign(new EventTarget(), {
    clientWidth: width,
    clientHeight: height,
    width,
    height,
  });
  const ellipsoid = Cesium.Ellipsoid.WGS84;
  const scene = {
    canvas,
    drawingBufferWidth: width,
    drawingBufferHeight: height,
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    mapProjection: new Cesium.GeographicProjection(ellipsoid),
    globe: { ellipsoid },
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    // Cesium's running camera flights.
    tweens: [],
    primitives: new Cesium.PrimitiveCollection(),
    preUpdate: new Cesium.Event(),
    preRender: new Cesium.Event(),
    postRender: new Cesium.Event(),
    requestRender() {},
  };
  const camera = new Cesium.Camera(scene);
  scene.camera = camera;
  let trackedEntity;
  const viewer = {
    scene,
    camera,
    canvas,
    container: {},
    trackedEntityChanged: new Cesium.Event(),
    // Assigning raises trackedEntityChanged, as Cesium's Viewer does.
    get trackedEntity() {
      return trackedEntity;
    },
    set trackedEntity(value) {
      if (value === trackedEntity) return;
      trackedEntity = value;
      viewer.trackedEntityChanged.raiseEvent(value);
    },
    clock: {
      onTick: new Cesium.Event(),
      currentTime: Cesium.JulianDate.fromIso8601('2026-10-16T12:00:00Z'),
    },
    isDestroyed: () => false,
  };
  const engine = createCesiumEngine(viewer, {
    requestRender: () => {},
    ...engineOptions,
  });
  const frame = () => {
    const time = viewer.clock.currentTime;
    viewer.clock.onTick.raiseEvent(viewer.clock);
    scene.preUpdate.raiseEvent(scene, time);
    scene.preRender.raiseEvent(scene, time);
    scene.postRender.raiseEvent(scene, time);
  };
  return { viewer, scene, camera, canvas, engine, frame };
}
