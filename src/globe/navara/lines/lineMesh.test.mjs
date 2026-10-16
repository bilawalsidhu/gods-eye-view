import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GreaterDepth,
  Matrix4,
  ShaderLib,
  UniformsUtils,
  Vector3,
} from 'three';
import { normalizeLineOptions } from '../../lines.js';
import { buildRibbon, createLineMesh, patchLineShader } from './lineMesh.js';

const flat = new Float64Array([
  6_378_137, 0, 0, 6_378_137, 300, 0, 6_378_137, 300, 400,
]);

test('the ribbon has a quad per segment relative to the first point', () => {
  const geometry = buildRibbon(flat, [6_378_137, 0, 0]);
  assert.equal(geometry.getAttribute('position').count, 8);
  assert.equal(geometry.index.count, 12);
  assert.deepEqual(
    [...geometry.getAttribute('gevEnd').array.subarray(0, 3)],
    [0, 300, 0],
  );
  // The fraction along the line: 0 at the start, 300/700 at the joint, 1 at the end.
  const s = geometry.getAttribute('gevS').array;
  assert.deepEqual([s[0], s[2]], [0, 300 / 700].map(Math.fround));
  assert.equal(s[7], 1);
  const side = geometry.getAttribute('gevSide').array;
  assert.deepEqual([...side.subarray(0, 8)], [0, 1, 0, -1, 1, 1, 1, -1]);
});

test('the shader patch widens the ribbon in pixels and cuts dashes', () => {
  const shader = patchLineShader(
    {
      uniforms: UniformsUtils.clone(ShaderLib.basic.uniforms),
      vertexShader: ShaderLib.basic.vertexShader,
      fragmentShader: ShaderLib.basic.fragmentShader,
    },
    { uGevWidthPx: { value: 3 } },
  );
  assert.match(
    shader.vertexShader,
    /uGevWidthPx \/ uGevViewport \* gl_Position\.w/,
  );
  assert.match(
    shader.fragmentShader,
    /mod\(gevAlong, uGevDashPx\.x \+ uGevDashPx\.y\)/,
  );
  assert.match(shader.fragmentShader, /float gevTactical\(\)/);
});

test('a line places its group at the first point under its model matrix', () => {
  const turn = new Matrix4().makeRotationZ(Math.PI / 2);
  const line = createLineMesh(
    normalizeLineOptions({
      id: 'orbit',
      widthPx: 3,
      color: [0, 1, 1, 1],
      depthFailAlpha: 0.3,
      dash: 'tactical',
      modelMatrix: turn.toArray(),
    }),
  );
  line.setPositions(flat);
  const origin = new Vector3().setFromMatrixPosition(line.group.matrix);
  // (6378137, 0, 0) turned 90° about z.
  assert.ok(Math.abs(origin.x) < 1e-6 && Math.abs(origin.y - 6_378_137) < 1e-6);
  const [main, behind] = line.meshes();
  // The overlay tests depth in the shader: normal for the line, drawn
  // only where the scene is nearer for its depth-fail copy.
  assert.equal(main.material.depthTest, false);
  assert.equal(main.material.userData.gevDepthMode, 1);
  assert.equal(behind.material.userData.gevDepthMode, 2);
  // Viewport and pixel ratio update in place (no allocation per frame).
  const viewport = line.uniforms.uGevViewport.value;
  line.update(1280, 800, 2);
  assert.equal(line.uniforms.uGevViewport.value, viewport);
  assert.deepEqual(viewport, [1280, 800]);
  assert.equal(line.uniforms.uGevPixelRatio.value, 2);
  assert.equal(main.geometry, behind.geometry);
  assert.equal(line.uniforms.uGevDash.value, 2);
  assert.deepEqual(line.uniforms.uGevTactical.value, [4, 100]);
  line.setColor([1, 0, 0, 0.5]);
  assert.deepEqual(line.uniforms.uGevColor.value, [1, 0, 0, 0.5]);
  line.show(false);
  assert.equal(line.group.visible, false);
  line.dispose();
});
