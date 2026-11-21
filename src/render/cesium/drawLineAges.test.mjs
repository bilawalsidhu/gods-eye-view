import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test, { after } from 'node:test';
import { createCesiumDraw, lineAgeData } from './draw.js';

// Node has no WebGL context to report line-width limits.
Cesium.ContextLimits._minimumAliasedLineWidth = 1;
Cesium.ContextLimits._maximumAliasedLineWidth = 10;

// A material's texture uniform is told from the browser's image classes, which
// Node lacks.
const IMAGE_CLASSES = [
  'HTMLCanvasElement',
  'HTMLImageElement',
  'ImageBitmap',
  'OffscreenCanvas',
];
const realClasses = IMAGE_CLASSES.map((name) => globalThis[name]);
for (const name of IMAGE_CLASSES) globalThis[name] ??= class {};
after(() =>
  IMAGE_CLASSES.forEach((name, i) => (globalThis[name] = realClasses[i])),
);

/** A scene with what a line set touches: primitives, its events and its time. */
function fakeScene(ms = Date.UTC(2026, 0, 1)) {
  const added = [];
  return {
    added,
    postRender: new Cesium.Event(),
    preRender: new Cesium.Event(),
    camera: { positionWC: new Cesium.Cartesian3(2e7, 0, 0) },
    frameState: {
      mode: Cesium.SceneMode.SCENE3D,
      time: Cesium.JulianDate.fromDate(new Date(ms)),
    },
    updateHeight: () => () => {},
    getHeight: () => undefined,
    primitives: {
      add: (primitive) => (added.push(primitive), primitive),
      remove: (primitive) => {
        const at = added.indexOf(primitive);
        if (at >= 0) added.splice(at, 1);
        return at >= 0;
      },
      length: 0,
    },
    requestRender() {},
    isDestroyed: () => false,
  };
}

const T0 = Date.UTC(2026, 0, 1);

/** A port that fades lines with age, over `scene`, and its frames at a scene time. */
function agedDraw(scene = fakeScene(), capabilities = ['lineAgeFade']) {
  const part = createCesiumDraw({
    scene,
    report: (error) => assert.fail(error),
    capabilities: new Set(capabilities),
  });
  return {
    part,
    scene,
    frameAt(ms) {
      scene.frameState.time = Cesium.JulianDate.fromDate(new Date(ms));
      part.beforeRender();
      part.afterRender();
    },
  };
}

const along = (n, lat = 10) =>
  Array.from({ length: n }, (_, i) =>
    Cesium.Cartesian3.fromDegrees(i * 0.01, lat, 100),
  );

const trail = (positions, times, extra = {}) => ({
  id: 'trail',
  positions,
  widthPx: 3,
  mode: '3d',
  style: { kind: 'solid', color: [0.2, 0.8, 1, 0.9] },
  ageFade: { times, windowMs: 60_000, alphaFloor: 0.06, ...extra },
  pickable: false,
});

/** The polylines a line set's host draws in its collection. */
function collectionOf(scene) {
  const host = scene.added.at(-1);
  if (host instanceof Cesium.PolylineCollection) return host;
  for (let i = 0; i < host.length; i++)
    if (host.get(i) instanceof Cesium.PolylineCollection) return host.get(i);
  return null;
}

test('a polyline’s age texels: a point at the place of the one before it is dropped, the rest even along it, times in seconds before the newest', () => {
  const [a, b, c] = along(3);
  const age = lineAgeData([a, a, b, c], [T0, T0 + 1000, T0 + 2000, T0 + 4000], {
    times: [],
    windowMs: 30_000,
    alphaFloor: 0.06,
    squaredAlphaFloor: 0.14,
  });
  assert.equal(age.count, 3);
  assert.equal(age.base, T0 + 4000);
  const texel = (i) => [age.data[i * 4], age.data[i * 4 + 1]];
  assert.deepEqual(texel(0), [0, -4]);
  assert.deepEqual(texel(1), [0.5, -2]);
  assert.deepEqual(texel(2), [1, 0]);
  assert.deepEqual(age.uniforms, {
    ageCount: 3,
    ageWidth: 3,
    ageRows: 1,
    ageByLength: 0,
    ageWindow: 30,
    ageAlphaFloor: 0.06,
    ageSquaredFloor: 0.14,
    ageWidthFloor: 1,
    ageShow: 0,
  });
});

