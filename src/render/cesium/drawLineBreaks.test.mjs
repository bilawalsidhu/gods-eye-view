import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test, { after } from 'node:test';
import { createCesiumDraw } from './draw.js';

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

/** A port over a fake scene that draws lines in runs (and with `more`). */
function brokenDraw(capabilities = ['lineBreaks'], scene = fakeScene()) {
  const part = createCesiumDraw({
    scene,
    report: (error) => assert.fail(error),
    capabilities: new Set(capabilities),
  });
  return { part, scene, set: part.port.lines({ id: 'trails' }) };
}

/** Six positions west to east, `height` up. */
const along = (n = 6, height = 100) =>
  Array.from({ length: n }, (_, i) =>
    Cesium.Cartesian3.fromDegrees(i * 0.01, 10, height),
  );

/** Three runs: positions 0-1, 2-4 and 5 alone (which draws nothing). */
const trails = (extra = {}) => ({
  id: 'trails',
  positions: along(),
  breaks: [2, 5],
  widthPx: 3,
  mode: '3d',
  style: { kind: 'solid', color: [0.2, 0.8, 1, 0.9] },
  ...extra,
});

/** Everything a set's host holds, collections opened. */
function everything(scene) {
  const all = [];
  const walk = (p) => {
    all.push(p);
    if (p instanceof Cesium.PrimitiveCollection)
      for (let i = 0; i < p.length; i++) walk(p.get(i));
  };
  for (const p of scene.added) walk(p);
  return all;
}

/** The polylines a set's collection draws. */
function polylinesOf(scene) {
  const collection = everything(scene).find(
    (p) => p instanceof Cesium.PolylineCollection,
  );
  const lines = [];
  for (let i = 0; i < collection.length; i++) lines.push(collection.get(i));
  return lines;
}

const lonOf = (p) =>
  Number(
    Cesium.Math.toDegrees(
      Cesium.Cartographic.fromCartesian(p).longitude,
    ).toFixed(6),
  );

test('an undraped line in runs is a polyline a run in its collection, each picked as the line', () => {
  const { scene, set } = brokenDraw();
  set.set([trails()]);
  const lines = polylinesOf(scene);
  assert.equal(lines.length, 2, 'a polyline a run with length');
  assert.deepEqual(
    lines.map((line) => line.positions.map(lonOf)),
    [
      [0, 0.01],
      [0.02, 0.03, 0.04],
    ],
    'nothing from position 1 to 2, nor 4 to 5',
  );
  assert.deepEqual(
    lines.map((line) => line.id.id),
    ['trails', 'trails'],
    'each run picks as its line',
  );
  assert.notEqual(lines[0].id, lines[1].id, 'under a pick id of its own');
  assert.equal(set.size(), 1, 'one item');
});

test('a line in runs takes packed positions and breaks', () => {
  const { scene, set } = brokenDraw();
  const flat = new Float64Array(along().flatMap((p) => [p.x, p.y, p.z]));
  set.set([trails({ positions: flat, breaks: new Uint32Array([3]) })]);
  assert.deepEqual(
    polylinesOf(scene).map((line) => line.positions.length),
    [3, 3],
  );
});

test('an arrow in runs has a head at the end of each run', () => {
  const { scene, set } = brokenDraw();
  set.set([trails({ style: { kind: 'arrow', color: '#ffffff' } })]);
  assert.deepEqual(
    polylinesOf(scene).map((line) => line.material.type),
    ['PolylineArrow', 'PolylineArrow'],
  );
});

