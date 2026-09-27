import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createCyberSonarGpu,
  sonarVertexSource,
  CYBER_SONAR_CESIUM_VERSION,
  isCyberSonarCommandVisible,
  syncCyberSonarCommand,
} from './cyberSonarGpu.js';

test('stable commands reuse uniforms and derived pipelines while all native fields remain live', () => {
  const native = new Cesium.DrawCommand({
    count: 6,
    uniformMap: { value: () => 1 },
  });
  const record = {},
    program = {},
    uniforms = { u_gevSonar: () => 42 };
  const derived = syncCyberSonarCommand(native, record, program, uniforms, 0);
  const map = derived.uniformMap;
  derived.dirty = false;
  derived.lastDirtyTime = 7;
  assert.equal(native.dirty, true);
  assert.equal(
    syncCyberSonarCommand(native, record, program, uniforms, 1),
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
    syncCyberSonarCommand(native, record, program, uniforms, 0);
    assert.equal(derived[key], value, key);
    assert.equal(derived.dirty, true, key);
  }
  native.uniformMap.value = () => 2;
  syncCyberSonarCommand(native, record, program, uniforms, 0);
  assert.equal(map.value(), 2);
  native.uniformMap = { replacement: () => 3 };
  syncCyberSonarCommand(native, record, program, uniforms, 0);
  assert.equal(map.value, undefined);
  assert.equal(map.replacement(), 3);
  assert.equal(map.u_gevSonar(), 42);
  const nextProgram = {};
  syncCyberSonarCommand(native, record, nextProgram, uniforms, 0);
  assert.equal(derived.shaderProgram, nextProgram);
  assert.equal(native.shaderProgram, undefined);
});

