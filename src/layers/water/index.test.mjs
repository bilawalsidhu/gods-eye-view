import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWaterLayer } from './index.js';
import {
  DEFAULT_PARAMS,
  HIDDEN_CAMERA_TOO_HIGH,
  WATER_LAYER_ID,
  WAVE_REPEAT,
} from './policy.js';
import { WATER_MATERIAL_TYPE } from './material.js';

/** A Cesium stand-in: enough surface for the layer, no WebGL. */
function fakeCesium() {
  const materials = new Map();
  const built = [];
  class Cartesian2 {
    constructor(x, y) {
      this.x = x;
      this.y = y;
    }
  }
  class Color {
    constructor(r, g, b, a) {
      Object.assign(this, { r, g, b, a });
    }
  }
  const cesium = {
    built,
    Cartesian2,
    Color,
    Math: {
      toDegrees: (rad) => (rad * 180) / Math.PI,
      toRadians: (deg) => (deg * Math.PI) / 180,
    },
    Cartographic: {
      fromCartesian: (c) => c,
    },
    Rectangle: {
      fromDegrees: (west, south, east, north) => ({ west, south, east, north }),
    },
    RectangleGeometry: class {
      constructor(options) {
        this.options = options;
      }
    },
    GeometryInstance: class {
      constructor(options) {
        this.options = options;
      }
    },
    EllipsoidSurfaceAppearance: class {
      constructor(options) {
        this.options = options;
      }
    },
    Primitive: class {
      constructor(options) {
        this.options = options;
        this.show = true;
        built.push(this);
      }
      destroy() {
        this.destroyed = true;
      }
      isDestroyed() {
        return Boolean(this.destroyed);
      }
    },
    buildModuleUrl: (path) => `/cesium/${path}`,
    EllipsoidTerrainProvider: class EllipsoidTerrainProvider {},
    Material: {
      DefaultImageId: 'czm_defaultImage',
      _materialCache: {
        getMaterial: (type) => materials.get(type) || null,
        addMaterial: (type, template) => materials.set(type, template),
      },
      fromType: (type, uniforms) => ({ type, uniforms: { ...uniforms } }),
    },
  };
  cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT = 'POSITION_AND_ST';
  return cesium;
}

function fakeViewer({ lat = 37.8, lon = -122.45, cameraHeightM = 900 } = {}) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const items = [];
  const listeners = { moveEnd: new Set(), preRender: new Set() };
  const camera = {
    positionCartographic: {
      latitude: toRad(lat),
      longitude: toRad(lon),
      height: cameraHeightM,
    },
    pickEllipsoid: () => ({ latitude: toRad(lat), longitude: toRad(lon) }),
    moveEnd: {
      addEventListener(fn) {
        listeners.moveEnd.add(fn);
        return () => listeners.moveEnd.delete(fn);
      },
    },
  };
  const scene = {
    camera,
    canvas: { clientWidth: 800, clientHeight: 600 },
    globe: { ellipsoid: {}, depthTestAgainstTerrain: false },
    renders: 0,
    requestRender() {
      this.renders += 1;
    },
    preRender: {
      addEventListener(fn) {
        listeners.preRender.add(fn);
        return () => listeners.preRender.delete(fn);
      },
    },
    primitives: {
      items,
      add(p) {
        items.push(p);
        return p;
      },
      contains: (p) => items.includes(p),
      remove(p) {
        const i = items.indexOf(p);
        if (i >= 0) items.splice(i, 1);
        p.destroy();
        return i >= 0;
      },
      isDestroyed: () => false,
    },
  };
  return {
    scene,
    camera,
    listeners,
    terrainProvider: { availability: {} },
    moveTo(nextLat, nextLon, height = cameraHeightM) {
      camera.positionCartographic = {
        latitude: toRad(nextLat),
        longitude: toRad(nextLon),
        height,
      };
      camera.pickEllipsoid = () => ({
        latitude: toRad(nextLat),
        longitude: toRad(nextLon),
      });
      for (const fn of listeners.moveEnd) fn();
    },
  };
}

