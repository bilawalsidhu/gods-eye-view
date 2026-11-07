import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GreaterDepth,
  Matrix4,
  ShaderLib,
  UniformsUtils,
  Vector3,
} from 'three';
import { createNavaraLines } from './index.js';
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

test('segment batches share an overlay mesh without connecting the endpoints', () => {
  const groups = [];
  let requests = 0,
    disposed = 0;
  const overlay = {
    uniforms: {
      tGevSceneDepth: { value: null },
      uGevResolution: { value: [0, 0] },
    },
    add: (group) => groups.push(group),
    remove: (group) => groups.splice(groups.indexOf(group), 1),
  };
  const part = createNavaraLines(
    {
      forceUpdate() {
        requests++;
      },
      canvas: { clientWidth: 800, clientHeight: 600 },
    },
    { overlay },
  );
  const batch = part.lines.createSegments({
    id: 'stems',
    widthPx: 2,
    color: [1, 0, 0, 1],
  });
  const items = [
    {
      positions: new Float64Array([6378137, 0, 0, 6378137, 10, 0]),
      pickId: 'first',
    },
    {
      positions: new Float64Array([6378137, 100, 0, 6378137, 110, 0]),
      widthPx: 4,
      color: [0, 1, 0, 0.5],
      pickId: 'second',
    },
  ];
  batch.replace(items);
  batch.commit();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].children.length, 1);
  const mesh = groups[0].children[0];
  const geometry = mesh.geometry;
  assert.equal(geometry.index.count, 12, 'two quads, no bridge');
  assert.deepEqual(
    [...geometry.getAttribute('position').array.slice(12, 15)],
    [0, 100, 0],
  );
  assert.deepEqual(
    [...geometry.getAttribute('gevWidth').array],
    [2, 2, 2, 2, 4, 4, 4, 4],
  );
  assert.deepEqual(
    [...geometry.getAttribute('gevColor').array.slice(16, 20)],
    [0, 1, 0, 0.5],
  );
  assert.equal(mesh.material.defines.GEV_SEGMENTS, 1);
  assert.deepEqual(
    part.pickables().map((item) => item.options.pickId),
    ['first', 'second'],
  );
  geometry.addEventListener('dispose', () => disposed++);
  batch.show(false);
  batch.replace(items.slice(1));
  batch.commit();
  assert.equal(disposed, 1);
  assert.equal(groups[0].visible, false);
  assert.deepEqual(part.pickables(), []);
  batch.show(true);
  assert.equal(part.pickables()[0].options.pickId, 'second');
  assert.equal(part.pickables()[0].options.id, 'stems');
  part.destroy();
  assert.deepEqual(groups, []);
  assert.deepEqual(part.lines.list(), []);
  assert.ok(requests >= 5);
});
