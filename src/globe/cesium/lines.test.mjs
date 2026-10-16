import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createCesiumLines, dashPattern } from './lines.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

function fakePrimitives() {
  const made = [];
  return {
    made,
    factories: {
      primitive: (options) => {
        const primitive = {
          ...options,
          isDestroyed: () => false,
          destroy() {
            primitive.destroyed = true;
          },
        };
        made.push(primitive);
        return primitive;
      },
      appearance: (spec) => ({
        material: { type: spec.type, uniforms: { ...spec.uniforms } },
      }),
    },
  };
}

const points = [
  { x: 6_378_137, y: 0, z: 0 },
  { x: 6_378_137, y: 1000, z: 0 },
  { x: 6_378_137, y: 2000, z: 1000 },
];

test('a dash in pixels becomes PolylineDash with a 16-bit pattern', () => {
  assert.equal(dashPattern(16, 16), 0xff00);
  assert.equal(dashPattern(12, 4), 0xfff0);
  assert.equal(dashPattern(1, 0), 0xffff);
});

test('positions build one polyline primitive; a change rebuilds it', () => {
  const viewer = createFakeViewer();
  const { factories, made } = fakePrimitives();
  const renders = [];
  const { lines, destroy } = createCesiumLines(viewer, {
    factories,
    requestRender: (reason) => renders.push(reason),
  });
  assert.equal(viewer.scene.primitives.length, 0, 'nothing at creation');
  const line = lines.createLine({
    id: 'trail',
    widthPx: 3,
    color: [1, 0, 0, 1],
    depthFailAlpha: 0.4,
    arc: 'geodesic',
    pickId: 'trail-1',
  });
  assert.equal(viewer.scene.primitives.length, 1);
  assert.equal(made.length, 0, 'no primitive without positions');
  line.setPositions(points);
  assert.equal(made.length, 1);
  const [first] = made;
  const geometry = first.geometryInstances.geometry;
  assert.equal(geometry._width, 3);
  assert.equal(geometry._arcType, Cesium.ArcType.GEODESIC);
  assert.equal(geometry._positions.length, 3);
  assert.equal(first.geometryInstances.id, 'trail-1');
  assert.equal(first.asynchronous, false);
  assert.ok(first.depthFailAppearance, 'the dimmer copy behind the scene');
  assert.ok(
    Cesium.Color.equals(
      first.depthFailAppearance.material.uniforms.color,
      new Cesium.Color(1, 0, 0, 0.4),
    ),
  );
  line.setPositions(points.slice(0, 2));
  assert.equal(made.length, 2);
  assert.equal(first.destroyed, true, 'the old primitive goes');
  line.setColor([0, 1, 0, 1]);
  assert.ok(
    Cesium.Color.equals(
      made[1].appearance.material.uniforms.color,
      new Cesium.Color(0, 1, 0, 1),
    ),
  );
  const turn = Cesium.Matrix4.fromRotation(Cesium.Matrix3.fromRotationZ(0.5));
  line.setModelMatrix(Cesium.Matrix4.toArray(turn));
  assert.ok(Cesium.Matrix4.equals(made[1].modelMatrix, turn));
  line.show(false);
  assert.equal(made[1].show, false);
  line.setPositions(points);
  assert.equal(made[2].show, false, 'a rebuild keeps show and matrix');
  assert.ok(Cesium.Matrix4.equals(made[2].modelMatrix, turn));
  assert.ok(renders.length >= 4);
  line.destroy();
  assert.equal(made[2].destroyed, true);
  destroy();
  assert.equal(viewer.scene.primitives.length, 0);
});

test('dash kinds pick their materials', () => {
  const viewer = createFakeViewer();
  const { factories, made } = fakePrimitives();
  const { lines } = createCesiumLines(viewer, { factories });
  lines
    .createLine({
      id: 'd',
      widthPx: 2,
      color: [1, 1, 1, 1],
      dash: { lengthPx: 12, gapPx: 4 },
    })
    .setPositions(points);
  lines
    .createLine({ id: 't', widthPx: 3, color: [0, 1, 1, 1], dash: 'tactical' })
    .setPositions(points);
  lines
    .createLine({ id: 's', widthPx: 1, color: [1, 1, 1, 1] })
    .setPositions(points);
  assert.equal(made[0].appearance.material.type, 'PolylineDash');
  assert.equal(made[0].appearance.material.uniforms.dashLength, 16);
  assert.equal(made[0].appearance.material.uniforms.dashPattern, 0xfff0);
  assert.equal(made[1].appearance.material.type, 'GevLineTactical');
  assert.equal(made[1].appearance.material.uniforms.groupCount, 4);
  assert.equal(made[2].appearance.material.type, 'Color');
  assert.equal(made[2].depthFailAppearance, undefined);
});

test('a pick of a line primitive names the line', () => {
  const viewer = createFakeViewer();
  const { factories, made } = fakePrimitives();
  const { lines, identify } = createCesiumLines(viewer, { factories });
  lines
    .createLine({
      id: 'orbit-25544',
      widthPx: 2,
      color: [1, 1, 1, 1],
      pickId: 'o',
    })
    .setPositions(points);
  assert.deepEqual(identify({ primitive: made[0], id: 'o' }), {
    owner: 'orbit-25544',
  });
  assert.equal(identify({ primitive: {}, id: 'o' }), null);
});
