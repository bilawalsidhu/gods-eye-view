import test from 'node:test';
import assert from 'node:assert/strict';
import { createDepthOcclusionTest } from './index.js';
import {
  createFakeGl,
  rawDepthImage,
  viewDistanceToDepth,
} from '../cesium/fixtures/fakeDepthScene.mjs';

const FAR = 100_000;
const WIDTH = 64;
const HEIGHT = 32;

/** A depth texture of a frame drawn with three's log depth (near 0): left half a wall 400 m away, right half ground 500 m away. */
function depthSource(gl, { webgl2 = true } = {}) {
  const texture = gl.createTexture();
  texture.image = rawDepthImage(WIDTH, HEIGHT, (column) =>
    viewDistanceToDepth(column < WIDTH / 2 ? 400 : 500, 0, FAR, true),
  );
  return {
    gl,
    webgl2,
    width: WIDTH,
    height: HEIGHT,
    framebuffers: [],
    textures: [texture],
    encoding: 'depth',
    frustums: [{ near: 0, far: FAR }],
    logDepth: true,
    // The eye at the origin looking down -z, y up.
    view: Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    tanHalfFovX: 1,
    tanHalfFovY: 1,
  };
}

const point = () => ({
  pending: false,
  answered: false,
  lastHiddenAt: Number.NEGATIVE_INFINITY,
});

test('a depth texture is read as depth: a point behind the wall is hidden, one on the street is not', () => {
  const gl = createFakeGl();
  const source = depthSource(gl);
  const set = {};
  const uniform1i = gl.uniform1i;
  gl.uniform1i = (name, value) => {
    set[name] = value;
    uniform1i(name, value);
  };
  const test = createDepthOcclusionTest({
    readSource: () => source,
    target: () => ({}),
  });
  const behindWall = point();
  const onStreet = point();
  test.beginFrame(10);
  assert.equal(test.add(behindWall, { x: -250, y: 0, z: -500 }), true);
  assert.equal(test.add(onStreet, { x: 250, y: 0, z: -500 }), true);
  test.endFrame();
  assert.equal(test.mode, 'async');
  assert.equal(set.u_packed, 0, 'read as a depth texture');
  gl.finishGpu();
  test.beginFrame(20);
  assert.equal(behindWall.answered, true);
  assert.equal(behindWall.lastHiddenAt, 10);
  assert.equal(onStreet.answered, true);
  assert.equal(onStreet.lastHiddenAt, Number.NEGATIVE_INFINITY);
  assert.equal(gl.counts.readPixels, 0, 'nothing read back');
  test.destroy();
});

test('without queries a depth texture is not read back: nothing is tested', () => {
  const gl = createFakeGl({ webgl2: false });
  const test = createDepthOcclusionTest({
    readSource: () => depthSource(gl, { webgl2: false }),
    target: () => ({}),
  });
  test.beginFrame(0);
  assert.equal(test.add(point(), { x: -250, y: 0, z: -500 }), false);
  test.endFrame();
  assert.equal(test.mode, 'off');
  assert.equal(gl.counts.readPixels, 0);
});

test('with no target nothing is tested', () => {
  const test = createDepthOcclusionTest({
    readSource: (target) => (target ? depthSource(createFakeGl()) : null),
    target: () => null,
  });
  test.beginFrame(0);
  assert.equal(test.add(point(), { x: 0, y: 0, z: -500 }), false);
  assert.equal(test.mode, 'off');
});
