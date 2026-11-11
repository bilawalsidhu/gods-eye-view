import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { PerspectiveCamera, ShaderLib } from 'three';
import { cartesian3 } from '../../../geo/index.js';
import { createMoverStore, normalizeMoverSetOptions } from '../../movers.js';
import { createMoverMesh, patchMoverShader } from './moverMesh.js';

// Execute the scalar decisions from the material's actual shader patch.
function decision(name) {
  const shader = patchMoverShader(
    {
      uniforms: {},
      vertexShader: ShaderLib.basic.vertexShader,
      fragmentShader: ShaderLib.basic.fragmentShader,
    },
    {},
  );
  const functions = ['packedDepthOccluded', name].map((key) => {
    const body = shader.fragmentShader.match(
      new RegExp(`bool ${key}\\([^}]+}`),
    );
    assert.ok(body, `${key} is in the compiled mover shader`);
    return body[0]
      .replace(`bool ${key}`, `function ${key}`)
      .replaceAll(/float (\w+)/g, '$1');
  });
  return new Function(`${functions.join('\n')}\nreturn ${name};`)();
}

for (const [name, mine, scene, globe, hidden] of [
  ['on terrain', 0.4, 0.4, 0.4, false],
  ['below terrain', 0.7, 0.4, 0.4, false],
  ['terrain copy rounding', 0.7, 0.4 - 6e-8, 0.4, false],
  ['tile in front of terrain', 0.7, 0.3, 0.4, true],
  ['tile with globe hidden', 0.7, 0.3, 1, true],
  ['model in front of terrain', 0.7, 0.2, 0.4, true],
  ['point in front of model', 0.1, 0.2, 0.4, false],
  ['no surface', 0.7, 1, 1, false],
]) {
  test(`mover depth: ${name}`, () => {
    assert.equal(decision('gevMoverSceneHidden')(mine, scene, globe), hidden);
  });
}

for (const latitude of [0, 45, 90]) {
  test(`mover horizon at latitude ${latitude} ignores nearby underground points`, () => {
    const hidden = decision('gevMoverHorizonHidden');
    const eye = cartesian3.fromDegrees(0, latitude, 10000);
    const radii = [6378137, 6378137, 6356752.3142451793];
    const scaledEye = [eye.x, eye.y, eye.z].map((v, i) => v / radii[i]);
    const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
    const visible = (position) => {
      const ray = [
        position.x - eye.x,
        position.y - eye.y,
        position.z - eye.z,
      ].map((v, i) => v / radii[i]);
      return !hidden(
        dot(scaledEye, scaledEye) - 1,
        -dot(ray, scaledEye),
        dot(ray, ray),
      );
    };
    assert.equal(visible(cartesian3.fromDegrees(0, latitude, 0)), true);
    assert.equal(visible(cartesian3.fromDegrees(0, latitude, -1000)), true);
    assert.equal(visible(cartesian3.fromDegrees(180, -latitude, 0)), false);
  });
}

test('a high mover outside the Earth silhouette is not clipped by the limb plane', () => {
  assert.equal(decision('gevMoverHorizonHidden')(0.1, 0.2, 1), false);
});

test('point and sprite shaders share terrain classification and camera-relative horizon inputs', () => {
  for (const kind of ['point', 'sprite']) {
    const options = normalizeMoverSetOptions({
      id: kind,
      kind,
      capacity: 1,
      depthTest: 'normal',
      point: { sizePx: 24 },
      sprite: { sizePx: 24, atlas: { canvas: {}, cells: { a: [0, 0, 1, 1] } } },
    });
    const mover = createMoverMesh(options, createMoverStore(options));
    try {
      mover.update({
        cameraPosition: { x: 6379137, y: 0, z: 0 },
        cameraHeight: 1000,
        fovDeg: 60,
        viewportHeightPx: 800,
      });
      assert.deepEqual(mover.uniforms.uGevScaledCamera?.value, [
        6379137 / 6378137,
        0,
        0,
      ]);
      const shader = {
        uniforms: {},
        vertexShader: ShaderLib.basic.vertexShader,
        fragmentShader: ShaderLib.basic.fragmentShader,
      };
      mover.mesh.material.onBeforeCompile(shader);
      assert.match(shader.fragmentShader, /#define GEV_MOVER_DEPTH/);
      assert.match(shader.fragmentShader, /texelFetch\(tGevSceneDepth/);
      assert.match(shader.fragmentShader, /texelFetch\(tGevGlobeDepth/);
      assert.match(shader.vertexShader, /mvPosition.xyz \* mat3\(viewMatrix\)/);
      assert.equal(
        shader.uniforms.tGevGlobeDepth,
        mover.uniforms.tGevGlobeDepth,
      );
    } finally {
      mover.dispose();
    }
  }
});

test('mover frames bind the current public globe-depth copy', async () => {
  // The SDK's descriptor bases are browser-only; the mover and frame callback
  // remain real, with the public depth/renderer methods supplied below.
  const stub = `data:text/javascript,${encodeURIComponent(`
    export class MeshDesc {}
    export class EffectDesc {}
    export class Pass {}
    export class PickableInstancedMeshWrapper {}
    export function createGltfLoader() { throw new Error('Unexpected model load'); }
  `)}`;
  const loader = registerHooks({
    resolve(specifier, context, next) {
      return specifier === '@navaramap/three'
        ? { url: stub, shortCircuit: true }
        : next(specifier, context);
    },
  });
  let createNavaraMovers;
  try {
    ({ createNavaraMovers } = await import('./index.js'));
  } finally {
    loader.deregister();
  }
  const camera = new PerspectiveCamera(60, 1.6, 1, 1e8);
  camera.position.set(6379137, 0, 0);
  let globeDepth = {};
  let mesh;
  let frame;
  const overlay = {
    uniforms: {
      tGevSceneDepth: { value: {} },
      uGevResolution: { value: [1280, 800] },
    },
    ctx: {
      getGlobeDepthTexture: () => globeDepth,
      getRenderer: () => ({
        domElement: { clientHeight: 800 },
        getPixelRatio: () => 1,
      }),
    },
    add(value, update) {
      mesh = value;
      frame = update;
    },
    remove() {},
  };
  const owner = createNavaraMovers(
    {
      camera: { raw: camera },
      registerMesh() {},
      forceUpdate() {},
    },
    { overlay },
  );
  try {
    owner.movers.createSet({
      id: 'depth-copy',
      kind: 'point',
      capacity: 1,
      point: { sizePx: 24 },
    });
    const shader = {
      uniforms: {},
      vertexShader: ShaderLib.basic.vertexShader,
      fragmentShader: ShaderLib.basic.fragmentShader,
    };
    mesh.material.onBeforeCompile(shader);
    frame(1);
    assert.equal(shader.uniforms.tGevGlobeDepth?.value, globeDepth);
    globeDepth = {};
    frame(2);
    assert.equal(shader.uniforms.tGevGlobeDepth.value, globeDepth);
  } finally {
    owner.destroy();
  }
});