test('a windowed line’s age texels carry its span, in seconds; an endless one cuts at now alone', () => {
  const points = along(2);
  const fade = (showMs) => ({
    times: [],
    windowMs: 30_000,
    alphaFloor: 0.06,
    showMs,
  });
  const at = (showMs, windowed = true) =>
    lineAgeData(points, [T0, T0 + 1000], fade(showMs), false, windowed).uniforms
      .ageShow;
  assert.equal(at(45_000), 45);
  assert.equal(at(Infinity), -1);
  assert.equal(at(undefined), 0, 'no span, no cut');
  assert.equal(at(45_000, false), 0, 'not cut where the port does not');
});

test('a draped line’s age texels lie along it by distance, and a long line takes more rows', () => {
  const points = [
    Cesium.Cartesian3.fromDegrees(0, 0),
    Cesium.Cartesian3.fromDegrees(1, 0),
    Cesium.Cartesian3.fromDegrees(4, 0),
  ];
  const age = lineAgeData(
    points,
    [0, 1000, 2000],
    { times: [], windowMs: 1, alphaFloor: 0 },
    true,
  );
  assert.equal(age.uniforms.ageByLength, 1);
  assert.equal(age.data[0], 0);
  assert.ok(
    Math.abs(age.data[4] - 0.25) < 1e-6,
    `a quarter along (${age.data[4]})`,
  );
  assert.equal(age.data[8], 1);
  const long = along(2500);
  const many = lineAgeData(
    long,
    long.map((_, i) => i),
    { times: [], windowMs: 1, alphaFloor: 0 },
  );
  assert.equal(many.width, 1024);
  assert.equal(many.rows, 3);
  assert.equal(many.data.length, 1024 * 3 * 4);
});

test('an aged line fades on the scene clock: time passing changes its material, never its line', () => {
  const { part, scene, frameAt } = agedDraw();
  const set = part.port.lines({ id: 'trails' });
  const positions = along(4);
  const times = [T0 - 30_000, T0 - 20_000, T0 - 10_000, T0];
  set.set([
    trail(positions, times, { squaredAlphaFloor: 0.14, widthFloor: 0.3 }),
  ]);
  const polylines = collectionOf(scene);
  const polyline = polylines.get(0);
  const material = polyline.material;
  assert.equal(material.type, 'DrawAgedLine_solid');
  assert.ok(material.isTranslucent(), 'drawn in the translucent pass');
  assert.equal(material.uniforms.ageWindow, 60);
  assert.equal(material.uniforms.ageAlphaFloor, 0.06);
  assert.equal(material.uniforms.ageSquaredFloor, 0.14);
  assert.equal(material.uniforms.ageWidthFloor, 0.3);
  assert.equal(material.uniforms.ageCount, 4);
  assert.ok(
    Cesium.Color.equals(
      material.materials.aged.uniforms.color,
      new Cesium.Color(0.2, 0.8, 1, 0.9),
    ),
    'its style’s colour inside',
  );
  for (let k = 1; k <= 120; k++) {
    frameAt(T0 + k * 1000);
    assert.equal(
      material.uniforms.ageNow,
      k,
      `seconds after its newest point, frame ${k}`,
    );
  }
  assert.equal(collectionOf(scene), polylines, 'the same collection');
  assert.equal(polylines.length, 1);
  assert.equal(polylines.get(0), polyline, 'the same line');
  assert.equal(polyline.material, material, 'the same material');
});

