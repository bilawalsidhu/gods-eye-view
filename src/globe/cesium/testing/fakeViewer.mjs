// A recording stand-in for a Cesium Viewer, for the Cesium engine's unit tests.
// It carries real Cesium value types and events (no WebGL) and records every
// call into `viewer.calls` so tests can check what reached which Cesium member.

import * as Cesium from 'cesium';

/** A fake viewer whose members record their calls. */
export function createFakeViewer({ width = 1024, height = 768 } = {}) {
  const calls = [];
  const record =
    (name, value) =>
    (...args) => {
      calls.push({ name, args });
      return typeof value === 'function' ? value(...args) : value;
    };
  const primitiveList = [];
  const entityList = [];
  let trackedEntity;
  const imageryList = [];
  const staticCredits = [];
  const creditDisplay = {
    addStaticCredit: record('creditDisplay.addStaticCredit', (credit) =>
      staticCredits.push(credit),
    ),
    removeStaticCredit: record('creditDisplay.removeStaticCredit', (credit) => {
      const index = staticCredits.indexOf(credit);
      if (index >= 0) staticCredits.splice(index, 1);
    }),
  };
  const fovy = 2 * Math.atan(Math.tan(Math.PI / 6) * (height / width));
  const camera = {
    positionWC: new Cesium.Cartesian3(7e6, 1e5, 2e5),
    // Position and basis in the camera's transform (identity: world).
    position: new Cesium.Cartesian3(7e6, 1e5, 2e5),
    direction: new Cesium.Cartesian3(-1, 0, 0),
    up: new Cesium.Cartesian3(0, 0, 1),
    right: new Cesium.Cartesian3(0, 1, 0),
    directionWC: new Cesium.Cartesian3(-1, 0, 0),
    upWC: new Cesium.Cartesian3(0, 0, 1),
    rightWC: new Cesium.Cartesian3(0, 1, 0),
    heading: Cesium.Math.TWO_PI,
    pitch: -Cesium.Math.PI_OVER_TWO,
    roll: Cesium.Math.TWO_PI,
    frustum: {
      fovy,
      aspectRatio: width / height,
      projectionMatrix: Cesium.Matrix4.fromArray([
        2, 0, 0, 0, 0, 3, 0, 0, 0, 0, -1, -1, 0, 0, -2, 0,
      ]),
    },
    viewMatrix: Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(1, 2, 3)),
    transform: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
    get inverseTransform() {
      return Cesium.Matrix4.inverseTransformation(
        camera.transform,
        new Cesium.Matrix4(),
      );
    },
    defaultZoomAmount: 100000,
    percentageChanged: 0.5,
    changed: new Cesium.Event(),
    moveStart: new Cesium.Event(),
    moveEnd: new Cesium.Event(),
    flights: [],
    setView: record('camera.setView'),
    flyTo: record('camera.flyTo', (options) => {
      // Cesium cancels a running flight before starting the next one.
      const previous = camera.flights.at(-1);
      if (previous && !previous.done) {
        previous.done = true;
        previous.options.cancel?.();
      }
      const flight = { options, done: false };
      camera.flights.push(flight);
      if (options.duration !== undefined && options.duration <= 0) {
        flight.done = true;
        options.complete?.();
      }
    }),
    flyToBoundingSphere: record(
      'camera.flyToBoundingSphere',
      (sphere, options) => camera.flyTo({ ...options, sphere }),
    ),
    completeFlight() {
      const flight = camera.flights.at(-1);
      if (!flight || flight.done) return;
      flight.done = true;
      flight.options.complete?.();
    },
    cancelFlight: record('camera.cancelFlight', () => {
      const flight = camera.flights.at(-1);
      if (!flight || flight.done) return;
      flight.done = true;
      flight.options.cancel?.();
    }),
    lookAt: record('camera.lookAt'),
    // With an offset (a Cartesian3), the camera sits there in the new frame
    // looking at its origin.
    lookAtTransform: record('camera.lookAtTransform', (transform, offset) => {
      Cesium.Matrix4.clone(transform, camera.transform);
      if (offset instanceof Cesium.Cartesian3) {
        Cesium.Cartesian3.clone(offset, camera.position);
        Cesium.Cartesian3.normalize(
          Cesium.Cartesian3.negate(offset, camera.direction),
          camera.direction,
        );
      }
    }),
    zoomIn: record('camera.zoomIn'),
    zoomOut: record('camera.zoomOut'),
    computeViewRectangle: record(
      'camera.computeViewRectangle',
      () => new Cesium.Rectangle(0.1, 0.2, 0.3, 0.4),
    ),
    pickEllipsoid: record(
      'camera.pickEllipsoid',
      () => new Cesium.Cartesian3(6378137, 0, 0),
    ),
    getPickRay: record(
      'camera.getPickRay',
      () =>
        new Cesium.Ray(
          new Cesium.Cartesian3(7e6, 0, 0),
          new Cesium.Cartesian3(-1, 0, 0),
        ),
    ),
  };
  let terrainProvider;
  const globe = {
    show: true,
    tilesLoaded: true,
    getHeight: record('globe.getHeight', () => 12.5),
    pick: record('globe.pick', () => new Cesium.Cartesian3(6378137, 3, 4)),
    terrainProviderChanged: new Cesium.Event(),
  };
  const scene = {
    camera,
    canvas: { clientWidth: width, clientHeight: height },
    globe,
    preUpdate: new Cesium.Event(),
    postUpdate: new Cesium.Event(),
    preRender: new Cesium.Event(),
    postRender: new Cesium.Event(),
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    // Cesium's running camera flights (a flight on viewer.camera is one).
    tweens: [],
    requestRender: record('scene.requestRender'),
    pick: record('scene.pick', () => undefined),
    drillPick: record('scene.drillPick', () => []),
    pickPositionSupported: true,
    pickPosition: record(
      'scene.pickPosition',
      () => new Cesium.Cartesian3(6378137, 1, 2),
    ),
    sampleHeightSupported: true,
    sampleHeight: record('scene.sampleHeight', () => 42),
    clampToHeightSupported: true,
    clampToHeight: record(
      'scene.clampToHeight',
      () => new Cesium.Cartesian3(6378200, 0, 0),
    ),
    screenSpaceCameraController: { enableInputs: true },
    frameState: { creditDisplay },
    primitives: {
      get length() {
        return primitiveList.length;
      },
      get: (index) => primitiveList[index],
      add: record('primitives.add', (value) => {
        primitiveList.push(value);
        return value;
      }),
      remove: record('primitives.remove', (value) => {
        const index = primitiveList.indexOf(value);
        if (index < 0) return false;
        primitiveList.splice(index, 1);
        return true;
      }),
      contains: (value) => primitiveList.includes(value),
    },
    setTerrain: record('scene.setTerrain'),
  };
  const viewer = {
    calls,
    callsOf: (name) => calls.filter((call) => call.name === name),
    scene,
    camera,
    container: { kind: 'container' },
    canvas: scene.canvas,
    creditDisplay,
    staticCredits,
    primitiveList,
    trackedEntityChanged: new Cesium.Event(),
    // Assigning raises trackedEntityChanged, as Cesium's Viewer does.
    get trackedEntity() {
      return trackedEntity;
    },
    set trackedEntity(value) {
      if (value === trackedEntity) return;
      trackedEntity = value;
      calls.push({ name: 'trackedEntity', args: [value] });
      viewer.trackedEntityChanged.raiseEvent(value);
    },
    entities: {
      values: entityList,
      add: record('entities.add', (options) => {
        const entity = new Cesium.Entity(options);
        entityList.push(entity);
        return entity;
      }),
      remove: record('entities.remove', (entity) => {
        const index = entityList.indexOf(entity);
        if (index >= 0) entityList.splice(index, 1);
        return index >= 0;
      }),
      contains: (entity) => entityList.includes(entity),
    },
    isDestroyed: () => false,
    // The viewer clock: its tick event (CesiumWidget ticks it right before
    // scene.render on every animation frame) and current time.
    clock: {
      onTick: new Cesium.Event(),
      currentTime: Cesium.JulianDate.fromIso8601('2026-10-16T12:00:00Z'),
    },
    imageryList,
    // As Viewer's: the globe takes it and says so.
    get terrainProvider() {
      return terrainProvider;
    },
    set terrainProvider(provider) {
      terrainProvider = provider;
      globe.terrainProviderChanged.raiseEvent(provider);
    },
    imageryLayers: {
      add: record('imageryLayers.add', (layer, index) =>
        imageryList.splice(index ?? imageryList.length, 0, layer),
      ),
      remove: record('imageryLayers.remove', (layer) => {
        const index = imageryList.indexOf(layer);
        if (index >= 0) imageryList.splice(index, 1);
        return index >= 0;
      }),
    },
  };
  return viewer;
}

/** A fake ScreenSpaceEventHandler factory that records its actions. */
export function createFakeEventHandlers() {
  const handlers = [];
  const create = (canvas) => {
    const actions = new Map();
    const handler = {
      canvas,
      destroyed: false,
      actions,
      setInputAction(action, type, modifier) {
        actions.set(`${type}:${modifier}`, action);
      },
      removeInputAction(type, modifier) {
        actions.delete(`${type}:${modifier}`);
      },
      fire(type, event, modifier) {
        actions.get(`${type}:${modifier}`)?.(event);
      },
      destroy() {
        handler.destroyed = true;
      },
    };
    handlers.push(handler);
    return handler;
  };
  return { handlers, create };
}
