import { installDomClasses } from '../../testSupport/domClasses.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createCesiumLines, dashPattern, materialSpec } from './lines.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

// Cesium's Material sorts uniform values with instanceof checks against these
// DOM classes; Node has none of them.
installDomClasses();

// Cesium's own Primitive, PolylineGeometry and materials (built, never drawn).
function setup() {
  const viewer = createFakeViewer();
  const renders = [];
  const part = createCesiumLines(viewer, {
    requestRender: (reason) => renders.push(reason),
  });
  const root = () => viewer.primitiveList[0];
  const slots = () =>
    Array.from({ length: root()?.length ?? 0 }, (_, index) =>
      root().get(index),
    );
  // The primitive drawing each line now, in draw order (null: none yet).
  const drawn = () => slots().map((slot) => (slot.length ? slot.get(0) : null));
  return { viewer, renders, root, slots, drawn, ...part };
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
  assert.equal(dashPattern(1, 100), 0x8000, 'at least one bit on');
});

test('positions build one polyline primitive; a change rebuilds it', () => {
  const { viewer, renders, drawn, lines, destroy } = setup();
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
  assert.deepEqual(drawn(), [null], 'no primitive without positions');
  line.setPositions(points);
  const [first] = drawn();
  assert.ok(first instanceof Cesium.Primitive);
  const geometry = first.geometryInstances.geometry;
  assert.ok(geometry instanceof Cesium.PolylineGeometry);
  assert.equal(geometry._width, 3);
  assert.equal(geometry._arcType, Cesium.ArcType.GEODESIC);
  assert.equal(geometry._positions.length, 3);
  assert.equal(first.geometryInstances.id, 'trail-1');
  assert.equal(first.asynchronous, false);
  assert.equal(first.allowPicking, true);
  assert.ok(first.appearance instanceof Cesium.PolylineMaterialAppearance);
  assert.equal(first.appearance.material.type, 'Color');
  assert.ok(first.depthFailAppearance, 'the dimmer copy behind the scene');
  assert.ok(
    Cesium.Color.equals(
      first.depthFailAppearance.material.uniforms.color,
      new Cesium.Color(1, 0, 0, 0.4),
    ),
  );
  line.setPositions(points.slice(0, 2));
  const [second] = drawn();
  assert.notEqual(second, first);
  assert.equal(first.isDestroyed(), true, 'the old primitive goes');
  assert.equal(second.geometryInstances.geometry._positions.length, 2);
  line.setColor([0, 1, 0, 1]);
  assert.ok(
    Cesium.Color.equals(
      second.appearance.material.uniforms.color,
      new Cesium.Color(0, 1, 0, 1),
    ),
  );
  assert.ok(
    Cesium.Color.equals(
      second.depthFailAppearance.material.uniforms.color,
      new Cesium.Color(0, 1, 0, 0.4),
    ),
  );
  const turn = Cesium.Matrix4.fromRotation(Cesium.Matrix3.fromRotationZ(0.5));
  line.setModelMatrix(Cesium.Matrix4.toArray(turn));
  assert.ok(Cesium.Matrix4.equals(second.modelMatrix, turn));
  line.show(false);
  assert.equal(second.show, false);
  line.setPositions(points);
  const [third] = drawn();
  assert.equal(third.show, false, 'a rebuild keeps show, matrix and colour');
  assert.ok(Cesium.Matrix4.equals(third.modelMatrix, turn));
  assert.ok(
    Cesium.Color.equals(
      third.appearance.material.uniforms.color,
      new Cesium.Color(0, 1, 0, 1),
    ),
  );
  assert.deepEqual(lines.list(), [{ id: 'trail', points: 3, shown: false }]);
  assert.ok(renders.length >= 6 && renders.every((r) => r === 'lines'));
  line.setPositions(points.slice(0, 1));
  assert.deepEqual(drawn(), [null], 'one point draws nothing');
  assert.equal(third.isDestroyed(), true);
  line.destroy();
  assert.deepEqual(drawn(), []);
  assert.deepEqual(lines.list(), []);
  destroy();
  assert.equal(viewer.scene.primitives.length, 0);
});

test('a model matrix given at creation places the line', () => {
  const { drawn, lines } = setup();
  const shift = Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(0, 0, 42));
  lines
    .createLine({
      id: 'ring',
      widthPx: 1,
      color: [1, 1, 1, 1],
      modelMatrix: Cesium.Matrix4.toArray(shift),
    })
    .setPositions(points);
  const [primitive] = drawn();
  assert.ok(Cesium.Matrix4.equals(primitive.modelMatrix, shift));
  assert.equal(
    primitive.geometryInstances.geometry._arcType,
    Cesium.ArcType.NONE,
  );
});