test('segment colours and shows stay a pair of positions; the pairs across a break draw nothing', () => {
  const { scene, set } = brokenDraw();
  const red = [1, 0, 0, 1];
  const green = [0, 1, 0, 1];
  const blue = [0, 0, 1, 1];
  const line = (colors, shows) =>
    trails({
      style: { kind: 'glow', color: '#ffffff', power: 0.2 },
      segmentColors: colors,
      segmentShow: shows,
    });
  set.set([
    line([red, blue, green, green, blue], [true, true, true, false, true]),
  ]);
  const host = scene.added[0];
  // In the set's collection, a polyline a segment.
  const pieces = polylinesOf(scene);
  assert.equal(pieces.length, 3, 'segments 0, 2 and 3; not 1 nor 4');
  assert.equal(pieces[0].material.type, 'PolylineGlow');
  const color = (p) => p.material.uniforms.color;
  assert.deepEqual(
    pieces.map((p) => [color(p).red, color(p).green, color(p).blue, p.show]),
    [
      [1, 0, 0, true],
      [0, 1, 0, true],
      [0, 1, 0, false],
    ],
  );
  set.upsert([
    line([green, red, red, blue, red], [true, false, true, true, true]),
  ]);
  assert.equal(scene.added[0], host, 'recoloured and shown in place');
  assert.deepEqual(
    pieces.map((p) => [color(p).red, color(p).green, color(p).blue, p.show]),
    [
      [0, 1, 0, true],
      [1, 0, 0, true],
      [0, 0, 1, true],
    ],
  );
});

test('a run of a line that fades with age takes its own points’ times', () => {
  const { scene, set } = brokenDraw(['lineAgeFade', 'lineBreaks']);
  const times = along().map((_, i) => T0 + i * 1000);
  set.set([trails({ ageFade: { times, windowMs: 60_000, alphaFloor: 0.1 } })]);
  const lines = polylinesOf(scene);
  assert.deepEqual(
    lines.map((line) => [line.material.type, line.material.uniforms.ageCount]),
    [
      ['DrawAgedLine_solid', 2],
      ['DrawAgedLine_solid', 3],
    ],
  );
});

test('a revealed line in runs reveals them in order, along their own length', () => {
  const { scene, set } = brokenDraw();
  // Runs of one leg and of two, all of one length, the gap between them
  // (positions 1 to 2) none: half their length is all of the first run
  // and a quarter of the second.
  set.set([trails({ positions: along(5), breaks: [2], revealFraction: 0.5 })]);
  let lines = polylinesOf(scene);
  const revealOf = (line) => line.material.materials?.revealed;
  assert.equal(revealOf(lines[0]), undefined, 'the first run all shown');
  assert.equal(lines[0].show, true);
  const second = lines[1];
  assert.ok(revealOf(second), 'the second run revealed');
  // Half its first leg, of two.
  assert.ok(
    Math.abs(second.material.uniforms.reveal - 0.25) < 1e-9,
    `revealed a quarter along (${second.material.uniforms.reveal})`,
  );
  set.set([trails({ positions: along(5), breaks: [2], revealFraction: 0.25 })]);
  lines = polylinesOf(scene);
  assert.equal(lines[1].show, false, 'a run not yet reached is hidden');
});

test('a draped line in runs drapes a ground piece a run; a solid segmented one a ground instance a segment, none across a break', () => {
  const { scene, set } = brokenDraw();
  set.set([trails({ mode: 'draped', positions: along(6, 0) })]);
  const ground = everything(scene).filter(
    (p) => p instanceof Cesium.GroundPolylinePrimitive,
  );
  assert.equal(ground.length, 2, 'a ground piece a run with length');
  assert.deepEqual(
    ground.map((p) => p.geometryInstances[0].geometry._positions.length),
    [2, 3],
  );
  set.set([
    trails({
      mode: 'draped',
      positions: along(6, 0),
      segmentColors: along()
        .slice(1)
        .map(() => [0, 1, 0, 1]),
    }),
  ]);
  const batch = everything(scene).filter(
    (p) => p instanceof Cesium.GroundPolylinePrimitive,
  );
  assert.equal(batch.length, 1, 'one batch');
  assert.equal(
    batch[0].geometryInstances.length,
    3,
    'segments 0, 2 and 3: not 1 nor 4',
  );
});