/** Radians round-trip through the fake camera, so compare within 1e-9°. */
function assertNear(actual, expected) {
  assert.ok(Math.abs(actual.lat - expected.lat) < 1e-9, `lat ${actual.lat}`);
  assert.ok(Math.abs(actual.lon - expected.lon) < 1e-9, `lon ${actual.lon}`);
}

function fakeServices() {
  const holds = new Set();
  return {
    holds,
    render: {
      holdContinuousRender: (id) => holds.add(id),
      releaseContinuousRender: (id) => holds.delete(id),
      governorRequestRender: () => {},
    },
    geoid: {
      ready: 0,
      async ensureGeoidReady() {
        this.ready += 1;
      },
      geoidHeight: () => -32.4,
    },
  };
}

test('enable builds one surface at geoid height plus the offset and holds rendering', async () => {
  const cesium = fakeCesium();
  const viewer = fakeViewer();
  const services = fakeServices();
  let clock = 1000;
  const layer = createWaterLayer({ services, cesium, now: () => clock });
  layer.init(viewer);
  assert.equal(await layer.enable(), true);
  assert.equal(services.geoid.ready, 1);
  assert.ok(services.holds.has(WATER_LAYER_ID));
  assert.equal(viewer.scene.primitives.items.length, 1);
  const diagnostics = layer.diagnostics();
  assert.equal(diagnostics.heightM, -32.4 + DEFAULT_PARAMS.offsetM);
  assert.equal(diagnostics.hidden, null);
  assertNear(diagnostics.center, { lat: 37.8, lon: -122.45 });
  const geometry = cesium.built[0].options.geometryInstances.options.geometry;
  assert.equal(geometry.options.height, diagnostics.heightM);
  assert.equal(cesium.built[0].options.allowPicking, false);
  // Depth against terrain is on while enabled so land hides the surface on globe stacks.
  assert.equal(viewer.scene.globe.depthTestAgainstTerrain, true);
  assert.deepEqual(layer.getStats(), { count: 1, error: null, loading: false });

  // The material is the registered water fabric with whole-cell repeats.
  const material = cesium.built[0].options.appearance.options.material;
  assert.equal(material.type, WATER_MATERIAL_TYPE);
  assert.deepEqual(
    { x: material.uniforms.repeat.x, y: material.uniforms.repeat.y },
    { x: WAVE_REPEAT.s, y: WAVE_REPEAT.t },
  );
  assert.equal(material.uniforms.normalMap, '/cesium/Assets/Textures/waterNormals.jpg');

  // The wave clock advances from enable time on each frame.
  clock = 3500;
  for (const fn of viewer.listeners.preRender) fn();
  assert.equal(material.uniforms.time, 2.5);

  layer.disable();
  assert.equal(services.holds.has(WATER_LAYER_ID), false);
  assert.equal(viewer.scene.primitives.items.length, 0);
  assert.equal(viewer.scene.globe.depthTestAgainstTerrain, false);
  assert.equal(viewer.listeners.moveEnd.size, 0);
  assert.equal(viewer.listeners.preRender.size, 0);
});

test('the surface follows the view: a small move keeps it, a long move rebuilds it', async () => {
  const cesium = fakeCesium();
  const viewer = fakeViewer();
  const layer = createWaterLayer({ services: fakeServices(), cesium });
  layer.init(viewer);
  await layer.enable();
  const first = viewer.scene.primitives.items[0];
  viewer.moveTo(37.81, -122.44);
  assert.equal(viewer.scene.primitives.items[0], first);
  viewer.moveTo(38.4, -122.45);
  assert.notEqual(viewer.scene.primitives.items[0], first);
  assert.equal(first.destroyed, true);
  assert.equal(viewer.scene.primitives.items.length, 1);
  assertNear(layer.diagnostics().center, { lat: 38.4, lon: -122.45 });
});

