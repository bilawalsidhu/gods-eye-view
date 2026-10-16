import assert from 'node:assert/strict';
import test from 'node:test';
import { ShaderLib, UniformsUtils } from 'three';
import { createMoverStore, normalizeMoverSetOptions } from '../../movers.js';
import { createMoverMesh, patchMoverShader } from './moverMesh.js';

const spriteOptions = normalizeMoverSetOptions({
  id: 'flights',
  kind: 'sprite',
  capacity: 4,
  order: 3,
  depthTest: { disableWithinM: 2000 },
  sprite: {
    atlas: { canvas: { width: 8, height: 8 }, cells: { a: [0, 0, 1, 1] } },
    sizePx: 24,
    scaleByDistance: [1000, 1, 100000, 0.5],
  },
});

const basicShader = () => ({
  uniforms: UniformsUtils.clone(ShaderLib.basic.uniforms),
  vertexShader: ShaderLib.basic.vertexShader,
  fragmentShader: ShaderLib.basic.fragmentShader,
});

test('the shader patch sizes the quad in pixels and colours it per instance', () => {
  const shader = patchMoverShader(basicShader(), { uGevSizePx: { value: 9 } });
  assert.equal(shader.uniforms.uGevSizePx.value, 9);
  assert.match(shader.vertexShader, /attribute vec4 gevStyle;/);
  assert.match(
    shader.vertexShader,
    /uGevFootprint \* max\(-mvCenter\.z, 0\.0\)/,
  );
  assert.match(shader.vertexShader, /vMapUv = mix\(gevUv\.xy, gevUv\.zw, uv\)/);
  assert.match(
    shader.vertexShader,
    /vGevDepthFree = gevDistance < uGevDisableWithinM/,
  );
  assert.match(shader.fragmentShader, /if \(gevOverlayHidden\(\)\) discard;/);
  assert.doesNotMatch(shader.vertexShader, /#include <project_vertex>/);
  assert.match(
    shader.fragmentShader,
    /diffuseColor \*= sRGBTransferEOTF\(vGevColor\);/,
    'sRGB instance colours are decoded',
  );
  assert.doesNotMatch(shader.fragmentShader, /gevRadius > 1\.0\) discard/);
  const point = patchMoverShader(basicShader(), {}, { point: true });
  assert.match(point.fragmentShader, /if \(gevRadius > 1\.0\) discard;/);
});

test('a sprite mesh uploads committed instances relative to its origin', () => {
  const store = createMoverStore(spriteOptions);
  const mover = createMoverMesh(spriteOptions, store);
  const { mesh, uniforms } = mover;
  assert.equal(mesh.renderOrder, 3);
  assert.equal(mesh.count, 0);
  // The overlay tests depth in the shader, against the scene's.
  assert.equal(mesh.material.depthTest, false);
  assert.equal(uniforms.uGevDepthMode.value, 1);
  assert.equal(uniforms.uGevDisableWithinM.value, 2000);
  assert.deepEqual(uniforms.uGevScaleByDistance.value, [1000, 1, 100000, 0.5]);
  store.set(0, { position: { x: 6_378_137, y: 10, z: 20 } });
  store.set(1, {
    position: { x: 6_378_147, y: 10, z: 20 },
    color: [1, 0, 0, 1],
  });
  store.setCount(2);
  mover.commit(store.dirty());
  assert.equal(mesh.count, 2);
  assert.deepEqual(mover.origin(), { x: 6_378_137, y: 10, z: 20 });
  assert.equal(mesh.position.x, 6_378_137);
  assert.deepEqual([...mesh.instanceMatrix.array.subarray(28, 31)], [10, 0, 0]);
  const color = mesh.geometry.getAttribute('gevColor');
  assert.deepEqual([...color.array.subarray(4, 8)], [1, 0, 0, 1]);
  assert.ok(color.version > 0);
});

test('update sets the pixel footprint and moves the origin to a far camera', () => {
  const store = createMoverStore(spriteOptions);
  const mover = createMoverMesh(spriteOptions, store);
  store.set(0, { position: { x: 6_378_137, y: 0, z: 0 } });
  store.setCount(1);
  mover.commit(store.dirty());
  const camera = {
    cameraPosition: { x: 6_378_137 + 300, y: 0, z: 0 },
    cameraHeight: 300,
    fovDeg: 90,
    viewportHeightPx: 800,
  };
  assert.equal(mover.update(camera), false, 'close: the origin stays');
  assert.ok(Math.abs(mover.uniforms.uGevFootprint.value - 2 / 800) < 1e-12);
  camera.cameraPosition = { x: 6_378_137 + 5_000, y: 0, z: 0 };
  assert.equal(mover.update(camera), true);
  assert.equal(mover.origin().x, 6_378_137 + 5_000);
  assert.equal(mesh(mover).instanceMatrix.array[12], -5_000);
});

const mesh = (mover) => mover.mesh;

test('points have no atlas and draw a disc', () => {
  const options = normalizeMoverSetOptions({
    id: 'p',
    kind: 'point',
    capacity: 1,
    depthTest: 'always',
    point: { sizePx: 6, outlinePx: 1 },
  });
  const mover = createMoverMesh(options, createMoverStore(options));
  assert.equal(mover.mesh.material.map, null);
  assert.equal(mover.mesh.material.depthTest, false);
  assert.equal(mover.uniforms.uGevDepthMode.value, 0, "'always': no test");
  assert.equal(mover.uniforms.uGevOutlinePx.value, 1);
  mover.dispose();
});
