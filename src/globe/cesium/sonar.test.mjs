import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { CONTACT_SONAR_INITIAL } from '../contract.js';
import { createCesiumSonar, visitCyberSonarModels } from './sonar.js';
import { createCesiumRender } from './render.js';

const ON = Object.freeze({
  ...CONTACT_SONAR_INITIAL,
  enabled: true,
  active: true,
  angleDeg: 90,
  opacity: 40,
});

// A scene with its frame events, camera and the given primitives.
function sonarScene(primitives, extra = {}) {
  let requests = 0;
  const scene = {
    primitives,
    preUpdate: new Cesium.Event(),
    postUpdate: new Cesium.Event(),
    preRender: new Cesium.Event(),
    postRender: new Cesium.Event(),
    canvas: { clientWidth: 1000, clientHeight: 800 },
    drawingBufferWidth: 1000,
    drawingBufferHeight: 800,
    camera: {
      frustum: { projectionMatrix: Cesium.Matrix4.IDENTITY },
      viewMatrix: Cesium.Matrix4.IDENTITY,
    },
    requestRender() {
      requests++;
    },
    ...extra,
  };
  const draw = () => {
    scene.preUpdate.raiseEvent();
    scene.postUpdate.raiseEvent();
    scene.preRender.raiseEvent();
    scene.postRender.raiseEvent();
  };
  return { scene, viewer: { scene }, draw, requests: () => requests };
}

// A model-shaped fixture exercises the actual scene walk without loading a
// glTF or allocating a WebGL context. Rendering remains the browser gate.
function fakeModel(color) {
  return Object.create(Cesium.Model.prototype, {
    ready: { value: true },
    show: { value: true },
    color: { value: color.clone(), writable: true },
    modelMatrix: { value: Cesium.Matrix4.IDENTITY },
  });
}

test('model walk never enumerates native contact or EntityCluster records', () => {
  const root = new Cesium.PrimitiveCollection();
  const points = root.add(new Cesium.PointPrimitiveCollection());
  points.add();
  points.get = () => {
    throw new Error('must not enumerate contacts');
  };
  const cluster = root.add(new Cesium.EntityCluster());
  Object.defineProperty(cluster, '_billboardCollection', {
    get() {
      throw new Error('must not access cluster internals');
    },
    configurable: true,
  });
  const seen = [];
  visitCyberSonarModels(root, (...v) => seen.push(v));
  assert.equal(seen.length, 0);
  delete cluster._billboardCollection;
  root.destroy();
});

test('nothing joins the scene until the treatment is first on', () => {
  const primitives = new Cesium.PrimitiveCollection();
  const original = primitives.update;
  const { viewer, scene } = sonarScene(primitives);
  const sonar = createCesiumSonar(viewer);
  sonar.set({ ...CONTACT_SONAR_INITIAL });
  assert.equal(primitives.update, original);
  assert.equal(scene.postUpdate.numberOfListeners, 0);
  sonar.set({ ...ON });
  assert.notEqual(primitives.update, original);
  assert.equal(scene.postUpdate.numberOfListeners, 1);
  sonar.destroy();
  sonar.destroy();
  assert.equal(primitives.update, original);
  assert.equal(scene.postUpdate.numberOfListeners, 0);
  assert.equal(scene.preRender.numberOfListeners, 0);
  primitives.destroy();
});

test('native owner colors remain untouched; models take the sweep and get theirs back', () => {
  const primitives = new Cesium.PrimitiveCollection({
    destroyPrimitives: false,
  });
  const points = primitives.add(new Cesium.PointPrimitiveCollection());
  const point = points.add({ color: new Cesium.Color(0.3, 0.7, 0.5, 0.8) });
  const nativeColor = new Cesium.Color(0.2, 0.4, 0.8, 1);
  const model = fakeModel(nativeColor);
  primitives.add(model);
  const { viewer, draw } = sonarScene(primitives);
  const sonar = createCesiumSonar(viewer);
  try {
    for (const active of [true, false, true]) {
      for (const opacity of [35, 84, 100]) {
        sonar.set({ ...ON, active, opacity });
        point.color = new Cesium.Color(0.6, 0.4, 0.2, 0.7);
        draw();
        assert.equal(point.color.alpha, 0.7);
        assert.equal(point.color.red, 0.6);
      }
    }
    assert.notDeepEqual(model.color, nativeColor, 'the model is tinted');
    assert.equal(sonar.diagnostics().contacts, 1);
    // Off: the model's colour comes back at once, before any frame.
    sonar.set({ ...ON, enabled: false });
    assert.deepEqual(model.color, nativeColor);
    assert.equal(sonar.diagnostics().contacts, 0);
  } finally {
    sonar.destroy();
    points.destroy();
    primitives.destroy();
  }
});

