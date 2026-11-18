import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  SCREEN_MODULATION_CESIUM_VERSION,
  createCesiumScreenModulation,
  createModelTint,
  isModulatedCommandVisible,
  modulationVertexSource,
  normalizeSector,
  sectorSampler,
  syncModulatedCommand,
  visitModels,
} from './screenModulation.js';
import { createCyberSonarSampler, cyberSonarSector } from '../../cyberSonar.js';

const sweep = (extra = {}) => ({
  center: { x: 500, y: 400 },
  angle: 0,
  width: (24 * Math.PI) / 180,
  radius: 400,
  floor: 0.84,
  strength: 0.72,
  color: '#ffd6d6',
  ...extra,
});

test('stable commands reuse uniforms and derived pipelines while all native fields remain live', () => {
  const native = new Cesium.DrawCommand({
    count: 6,
    uniformMap: { value: () => 1 },
  });
  const record = {},
    program = {},
    uniforms = { u_gevSonar: () => 42 };
  const derived = syncModulatedCommand(native, record, program, uniforms, 0);
  const map = derived.uniformMap;
  derived.dirty = false;
  derived.lastDirtyTime = 7;
  assert.equal(native.dirty, true);
  assert.equal(
    syncModulatedCommand(native, record, program, uniforms, 1),
    derived,
  );
  assert.equal(
    derived.dirty,
    false,
    'stale native dirty flag must not rebuild pipelines',
  );
  assert.equal(derived.lastDirtyTime, 7);
  assert.equal(derived.uniformMap, map);
  assert.equal(map.u_gevSonarLabelBackground(), 1);
  for (const [key, value] of Object.entries({
    count: 12,
    offset: 2,
    instanceCount: 3,
    pickId: 'pick',
    pass: Cesium.Pass.TRANSLUCENT,
    cull: false,
    occlude: false,
    castShadows: true,
    receiveShadows: true,
    pickOnly: true,
    renderState: {},
    vertexArray: {},
    modelMatrix: Cesium.Matrix4.IDENTITY,
    framebuffer: {},
  })) {
    derived.dirty = false;
    native[key] = value;
    syncModulatedCommand(native, record, program, uniforms, 0);
    assert.equal(derived[key], value, key);
    assert.equal(derived.dirty, true, key);
  }
  native.uniformMap.value = () => 2;
  syncModulatedCommand(native, record, program, uniforms, 0);
  assert.equal(map.value(), 2);
  native.uniformMap = { replacement: () => 3 };
  syncModulatedCommand(native, record, program, uniforms, 0);
  assert.equal(map.value, undefined);
  assert.equal(map.replacement(), 3);
  assert.equal(map.u_gevSonar(), 42);
  const nextProgram = {};
  syncModulatedCommand(native, record, nextProgram, uniforms, 0);
  assert.equal(derived.shaderProgram, nextProgram);
  assert.equal(native.shaderProgram, undefined);
});

test('the shader transform runs the native shader first, keeps geometry, and shades before fragment classification', () => {
  assert.equal(
    Cesium.VERSION,
    SCREEN_MODULATION_CESIUM_VERSION,
    'engine upgrades require GPU revalidation',
  );
  for (const [kind, attr, low] of [
    ['point', 'positionHighAndSize', 'positionLowAndOutline'],
    ['billboard', 'positionHighAndScale', 'positionLowAndRotation'],
  ]) {
    const source = new Cesium.ShaderSource({
      defines: ['SDF'],
      sources: [
        `in vec4 ${attr}; in vec4 ${low}; out vec4 v_color; void main() { v_color=vec4(1.); }`,
      ],
    });
    const original = source.sources[0];
    const next = modulationVertexSource(source, kind);
    assert.equal(source.sources[0], original);
    assert.notEqual(next, source);
    assert.deepEqual(next.defines, ['SDF']);
    assert.match(next.sources[0], /void gev_sonar_main/);
    assert.match(next.sources[1], /v_color.a \*= factor/);
    assert.match(next.sources[1], /u_gevSonarSector/);
    assert.match(next.sources[1], /u_gevSonarCenter/);
    assert.match(next.sources[1], /u_gevSonarTint/);
    assert.ok(
      next.sources[1].includes(
        `czm_translateRelativeToEye(${attr}.xyz, ${low}.xyz)`,
      ),
    );
    assert.match(next.sources[1], /anchor.xy \/ anchor.w/);
    assert.doesNotMatch(next.sources[1], /gl_Position\s*[=/]/);
  }
  assert.equal(
    modulationVertexSource(
      new Cesium.ShaderSource({ sources: ['void main() {}'] }),
      'point',
    ),
    null,
  );
});

