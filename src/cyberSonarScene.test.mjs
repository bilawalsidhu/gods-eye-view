import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createCyberSonarSampler,
  cyberSonarIntensityAtScreenPoint,
  applyCyberSonarPrimitive,
  applyCyberSonarSettings,
  isCyberContactSonarActive,
  isCyberSonarActive,
} from './cyberSonar.js';
import {
  createCyberSonarScene,
  visitCyberSonarModels,
  getCyberSonarSceneDiagnostics,
} from './cyberSonarScene.js';

test('frame sampler matches reference without per-contact settings access', () => {
  let reads = 0;
  const values = {
    cyberSonarOpacity: '62',
    cyberSonarSector: '40',
    cyberSonarRange: '110',
  };
  const root = {
    dataset: new Proxy(values, {
      get(o, k) {
        reads++;
        return o[k];
      },
    }),
  };
  const frame = createCyberSonarSampler(1000, 800, 1234, root),
    once = reads;
  for (let x = 0; x < 1000; x += 33)
    for (let y = 0; y < 800; y += 31) frame.at(x, y);
  assert.equal(reads, once);
  for (let x = 0; x < 1000; x += 33)
    for (let y = 0; y < 800; y += 31)
      assert.ok(
        Math.abs(
          frame.at(x, y) -
            cyberSonarIntensityAtScreenPoint(x, y, 1000, 800, 1234, {
              dataset: values,
            }),
        ) < 1e-10,
      );
});

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

test('models retain render-pass alpha and owner refresh survives teardown', () => {
  const frame = createCyberSonarSampler(1000, 800, 0);
  const model = { color: new Cesium.Color(1, 0.5, 0.2, 1) };
  applyCyberSonarPrimitive(model, 0.5, true, frame, 'color', true);
  assert.equal(model.color.alpha, 1);
  assert.ok(model.color.red < 1);
  const owner = new Cesium.Color(0.2, 0.3, 0.4, 0.7);
  model.color = owner;
  applyCyberSonarPrimitive(model, 1, false);
  assert.equal(model.color, owner);
  const unset = {};
  applyCyberSonarPrimitive(unset, 0.5, true, frame, 'color', true);
  applyCyberSonarPrimitive(unset, 1, false);
  assert.equal(unset.color, undefined);
});

test('removed CSS mode cannot disable GPU contacts; unsupported adapters fail closed', () => {
  const root = { dataset: { uiTheme: 'cyber' }, style: { setProperty() {} } };
  const options = {
    root,
    body: { classList: { contains: () => false } },
    hud: { classList: { contains: () => true } },
    reducedMotion: false,
  };
  root.dataset.cyberSonarMode = 'css';
  assert.equal(applyCyberSonarSettings({ mode: 'css' }, root).mode, undefined);
  assert.equal(root.dataset.cyberSonarMode, undefined);
  assert.equal(isCyberSonarActive(options), true);
  assert.equal(isCyberContactSonarActive(options), true);
  assert.equal(
    applyCyberSonarSettings({ mode: 'invalid' }, root).mode,
    undefined,
  );
  assert.equal(isCyberContactSonarActive(options), true);
  root.dataset.cyberSonarGpu = 'unsupported';
  assert.equal(isCyberContactSonarActive(options), false);
});

test('native owner colors remain untouched and scene teardown releases listeners', () => {
  const previous = globalThis.document;
  const root = { dataset: { uiTheme: 'cyber', cyberSonar: 'on' } };
  let cockpit = false;
  globalThis.document = {
    documentElement: root,
    body: { classList: { contains: () => cockpit } },
    getElementById: () => ({ classList: { contains: () => true } }),
  };
  const primitives = new Cesium.PrimitiveCollection();
  const points = primitives.add(new Cesium.PointPrimitiveCollection());
  const point = points.add({ color: new Cesium.Color(0.3, 0.7, 0.5, 0.8) });
  const original = primitives.update;
  const scene = {
    primitives,
    postUpdate: new Cesium.Event(),
    preRender: new Cesium.Event(),
    postRender: new Cesium.Event(),
    canvas: { clientWidth: 1000, clientHeight: 800 },
    camera: {
      frustum: { projectionMatrix: Cesium.Matrix4.IDENTITY },
      viewMatrix: Cesium.Matrix4.IDENTITY,
    },
    requestRender() {},
  };
  const viewer = { scene };
  const dispose = createCyberSonarScene(viewer);
  try {
    for (const enabled of ['on', 'off', 'on']) {
      root.dataset.cyberSonar = enabled;
      for (const opacity of [35, 84, 100]) {
        root.dataset.cyberSonarOpacity = String(opacity);
        point.color = new Cesium.Color(0.6, 0.4, 0.2, 0.7);
        scene.postUpdate.raiseEvent();
        scene.preRender.raiseEvent();
        assert.equal(point.color.alpha, 0.7);
        assert.equal(point.color.red, 0.6);
      }
    }
    const previousTimeout = globalThis.setTimeout;
    const previousClear = globalThis.clearTimeout;
    let timers = 0;
    globalThis.setTimeout = () => {
      timers++;
      return 1;
    };
    globalThis.clearTimeout = () => {};
    try {
      const gpu = getCyberSonarSceneDiagnostics(viewer).gpu;
      gpu.commands = 6;
      gpu.visibleCommands = 0;
      scene.postRender.raiseEvent();
      assert.equal(timers, 0, 'culled batches must not schedule a sonar draw');
      gpu.visibleCommands = 1;
      scene.postRender.raiseEvent();
      assert.equal(timers, 1, 'a visible batch keeps the sweep moving');
      root.dataset.cyberSonar = 'off';
      scene.postRender.raiseEvent();
      assert.equal(timers, 1, 'OFF does not schedule contact draws');
    } finally {
      globalThis.setTimeout = previousTimeout;
      globalThis.clearTimeout = previousClear;
    }
    cockpit = true;
    scene.postUpdate.raiseEvent();
    scene.preRender.raiseEvent();
    root.dataset.uiTheme = 'tactical';
    scene.postUpdate.raiseEvent();
    scene.preRender.raiseEvent();
    dispose();
    dispose();
    assert.equal(primitives.update, original);
    assert.equal(scene.postUpdate.numberOfListeners, 0);
    assert.equal(scene.preRender.numberOfListeners, 0);
    assert.equal(scene.postRender.numberOfListeners, 0);
    assert.equal(root.dataset.cyberSonarGpu, undefined);
  } finally {
    dispose();
    primitives.destroy();
    globalThis.document = previous;
  }
});