test('an aged line given new points and times moves in place and takes the new times', () => {
  const { part, scene, frameAt } = agedDraw();
  const set = part.port.lines({ id: 'trails' });
  const positions = along(5);
  const times = [0, 1, 2, 3, 4].map((i) => T0 + i * 10_000);
  set.set([trail(positions.slice(0, 4), times.slice(0, 4))]);
  const polyline = collectionOf(scene).get(0);
  const material = polyline.material;
  frameAt(T0 + 40_000);
  assert.equal(material.uniforms.ageNow, 10);
  set.upsert([trail(positions.slice(1), times.slice(1))]);
  assert.equal(collectionOf(scene).get(0), polyline, 'moved in place');
  assert.equal(polyline.material, material);
  frameAt(T0 + 45_000);
  assert.equal(material.uniforms.ageNow, 5, 'from its new newest point');
  assert.ok(Cesium.Cartesian3.equals(polyline.positions[0], positions[1]));
  // A new colour is taken in place too, inside the fade.
  set.upsert([
    {
      ...trail(positions.slice(1), times.slice(1)),
      style: { kind: 'solid', color: '#ff0000' },
    },
  ]);
  assert.equal(collectionOf(scene).get(0), polyline, 'recoloured in place');
  assert.ok(
    Cesium.Color.equals(
      material.materials.aged.uniforms.color,
      Cesium.Color.RED,
    ),
  );
});

test('segment colours fade with age too, each segment with its own two times', () => {
  const { part, scene, frameAt } = agedDraw();
  const set = part.port.lines({ id: 'trails' });
  const times = [T0, T0 + 1000, T0 + 2000];
  set.set([
    {
      ...trail(along(3), times),
      segmentColors: ['#ff0000', '#00ff00'],
    },
  ]);
  const pieces = [];
  const visit = (primitive) => {
    if (primitive instanceof Cesium.Primitive) pieces.push(primitive);
    else if (primitive?.length !== undefined && primitive.get)
      for (let i = 0; i < primitive.length; i++) visit(primitive.get(i));
  };
  visit(scene.added.at(-1));
  assert.equal(pieces.length, 2);
  frameAt(T0 + 3000);
  const [first, second] = pieces.map((piece) => piece.appearance.material);
  assert.equal(first.type, 'DrawAgedLine_solid');
  assert.equal(
    first.uniforms.ageNow,
    2,
    'its newer point a second after the first',
  );
  assert.equal(second.uniforms.ageNow, 1);
  assert.ok(
    Cesium.Color.equals(first.materials.aged.uniforms.color, Cesium.Color.RED),
  );
  assert.ok(
    Cesium.Color.equals(
      second.materials.aged.uniforms.color,
      Cesium.Color.LIME,
    ),
  );
});

test('a draped aged line draws by a ground primitive of its own, its times along its length', () => {
  const { part, scene } = agedDraw();
  const set = part.port.lines({ id: 'trails' });
  const ground = [0, 1, 2].map((i) =>
    Cesium.Cartesian3.fromDegrees(i * 0.01, 10),
  );
  set.set([{ ...trail(ground, [T0, T0 + 1, T0 + 2]), mode: 'draped' }]);
  const host = scene.added.at(-1);
  const primitives = [];
  const visit = (primitive) => {
    if (primitive instanceof Cesium.GroundPolylinePrimitive)
      primitives.push(primitive);
    else if (primitive?.length !== undefined && primitive.get)
      for (let i = 0; i < primitive.length; i++) visit(primitive.get(i));
  };
  visit(host);
  assert.equal(primitives.length, 1);
  const material = primitives[0].appearance.material;
  assert.equal(material.type, 'DrawAgedLine_solid');
  assert.equal(material.uniforms.ageByLength, 1);
});

test('an aged line built anew lets its old material go once its primitive is gone', () => {
  const { part, scene, frameAt } = agedDraw();
  const set = part.port.lines({ id: 'trails' });
  const deep = (times) => ({
    ...trail(along(3), times),
    depthFail: { kind: 'solid', color: '#ffffff' },
  });
  set.set([deep([T0, T0 + 1, T0 + 2])]);
  const record = part.sets.get('trails');
  assert.equal(record.ages.size, 2, 'its line and the part behind the surface');
  const [old] = record.ages.keys();
  set.upsert([deep([T0 + 1, T0 + 2, T0 + 3])]);
  frameAt(T0 + 10);
  assert.ok(old.isDestroyed(), 'the old material went with its primitive');
  assert.equal(record.ages.size, 2);
  void scene;
});

