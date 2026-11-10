import { createFakeEngine } from '../testing/fakeEngine.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BasicDepthPacking,
  DataTexture,
  MeshBasicMaterial,
  RGBADepthPacking,
  ShaderLib,
} from 'three';
import {
  SCENE_DEPTH_BIAS,
  createSceneDepthTest,
  withSceneDepthTest,
} from './sceneDepth.js';
import { createPackRenderer } from '../../scenes/dataPacks/display.js';
import { createNavaraMeshes } from './meshes.js';

const count = (text, part) => text.split(part).length - 1;

test('the scene-depth test goes after the log depth and brings packing once', () => {
  for (const source of [
    ShaderLib.basic.fragmentShader,
    '#include <common>\n#include <packing>\nvoid main() {\n#include <logdepthbuf_fragment>\n}',
  ]) {
    const patched = withSceneDepthTest(source);
    assert.equal(count(patched, '#include <packing>'), 1);
    assert.equal(count(patched, 'uniform sampler2D tGevSceneDepth;'), 1);
    const depth = patched.indexOf('#include <logdepthbuf_fragment>');
    const test = patched.indexOf('if (uGevSceneDepthOn > 0.5)');
    assert.ok(depth >= 0 && test > depth, 'tested after gl_FragDepth is set');
    assert.ok(
      patched.indexOf('uniform float uGevSceneDepthOn;') <
        patched.indexOf('void main() {'),
    );
    assert.match(
      patched,
      /packedDepthOccluded\(gevDepth, gevScene, 5e-6\)\)\s*discard;/,
    );
  }
  assert.ok(SCENE_DEPTH_BIAS > 0 && SCENE_DEPTH_BIAS < 1e-4);
  assert.throws(() => withSceneDepthTest('void main() {}'), /logdepthbuf/);
});

test('the test binds the MRT pass packed depth before each draw, and only packed RGBA depth', () => {
  const depth = createSceneDepthTest();
  const material = depth.material(new MeshBasicMaterial());
  const shader = {
    uniforms: {},
    vertexShader: ShaderLib.basic.vertexShader,
    fragmentShader: ShaderLib.basic.fragmentShader,
  };
  material.onBeforeCompile(shader, null);
  assert.match(material.customProgramCacheKey(), /_gevSceneDepth$/);
  assert.equal(shader.uniforms.tGevSceneDepth, depth.uniforms.tGevSceneDepth);
  assert.match(shader.fragmentShader, /discard;/);

  const drawn = [];
  const object = depth.object({
    userData: {},
    onBeforeRender: (renderer) => drawn.push(renderer),
  });
  const texture = new DataTexture();
  const mrt = { depthBuffer: texture, depthBufferPacking: RGBADepthPacking };
  const renderer = { getRenderTarget: () => ({ width: 640, height: 360 }) };
  // Before the descriptor attaches its context the test stays off.
  object.onBeforeRender(renderer);
  assert.equal(depth.uniforms.uGevSceneDepthOn.value, 0);
  depth.attach({ findEffect: (key) => (key === 'mrt' ? mrt : undefined) });
  object.onBeforeRender(renderer);
  assert.equal(depth.uniforms.tGevSceneDepth.value, texture);
  assert.equal(depth.uniforms.uGevSceneDepthOn.value, 1);
  assert.deepEqual(depth.uniforms.uGevTargetSize.value.toArray(), [640, 360]);
  assert.deepEqual(drawn, [renderer, renderer], 'the mesh hook still runs');
  // Another packing would be read wrong: the mesh draws as before.
  mrt.depthBufferPacking = BasicDepthPacking;
  object.onBeforeRender(renderer);
  assert.equal(depth.uniforms.uGevSceneDepthOn.value, 0);
  assert.equal(depth.uniforms.tGevSceneDepth.value, null);
});

/** An overlay that exposes the scene's packed depth to its meshes. */
function fakeView() {
  const created = [];
  const mrt = {
    depthBuffer: new DataTexture(),
    depthBufferPacking: RGBADepthPacking,
  };
  const ctx = { findEffect: (key) => (key === 'mrt' ? mrt : undefined) };
  const view = {
    forceUpdate() {},
  };
  const overlay = {
    ctx,
    add(object) {
      created.push(object);
    },
    remove() {},
  };
  return { view, overlay, created, mrt };
}

/** Every renderable under an object compiles with the test and binds depth. */
function assertTested(object, mrt) {
  const renderables = [];
  object.traverse?.((child) => {
    if (child.material) renderables.push(child);
  });
  if (!object.traverse && object.material) renderables.push(object);
  assert.ok(renderables.length > 0);
  for (const child of renderables) {
    const shader = {
      uniforms: { ...(child.material.uniforms ?? {}) },
      vertexShader: '',
      fragmentShader:
        child.material.fragmentShader ?? ShaderLib.basic.fragmentShader,
    };
    child.material.onBeforeCompile(shader, null);
    assert.match(shader.fragmentShader, /if \(uGevSceneDepthOn > 0\.5\)/);
    assert.ok(shader.uniforms.tGevSceneDepth);
    child.onBeforeRender(
      {
        getRenderTarget: () => ({ width: 8, height: 8 }),
        getViewport: (target) => target.set(0, 0, 8, 8),
      },
      null,
      null,
      child.geometry,
      child.material,
    );
    assert.equal(shader.uniforms.tGevSceneDepth.value, mrt.depthBuffer);
    assert.equal(shader.uniforms.uGevSceneDepthOn.value, 1);
  }
}

test('pack meshes draw in the overlay and test the scene depth', () => {
  const packs = fakeView();
  const owned = [];
  const port = createNavaraMeshes(packs.view, {
    overlay: packs.overlay,
    camera: {},
    picker: { registerMeshPicker: () => () => {} },
  });
  const engine = Object.assign(createFakeEngine(), { meshes: port.meshes });
  createPackRenderer(engine).image(
    { id: 'p', placement: { bounds: [0, 0, 0.01, 0.01], height: 300 } },
    {},
    { own: (fn) => owned.push(fn) },
  );
  assert.equal(packs.created.length, 1);
  assertTested(packs.created[0], packs.mrt);
  assert.equal(packs.created[0].children[0].material.depthTest, true);
  for (const release of owned) release();
  port.destroy();
});