test('changed breaks draw the line anew; the same ones change it in place', () => {
  const { scene, set } = brokenDraw();
  set.set([trails()]);
  const host = scene.added[0];
  set.upsert([trails({ show: false })]);
  assert.equal(scene.added[0], host, 'shown in place');
  assert.deepEqual(
    polylinesOf(scene).map((line) => line.show),
    [false, false],
  );
  set.upsert([trails({ breaks: [3] })]);
  assert.notEqual(scene.added[0], host, 'built anew');
  assert.deepEqual(
    polylinesOf(scene).map((line) => line.positions.length),
    [3, 3],
  );
});

test('without the capability a line ignores its breaks; with it bad breaks are refused', () => {
  const plain = brokenDraw([]);
  plain.set.set([trails()]);
  assert.equal(polylinesOf(plain.scene).length, 1, 'one line, joined');

  const { set } = brokenDraw();
  for (const breaks of [[0], [6], [3, 2], [2, 2], [1.5], ['2']])
    assert.throws(
      () => set.set([trails({ breaks })]),
      TypeError,
      `refused: ${JSON.stringify(breaks)}`,
    );
  assert.equal(set.size(), 0, 'nothing changed');
  set.set([trails({ breaks: [] })]);
  assert.equal(set.size(), 1, 'no breaks: one run');
});

test('where the scene cannot drape, a draped line in runs draws a run over the surface each, hidden past the horizon', () => {
  const scene = fakeScene();
  scene.frameState.context = { depthTexture: false };
  const { part, set } = brokenDraw(['lineBreaks'], scene);
  const at = (lon) => Cesium.Cartesian3.fromDegrees(lon, 0, 0);
  set.set([
    trails({
      mode: 'draped',
      positions: [at(0), at(0.01), at(0.02), at(0.03)],
      breaks: [2],
      // The overlay draws its shown segments only, from first to last.
      segmentShow: [false, true, true],
    }),
    trails({
      id: 'two',
      mode: 'draped',
      positions: [at(0), at(0.01), at(0.02), at(0.03)],
      breaks: [2],
    }),
  ]);
  const frame = () => {
    part.beforeRender();
    part.afterRender();
  };
  const runs = everything(scene).filter(
    (p) => p instanceof Cesium.Primitive && p.depthFailAppearance,
  );
  // The first line kept positions 1 to 3, its break at 1 of them: a run of
  // one position and one of two; the second two runs of two.
  assert.equal(runs.length, 3, 'a primitive a run with length');
  scene.camera.positionWC = new Cesium.Cartesian3(2e7, 0, 0);
  frame();
  assert.deepEqual(
    runs.map((p) => p.show),
    [true, true, true],
  );
  scene.camera.positionWC = new Cesium.Cartesian3(-2e7, 0, 0);
  frame();
  assert.deepEqual(
    runs.map((p) => p.show),
    [false, false, false],
    'past the horizon',
  );
});

test('a draped line in runs whose first run is later than its second times each run by its own points', () => {
  const { scene, set } = brokenDraw([
    'lineAgeFade',
    'lineTimeWindow',
    'lineBreaks',
  ]);
  set.set([
    trails({
      mode: 'draped',
      positions: along(4, 0),
      breaks: [2],
      ageFade: {
        times: [T0 + 110_000, T0 + 120_000, T0, T0 + 10_000],
        windowMs: 60_000,
        alphaFloor: 1,
        showMs: 30_000,
      },
    }),
  ]);
  const ground = everything(scene).filter(
    (p) => p instanceof Cesium.GroundPolylinePrimitive,
  );
  assert.equal(ground.length, 2, 'a ground piece a run');
  const ages = ground.map((p) => p.appearance.material.uniforms);
  assert.deepEqual(
    ages.map((u) => [u.ageCount, u.ageByLength, u.ageShow]),
    [
      [2, 1, 30],
      [2, 1, 30],
    ],
    'its own two points each, along its length, cut to the span',
  );
  // Each run's clock reads from its own newest point: the first's is
  // 110 s later than the second's.
  assert.equal(ages[1].ageNow - ages[0].ageNow, 110);
});