test('render demand follows batch bounds, including horizon culling, without far-plane rejection', () => {
  const planes = Array.from(
    { length: 6 },
    (_, i) => new Cesium.Cartesian4(1, 0, 0, i),
  );
  const frame = {
    cullingVolume: { planes },
    mode: Cesium.SceneMode.SCENE3D,
    occluder: {},
  };
  let intersections = 0;
  let occluded = false;
  const command = {
    cull: true,
    occlude: true,
    boundingVolume: {
      intersectPlane(plane) {
        intersections++;
        return plane.distance === 5
          ? Cesium.Intersect.OUTSIDE
          : Cesium.Intersect.INSIDE;
      },
      isOccluded() {
        return occluded;
      },
    },
  };
  assert.equal(isModulatedCommandVisible(command, frame), true);
  assert.equal(intersections, 5);
  occluded = true;
  assert.equal(isModulatedCommandVisible(command, frame), false);
  frame.mode = Cesium.SceneMode.SCENE2D;
  assert.equal(isModulatedCommandVisible(command, frame), true);
  command.boundingVolume.intersectPlane = () => Cesium.Intersect.OUTSIDE;
  assert.equal(isModulatedCommandVisible(command, frame), false);
  command.cull = false;
  assert.equal(isModulatedCommandVisible(command, frame), true);
  assert.equal(isModulatedCommandVisible({}, frame), true);
});

test('the CPU sampler of a sector matches the sweep it was made from', () => {
  const values = {
    cyberSonarOpacity: '62',
    cyberSonarSector: '40',
    cyberSonarRange: '110',
  };
  const root = { dataset: values };
  for (const now of [0, 1234, 4100]) {
    const reference = createCyberSonarSampler(1000, 800, now, root);
    const sampler = sectorSampler(
      normalizeSector(cyberSonarSector(1000, 800, now, { root })),
    );
    for (let x = 0; x < 1000; x += 33)
      for (let y = 0; y < 800; y += 31)
        assert.ok(
          Math.abs(sampler.at(x, y) - reference.at(x, y)) < 1e-9,
          `${now} ${x},${y}`,
        );
    for (const factor of [reference.floor, 0.9, 1]) {
      const base = { red: 0.3, green: 0.6, blue: 0.9 };
      const a = reference.tint(base, factor, {});
      const b = sampler.tint(base, factor, {});
      for (const c of ['red', 'green', 'blue'])
        assert.ok(Math.abs(a[c] - b[c]) < 0.003, `${factor} ${c}`);
    }
  }
  // At rest the sweep holds every contact at the neutral level and tint.
  const rest = sectorSampler(
    normalizeSector(cyberSonarSector(1000, 800, 0, { root, sweeping: false })),
  );
  const reference = createCyberSonarSampler(1000, 800, 0, root);
  assert.ok(Math.abs(rest.at(10, 10) - reference.neutral) < 1e-9);
  const base = { red: 0.3, green: 0.6, blue: 0.9 };
  const a = reference.tint(base, reference.neutral, {});
  const b = rest.tint(base, rest.at(10, 10), {});
  for (const c of ['red', 'green', 'blue'])
    assert.ok(Math.abs(a[c] - b[c]) < 0.003, c);
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
  visitModels(root, (...v) => seen.push(v));
  assert.equal(seen.length, 0);
  delete cluster._billboardCollection;
  root.destroy();
});

test('models keep their render-pass alpha, and an owner colour written since survives restore', () => {
  const sampler = sectorSampler(normalizeSector(sweep()));
  const tint = createModelTint();
  const model = { color: new Cesium.Color(1, 0.5, 0.2, 1) };
  tint.apply(model, 0.5, sampler);
  assert.equal(model.color.alpha, 1);
  assert.ok(model.color.red < 1);
  const owner = new Cesium.Color(0.2, 0.3, 0.4, 0.7);
  model.color = owner;
  tint.restore(model);
  assert.equal(model.color, owner);
  const shaded = { color: new Cesium.Color(0.2, 0.4, 0.8, 1) };
  tint.apply(shaded, 0.9, sampler);
  tint.restore(shaded);
  assert.deepEqual(shaded.color, new Cesium.Color(0.2, 0.4, 0.8, 1));
  const unset = {};
  tint.apply(unset, 0.5, sampler);
  tint.restore(unset);
  assert.equal(unset.color, undefined);
});