test('the surface hides from orbit and reports why, then returns on descent', async () => {
  const cesium = fakeCesium();
  const viewer = fakeViewer({ cameraHeightM: 500_000 });
  const layer = createWaterLayer({ services: fakeServices(), cesium });
  layer.init(viewer);
  await layer.enable();
  assert.equal(viewer.scene.primitives.items.length, 0);
  assert.deepEqual(layer.getStats(), {
    count: 0,
    error: HIDDEN_CAMERA_TOO_HIGH,
    loading: false,
  });
  viewer.moveTo(37.8, -122.45, 2000);
  assert.equal(viewer.scene.primitives.items.length, 1);
  assert.equal(layer.getStats().error, null);
  viewer.moveTo(37.8, -122.45, 900_000);
  assert.equal(viewer.scene.primitives.items[0].show, false);
  assert.equal(layer.getStats().count, 0);
});

test('setParams: offset rebuilds at the new height, opacity and relief update uniforms', async () => {
  const cesium = fakeCesium();
  const viewer = fakeViewer();
  const layer = createWaterLayer({ services: fakeServices(), cesium });
  layer.init(viewer);
  await layer.enable();
  const before = viewer.scene.primitives.items[0];
  layer.setParams({ opacity: 0.5, waveScale: 2 });
  assert.equal(viewer.scene.primitives.items[0], before);
  const material = before.options.appearance.options.material;
  assert.equal(material.uniforms.alpha, 0.5);
  assert.ok(material.uniforms.amplitude > 1);
  layer.setParams({ offsetM: 3 });
  assert.notEqual(viewer.scene.primitives.items[0], before);
  assert.equal(layer.diagnostics().heightM, -32.4 + 3);
  assert.deepEqual(layer.getParams(), { offsetM: 3, opacity: 0.5, waveScale: 2 });
  const slider = layer.getRowControls().slider;
  assert.equal(slider.value, 30);
  assert.deepEqual(slider.params('12'), { offsetM: 1.2 });
});

test('the flat-ellipsoid fallback globe puts the sea at ellipsoid zero, terrain and tilesets at the geoid', async () => {
  const cesium = fakeCesium();
  const viewer = fakeViewer();
  viewer.terrainProvider = new cesium.EllipsoidTerrainProvider();
  const layer = createWaterLayer({ services: fakeServices(), cesium });
  layer.init(viewer);
  await layer.enable();
  assert.equal(layer.diagnostics().datum, 'ellipsoid');
  assert.equal(layer.diagnostics().heightM, DEFAULT_PARAMS.offsetM);
  // Google 3D hides the globe: the tileset's sea is at the geoid again.
  viewer.scene.globe.show = false;
  viewer.moveTo(37.8, -122.45);
  assert.equal(layer.diagnostics().datum, 'geoid');
  assert.equal(layer.diagnostics().heightM, -32.4 + DEFAULT_PARAMS.offsetM);
  // Terrain arriving on the globe stack also moves the sea to the geoid.
  viewer.scene.globe.show = true;
  viewer.terrainProvider = { availability: {} };
  viewer.moveTo(37.8, -122.45);
  assert.equal(layer.diagnostics().datum, 'geoid');
});

test('a disable during the geoid wait leaves nothing behind', async () => {
  const cesium = fakeCesium();
  const viewer = fakeViewer();
  const services = fakeServices();
  let release;
  services.geoid.ensureGeoidReady = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const layer = createWaterLayer({ services, cesium });
  layer.init(viewer);
  const pending = layer.enable();
  layer.disable();
  release();
  assert.equal(await pending, false);
  assert.equal(viewer.scene.primitives.items.length, 0);
  assert.equal(services.holds.size, 0);
  assert.equal(viewer.scene.globe.depthTestAgainstTerrain, false);
});

test('destroy releases the scene and the material', async () => {
  const cesium = fakeCesium();
  const viewer = fakeViewer();
  const services = fakeServices();
  const layer = createWaterLayer({ services, cesium });
  layer.init(viewer);
  await layer.enable();
  layer.destroy();
  assert.equal(viewer.scene.primitives.items.length, 0);
  assert.equal(services.holds.size, 0);
  assert.equal(layer.diagnostics().enabled, false);
});
