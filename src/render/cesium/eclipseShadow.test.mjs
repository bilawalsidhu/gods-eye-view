import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  ECLIPSE_SHADOW_SHADER,
  createEclipseShadowField,
} from './eclipseShadow.js';

// Words GLSL ES 3.00 keeps for itself: a variable named with one fails to
// compile, and a shader that fails to compile stops the whole scene.
const RESERVED = [
  'active',
  'asm',
  'cast',
  'class',
  'common',
  'double',
  'enum',
  'extern',
  'external',
  'filter',
  'fixed',
  'goto',
  'half',
  'hvec2',
  'inline',
  'input',
  'interface',
  'long',
  'namespace',
  'noinline',
  'output',
  'partition',
  'public',
  'resource',
  'short',
  'sizeof',
  'static',
  'superp',
  'template',
  'this',
  'typedef',
  'union',
  'unsigned',
  'using',
  'volatile',
];

test('the shader names no variable with a word GLSL reserves', () => {
  const code = ECLIPSE_SHADOW_SHADER.replace(/\/\/[^\n]*/g, '');
  const declared = [
    ...code.matchAll(
      /\b(?:float|int|bool|vec[234]|mat[234])\s+([A-Za-z_]\w*)/g,
    ),
  ].map((match) => match[1]);
  assert.ok(declared.length > 30);
  assert.deepEqual(
    declared.filter((name) => RESERVED.includes(name)),
    [],
  );
});

test('every uniform the shader declares is one it uses', () => {
  const uniforms = [
    ...ECLIPSE_SHADOW_SHADER.matchAll(/uniform \w+ (\w+);/g),
  ].map((match) => match[1]);
  assert.ok(uniforms.length >= 11);
  for (const name of uniforms)
    assert.ok(
      ECLIPSE_SHADOW_SHADER.split(name).length > 2,
      `${name} is declared but never read`,
    );
});

/** A scene with a perspective camera, and the stages it was given. */
function fakeScene() {
  const stages = [];
  const postRender = new Cesium.Event();
  let renders = 0;
  const scene = {
    mode: Cesium.SceneMode.SCENE3D,
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(10, 30, 9_500_000),
      directionWC: new Cesium.Cartesian3(0, 0, -1),
      rightWC: new Cesium.Cartesian3(1, 0, 0),
      upWC: new Cesium.Cartesian3(0, 1, 0),
      frustum: { fovy: 1, aspectRatio: 2 },
    },
    postProcessStages: {
      add: (stage) => stages.push(stage),
      remove: (stage) => stages.splice(stages.indexOf(stage), 1),
    },
    postRender,
    requestRender() {
      renders += 1;
    },
  };
  return { scene, stages, renders: () => renders };
}

const solar = {
  origin: { x: 0.1, y: 0.2, z: 0 },
  axis: { x: 0, y: 0, z: 1 },
  cones: [0.54, -0.004, 0.0047, 0.0046],
  skyShade: 0.4,
};

test('the field draws the solar shadow, the lunar tint or nothing, and goes when disposed', () => {
  const { scene, stages, renders } = fakeScene();
  let gone = 0;
  const field = createEclipseShadowField({
    scene,
    spec: { kind: 'eclipseShadow', id: 'shadow', solar: null, lunar: null },
    createStage: (options) => ({ ...options, enabled: true }),
    onDispose: () => {
      gone += 1;
    },
  });
  assert.equal(stages.length, 1);
  const [stage] = stages;
  assert.equal(stage.fragmentShader, ECLIPSE_SHADOW_SHADER);
  // Nothing to draw: the stage is off, so an idle field costs nothing.
  assert.equal(stage.enabled, false);
  field.update({ solar });
  assert.equal(stage.enabled, true);
  const u = stage.uniforms;
  assert.deepEqual(
    [u.u_axisOrigin().x, u.u_axisOrigin().y, u.u_axisDirection().z],
    [0.1, 0.2, 1],
  );
  assert.deepEqual(
    [u.u_cones().x, u.u_cones().y, u.u_cones().z, u.u_cones().w],
    solar.cones,
  );
  assert.equal(u.u_skyShade(), 0.4);
  assert.equal(u.u_lunar(), 0);
  // The camera in Earth radii, its right and up scaled by the field of view.
  assert.ok(
    Math.abs(Cesium.Cartesian3.magnitude(u.u_cameraPosition()) - 2.49) < 0.01,
  );
  assert.ok(Math.abs(u.u_cameraUp().y - Math.tan(0.5)) < 1e-12);
  assert.ok(Math.abs(u.u_cameraRight().x - 2 * Math.tan(0.5)) < 1e-12);
  // A lunar eclipse in its place.
  field.update({
    solar: null,
    lunar: { moon: [0, 60, 0, 0.27], depth: 1.4 },
  });
  assert.equal(u.u_lunar(), 1);
  assert.equal(u.u_lunarDepth(), 1);
  assert.equal(u.u_lunarMoon().y, 60);
  assert.equal(u.u_skyShade(), 0);
  // Hidden, then shown again with what it had.
  field.show = false;
  assert.equal(stage.enabled, false);
  field.show = true;
  assert.equal(stage.enabled, true);
  assert.ok(renders() >= 4);
  assert.throws(() => field.update({ kind: 'rasterShell' }), /keeps its kind/);
  // An axis given as an array is refused before it reaches the shader.
  assert.throws(
    () => field.update({ solar: { ...solar, origin: [0.1, 0.2, 0] } }),
    /finite x, y and z/,
  );
  assert.equal(stage.uniforms.u_axisOrigin().x, 0.1);
  field.dispose();
  field.dispose();
  assert.equal(stages.length, 0);
  assert.equal(gone, 1);
});

test('the field draws nothing off the 3D globe', () => {
  const { scene, stages } = fakeScene();
  scene.mode = Cesium.SceneMode.SCENE2D;
  createEclipseShadowField({
    scene,
    spec: { kind: 'eclipseShadow', id: 'shadow', solar },
    createStage: (options) => ({ ...options }),
  });
  assert.equal(stages[0].enabled, false);
});

test('the draw port makes an eclipse shadow field', async () => {
  const { createCesiumFields } = await import('./drawFields.js');
  const { scene, stages } = fakeScene();
  scene.postProcessStages.isDestroyed = () => false;
  const fields = createCesiumFields({ scene });
  const handle = fields.field({ kind: 'eclipseShadow', id: 'shadow', solar });
  assert.equal(fields.has('shadow'), true);
  assert.equal(stages.length, 1);
  handle.dispose();
  assert.equal(fields.has('shadow'), false);
  assert.equal(stages.length, 0);
});