test('dash kinds and arrows pick their materials', () => {
  const { drawn, lines } = setup();
  const make = (options) =>
    lines
      .createLine({ widthPx: 2, color: [1, 1, 1, 1], ...options })
      .setPositions(points);
  make({ id: 'd', dash: { lengthPx: 12, gapPx: 4 } });
  make({ id: 't', dash: 'tactical' });
  make({ id: 'c', dash: { tactical: { groups: 2 } } });
  make({ id: 's' });
  make({ id: 'a', arrow: true, depthFailAlpha: 0.45, color: [1, 0, 0, 1] });
  const [dashed, tactical, custom, solid, arrow] = drawn();
  assert.equal(dashed.appearance.material.type, 'PolylineDash');
  assert.equal(dashed.appearance.material.uniforms.dashLength, 16);
  assert.equal(dashed.appearance.material.uniforms.dashPattern, 0xfff0);
  assert.ok(
    Cesium.Color.equals(
      dashed.appearance.material.uniforms.gapColor,
      Cesium.Color.TRANSPARENT,
    ),
  );
  assert.equal(tactical.appearance.material.type, 'GevLineTactical');
  assert.equal(tactical.appearance.material.uniforms.groupCount, 4);
  assert.equal(tactical.appearance.material.uniforms.dashCount, 100);
  assert.equal(custom.appearance.material.uniforms.groupCount, 2);
  assert.equal(solid.appearance.material.type, 'Color');
  assert.equal(solid.depthFailAppearance, undefined);
  assert.equal(arrow.appearance.material.type, 'PolylineArrow');
  assert.equal(arrow.depthFailAppearance.material.type, 'PolylineArrow');
  assert.equal(arrow.depthFailAppearance.material.uniforms.color.alpha, 0.45);
  // The spec is pure: the same for a scaled alpha.
  assert.equal(
    materialSpec({ dash: null }, [1, 1, 1, 0.5], 0.5).uniforms.color.alpha,
    0.25,
  );
});

test('lines draw in their order; a rebuild keeps its place', () => {
  const { slots, drawn, lines } = setup();
  const make = (id, order) => {
    const line = lines.createLine({
      id,
      widthPx: 1,
      color: [1, 1, 1, 1],
      order,
    });
    line.setPositions(points);
    return line;
  };
  make('top', 5);
  const bottom = make('bottom', -1);
  make('middle', 0);
  const ids = () => drawn().map((primitive) => primitive?.gevLine);
  assert.deepEqual(ids(), ['bottom', 'middle', 'top']);
  bottom.setPositions(points.slice(0, 2));
  assert.deepEqual(ids(), ['bottom', 'middle', 'top']);
  bottom.destroy();
  assert.equal(slots().length, 2);
  make('again', -2);
  assert.deepEqual(ids(), ['again', 'middle', 'top']);
});

test('only a line with a pickId is picked; identify names it and its pickId', () => {
  const { drawn, lines, identify } = setup();
  const picked = lines.createLine({
    id: 'orbit-25544',
    widthPx: 2,
    color: [1, 1, 1, 1],
    pickId: 'o',
  });
  picked.setPositions(points);
  lines
    .createLine({ id: 'trail', widthPx: 2, color: [1, 1, 1, 1] })
    .setPositions(points);
  const [orbit, trail] = drawn();
  assert.equal(trail.allowPicking, false);
  assert.deepEqual(identify({ primitive: orbit, id: 'o' }), {
    owner: 'orbit-25544',
    id: 'o',
  });
  assert.equal(identify({ primitive: trail }), null);
  assert.equal(identify({ primitive: {}, id: 'o' }), null);
  assert.equal(identify(undefined), null);
  picked.destroy();
  assert.equal(identify({ primitive: orbit, id: 'o' }), null);
});

test('engine destroy destroys every line and removes the root', () => {
  const { viewer, drawn, lines, destroy } = setup();
  const line = lines.createLine({ id: 'x', widthPx: 1, color: [1, 1, 1, 1] });
  line.setPositions(points);
  const [primitive] = drawn();
  destroy();
  assert.equal(primitive.isDestroyed(), true);
  assert.equal(viewer.scene.primitives.length, 0);
  assert.deepEqual(lines.list(), []);
  assert.throws(() => line.setPositions(points), /destroyed/);
});

test('segments share one primitive with individual widths, colours and pick ids', () => {
  const { lines, drawn, identify, primitiveOf, destroy } = setup();
  const batch = lines.createSegments({
    id: 'stems',
    widthPx: 3.5,
    color: [1, 0, 0, 0.5],
  });
  batch.replace([
    { positions: points.slice(0, 2), pickId: 'first' },
    {
      positions: points.slice(1),
      widthPx: 2.4,
      color: [0, 1, 0, 0.7],
      pickId: 'second',
    },
    { positions: points.slice(0, 2) },
  ]);
  batch.commit();
  const [primitive] = drawn();
  assert.equal(drawn().length, 1);
  assert.equal(
    primitiveOf(batch).get(0),
    primitive,
    'surface exclusions resolve the batch',
  );
  assert.ok(primitive.appearance instanceof Cesium.PolylineColorAppearance);
  const [first, second] = primitive.geometryInstances;
  assert.equal(first.geometry._width, 3.5);
  assert.equal(second.geometry._width, 2.4);
  assert.equal(first.geometry._positions.length, 2);
  assert.equal(first.geometry._arcType, Cesium.ArcType.NONE);
  assert.deepEqual([...first.attributes.color.value], [255, 0, 0, 128]);
  assert.deepEqual([...second.attributes.color.value], [0, 255, 0, 179]);
  assert.deepEqual(identify({ primitive, id: 'second' }), {
    owner: 'stems',
    id: 'second',
  });
  assert.equal(identify({ primitive }).pickable, false);
  batch.show(false);
  assert.equal(identify({ primitive, id: 'first' }).pickable, false);
  batch.replace([{ positions: points.slice(1), pickId: 'next' }]);
  batch.commit();
  assert.equal(primitive.isDestroyed(), true);
  assert.equal(drawn()[0].show, false);
  batch.show(true);
  assert.equal(
    identify({ primitive: drawn()[0], id: 'first' }).pickable,
    false,
  );
  batch.replace([]);
  batch.commit();
  assert.deepEqual(drawn(), [null]);
  destroy();
  assert.deepEqual(lines.list(), []);
});