/** A scene of Cesium events, a primitives root and a frame port fake. */
function fixture({ commands = [] } = {}) {
  const primitives = new Cesium.PrimitiveCollection({
    destroyPrimitives: false,
  });
  primitives.update = (frameState) => frameState.commandList.push(...commands);
  const original = primitives.update;
  const scene = {
    primitives,
    postUpdate: new Cesium.Event(),
    preRender: new Cesium.Event(),
    postRender: new Cesium.Event(),
    canvas: { clientWidth: 1000, clientHeight: 800 },
    drawingBufferWidth: 2000,
    drawingBufferHeight: 1600,
    camera: {
      frustum: { projectionMatrix: Cesium.Matrix4.IDENTITY },
      viewMatrix: Cesium.Matrix4.IDENTITY,
    },
  };
  const requests = [];
  let changes = 0;
  const part = createCesiumScreenModulation(scene, {
    frame: { requestRender: (reason) => requests.push(reason) },
    onChange: () => changes++,
  });
  const draw = (passes = { render: true }) => {
    scene.postUpdate.raiseEvent();
    scene.preRender.raiseEvent();
    const frameState = { commandList: [], passes };
    primitives.update(frameState);
    scene.postRender.raiseEvent();
    return frameState.commandList;
  };
  return {
    scene,
    primitives,
    original,
    part,
    requests,
    changes: () => changes,
    draw,
  };
}

test('setting nothing changes nothing in the scene', () => {
  const f = fixture();
  assert.equal(f.primitives.update, f.original);
  assert.equal(f.scene.postUpdate.numberOfListeners, 0);
  assert.equal(f.part.draws(), false);
  f.part.set(null);
  assert.deepEqual(f.requests, []);
  f.part.dispose();
  f.primitives.destroy();
});

test('a set asks for a frame; moving the angle asks only while a shaded marker was in view', () => {
  const points = new Cesium.PointPrimitiveCollection();
  const native = new Cesium.DrawCommand({
    owner: points,
    uniformMap: {},
    shaderProgram: {
      vertexShaderSource: new Cesium.ShaderSource({
        sources: [
          'in vec4 positionHighAndSize; in vec4 positionLowAndOutline; out vec4 v_color; void main() {}',
        ],
      }),
      vertexAttributes: {},
      fragmentShaderSource: new Cesium.ShaderSource({
        sources: ['void main() {}'],
      }),
    },
    cull: false,
  });
  const commands = [];
  const f = fixture({ commands });
  const fromCache = Cesium.ShaderProgram.fromCache;
  Cesium.ShaderProgram.fromCache = () => ({
    allUniforms: {},
    isDestroyed: () => false,
    destroy() {},
  });
  try {
    f.part.set(sweep());
    assert.equal(f.part.draws(), true);
    assert.deepEqual(f.requests, ['effects-modulation'], 'a first set asks');
    f.draw();
    f.part.set(sweep({ angle: 0.5 }));
    assert.equal(f.requests.length, 1, 'nothing shaded: the angle asks none');
    f.part.set(sweep({ angle: 0.5, radius: 300 }));
    assert.equal(f.requests.length, 2, 'anything else asks');
    commands.push(native);
    const drawn = f.draw();
    assert.notEqual(drawn[0], native, 'the marker draws shaded');
    f.part.set(sweep({ angle: 1, radius: 300 }));
    assert.equal(f.requests.length, 3, 'a marker in view: the angle asks');
    f.part.set(sweep({ angle: 1, radius: 300 }));
    assert.equal(f.requests.length, 3, 'the same sector again asks none');
    f.part.set(sweep({ angle: 1, radius: 0 }));
    assert.equal(f.requests.length, 4, 'resting the sweep asks');
    f.draw();
    f.part.set(sweep({ angle: 2, radius: 0 }));
    assert.equal(f.requests.length, 4, 'a resting angle asks none');
    f.part.set(sweep({ angle: 1, radius: 300 }));
    assert.equal(f.requests.length, 5);
    assert.deepEqual(
      f.draw({ render: false, pick: true }),
      [native],
      'pick passes keep the native command',
    );
    f.part.set(null);
    assert.equal(f.requests.length, 6, 'clearing asks');
    assert.equal(f.part.draws(), false);
    assert.deepEqual(f.draw(), [native], 'cleared: native commands');
    f.part.set(null);
    assert.equal(f.requests.length, 6, 'clearing nothing asks none');
    f.part.set(sweep());
    f.part.dispose();
    assert.equal(
      f.requests.length,
      8,
      'disposal draws the markers as they are',
    );
  } finally {
    Cesium.ShaderProgram.fromCache = fromCache;
    f.part.dispose();
    assert.equal(f.primitives.update, f.original);
    assert.equal(f.scene.postUpdate.numberOfListeners, 0);
    assert.equal(f.scene.preRender.numberOfListeners, 0);
    assert.equal(f.scene.postRender.numberOfListeners, 0);
    points.destroy();
    f.primitives.destroy();
  }
});