test('a windowed line is cut on the scene clock: time passing changes its material, never its line', () => {
  const { part, scene, frameAt } = agedDraw(fakeScene(), [
    'lineAgeFade',
    'lineTimeWindow',
  ]);
  const set = part.port.lines({ id: 'trails' });
  // A whole track, an hour of it, shown over its last minute.
  const positions = along(61);
  const times = positions.map((_, i) => T0 + i * 60_000);
  set.set([trail(positions, times, { alphaFloor: 1, showMs: 60_000 })]);
  const polylines = collectionOf(scene);
  const polyline = polylines.get(0);
  const material = polyline.material;
  assert.equal(material.type, 'DrawAgedLine_solid');
  assert.equal(material.uniforms.ageShow, 60);
  assert.equal(material.uniforms.ageCount, 61);
  const before = polyline.positions;
  for (let k = 1; k <= 120; k++) {
    frameAt(T0 + k * 30_000);
    assert.equal(
      material.uniforms.ageNow,
      (k * 30_000 - 3_600_000) / 1000,
      `seconds after its newest point, frame ${k}`,
    );
  }
  assert.equal(collectionOf(scene), polylines, 'the same collection');
  assert.equal(polylines.get(0), polyline, 'the same line');
  assert.equal(polyline.material, material, 'the same material');
  assert.equal(polyline.positions, before, 'its points untouched');
  // A new span is a new look: drawn anew, with it.
  set.upsert([trail(positions, times, { alphaFloor: 1, showMs: 120_000 })]);
  assert.equal(collectionOf(scene).get(0).material.uniforms.ageShow, 120);
});

test('without the window’s capability a line ignores its span and draws whole', () => {
  const { part, scene } = agedDraw();
  const set = part.port.lines({ id: 'trails' });
  set.set([trail(along(3), [T0, T0 + 1, T0 + 2], { showMs: 60_000 })]);
  const material = collectionOf(scene).get(0).material;
  assert.equal(material.type, 'DrawAgedLine_solid', 'still faded');
  assert.equal(material.uniforms.ageShow, 0, 'never cut');
});

test('without the capability a line ignores its age fade; with it a bad fade is refused', () => {
  const plain = agedDraw(fakeScene(), []);
  const lines = plain.part.port.lines({ id: 'trails' });
  lines.set([trail(along(3), [T0])]);
  const material = collectionOf(plain.scene).get(0).material;
  assert.equal(material.type, 'Color', 'drawn as its style alone');

  const { part } = agedDraw();
  const set = part.port.lines({ id: 'trails' });
  assert.throws(
    () => set.set([trail(along(3), [T0, T0])]),
    TypeError,
    'one time a position',
  );
  assert.throws(
    () => set.set([trail(along(2), [T0, T0], { windowMs: 0 })]),
    TypeError,
    'a positive window',
  );
  assert.throws(
    () => set.set([trail(along(2), [T0, T0], { widthFloor: 2 })]),
    TypeError,
    'floors from 0 to 1',
  );
  for (const showMs of [0, -1, Number.NaN])
    assert.throws(
      () => set.set([trail(along(2), [T0, T0], { showMs })]),
      TypeError,
      'a positive span',
    );
  assert.equal(set.size(), 0, 'nothing changed');
});

test('an aged line made first leaves its style’s type named as a plain material of it is', () => {
  const lists = Cesium.Material._uniformList;
  const was = lists.Color;
  delete lists.Color;
  try {
    const { part, scene } = agedDraw();
    const set = part.port.lines({ id: 'trails' });
    set.set([trail(along(2), [T0, T0 + 1])]);
    assert.deepEqual(lists.Color, ['color_0'], 'as a plain Color material');
    // A plain line beside it then draws with it in its collection.
    set.upsert([
      { ...trail(along(2), [T0, T0 + 1]), id: 'plain', ageFade: undefined },
    ]);
    const plain = collectionOf(scene).get(1).material;
    assert.equal(plain.type, 'Color');
    assert.ok(
      lists.Color.every((name) => typeof plain._uniforms[name] === 'function'),
    );
  } finally {
    if (was) lists.Color = was;
  }
});