test('a shader failure turns the treatment off and the next frame restores the models', () => {
  const nativeColor = new Cesium.Color(0.2, 0.4, 0.8, 1);
  const model = fakeModel(nativeColor);
  const primitives = new Cesium.PrimitiveCollection({
    destroyPrimitives: false,
  });
  primitives.add(model);
  const points = new Cesium.PointPrimitiveCollection();
  const nativeCommand = {
    owner: points,
    uniformMap: {},
    shaderProgram: {
      vertexShaderSource: new Cesium.ShaderSource({
        sources: ['void main() {}'],
      }),
    },
  };
  primitives.update = (frame) => frame.commandList.push(nativeCommand);
  const { viewer, scene } = sonarScene(primitives);
  const sonar = createCesiumSonar(viewer);
  try {
    assert.equal(sonar.diagnostics().supported, true);
    sonar.set({ ...ON, active: false });
    scene.postUpdate.raiseEvent();
    scene.preRender.raiseEvent();
    assert.notDeepEqual(
      model.color,
      nativeColor,
      'Cyber neutral treatment precedes shader compilation',
    );
    const frame = { commandList: [], passes: { render: true } };
    primitives.update(frame);
    assert.equal(sonar.diagnostics().supported, false);
    assert.equal(frame.commandList[0], nativeCommand);
    scene.postUpdate.raiseEvent();
    scene.preRender.raiseEvent();
    assert.deepEqual(
      model.color,
      nativeColor,
      'the next draw restores native model color',
    );
    assert.equal(sonar.diagnostics().contacts, 0);
  } finally {
    sonar.destroy();
    points.destroy();
    primitives.destroy();
  }
});

test('render.setContactSonar merges, hands the sonar a copy and asks for a frame only outside one', () => {
  const primitives = new Cesium.PrimitiveCollection();
  const { viewer, draw, scene } = sonarScene(primitives);
  const reasons = [];
  const states = [];
  const { render, sonarDiagnostics, destroy } = createCesiumRender(viewer, {
    requestRender: (reason) => reasons.push(reason),
    createSonar: () => ({
      set: (state) => states.push(state),
      diagnostics: () => ({ supported: true }),
      destroy() {},
    }),
  });
  assert.deepEqual(render.contactSonar(), CONTACT_SONAR_INITIAL);
  render.setContactSonar({ enabled: true, angleDeg: 10 });
  assert.deepEqual(reasons, ['cyber-sonar']);
  assert.deepEqual(states.at(-1), {
    ...CONTACT_SONAR_INITIAL,
    enabled: true,
    angleDeg: 10,
  });
  // The app sets it every frame, in preRender: no request then.
  const off = scene.preRender.addEventListener(() =>
    render.setContactSonar({ angleDeg: 20 }),
  );
  draw();
  off();
  assert.deepEqual(reasons, ['cyber-sonar']);
  assert.equal(render.contactSonar().angleDeg, 20);
  // An unchanged state is not handed on.
  const handed = states.length;
  render.setContactSonar({ angleDeg: 20 });
  assert.equal(states.length, handed);
  assert.throws(() => render.setContactSonar({ range: 0 }), TypeError);
  assert.equal(sonarDiagnostics().supported, true);
  destroy();
  assert.equal(scene.preUpdate.numberOfListeners, 0);
  assert.equal(scene.postRender.numberOfListeners, 0);
  primitives.destroy();
});