test('the band is placed in drawing-buffer pixels from CSS pixels', () => {
  const points = new Cesium.PointPrimitiveCollection();
  let uniforms = null;
  const native = new Cesium.DrawCommand({
    owner: points,
    uniformMap: {},
    shaderProgram: {
      vertexShaderSource: new Cesium.ShaderSource({
        sources: [
          'in vec4 positionHighAndSize; in vec4 positionLowAndOutline; out vec4 v_color; void main() {}',
        ],
      }),
      vertexAttributes: {},
      fragmentShaderSource: new Cesium.ShaderSource({
        sources: ['void main() {}'],
      }),
    },
    cull: false,
  });
  const f = fixture({ commands: [native] });
  const fromCache = Cesium.ShaderProgram.fromCache;
  Cesium.ShaderProgram.fromCache = () => ({
    allUniforms: {},
    isDestroyed: () => false,
    destroy() {},
  });
  try {
    f.part.set(
      sweep({
        center: { x: 600, y: 300 },
        angle: Math.PI / 2,
        radius: 200,
        floor: 0.5,
        color: '#ff0000',
        strength: 0.25,
      }),
    );
    uniforms = f.draw()[0].uniformMap;
    const read = (name) => uniforms[name]();
    assert.deepEqual(
      [read('u_gevSonarCenter').x, read('u_gevSonarCenter').y],
      [200, 200],
      'the centre offset, y up, at two buffer pixels per CSS pixel',
    );
    const u = read('u_gevSonar');
    assert.deepEqual([u.x, u.y, u.z, u.w], [90, 400, 0.5, 1]);
    assert.ok(Math.abs(read('u_gevSonarSector') - 24) < 1e-9);
    const tint = read('u_gevSonarTint');
    assert.deepEqual([tint.x, tint.y, tint.z, tint.w], [1, 0, 0, 0.25]);
    f.scene.canvas = { clientWidth: 500, clientHeight: 400 };
    f.draw();
    assert.deepEqual(
      [read('u_gevSonarCenter').x, read('u_gevSonarCenter').y],
      [1400, -400],
      'a resized canvas keeps the centre where the app put it',
    );
    f.part.set(sweep({ radius: 0 }));
    f.draw();
    assert.equal(read('u_gevSonar').w, 0, 'a radius of 0 holds the floor');
  } finally {
    Cesium.ShaderProgram.fromCache = fromCache;
    f.part.dispose();
    points.destroy();
    f.primitives.destroy();
  }
});

test('an unknown native shader stops the pass, keeps native commands and gives models back', () => {
  const points = new Cesium.PointPrimitiveCollection();
  const command = {
    owner: points,
    uniformMap: {},
    shaderProgram: {
      vertexShaderSource: new Cesium.ShaderSource({
        sources: ['void main() {}'],
      }),
    },
  };
  const f = fixture({ commands: [command] });
  const nativeColor = new Cesium.Color(0.2, 0.4, 0.8, 1);
  const model = Object.create(Cesium.Model.prototype, {
    ready: { value: true },
    show: { value: true },
    color: { value: nativeColor.clone(), writable: true },
    modelMatrix: { value: Cesium.Matrix4.IDENTITY },
  });
  f.primitives.add(model);
  try {
    f.part.set(sweep({ radius: 0 }));
    const before = f.requests.length;
    f.scene.postUpdate.raiseEvent();
    f.scene.preRender.raiseEvent();
    assert.notDeepEqual(model.color, nativeColor, 'the model is shaded');
    const frameState = { commandList: [], passes: { render: true } };
    f.primitives.update(frameState);
    assert.equal(frameState.commandList[0], command);
    assert.equal(f.part.stats.supported, false);
    assert.match(f.part.stats.error, /Unsupported native contact shader/);
    assert.equal(f.part.draws(), false);
    assert.equal(f.changes(), 1, 'listeners hear the pass stop');
    assert.equal(f.requests.length, before + 1, 'one frame to give back');
    f.scene.postRender.raiseEvent();
    f.draw();
    assert.deepEqual(model.color, nativeColor, 'the model is given back');
    f.part.set(sweep({ angle: 2 }));
    f.draw();
    assert.equal(f.part.stats.programs, 0, 'no retry');
  } finally {
    f.part.dispose();
    points.destroy();
    f.primitives.destroy();
  }
});