test('GPU shader transform is isolated, settings-driven, and precedes native fragment classification', () => {
  assert.equal(
    Cesium.VERSION,
    CYBER_SONAR_CESIUM_VERSION,
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
    const next = sonarVertexSource(source, kind);
    assert.equal(source.sources[0], original);
    assert.notEqual(next, source);
    assert.deepEqual(next.defines, ['SDF']);
    assert.match(next.sources[0], /void gev_sonar_main/);
    assert.match(next.sources[1], /v_color.a \*= factor/);
    assert.match(next.sources[1], /u_gevSonarSector/);
    assert.match(next.sources[1], /floorValue \+ \(1.0 - floorValue\) \* 0.46/);
    assert.ok(
      next.sources[1].includes(
        `czm_translateRelativeToEye(${attr}.xyz, ${low}.xyz)`,
      ),
    );
    assert.match(next.sources[1], /anchor.xy \/ anchor.w/);
    assert.doesNotMatch(next.sources[1], /gl_Position\s*[=\/]/);
  }
  assert.equal(
    sonarVertexSource(
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
  assert.equal(isCyberSonarCommandVisible(command, frame), true);
  assert.equal(intersections, 5);
  occluded = true;
  assert.equal(isCyberSonarCommandVisible(command, frame), false);
  frame.mode = Cesium.SceneMode.SCENE2D;
  assert.equal(isCyberSonarCommandVisible(command, frame), true);
  command.boundingVolume.intersectPlane = () => Cesium.Intersect.OUTSIDE;
  assert.equal(isCyberSonarCommandVisible(command, frame), false);
  command.cull = false;
  assert.equal(isCyberSonarCommandVisible(command, frame), true);
  assert.equal(isCyberSonarCommandVisible({}, frame), true);
});

test('adapter never walks contacts, touches other scenes, or transforms pick-only passes', () => {
  let calls = 0;
  const original = function (fs) {
    assert.equal(this, root);
    calls++;
    fs.commandList.push({ owner: {}, id: 'terrain' });
  };
  const root = { update: original };
  const other = { update: original };
  const adapter = createCyberSonarGpu({ primitives: root }, () => ({
    enabled: false,
  }));
  const frame = { commandList: [], passes: { render: true, pick: false } };
  root.update(frame);
  assert.equal(calls, 1);
  assert.equal(frame.commandList[0].id, 'terrain');
  assert.equal(other.update, original);
  root.update({ commandList: [], passes: { render: false, pick: true } });
  assert.equal(calls, 2);
  adapter.destroy();
  adapter.destroy();
  assert.equal(root.update, original);
});

test('unknown native shaders fail closed without losing native commands', () => {
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
  const root = {
    update(fs) {
      fs.commandList.push(command);
    },
  };
  const adapter = createCyberSonarGpu(
    { primitives: root, drawingBufferWidth: 800, drawingBufferHeight: 600 },
    () => ({
      enabled: true,
      active: true,
      angle: 0,
      range: 100,
      opacity: 84,
      sector: 24,
    }),
  );
  const frame = { commandList: [], passes: { render: true } };
  root.update(frame);
  assert.equal(frame.commandList[0], command);
  assert.equal(adapter.stats.supported, false);
  assert.match(adapter.stats.error, /Unsupported native contact shader/);
  assert.equal(adapter.stats.programs, 0);
  adapter.destroy();
  points.destroy();
});

test('program swaps, layer removal and late shader failure release only adapter resources', () => {
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
  let nativeCommands = [native];
  let enabled = true;
  const root = {
    update(frame) {
      frame.commandList.push(...nativeCommands);
    },
  };
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
  const adapter = createCyberSonarGpu(
    { primitives: root, drawingBufferWidth: 800, drawingBufferHeight: 600 },
    () => ({
      enabled,
      active: true,
      angle: 0,
      range: 100,
      opacity: 84,
      sector: 24,
    }),
  );
  const draw = () => {
    const frame = { commandList: [], passes: { render: true } };
    root.update(frame);
    return frame.commandList;
  };
  try {
    const first = draw()[0];
    assert.notEqual(first, native);
    first.dirty = false;
    assert.equal(draw()[0], first);
    assert.equal(first.dirty, false);
    assert.equal(created.length, 1, 'stable draws reuse the program');
    const buffer = { generation: 2 };
    native.vertexArray = buffer;
    native.shaderProgram = source();
    const swapped = draw()[0];
    assert.equal(swapped, first);
    assert.equal(swapped.vertexArray, buffer);
    assert.equal(swapped.pickId, 'native-pick');
    assert.equal(swapped.shaderProgram, created[1]);
    assert.equal(created[0].destroyed, true);
    assert.equal(adapter.stats.programs, 1);
    nativeCommands = [];
    draw();
    assert.equal(created[1].destroyed, true);
    assert.equal(
      adapter.stats.programs,
      0,
      'disabled layers retain no adapter program',
    );
    nativeCommands = [native];
    draw();
    enabled = false;
    assert.equal(draw()[0], native);
    assert.equal(
      created[2].destroyed,
      true,
      'theme/cockpit exit releases the derived program',
    );
    enabled = true;
    nativeCommands = [native, unknown];
    assert.deepEqual(
      draw(),
      nativeCommands,
      'a later failure rolls back earlier replacements in the same slice',
    );
    assert.equal(created[3].destroyed, true);
    assert.equal(adapter.stats.supported, false);
    assert.equal(adapter.stats.programs, 0);
    assert.equal(adapter.stats.commands, 0);
    assert.equal(adapter.stats.visibleCommands, 0);
    assert.deepEqual(draw(), nativeCommands);
    assert.equal(
      created.length,
      4,
      'unsupported draws do not retry compilation',
    );
  } finally {
    adapter.destroy();
    Cesium.ShaderProgram.fromCache = fromCache;
    points.destroy();
  }
});

test('disposal does not overwrite a successor update owner', () => {
  const root = { update() {} };
  const adapter = createCyberSonarGpu({ primitives: root }, () => ({
    enabled: false,
  }));
  const successor = () => {};
  root.update = successor;
  adapter.destroy();
  assert.equal(root.update, successor);
});