for (const reducedMotion of [false, true]) {
  test(`shader failure requests one parked restoration draw with ${reducedMotion ? 'reduced motion' : 'Sonar OFF'}`, () => {
    const previousDocument = globalThis.document;
    const previousMatchMedia = globalThis.matchMedia;
    const previousTimeout = globalThis.setTimeout;
    const previousClear = globalThis.clearTimeout;
    const root = {
      dataset: { uiTheme: 'cyber', cyberSonar: reducedMotion ? 'on' : 'off' },
    };
    const status = { textContent: '' };
    globalThis.document = {
      documentElement: root,
      body: { classList: { contains: () => false } },
      getElementById: (id) =>
        id === 'cyber-sonar-status'
          ? status
          : { classList: { contains: () => true } },
    };
    globalThis.matchMedia = () => ({ matches: reducedMotion });
    let scheduled = 0;
    globalThis.setTimeout = () => {
      scheduled++;
      return 1;
    };
    globalThis.clearTimeout = () => {};
    // A model-shaped fixture exercises the actual scene walk without loading a
    // glTF or allocating a WebGL context. Rendering remains the browser gate.
    const nativeColor = new Cesium.Color(0.2, 0.4, 0.8, 1);
    const model = Object.create(Cesium.Model.prototype, {
      ready: { value: true },
      show: { value: true },
      color: { value: nativeColor.clone(), writable: true },
      modelMatrix: { value: Cesium.Matrix4.IDENTITY },
    });
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
    let requests = 0;
    const scene = {
      primitives,
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
    };
    const viewer = { scene };
    const dispose = createCyberSonarScene(viewer);
    try {
      scene.postUpdate.raiseEvent();
      scene.preRender.raiseEvent();
      assert.notDeepEqual(
        model.color,
        nativeColor,
        'Cyber neutral treatment precedes shader compilation',
      );
      const frame = { commandList: [], passes: { render: true } };
      primitives.update(frame);
      assert.equal(getCyberSonarSceneDiagnostics(viewer).gpu.supported, false);
      assert.equal(frame.commandList[0], nativeCommand);
      scene.postRender.raiseEvent();
      assert.equal(
        scheduled,
        0,
        'inactive sweep has no timer to perform recovery',
      );
      scene.postUpdate.raiseEvent();
      assert.equal(root.dataset.cyberSonarGpu, 'unsupported');
      assert.match(status.textContent, /Native contacts remain visible/);
      assert.equal(
        requests,
        1,
        'support loss explicitly wakes the parked scene',
      );
      scene.preRender.raiseEvent();
      assert.deepEqual(
        model.color,
        nativeColor,
        'the requested draw restores native model color',
      );
      assert.equal(getCyberSonarSceneDiagnostics(viewer).contacts, 0);
      scene.postRender.raiseEvent();
      for (let i = 0; i < 3; i++) scene.postUpdate.raiseEvent();
      assert.equal(
        requests,
        1,
        'unsupported idle ticks do not create a render loop',
      );
      assert.equal(scheduled, 0);
      dispose();
      scene.postUpdate.raiseEvent();
      assert.equal(requests, 1, 'disposed callbacks cannot wake the scene');
    } finally {
      dispose();
      points.destroy();
      primitives.destroy();
      globalThis.document = previousDocument;
      globalThis.matchMedia = previousMatchMedia;
      globalThis.setTimeout = previousTimeout;
      globalThis.clearTimeout = previousClear;
    }
  });
}