test('program swaps, layer removal and late shader failure release only the pass resources', () => {
  const points = new Cesium.PointPrimitiveCollection();
  const source = () => ({
    vertexShaderSource: new Cesium.ShaderSource({
      sources: [
        'in vec4 positionHighAndSize; in vec4 positionLowAndOutline; out vec4 v_color; void main() {}',
      ],
    }),
    vertexAttributes: {},
    fragmentShaderSource: new Cesium.ShaderSource({
      sources: ['void main() {}'],
    }),
  });
  const native = new Cesium.DrawCommand({
    owner: points,
    uniformMap: {},
    shaderProgram: source(),
    cull: false,
    vertexArray: { generation: 1 },
    pickId: 'native-pick',
  });
  const unknown = new Cesium.DrawCommand({
    owner: points,
    uniformMap: {},
    shaderProgram: {
      vertexShaderSource: new Cesium.ShaderSource({
        sources: ['void main() {}'],
      }),
    },
  });
  const commands = [native];
  const f = fixture({ commands });
  const fromCache = Cesium.ShaderProgram.fromCache;
  const created = [];
  Cesium.ShaderProgram.fromCache = () => {
    const program = {
      allUniforms: {},
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
      destroy() {
        assert.equal(this.destroyed, false);
        this.destroyed = true;
      },
    };
    created.push(program);
    return program;
  };
  try {
    f.part.set(sweep());
    const first = f.draw()[0];
    assert.notEqual(first, native);
    first.dirty = false;
    assert.equal(f.draw()[0], first);
    assert.equal(first.dirty, false);
    assert.equal(created.length, 1, 'stable draws reuse the program');
    const buffer = { generation: 2 };
    native.vertexArray = buffer;
    native.shaderProgram = source();
    const swapped = f.draw()[0];
    assert.equal(swapped, first);
    assert.equal(swapped.vertexArray, buffer);
    assert.equal(swapped.pickId, 'native-pick');
    assert.equal(swapped.shaderProgram, created[1]);
    assert.equal(created[0].destroyed, true);
    assert.equal(f.part.stats.programs, 1);
    commands.length = 0;
    f.draw();
    assert.equal(created[1].destroyed, true);
    assert.equal(f.part.stats.programs, 0, 'removed layers keep no program');
    commands.push(native);
    f.draw();
    f.part.set(null);
    assert.equal(f.draw()[0], native);
    assert.equal(created[2].destroyed, true, 'clearing releases the program');
    f.part.set(sweep());
    commands.push(unknown);
    assert.deepEqual(
      f.draw(),
      commands,
      'a later failure rolls back earlier replacements in the same slice',
    );
    assert.equal(created[3].destroyed, true);
    assert.equal(f.part.stats.supported, false);
    assert.equal(f.part.stats.programs, 0);
    assert.equal(f.part.stats.commands, 0);
    assert.equal(f.part.stats.visibleCommands, 0);
    assert.deepEqual(f.draw(), commands);
    assert.equal(created.length, 4, 'unsupported draws do not recompile');
  } finally {
    f.part.dispose();
    Cesium.ShaderProgram.fromCache = fromCache;
    points.destroy();
    f.primitives.destroy();
  }
});

test('disposal does not overwrite a successor update owner', () => {
  const f = fixture();
  f.part.set(sweep());
  const successor = () => {};
  f.primitives.update = successor;
  f.part.dispose();
  assert.equal(f.primitives.update, successor);
  f.primitives.destroy();
});
