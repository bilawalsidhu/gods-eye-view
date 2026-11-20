import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { bindRenderer, drawOf, findDraw } from '../rendererOf.js';
import {
  createCesiumDraw,
  FEW_LOOSE_LINES,
  LONG_SETTLE_MS,
  MOVING_SHAPES,
  revealUniform,
  SETTLE_MS,
  unboundDrawPart,
} from './draw.js';
import { drawHitOf } from './drawHit.js';
import { MODEL_RETRY_MS } from './drawModels.js';
import { spriteDrawOrder } from '../../data/spriteOrder.js';

// Node has no WebGL context to report line-width limits.
Cesium.ContextLimits._minimumAliasedLineWidth = 1;
Cesium.ContextLimits._maximumAliasedLineWidth = 10;

/** A scene with what the draw port touches: primitives and its events. */
function fakeScene() {
  const added = [];
  const postRender = new Cesium.Event();
  const preRender = new Cesium.Event();
  return {
    added,
    postRender,
    preRender,
    camera: { positionWC: new Cesium.Cartesian3(2e7, 0, 0) },
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    // Clamped billboards ask the scene to follow the ground.
    clamped: [],
    updateHeight(position, update, heightReference) {
      this.clamped.push(heightReference);
      return () => {};
    },
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
    destroyed: false,
    requestRender() {
      if (this.destroyed) throw new Error('This object was destroyed');
    },
    isDestroyed() {
      return this.destroyed;
    },
  };
}

test('a viewer of its own, with no renderer bound, draws through a built port', () => {
  const scene = fakeScene();
  const viewer = { scene, isDestroyed: () => destroyed };
  let destroyed = false;
  const draw = drawOf(viewer);
  assert.equal(findDraw(viewer), draw, 'one per viewer');
  const set = draw.points({ id: 'mine' });
  set.set([{ id: 'a', pos: { lon: 0, lat: 0 }, pixelSize: 4, color: '#fff' }]);
  assert.equal(scene.added.length, 1, 'drawn into the viewer’s scene');
  assert.equal(scene.added[0].get(0).id.set, 'mine');

  // A renderer bound later answers new callers; the sets keep drawing.
  const unbind = bindRenderer(viewer, { draw: { id: 'renderer' } });
  assert.equal(findDraw(viewer).id, 'renderer');
  assert.equal(scene.added.length, 1);
  set.dispose();
  assert.equal(scene.added.length, 0);
  unbind();

  // Gone with its viewer, a built port lets go; a set its layer disposes
  // after that has nothing left to do.
  const again = drawOf(viewer);
  assert.notEqual(again, draw);
  const late = again.points({ id: 'left' });
  late.set([]);
  destroyed = true;
  scene.destroyed = true;
  assert.equal(findDraw(viewer), null);
  late.dispose();
});

test('nothing to draw into, no port', () => {
  assert.equal(findDraw({ scene: {} }), null);
  assert.throws(() => drawOf({}), /no renderer to draw with/);
});

/** A draw port over a fake scene, with its frame hooks. */
/**
 * Settling waits are timed. A test that settles times them by `frameClock`
 * (`timeFrames`), which each fake frame moves on by `FRAME_MS`.
 */
const FRAME_MS = 20;
const SETTLE_FRAMES = SETTLE_MS / FRAME_MS;
const LONG_SETTLE_FRAMES = LONG_SETTLE_MS / FRAME_MS;
const frameClock = { ms: 0 };
function timeFrames(t) {
  frameClock.ms = 0;
  t.mock.method(performance, 'now', () => frameClock.ms);
}

function drawOver(scene = fakeScene()) {
  const viewer = { scene };
  const draw = drawOf(viewer);
  return {
    scene,
    draw,
    frame() {
      frameClock.ms += FRAME_MS;
      scene.preRender.raiseEvent();
      scene.postRender.raiseEvent();
    },
  };
}

test('a clamped point is a billboard dot that follows the ground; others stay points', () => {
  const { scene, draw } = drawOver();
  const set = draw.points({ id: 'dots', clampTo: 'both' });
  set.set([
    {
      id: 'ground',
      pos: { lon: 10, lat: 20 },
      height: 'clampGround',
      pixelSize: 9,
      color: '#7fe6ed',
      outlineColor: '#000',
      outlineWidth: 2,
      disableDepthTest: Infinity,
    },
    { id: 'free', pos: { lon: 0, lat: 0 }, pixelSize: 4, color: '#fff' },
  ]);
  const host = scene.added[0];
  assert.ok(host instanceof Cesium.PrimitiveCollection, 'both kinds');
  const points = host.get(0);
  const dots = host.get(1);
  assert.ok(points instanceof Cesium.PointPrimitiveCollection);
  assert.ok(dots instanceof Cesium.BillboardCollection);
  const dot = dots.get(0);
  assert.equal(dot.heightReference, Cesium.HeightReference.CLAMP_TO_GROUND);
  assert.equal(dot.disableDepthTestDistance, Infinity);
  assert.equal(dot.scale, 1, 'an outlined dot is drawn at its size');
  assert.deepEqual(scene.clamped, [Cesium.HeightReference.CLAMP_TO_GROUND]);
  assert.deepEqual(dot.id, {
    set: 'dots',
    id: 'ground',
    meta: undefined,
  });
  set.dispose();
});

test('horizonCull hides points past the horizon each frame, and shows them again', () => {
  const { scene, draw, frame } = drawOver();
  const set = draw.points({ id: 'cull', horizonCull: true });
  const near = { lon: 0, lat: 0 };
  const far = { lon: 180, lat: 0 };
  set.set([
    { id: 'near', pos: near, pixelSize: 4, color: '#fff' },
    { id: 'far', pos: far, pixelSize: 4, color: '#fff' },
    { id: 'hidden', pos: near, pixelSize: 4, color: '#fff', show: false },
  ]);
  const host = scene.added[0];
  frame();
  assert.deepEqual(
    [0, 1, 2].map((i) => host.get(i).show),
    [true, false, false],
  );
  scene.camera.positionWC = new Cesium.Cartesian3(-2e7, 0, 0);
  frame();
  assert.deepEqual(
    [0, 1, 2].map((i) => host.get(i).show),
    [false, true, false],
    'the eye moved round',
  );
  set.setOptions({ horizonCull: false });
  assert.deepEqual(
    [0, 1, 2].map((i) => host.get(i).show),
    [true, true, false],
    'uncull shows what the cull hid, not what was hidden',
  );
  set.dispose();
});

test('draped lines are ground polylines; a rebuild keeps the old ones until the new are ready', () => {
  const { scene, draw, frame } = drawOver();
  const set = draw.lines({ id: 'tracks' });
  const line = (id) => ({
    id,
    positions: [
      { lon: 0, lat: 0 },
      { lon: 1, lat: 1 },
    ],
    widthPx: 2.5,
    mode: 'draped',
    style: { kind: 'solid', color: '#7fe6ed' },
  });
  set.set([line('a')]);
  const first = scene.added[0];
  const ground = first.get(1);
  assert.ok(ground instanceof Cesium.GroundPolylinePrimitive);
  assert.equal(ground.classificationType, Cesium.ClassificationType.BOTH);
  assert.equal(ground.geometryInstances[0].geometry.width, 2.5);
  assert.deepEqual(ground.geometryInstances[0].id.id, 'a');

  // Still not ready: the first build is all there is.
  set.set([line('a'), line('b')]);
  assert.deepEqual(scene.added.length, 1, 'an unready host is dropped');
  const second = scene.added[0];
  Object.defineProperty(second.get(1), 'ready', { value: true });
  frame();
  assert.equal(second.get(1).show, true, 'shown once ready');
  set.set([line('c')]);
  assert.equal(scene.added.length, 2, 'the ready one stays until…');
  const third = scene.added[1].get(1);
  assert.equal(third.show, false, 'the new one hidden while it builds');
  frame();
  assert.equal(scene.added.length, 2);
  Object.defineProperty(third, 'ready', { value: true });
  frame();
  assert.equal(scene.added.length, 1, '…the new one is ready');
  assert.equal(third.show, true, 'and they swap in one frame');
  set.dispose();
  assert.equal(scene.added.length, 0);
});

test('a draped outlined line keeps its outline in its own material', () =>
  withImageClasses(() => {
    const { scene, draw } = drawOver();
    const set = draw.lines({ id: 'edged' });
    set.set([
      {
        id: 'a',
        positions: [
          { lon: 0, lat: 0 },
          { lon: 1, lat: 1 },
        ],
        widthPx: 6,
        mode: 'draped',
        style: {
          kind: 'solid',
          color: '#7fe6ed',
          outline: { color: '#000000', widthPx: 2 },
        },
      },
    ]);
    const host = scene.added[0];
    const grounds = [];
    for (let i = 0; i < host.length; i++)
      if (host.get(i) instanceof Cesium.GroundPolylinePrimitive)
        grounds.push(host.get(i));
    assert.equal(grounds.length, 1);
    const { material } = grounds[0].appearance;
    assert.equal(material.type, 'PolylineOutline');
    assert.equal(material.uniforms.outlineWidth, 2);
    set.dispose();
  }));

test('clamped fills are ground primitives packed so none overlap within one', () => {
  const { scene, draw } = drawOver();
  const set = draw.shapes({ id: 'discs' });
  const disc = (id, lon, fill = [1, 0, 0, 0.3]) => ({
    id,
    geometry: {
      kind: 'ellipse',
      center: { lon, lat: 0 },
      semiMajor: 100_000,
      semiMinor: 100_000,
    },
    fill,
    height: 'clampGround',
  });
  set.set([disc('a', 0), disc('b', 0.5), disc('c', 30, '#ff0'), disc('x', 60)]);
  const host = scene.added[0];
  const grounds = [];
  for (let i = 0; i < host.length; i++)
    if (host.get(i) instanceof Cesium.GroundPrimitive)
      grounds.push(host.get(i));
  assert.deepEqual(
    grounds.map((g) => g.geometryInstances.map((instance) => instance.id.id)),
    [['a', 'c', 'x'], ['b']],
  );
  set.dispose();
});

test('a clamped outline is a draped line under its shape’s pick id, a ring each', () => {
  const { scene, draw } = drawOver();
  const set = draw.shapes({ id: 'outlined' });
  set.set([
    {
      id: 'o',
      geometry: {
        kind: 'polygon',
        rings: [
          [
            { lon: 0, lat: 0 },
            { lon: 1, lat: 0 },
            { lon: 1, lat: 1 },
          ],
          [
            { lon: 0.5, lat: 0.2 },
            { lon: 0.7, lat: 0.2 },
            { lon: 0.7, lat: 0.4 },
          ],
        ],
      },
      fill: [1, 0, 0, 0.3],
      outline: '#fff',
      outlineWidth: 3,
      height: 'clampGround',
    },
    {
      id: 'r',
      geometry: {
        kind: 'rectangle',
        rect: { west: 2, south: 0, east: 3, north: 1 },
      },
      outline: '#0f0',
      outlineOnly: true,
      height: 'clampGround',
    },
  ]);
  const host = scene.added[0];
  const lines = [];
  for (let i = 0; i < host.length; i++)
    if (host.get(i) instanceof Cesium.GroundPolylinePrimitive)
      lines.push(host.get(i));
  assert.deepEqual(
    lines.map((l) =>
      l.geometryInstances.map((g) => [g.id.id, g.geometry._positions.length]),
    ),
    [
      [
        ['o', 4],
        ['o', 4],
      ],
      [['r', 5]],
    ],
    'closed rings',
  );
  assert.equal(lines[0].geometryInstances[0].geometry.width, 3);
  set.dispose();
});

test('a pulsing clamped outline pulses its alpha through its material', () =>
  withImageClasses(() => {
    const { scene, draw, frame } = drawOver();
    const set = draw.shapes({ id: 'pulsing-outline' });
    set.set([
      {
        id: 'r',
        geometry: {
          kind: 'rectangle',
          rect: { west: 2, south: 0, east: 3, north: 1 },
        },
        outline: '#00ff00',
        outlineOnly: true,
        height: 'clampGround',
        animate: { property: 'alpha', from: 0.2, to: 0.2, periodMs: 1000 },
      },
    ]);
    const host = scene.added[0];
    let line;
    for (let i = 0; i < host.length; i++)
      if (host.get(i) instanceof Cesium.GroundPolylinePrimitive)
        line = host.get(i);
    assert.ok(line.appearance instanceof Cesium.PolylineMaterialAppearance);
    frame();
    const colour = line.appearance.material.uniforms.color;
    assert.deepEqual(
      [colour.green, Math.round(colour.alpha * 100) / 100],
      [1, 0.2],
    );
    set.dispose();
  }));

test('where the scene cannot drape materials, a clamped image fill lies on the surface', () =>
  withImageClasses(() => {
    const scene = fakeScene();
    scene.context = { depthTexture: false };
    const { draw } = drawOver(scene);
    const set = draw.shapes({ id: 'flat-image' });
    set.set([
      {
        id: 'pic',
        geometry: {
          kind: 'rectangle',
          rect: { west: 0, south: 0, east: 0.01, north: 0.01 },
        },
        fill: { image: 'pic.png' },
        height: 'clampGround',
      },
    ]);
    const found = [];
    const walk = (primitive) => {
      if (primitive instanceof Cesium.PrimitiveCollection)
        for (let i = 0; i < primitive.length; i++) walk(primitive.get(i));
      else found.push(primitive);
    };
    scene.added.forEach(walk);
    const fill = found.find((p) => p instanceof Cesium.Primitive);
    assert.ok(fill, 'an unclamped primitive');
    assert.ok(!found.some((p) => p instanceof Cesium.GroundPrimitive));
    assert.equal(fill.appearance.material.type, 'Image');
    set.dispose();
  }));

test('clamped extruded shapes and walls stand on the surface, unclamped', () => {
  const scene = fakeScene();
  scene.globe = { show: true, getHeight: () => 120 };
  const { draw } = drawOver(scene);
  const set = draw.shapes({ id: 'standing' });
  set.set([
    {
      id: 'block',
      geometry: {
        kind: 'polygon',
        rings: [
          [
            { lon: 0, lat: 0 },
            { lon: 0.01, lat: 0 },
            { lon: 0.01, lat: 0.01 },
          ],
        ],
      },
      fill: '#f00',
      extrudeHeight: 400,
      height: 'clampGround',
    },
    {
      id: 'fence',
      geometry: {
        kind: 'wall',
        positions: [
          { lon: 0, lat: 0, height: 10 },
          { lon: 0.01, lat: 0, height: 20 },
        ],
      },
      fill: '#00f',
      height: 'clampGround',
    },
  ]);
  const geometries = new Map();
  const walk = (primitive) => {
    if (!primitive) return;
    if (primitive instanceof Cesium.PrimitiveCollection)
      for (let i = 0; i < primitive.length; i++) walk(primitive.get(i));
    assert.ok(!(primitive instanceof Cesium.GroundPrimitive), 'not draped');
    for (const instance of [primitive.geometryInstances ?? []].flat())
      geometries.set(instance.id?.id, instance.geometry);
  };
  scene.added.forEach(walk);
  const block = geometries.get('block');
  assert.ok(block instanceof Cesium.PolygonGeometry);
  assert.deepEqual(
    [block._height, block._extrudedHeight].sort((a, b) => a - b),
    [120, 400],
    'from the surface up to its extruded height',
  );
  const fence = geometries.get('fence');
  assert.ok(fence instanceof Cesium.WallGeometry);
  assert.deepEqual(fence._minimumHeights, [120, 120], 'its foot on it');
  assert.deepEqual(fence._maximumHeights, [130, 140], 'its heights above it');
  set.dispose();
});

test('a set that never picks keeps its ground fills and draped lines out of picks', () => {
  const { scene, draw } = drawOver();
  const fills = draw.shapes({ id: 'cells', pickable: false });
  const square = {
    id: 'a',
    geometry: {
      kind: 'rectangle',
      rect: { west: 0, south: 0, east: 1, north: 1 },
    },
    fill: [1, 0, 0, 0.3],
    height: 'clampGround',
  };
  fills.set([square]);
  const groundOf = (host) => {
    for (let i = 0; i < host.length; i++)
      if (host.get(i) instanceof Cesium.GroundPrimitive) return host.get(i);
    return null;
  };
  const passes = (primitive) => {
    const seen = [];
    const update = Cesium.GroundPrimitive.prototype.update;
    Cesium.GroundPrimitive.prototype.update = function (frameState) {
      seen.push(frameState.passes.pick ? 'pick' : 'render');
    };
    try {
      primitive.update({ passes: { pick: true } });
      primitive.update({ passes: { render: true } });
    } finally {
      Cesium.GroundPrimitive.prototype.update = update;
    }
    return seen;
  };
  let ground = groundOf(scene.added[0]);
  assert.equal(ground.allowPicking, false);
  assert.deepEqual(passes(ground), ['render'], 'no pick pass at all');
  // Whether it picks is built into the primitives: a change rebuilds them.
  fills.setOptions({ pickable: true });
  ground = groundOf(scene.added.at(-1));
  assert.equal(ground.allowPicking, true);
  assert.deepEqual(passes(ground), ['pick', 'render']);
  // Stopping picks drops the old, pickable ground at once, before the new
  // ground is ready: kept drawing, it would still hide the ground from picks.
  fills.setOptions({ pickable: false });
  assert.equal(scene.added.length, 1, 'only the new host is drawn');
  assert.equal(groundOf(scene.added[0]).allowPicking, false);
  fills.dispose();

  const lines = draw.lines({ id: 'edges', pickable: false });
  lines.set([
    {
      id: 'e',
      positions: [
        Cesium.Cartesian3.fromDegrees(0, 0),
        Cesium.Cartesian3.fromDegrees(1, 0),
      ],
      widthPx: 2,
      mode: 'draped',
      style: { kind: 'solid', color: '#fff' },
    },
  ]);
  const host = scene.added.at(-1);
  let draped = null;
  for (let i = 0; i < host.length; i++)
    if (host.get(i) instanceof Cesium.GroundPolylinePrimitive)
      draped = host.get(i);
  assert.equal(draped.allowPicking, false);
  lines.dispose();
  assert.equal(scene.added.length, 0);
});

test('changing what a set clamps to rebuilds its items', () => {
  const { scene, draw } = drawOver();
  const set = draw.points({ id: 'reclamp', clampTo: 'terrain' });
  set.set([
    {
      id: 'p',
      pos: { lon: 0, lat: 0 },
      height: 'clampGround',
      pixelSize: 4,
      color: '#fff',
    },
  ]);
  assert.equal(
    scene.added[0].get(0).heightReference,
    Cesium.HeightReference.CLAMP_TO_TERRAIN,
  );
  set.setOptions({ clampTo: 'tiles' });
  assert.equal(
    scene.added[0].get(0).heightReference,
    Cesium.HeightReference.CLAMP_TO_3D_TILE,
  );
  set.dispose();
});

test('while a rebuild builds, only the old ground waits: the rest goes at once', () => {
  const { scene, draw, frame } = drawOver();
  const set = draw.shapes({ id: 'mixed' });
  const disc = (id, height) => ({
    id,
    geometry: {
      kind: 'ellipse',
      center: { lon: 0, lat: 0 },
      semiMajor: 1000,
      semiMinor: 1000,
    },
    fill: '#fff',
    ...(height ? { height } : {}),
  });
  const items = [disc('ground', 'clampGround'), disc('raised')];
  set.set(items);
  const first = scene.added[0];
  const ground = first.get(1);
  assert.ok(ground instanceof Cesium.GroundPrimitive);
  Object.defineProperty(ground, 'ready', { value: true });
  frame();
  set.set(items);
  assert.equal(scene.added.length, 2);
  assert.equal(first.length, 1, 'the old raised fill is gone');
  assert.equal(first.get(0), ground, 'its ground fill waits');
  set.dispose();
  assert.equal(scene.added.length, 0);
});

test('a clamped fill that only shows, hides or changes meta is changed in place', () => {
  const { scene, draw, frame } = drawOver();
  const set = draw.shapes({ id: 'toggles' });
  // Apart, so one ground primitive holds them all.
  const rings = new Map(
    ['a', 'b', 'c'].map((id, i) => [
      id,
      [
        { lon: i, lat: 0 },
        { lon: i + 0.1, lat: 0 },
        { lon: i + 0.1, lat: 0.1 },
      ],
    ]),
  );
  const fill = (id, show, meta = undefined) => ({
    id,
    geometry: { kind: 'polygon', rings: [rings.get(id)] },
    fill: [1, 0, 0, 0.3],
    height: 'clampGround',
    show,
    meta,
  });
  set.set([fill('a', true), fill('b', false)]);
  const host = scene.added[0];
  const groundOf = (h) => {
    for (let i = 0; i < h.length; i++)
      if (h.get(i) instanceof Cesium.GroundPrimitive) return h.get(i);
    return null;
  };
  const ground = groundOf(host);
  // A hidden one is built too, hidden.
  const instances = ground.geometryInstances;
  assert.deepEqual(
    instances.map((instance) => [
      instance.id.id,
      [...instance.attributes.show.value],
    ]),
    [
      ['a', [1]],
      ['b', [0]],
    ],
  );
  const shows = new Map(
    instances.map((instance) => [
      instance.id,
      { show: Uint8Array.from(instance.attributes.show.value) },
    ]),
  );
  const byItem = (id) => instances.find((i) => i.id.id === id).id;
  ground.getGeometryInstanceAttributes = (id) => shows.get(id);
  // Still building: the show waits for the swap.
  set.upsert([fill('b', true, { n: 1 })]);
  assert.equal(scene.added[0], host, 'not rebuilt');
  assert.deepEqual([...shows.get(byItem('b')).show], [0]);
  assert.deepEqual(byItem('b').meta, { n: 1 }, 'meta changed in place');
  Object.defineProperty(ground, 'ready', { value: true });
  frame();
  assert.deepEqual([...shows.get(byItem('b')).show], [1]);
  // Ready: written at once.
  set.upsert([fill('a', false), fill('b', true, { n: 1 })]);
  assert.equal(scene.added[0], host, 'still not rebuilt');
  assert.deepEqual([...shows.get(byItem('a')).show], [0]);
  // The same look written out anew is the same look.
  set.upsert([
    {
      ...fill('a', true),
      geometry: { kind: 'polygon', rings: [[...rings.get('a')]] },
    },
  ]);
  assert.equal(scene.added[0], host);
  assert.deepEqual([...shows.get(byItem('a')).show], [1]);
  // An item changed in place is a new look: it rebuilds.
  const reused = fill('a', true);
  set.upsert([reused]);
  assert.equal(scene.added[0], host);
  reused.geometry.rings[0][0] = { lon: 0.05, lat: 0 };
  set.upsert([reused]);
  assert.notEqual(scene.added.at(-1), host, 'a moved corner rebuilds');
  Object.defineProperty(groundOf(scene.added.at(-1)), 'ready', {
    value: true,
  });
  frame();
  const moved = scene.added.at(-1);
  // A new colour is written in place too.
  const colours = new Map();
  groundOf(moved).getGeometryInstanceAttributes = (id) => {
    if (!colours.has(id.id))
      colours.set(id.id, {
        color: new Uint8Array(4),
        show: new Uint8Array([1]),
      });
    return colours.get(id.id);
  };
  set.upsert([{ ...fill('a', true), fill: [0, 1, 0, 0.3] }]);
  assert.equal(scene.added.at(-1), moved, 'a new colour does not rebuild');
  assert.deepEqual([...colours.get('a').color], [0, 255, 0, 76]);
  // A new item rebuilds.
  set.upsert([fill('c', true)]);
  assert.notEqual(scene.added.at(-1), moved, 'a new item rebuilds');
  set.dispose();
  assert.equal(scene.added.length, 0);
});

test('hidden clamped fills wait for nothing, and the hidden ones it cannot build stay out', () => {
  const { scene, draw, frame } = drawOver();
  const set = draw.shapes({ id: 'hide-all' });
  const fill = (id, lon, show, extra = {}) => ({
    id,
    geometry: {
      kind: 'ellipse',
      center: { lon, lat: 0 },
      semiMajor: 1000,
      semiMinor: 1000,
    },
    fill: '#fff',
    height: 'clampGround',
    show,
    ...extra,
  });
  const groundsIn = (host) => {
    const found = [];
    for (let i = 0; i < host.length; i++)
      if (host.get(i) instanceof Cesium.GroundPrimitive)
        found.push(host.get(i));
    return found;
  };
  set.set([fill('a', 0, true), fill('b', 1, true)]);
  const first = scene.added[0];
  Object.defineProperty(groundsIn(first)[0], 'ready', { value: true });
  frame();
  // Everything hidden: nothing to wait for, the old fills go at once.
  set.set([fill('a', 0, false), fill('b', 1, false)]);
  assert.equal(scene.added.length, 1, 'the old host is gone');
  assert.notEqual(scene.added[0], first);
  // Hidden ones it could not draw shown are left out, as before.
  assert.doesNotThrow(() =>
    set.set([
      fill('a', 0, false, { outline: '#000' }),
      fill('b', 1, false, { extrudeHeight: 10 }),
      fill('c', 2, false, { fill: { gradient: 'radial' } }),
    ]),
  );
  assert.equal(groundsIn(scene.added.at(-1)).length, 0);
  set.dispose();
  assert.equal(scene.added.length, 0);
});

test('a show patched while a rebuild waits lands on the new fills, the old ones keep drawing', () => {
  const { scene, draw, frame } = drawOver();
  const set = draw.shapes({ id: 'patch-pending' });
  const fill = (id, lon, show, color = '#fff') => ({
    id,
    geometry: {
      kind: 'ellipse',
      center: { lon, lat: 0 },
      semiMajor: 1000,
      semiMinor: 1000,
    },
    fill: color,
    height: 'clampGround',
    show,
  });
  const groundOf = (host) => {
    for (let i = 0; i < host.length; i++)
      if (host.get(i) instanceof Cesium.GroundPrimitive) return host.get(i);
    return null;
  };
  set.set([fill('a', 0, true), fill('b', 1, true)]);
  const first = scene.added[0];
  Object.defineProperty(groundOf(first), 'ready', { value: true });
  frame();
  // A new colour rebuilds; the old fills draw until the new ones are ready.
  set.set([fill('a', 0, true, '#f00'), fill('b', 1, true, '#f00')]);
  const second = scene.added.at(-1);
  assert.equal(scene.added.length, 2, 'the old host waits');
  const ground = groundOf(second);
  const shows = new Map(
    ground.geometryInstances.map((instance) => [
      instance.id,
      { show: Uint8Array.from(instance.attributes.show.value) },
    ]),
  );
  ground.getGeometryInstanceAttributes = (id) => shows.get(id);
  const idOf = (item) =>
    ground.geometryInstances.find((i) => i.id.id === item).id;
  set.upsert([fill('b', 1, false, '#f00')]);
  set.upsert([fill('b', 1, true, '#f00')]);
  set.upsert([fill('a', 0, false, '#f00')]);
  assert.equal(scene.added.at(-1), second, 'patched, not rebuilt');
  assert.deepEqual([...shows.get(idOf('a')).show], [1], 'queued until ready');
  Object.defineProperty(ground, 'ready', { value: true });
  frame();
  assert.equal(scene.added.length, 1, 'swapped');
  assert.deepEqual([...shows.get(idOf('a')).show], [0]);
  assert.deepEqual([...shows.get(idOf('b')).show], [1], 'the last write wins');
  // A rebuild after a patch builds the patched show.
  set.upsert([fill('c', 2, true, '#f00')]);
  const third = groundOf(scene.added.at(-1));
  assert.deepEqual(
    third.geometryInstances.map((instance) => [
      instance.id.id,
      [...instance.attributes.show.value],
    ]),
    [
      ['a', [0]],
      ['b', [1]],
      ['c', [1]],
    ],
  );
  set.dispose();
  assert.equal(scene.added.length, 0);
});

test('clamped shapes refuse what they cannot draw', () => {
  const { draw } = drawOver();
  const set = draw.shapes({ id: 'refuse' });
  const disc = {
    id: 'a',
    geometry: {
      kind: 'ellipse',
      center: { lon: 0, lat: 0 },
      semiMajor: 1000,
      semiMinor: 1000,
    },
    fill: '#fff',
    height: 'clampGround',
  };
  // A fill that is neither a colour nor an image.
  assert.throws(
    () => set.set([{ ...disc, fill: { gradient: 'radial' } }]),
    /colours only/,
  );
  set.dispose();
});

test('a clamped colour ring whose radius alone changes is drawn alone where it now is', () =>
  withTerrainHeights(() => {
    const scene = fakeScene();
    const { draw, frame } = drawOver(scene);
    const set = draw.shapes({ id: 'rings' });
    // The app follows the camera's height and sends the radius it wants, as
    // annotation target rings do.
    const ring = (radius, show = true) => ({
      id: 'ring',
      geometry: {
        kind: 'ellipse',
        center: { lon: 0, lat: 0 },
        semiMajor: radius,
        semiMinor: radius,
      },
      fill: [0.5, 0.9, 1, 0.38],
      height: 'clampGround',
      show,
    });
    set.set([ring(60)]);
    const host = scene.added[0];
    const radiusIn = (ground) =>
      ground.geometryInstances[0].geometry._semiMajorAxis;
    const last = () => host.get(host.length - 1);
    assert.equal(radiusIn(last()), 60);
    const built = last();
    frame();
    assert.equal(last(), built, 'nothing built while nothing changes');
    // Wider: drawn alone, built in this frame, under its own pick id.
    set.upsert([ring(120)]);
    const wider = last();
    assert.notEqual(wider, built);
    assert.equal(wider.asynchronous, false);
    assert.equal(radiusIn(wider), 120);
    assert.equal(wider.geometryInstances[0].id.id, 'ring', 'its own pick id');
    set.upsert([ring(14)]);
    assert.equal(radiusIn(last()), 14);
    assert.equal(scene.added[0], host, 'never a rebuild of the set');
    set.dispose();
    assert.equal(scene.added.length, 0);
  }));

test('a semi-minor axis longer than the semi-major is drawn as the major axis, a quarter turn on', () =>
  withTerrainHeights(() => {
    const scene = fakeScene();
    const { draw } = drawOver(scene);
    const set = draw.shapes({ id: 'crossing' });
    set.set([
      {
        id: 'r',
        geometry: {
          kind: 'ellipse',
          center: { lon: 0, lat: 0 },
          semiMajor: 30,
          semiMinor: 50,
          rotation: 0.25,
        },
        fill: [0.5, 0.9, 1, 0.38],
        height: 'clampGround',
      },
    ]);
    const host = scene.added[0];
    let ground = null;
    for (let i = 0; i < host.length; i++)
      if (host.get(i) instanceof Cesium.GroundPrimitive) ground = host.get(i);
    const geometry = ground.geometryInstances[0].geometry;
    assert.equal(geometry._semiMajorAxis, 50);
    assert.equal(geometry._semiMinorAxis, 30);
    assert.ok(Math.abs(geometry._rotation - (0.25 + Math.PI / 2)) < 1e-12);
    set.dispose();
  }));

test('rings that would be drawn alone past the cap rebuild their set, counting those a retiring host draws alone', () =>
  withTerrainHeights(() => {
    const scene = fakeScene();
    const { draw, frame } = drawOver(scene);
    const set = draw.shapes({ id: 'climbing' });
    const ring = (i, radius) => ({
      id: `r${i}`,
      geometry: {
        kind: 'ellipse',
        center: { lon: i * 0.1, lat: 0 },
        semiMajor: radius,
        semiMinor: radius,
      },
      fill: [0.5, 0.9, 1, 0.38],
      height: 'clampGround',
    });
    const all = (radius, from = 0, to = MOVING_SHAPES + 4) =>
      Array.from({ length: to - from }, (_, k) => ring(from + k, radius));
    const ready = (host) => {
      for (let i = 0; i < host.length; i++)
        if (host.get(i) instanceof Cesium.GroundPrimitive) {
          Object.defineProperty(host.get(i), 'ready', { value: true });
          host.get(i).getGeometryInstanceAttributes = () => ({
            show: new Uint8Array([1]),
          });
        }
    };
    const solo = (host) => {
      let n = 0;
      for (let i = 0; i < host.length; i++) {
        const p = host.get(i);
        if (p instanceof Cesium.GroundPrimitive && p.asynchronous === false)
          n += 1;
      }
      return n;
    };
    set.set(all(30));
    const first = scene.added[0];
    ready(first);
    frame();
    // The cap moves alone.
    set.upsert(all(45, 0, MOVING_SHAPES));
    assert.equal(solo(first), MOVING_SHAPES);
    assert.equal(scene.added.at(-1), first);
    // One more would pass it: the set rebuilds, the old host retiring.
    set.upsert(all(45, MOVING_SHAPES));
    const second = scene.added.at(-1);
    assert.notEqual(second, first, 'rebuilding, the old host retiring');
    ready(second);
    // While the old host retires, its rings drawn alone still count, so
    // none more are drawn alone.
    set.upsert([ring(0, 75)]);
    assert.equal(solo(second), 0, 'nothing more drawn alone');
    set.dispose();
  }));

test('shapes that only change colour, pulse, show or meta change in place; a pulse runs on the frames', () =>
  withTerrainHeights(() => {
    const scene = fakeScene();
    const asked = [];
    scene.requestRender = () => asked.push(1);
    const { draw, frame } = drawOver(scene);
    const set = draw.shapes({ id: 'fading' });
    const ring = [
      { lon: 0, lat: 0, height: 10 },
      { lon: 0.001, lat: 0, height: 10 },
      { lon: 0.001, lat: 0.001, height: 10 },
    ];
    const pulse = (alpha) => ({
      property: 'alpha',
      from: alpha * 0.6,
      to: alpha,
      periodMs: 1000,
    });
    const column = (alpha, extra = {}) => ({
      id: 'column',
      geometry: { kind: 'polygon', rings: [ring] },
      fill: [1, 0.7, 0.3, 0.45 * alpha],
      animate: pulse(0.45 * alpha),
      extrudeHeight: 100,
      height: 'absolute',
      ...extra,
    });
    const cage = (alpha) => ({
      id: 'cage',
      geometry: { kind: 'polygon', rings: [ring] },
      outline: [1, 0.7, 0.3, 0.32 * alpha],
      outlineOnly: true,
      animate: pulse(0.32 * alpha),
      extrudeHeight: 100,
      height: 'absolute',
    });
    const fill = (alpha) => ({
      id: 'fill',
      geometry: {
        kind: 'polygon',
        rings: [ring.map(({ lon, lat }) => ({ lon: lon + 1, lat }))],
      },
      fill: [0.4, 1, 0.6, 0.2 * alpha],
      animate: pulse(0.2 * alpha),
      height: 'clampGround',
    });
    set.set([column(0), cage(0), fill(0)]);
    const host = scene.added[0];
    const solids = host.get(0);
    const [columnPrimitive, cagePrimitive] = [solids.get(0), solids.get(1)];
    let ground = null;
    for (let i = 0; i < host.length; i++)
      if (host.get(i) instanceof Cesium.GroundPrimitive) ground = host.get(i);
    // A pulsing colour draws translucent, whatever its alpha now.
    assert.equal(columnPrimitive.appearance.translucent, true);
    assert.equal(cagePrimitive.appearance.translucent, true);
    // Ready, with instance attributes to write.
    const colours = new Map();
    const ready = (primitive, key) => {
      Object.defineProperty(primitive, 'ready', { value: true });
      primitive.getGeometryInstanceAttributes = () => {
        if (!colours.has(key))
          colours.set(key, {
            color: new Uint8Array(4),
            show: new Uint8Array([1]),
          });
        return colours.get(key);
      };
    };
    ready(columnPrimitive, 'column');
    ready(cagePrimitive, 'cage');
    ready(ground, 'fill');
    frame();
    // Faded in: the same primitives take it.
    set.upsert([column(1, { meta: 'm' }), cage(1), fill(1)]);
    assert.equal(scene.added[0], host, 'not rebuilt');
    assert.equal(solids.get(0), columnPrimitive);
    assert.equal(columnPrimitive.geometryInstances.id.meta, 'm');
    // The pulse writes each frame between 60% and all of the alpha, and asks
    // for the next frame.
    const seen = { column: [], cage: [], fill: [] };
    const realNow = performance.now;
    let now = 0;
    performance.now = () => now;
    try {
      for (now = 0; now < 1000; now += 50) {
        asked.length = 0;
        frame();
        assert.ok(asked.length > 0, 'a pulse asks for frames');
        for (const key of Object.keys(seen))
          seen[key].push(colours.get(key).color[3] / 255);
      }
    } finally {
      performance.now = realNow;
    }
    const range = (values) => [Math.min(...values), Math.max(...values)];
    const near = (a, b) => Math.abs(a - b) < 0.01;
    assert.ok(
      near(range(seen.column)[0], 0.27) && near(range(seen.column)[1], 0.45),
      `${range(seen.column)}`,
    );
    assert.ok(
      near(range(seen.cage)[0], 0.192) && near(range(seen.cage)[1], 0.32),
      `${range(seen.cage)}`,
    );
    assert.ok(
      near(range(seen.fill)[0], 0.12) && near(range(seen.fill)[1], 0.2),
      `${range(seen.fill)}`,
    );
    // Hidden in place: its primitives hide, and stop pulsing.
    set.upsert([column(1, { show: false })]);
    assert.equal(scene.added[0], host);
    assert.equal(columnPrimitive.show, false);
    // An opaque colour drawn translucent is fine in place; a shape that
    // changes more than its colours rebuilds.
    set.upsert([column(1, { extrudeHeight: 200 })]);
    assert.notEqual(scene.added.at(-1), host, 'rebuilt');
    set.dispose();
  }));

test('colour fills carry what their appearance reads, as entities do', () =>
  withImageClasses(() => {
    const { scene, draw } = drawOver();
    const set = draw.shapes({ id: 'formats' });
    const ring = [
      { lon: 0, lat: 0, height: 10 },
      { lon: 0.001, lat: 0, height: 10 },
      { lon: 0.001, lat: 0.001, height: 10 },
    ];
    set.set([
      {
        id: 'column',
        geometry: { kind: 'polygon', rings: [ring] },
        fill: [1, 0.7, 0.3, 0.45],
        extrudeHeight: 100,
        height: 'absolute',
      },
      {
        id: 'disc',
        geometry: {
          kind: 'ellipse',
          center: { lon: 2, lat: 0, height: 10 },
          semiMajor: 50,
          semiMinor: 30,
        },
        fill: '#fff',
        extrudeHeight: 40,
        height: 'absolute',
      },
      {
        id: 'slab',
        geometry: {
          kind: 'rectangle',
          rect: { west: 3, south: 0, east: 3.01, north: 0.01 },
          height: 10,
        },
        fill: '#fff',
        extrudeHeight: 40,
        height: 'absolute',
      },
    ]);
    const host = scene.added[0];
    const formats = [];
    const walk = (c) => {
      for (let i = 0; i < c.length; i++) {
        const p = c.get(i);
        if (typeof p.length === 'number' && p.get) walk(p);
        else if (p instanceof Cesium.Primitive && p.geometryInstances?.geometry)
          formats.push(p.geometryInstances.geometry._vertexFormat);
      }
    };
    walk(host);
    assert.equal(formats.length, 3);
    // Position and normal only: with texture coordinates too, Cesium packs
    // them with the normals, and the colour appearance misreads them.
    for (const format of formats) {
      assert.equal(format.normal, true);
      assert.equal(format.st, false);
    }
    set.dispose();
  }));

test('a pulse the Cesium renderer cannot run is refused before anything changes', () => {
  const { scene, draw } = drawOver();
  const set = draw.shapes({ id: 'pulses' });
  const disc = (animate) => ({
    id: 'a',
    geometry: {
      kind: 'ellipse',
      center: { lon: 0, lat: 0 },
      semiMajor: 1000,
      semiMinor: 1000,
    },
    fill: '#fff',
    height: 'clampGround',
    animate,
  });
  set.set([disc(undefined)]);
  const host = scene.added[0];
  assert.throws(
    () => set.set([disc({ property: 'radius', from: 1, to: 2, periodMs: 1 })]),
    /pulses alpha only, forever/,
  );
  assert.throws(
    () =>
      set.upsert([
        disc({ property: 'alpha', from: 0, to: 1, periodMs: 1, repeat: 2 }),
      ]),
    /pulses alpha only, forever/,
  );
  assert.equal(scene.added[0], host, 'still drawn as it was');
  // Behind an item that would rebuild, and in a whole new list, too.
  const radius = { property: 'radius', from: 1, to: 2, periodMs: 1 };
  assert.throws(
    () => set.upsert([{ ...disc(undefined), id: 'b' }, disc(radius)]),
    /pulses alpha only, forever/,
  );
  assert.throws(() => set.set([disc(radius)]), /pulses alpha only, forever/);
  assert.equal(scene.added[0], host, 'still drawn as it was');
  assert.doesNotThrow(() => set.upsert([{ ...disc(undefined), id: 'c' }]));
  // Nor numbers it cannot draw.
  assert.throws(
    () =>
      set.upsert([disc({ property: 'alpha', from: 0, to: 1, periodMs: 0 })]),
    /positive period/,
  );
  set.dispose();
});

test('a pulsing ring outline changes in place; a pulsing shape that draws nothing asks for no frames', () =>
  withImageClasses(() => {
    const scene = fakeScene();
    const asked = [];
    scene.requestRender = () => asked.push(1);
    const { draw, frame } = drawOver(scene);
    const set = draw.shapes({ id: 'rings-pulse' });
    const ring = [
      { lon: 0, lat: 0, height: 10 },
      { lon: 0.001, lat: 0, height: 10 },
      { lon: 0.001, lat: 0.001, height: 10 },
    ];
    const pulse = { property: 'alpha', from: 0.2, to: 0.5, periodMs: 1000 };
    const outlined = (extra = {}) => ({
      id: 'o',
      geometry: { kind: 'polygon', rings: [ring] },
      outline: [1, 1, 1, 0.5],
      outlineOnly: true,
      animate: pulse,
      height: 'absolute',
      ...extra,
    });
    set.set([outlined()]);
    const host = scene.added[0];
    set.upsert([outlined({ meta: 'm' })]);
    assert.equal(scene.added[0], host, 'not rebuilt');
    set.set([
      {
        id: 'nothing',
        geometry: { kind: 'polygon', rings: [ring] },
        animate: pulse,
        height: 'absolute',
      },
    ]);
    frame();
    asked.length = 0;
    frame();
    assert.equal(asked.length, 0, 'nothing drawn, no frames asked');
    set.dispose();
  }));

test('an unclamped shape recoloured before it is drawn rebuilds; frames stop once nothing pulses', () =>
  withTerrainHeights(() => {
    const scene = fakeScene();
    const asked = [];
    scene.requestRender = () => asked.push(1);
    const { draw, frame } = drawOver(scene);
    const set = draw.shapes({ id: 'early' });
    const ring = [
      { lon: 0, lat: 0, height: 10 },
      { lon: 0.001, lat: 0, height: 10 },
      { lon: 0.001, lat: 0.001, height: 10 },
    ];
    const column = (alpha, extra = {}) => ({
      id: 'column',
      geometry: { kind: 'polygon', rings: [ring] },
      fill: [1, 0.7, 0.3, alpha],
      extrudeHeight: 100,
      height: 'absolute',
      ...extra,
    });
    set.set([column(0.4)]);
    const host = scene.added[0];
    set.upsert([column(0.5)]);
    assert.notEqual(scene.added.at(-1), host, 'not yet drawn: rebuilt');
    // Pulsing, it asks for frames; hidden, it stops.
    const pulse = { property: 'alpha', from: 0.2, to: 0.5, periodMs: 1000 };
    set.set([column(0.5, { animate: pulse })]);
    asked.length = 0;
    frame();
    assert.ok(asked.length > 0, 'a pulse asks for frames');
    set.set([column(0.5, { animate: pulse, show: false })]);
    frame();
    asked.length = 0;
    frame();
    assert.equal(asked.length, 0, 'nothing pulses, no frames asked');
    set.dispose();
  }));

test('the earthquakes layer draws its discs as ground fills on a viewer of its own', async () => {
  const { createEarthquakesLayer } =
    await import('../../layers/earthquakes/index.js');
  const scene = fakeScene();
  const viewer = { scene };
  const row = (stableId, lon, mag) => ({
    stableId,
    usgsId: stableId,
    lon,
    lat: 0,
    depthKm: 10,
    mag,
    place: null,
    time: null,
  });
  const layer = createEarthquakesLayer({
    source: { getSnapshot: async () => [row('a', 0, 5), row('b', 0.2, 3)] },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  const host = scene.added[0];
  const grounds = [];
  for (let i = 0; i < host.length; i++)
    if (host.get(i) instanceof Cesium.GroundPrimitive)
      grounds.push(host.get(i));
  // Overlapping discs: one batch each, as the entities' batches had them.
  assert.equal(grounds.length, 2);
  const [instance] = grounds[0].geometryInstances;
  assert.ok(instance.geometry instanceof Cesium.EllipseGeometry);
  assert.equal(instance.id.id, 'earthquake:a');
  assert.equal(grounds[0].classificationType, Cesium.ClassificationType.BOTH);
  layer.destroy();
  assert.equal(scene.added.length, 0);
});

test('the world annotation renderer draws, fades, hides and lets go of every kind on a viewer of its own', async () => {
  const { createWorldAnnotationRenderer } =
    await import('../../annotations/worldAnnotationRenderer.js');
  await withImageClasses(() =>
    withTerrainHeights(() => {
      const scene = fakeScene();
      const viewer = { scene };
      const renderer = createWorldAnnotationRenderer(viewer);
      const box = (lon, d) => [
        [lon - d, -d],
        [lon + d, -d],
        [lon + d, d],
        [lon - d, d],
      ];
      const marks = [
        {
          id: 'building',
          type: 'area',
          color: 'amber',
          footprintKind: 'building',
          buildingHeight: 40,
          anchor: { lon: 0, lat: 0, height: 200 },
          ring: box(0, 0.0004),
        },
        {
          id: 'area',
          type: 'area',
          color: 'green',
          footprintKind: 'area',
          anchor: { lon: 0.01, lat: 0 },
          ring: box(0.01, 0.002),
          polygons: [[box(0.01, 0.002), box(0.01, 0.0005)]],
        },
        {
          id: 'synth',
          type: 'area',
          color: 'cyan',
          synthesized: true,
          anchor: { lon: 0.02, lat: 0 },
          ring: box(0.02, 0.002),
        },
        {
          id: 'route',
          type: 'route',
          color: 'red',
          anchor: { lon: 0, lat: 0.01 },
          path: [
            { lon: 0, lat: 0.01 },
            { lon: 0.01, lat: 0.012 },
          ],
        },
        {
          id: 'arrow',
          type: 'arrow',
          color: 'primary',
          anchor: { lon: 0, lat: 0.02 },
          to: { lon: 0.01, lat: 0.02 },
        },
        {
          id: 'pin',
          type: 'pin',
          color: 'primary',
          anchor: { lon: 0.03, lat: 0 },
        },
        {
          id: 'label',
          type: 'label',
          color: 'amber',
          anchor: { lon: 0.04, lat: 0 },
        },
      ];
      for (const mark of marks) {
        mark.alpha = 0.25;
        renderer.add(
          mark,
          mark.footprintKind === 'building' ? { sampledGroundHeight: 150 } : {},
        );
      }
      assert.ok(scene.added.length >= marks.length, 'every kind drew');
      for (const alpha of [0.5, 1]) {
        for (const mark of marks) mark.alpha = alpha;
        assert.doesNotThrow(() => renderer.sync());
        scene.preRender.raiseEvent();
        scene.postRender.raiseEvent();
      }
      for (const mark of marks) mark.hidden = true;
      renderer.sync();
      for (const mark of marks) mark.hidden = false;
      renderer.sync();
      renderer.destroy();
      assert.equal(scene.added.length, 0, 'nothing left drawn');
    }),
  );
});

test('the air quality layer draws its stations as ground fills on a viewer of its own', async () => {
  const { createAirQualityLayer } =
    await import('../../layers/airQuality/index.js');
  const scene = fakeScene();
  const viewer = { scene };
  const reading = (id, lon) => ({
    id,
    provider: 'eccc',
    scale: 'AQHI',
    value: 3,
    band: 'low',
    name: id,
    lat: 45,
    lon,
    observedMs: 0,
    color: '#4cc9f0',
    label: '3',
    risk: 'Low health risk',
    note: null,
  });
  const layer = createAirQualityLayer({
    source: { getSnapshot: async () => [reading('a', -75), reading('b', -60)] },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  const host = scene.added[0];
  const grounds = [];
  for (let i = 0; i < host.length; i++)
    if (host.get(i) instanceof Cesium.GroundPrimitive)
      grounds.push(host.get(i));
  const instances = grounds.flatMap((ground) => ground.geometryInstances);
  assert.deepEqual(instances.map((instance) => instance.id.id).sort(), [
    'air-quality:a',
    'air-quality:b',
  ]);
  assert.ok(instances[0].geometry instanceof Cesium.EllipseGeometry);
  assert.equal(grounds[0].classificationType, Cesium.ClassificationType.BOTH);
  layer.destroy();
  assert.equal(scene.added.length, 0);
});

test('the cyclones layer draws clamped dots, draped tracks and holed cones on a viewer of its own', async () => {
  const { createCycloneRendering } =
    await import('../../layers/cyclones/rendering.js');
  const { scene, frame } = drawOver();
  const rendering = createCycloneRendering({
    viewer: { scene },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  const storm = (id, lon) => ({
    id,
    name: id,
    advisoryNumber: '1',
    geometryAdvisoryNumber: '1',
    geometryStatus: 'current',
    position: { longitude: lon, latitude: 0 },
    forecastPoints: [
      { position: { longitude: lon, latitude: 1 }, tauHours: 12 },
    ],
    track: {
      type: 'LineString',
      coordinates: [
        [lon, 0],
        [lon, 1],
      ],
    },
    cone: {
      type: 'Polygon',
      coordinates: [
        [
          [lon - 2, -2],
          [lon + 2, -2],
          [lon + 2, 2],
          [lon - 2, 2],
          [lon - 2, -2],
        ],
        [
          [lon - 1, -1],
          [lon + 1, -1],
          [lon + 1, 1],
          [lon - 1, -1],
        ],
      ],
    },
  });
  await rendering.setSnapshot({
    storms: [storm('near', 0), storm('far', 180)],
  });
  const all = (host, out = []) => {
    out.push(host);
    if (host instanceof Cesium.PrimitiveCollection)
      for (let i = 0; i < host.length; i++) all(host.get(i), out);
    return out;
  };
  const primitives = scene.added.flatMap((host) => all(host));
  const of = (type) => primitives.filter((p) => p instanceof type);
  const [dots] = of(Cesium.BillboardCollection);
  assert.equal(dots.length, 4, 'two centers, two forecast points');
  for (let i = 0; i < dots.length; i++) {
    const dot = dots.get(i);
    assert.equal(dot.heightReference, Cesium.HeightReference.CLAMP_TO_GROUND);
    assert.equal(dot.disableDepthTestDistance, Infinity);
  }
  const [tracks] = of(Cesium.GroundPolylinePrimitive);
  assert.equal(tracks.classificationType, Cesium.ClassificationType.BOTH);
  assert.equal(tracks.geometryInstances.length, 6, 'tracks and ring outlines');
  const cones = of(Cesium.GroundPrimitive);
  const instances = cones.flatMap((cone) => cone.geometryInstances);
  assert.deepEqual(instances.map((instance) => instance.id.id).sort(), [
    'cyclone:far:cone:0',
    'cyclone:near:cone:0',
  ]);
  for (const { geometry } of instances)
    assert.equal(geometry._polygonHierarchy.holes.length, 1, 'the hole stays');

  // Past the horizon the dots go; their storms' shapes are the globe's to hide.
  frame();
  const shown = [];
  for (let i = 0; i < dots.length; i++)
    shown.push([dots.get(i).id.id, dots.get(i).show]);
  assert.deepEqual(shown.sort(), [
    ['cyclone:far:center', false],
    ['cyclone:far:forecast:0', false],
    ['cyclone:near:center', true],
    ['cyclone:near:forecast:0', true],
  ]);
  rendering.destroy();
  assert.equal(scene.added.length, 0);
});

test('point sets blend as asked and fall off with distance', () => {
  const { scene, draw } = drawOver();
  const set = draw.points({ id: 'falloff', blend: 'translucent' });
  set.set([
    {
      id: 'a',
      pos: { lon: 0, lat: 0, height: 2 },
      pixelSize: 6,
      color: [1, 0, 0, 0.5],
      scaleByDistance: { near: 200, nearValue: 1.35, far: 1e5, farValue: 0.4 },
      fadeByDistance: { near: 200, nearValue: 1, far: 2e5, farValue: 0.15 },
    },
    { id: 'b', pos: { lon: 1, lat: 0 }, pixelSize: 6, color: '#fff' },
  ]);
  const [points] = scene.added;
  assert.equal(points.blendOption, Cesium.BlendOption.TRANSLUCENT);
  const a = points.get(0);
  assert.ok(
    Cesium.NearFarScalar.equals(
      a.scaleByDistance,
      new Cesium.NearFarScalar(200, 1.35, 1e5, 0.4),
    ),
  );
  assert.ok(
    Cesium.NearFarScalar.equals(
      a.translucencyByDistance,
      new Cesium.NearFarScalar(200, 1, 2e5, 0.15),
    ),
  );
  assert.equal(points.get(1).scaleByDistance, undefined, 'none asked');
  set.setOptions({ blend: 'opaque' });
  assert.equal(scene.added[0].blendOption, Cesium.BlendOption.OPAQUE);
  set.setOptions({ blend: undefined });
  assert.equal(
    scene.added[0].blendOption,
    Cesium.BlendOption.OPAQUE_AND_TRANSLUCENT,
    'the default, as before',
  );
  set.dispose();
});

test('the bikeshare layer draws its stations as point primitives on a viewer of its own', async () => {
  const { createState } = await import('../../layers/bikeshare/state.js');
  const { createModel } = await import('../../layers/bikeshare/model.js');
  const { createRendering } =
    await import('../../layers/bikeshare/rendering.js');
  const { createSelection } =
    await import('../../layers/bikeshare/selection.js');
  const scene = fakeScene();
  const viewer = { scene };
  const services = {
    render: { governorRequestRender() {} },
    overlays: {
      setOverlayEntries() {},
      setOverlaySourceVisible() {},
      clearOverlaySource() {},
    },
  };
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source: {} };
  parts.model = createModel(context);
  parts.rendering = createRendering(context);
  parts.selection = createSelection(context);
  state._viewer = viewer;
  parts.rendering.attachSets(viewer);
  state._stationSet.show = true;
  const info = parts.model.parseStationInformation({
    data: {
      stations: [
        { station_id: 'a', name: 'A', lat: 30.26, lon: -97.74, capacity: 20 },
        { station_id: 'b', name: 'B', lat: 30.27, lon: -97.75, capacity: 4 },
      ],
    },
  });
  parts.rendering.ensureCityPoints('austin', info);
  parts.rendering.applyStatusToPoints(
    'austin',
    parts.model.parseStationStatus({
      data: {
        stations: [
          { station_id: 'a', num_bikes_available: 18, num_docks_available: 2 },
        ],
      },
    }),
  );
  const points = scene.added.find((host) => host.get(0)?.id?.id === 'austin:a');
  assert.ok(points instanceof Cesium.PointPrimitiveCollection);
  assert.equal(points.blendOption, Cesium.BlendOption.TRANSLUCENT);
  assert.equal(points.length, 2);
  const a = points.get(0);
  assert.match(a.id.set, /^bikeshare:\d+:stations$/);
  assert.equal(a.disableDepthTestDistance, 2500);
  assert.equal(a.outlineWidth, 1);
  assert.ok(
    a.color.equalsEpsilon(
      Cesium.Color.fromCssColorString('#00ff88').withAlpha(0.95),
      1e-9,
    ),
    'plenty of bikes: green, as before',
  );
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(
      a.position,
      Cesium.Cartesian3.fromDegrees(-97.74, 30.26, 2),
      0,
      1e-6,
    ),
  );
  assert.ok(
    Cesium.NearFarScalar.equals(
      a.scaleByDistance,
      new Cesium.NearFarScalar(200, 1.35, 130000, 0.4),
    ),
  );

  // Selected: its own dot goes, a cyan one over everything takes its place.
  parts.selection._selectStation('austin:a');
  const stations = scene.added.find(
    (host) => host.get(0)?.id?.set === a.id.set,
  );
  assert.equal(stations.get(0).show, false);
  const highlight = scene.added.find((host) =>
    host.get(0)?.id?.set?.endsWith(':selected'),
  );
  const dot = highlight.get(0);
  assert.ok(Cesium.Color.equals(dot.color, Cesium.Color.CYAN));
  assert.equal(dot.pixelSize, 14);
  assert.equal(dot.outlineWidth, 2);
  assert.equal(dot.disableDepthTestDistance, Infinity);
  parts.selection._clearSelection();
  parts.rendering.detachSets();
  assert.equal(scene.added.length, 0);
});

test('the traffic layer draws its dots as one point collection moved, added to and taken from in place on a viewer of its own', async (t) => {
  const { createState } = await import('../../layers/traffic/state.js');
  const { createStyle } = await import('../../layers/traffic/style.js');
  const { createModel } = await import('../../layers/traffic/model.js');
  const { createAnimation } = await import('../../layers/traffic/animation.js');
  const { JAM_DOT_FAR_SCALE } = await import('../../layers/traffic/policy.js');
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const { scene, draw } = drawOver();
  const state = createState({ services: {} });
  state._enabled = true;
  state._fadeScaleFar = 8000;
  state._fadeTransFar = 10000;
  state._dotSet = draw.points({ id: 'traffic:1:dots', blend: 'translucent' });
  const parts = {
    rendering: { removeHeatLines() {}, rebuildHeatLines() {} },
    retention: { easeHeights() {}, finishHeights() {}, clear() {} },
  };
  const context = {
    state,
    services: {
      render: { holdContinuousRender() {}, releaseContinuousRender() {} },
    },
    parts,
    source: {},
  };
  parts.style = createStyle(context);
  parts.model = createModel(context);
  parts.animation = createAnimation(context);
  parts.style.refreshBucketColors();
  const [road] = parts.model.parseRoads({
    roads: [
      {
        type: 'primary',
        oneway: 1,
        coordinates: [
          [-97.74, 30.26],
          [-97.737, 30.26],
        ],
      },
    ],
  });
  parts.animation.spawnDotsForRoad(road, 450, 3);
  const host = scene.added[0];
  assert.ok(host instanceof Cesium.PointPrimitiveCollection);
  assert.equal(host.blendOption, Cesium.BlendOption.TRANSLUCENT);
  assert.equal(host.length, 3, 'drawn as they join');
  const point = host.get(0);
  assert.equal(point.id.set, 'traffic:1:dots');
  assert.ok(
    Cesium.Color.equals(point.color, Cesium.Color.WHITE.withAlpha(0.85)),
    'the simulated white',
  );
  assert.equal(point.disableDepthTestDistance, 0);
  const before = Cesium.Cartesian3.clone(point.position);
  now += 500;
  parts.animation.animate();
  assert.equal(scene.added[0], host, 'moved where it is');
  assert.equal(host.get(0), point);
  assert.ok(!Cesium.Cartesian3.equals(point.position, before), 'it moves');
  assert.ok(
    Cesium.NearFarScalar.equals(
      point.scaleByDistance,
      new Cesium.NearFarScalar(100, 1.5, 8000, 0.3),
    ),
  );
  assert.ok(
    Cesium.NearFarScalar.equals(
      point.translucencyByDistance,
      new Cesium.NearFarScalar(100, 1, 10000, 0),
    ),
  );
  // What the style part changes on a dot reaches its point at the next
  // frame, on the point it has.
  const dot = state._dots[0];
  parts.style.paintDot(dot, 'jam');
  parts.style.emphasizeJamDot(dot);
  dot.point.outlineColor = Object.freeze([0, 0, 0, 0.5]);
  dot.point.outlineWidth = 2;
  now += 16;
  parts.animation.animate();
  assert.equal(host.get(0), point);
  assert.ok(
    Cesium.Color.equals(
      point.color,
      new Cesium.Color(...state._activeBucketColors.jam),
    ),
    'painted',
  );
  assert.ok(
    Cesium.NearFarScalar.equals(
      point.scaleByDistance,
      new Cesium.NearFarScalar(100, 1.5, 8000, JAM_DOT_FAR_SCALE),
    ),
    'emphasised',
  );
  assert.ok(
    Cesium.Color.equals(point.outlineColor, new Cesium.Color(0, 0, 0, 0.5)),
  );
  assert.equal(point.outlineWidth, 2);
  parts.style.showDot(dot, false);
  now += 16;
  parts.animation.animate();
  assert.equal(point.show, false, 'hidden');
  parts.style.showDot(dot, true);
  now += 16;
  parts.animation.animate();
  assert.equal(point.show, true);
  parts.animation.spawnDotsForRoad(road, 450, 2);
  assert.equal(scene.added[0], host, 'joined where it is');
  assert.equal(host.length, 5);
  // A dot that has faded out leaves the collection where it is, as the
  // retention part takes it.
  state._dotSet.remove([state._dots[0].point.id]);
  assert.equal(scene.added[0], host);
  assert.equal(state._dotSet.size(), 4);
  parts.animation.clearDots();
  state._dotSet.dispose();
  assert.equal(scene.added.length, 0);
});

test('a rebuilt set keeps its place among the scene primitives, and names its host', () => {
  const scene = fakeScene();
  scene.primitives = new Cesium.PrimitiveCollection();
  const { draw } = drawOver(scene);
  const below = scene.primitives.add(new Cesium.PrimitiveCollection());
  const set = draw.points({ id: 'kept' });
  set.set([]);
  const above = scene.primitives.add(new Cesium.PrimitiveCollection());
  const order = () => {
    const out = [];
    for (let i = 0; i < scene.primitives.length; i++) {
      const p = scene.primitives.get(i);
      out.push(p === below ? 'below' : p === above ? 'above' : p.drawSetId);
    }
    return out;
  };
  assert.deepEqual(order(), ['below', 'kept', 'above']);
  set.set([{ id: 'a', pos: { lon: 0, lat: 0 }, pixelSize: 4, color: '#fff' }]);
  set.upsert([
    { id: 'b', pos: { lon: 1, lat: 0 }, pixelSize: 4, color: '#fff' },
  ]);
  assert.deepEqual(
    order(),
    ['below', 'kept', 'above'],
    'not raised by updates',
  );

  set.dispose();
});

test('sets stack by drawOrder, a higher one earlier, ties as they were made', () => {
  const scene = fakeScene();
  scene.primitives = new Cesium.PrimitiveCollection();
  const { draw } = drawOver(scene);
  const below = scene.primitives.add(new Cesium.PrimitiveCollection());
  const order = () => {
    const out = [];
    for (let i = 0; i < scene.primitives.length; i++) {
      const p = scene.primitives.get(i);
      out.push(p === below ? 'below' : p.drawSetId);
    }
    return out;
  };
  const dot = { id: 'a', pos: { lon: 0, lat: 0 }, pixelSize: 4, color: '#fff' };
  const plain = draw.points({ id: 'plain' });
  plain.set([dot]);
  const between = scene.primitives.add(new Cesium.PrimitiveCollection());
  const high = draw.points({ id: 'high', drawOrder: 2 });
  high.set([dot]);
  const named = () =>
    order().map((n, i) =>
      scene.primitives.get(i) === between ? 'between' : n,
    );
  // Drawn first, so on top; the other primitives keep their places.
  assert.deepEqual(named(), ['below', 'high', 'between', 'plain']);
  assert.equal(high.size(), 1, 'not destroyed by the move');
  high.setOptions({ drawOrder: 0 });
  assert.deepEqual(
    named(),
    ['below', 'plain', 'between', 'high'],
    'back to 0, it takes its place by when it was made',
  );
  // All at 0, nothing is moved: what others stacked stays.
  scene.primitives.raiseToTop(below);
  const added = draw.points({ id: 'added' });
  added.set([dot]);
  assert.deepEqual(named(), ['plain', 'between', 'high', 'below', 'added']);
  for (const set of [high, plain, added]) set.dispose();
});

test('reordering by drawOrder leaves the other primitives where they are', () => {
  const scene = fakeScene();
  scene.primitives = new Cesium.PrimitiveCollection();
  const { draw } = drawOver(scene);
  const dot = { id: 'a', pos: { lon: 0, lat: 0 }, pixelSize: 4, color: '#fff' };
  const [a, b, c] = ['A', 'B', 'C'].map((id) => draw.points({ id }));
  const x = new Cesium.PrimitiveCollection();
  const y = new Cesium.PrimitiveCollection();
  c.set([dot]);
  scene.primitives.add(x);
  b.set([dot]);
  scene.primitives.add(y);
  a.set([dot]);
  const order = () => {
    const out = [];
    for (let i = 0; i < scene.primitives.length; i++) {
      const p = scene.primitives.get(i);
      out.push(p === x ? 'X' : p === y ? 'Y' : p.drawSetId);
    }
    return out;
  };
  assert.deepEqual(order(), ['C', 'X', 'B', 'Y', 'A']);
  a.setOptions({ drawOrder: 1 });
  assert.deepEqual(order(), ['A', 'X', 'B', 'Y', 'C']);
  assert.ok(!x.isDestroyed() && !y.isDestroyed());
  for (const set of [a, b, c]) set.dispose();
});

test('sprite layers stack flights on top, all under a set at the default order', () => {
  const scene = fakeScene();
  scene.primitives = new Cesium.PrimitiveCollection();
  const { draw } = drawOver(scene);
  const dot = { id: 'a', pos: { lon: 0, lat: 0 }, pixelSize: 4, color: '#fff' };
  // Made before every sprite set, and again after them.
  const highlight = draw.points({ id: 'highlight' });
  highlight.set([dot]);
  const sets = ['flights', 'cctv', 'ais', 'transit'].map((layerId) => {
    const set = draw.points({
      id: layerId,
      drawOrder: spriteDrawOrder(layerId),
    });
    set.set([dot]);
    return set;
  });
  const endpoint = draw.points({ id: 'endpoint' });
  endpoint.set([dot]);
  const order = [];
  for (let i = 0; i < scene.primitives.length; i++) {
    order.push(scene.primitives.get(i).drawSetId);
  }
  // Earlier draws on top.
  assert.deepEqual(order, [
    'highlight',
    'endpoint',
    'flights',
    'ais',
    'transit',
    'cctv',
  ]);
  // Raised above flights in place, CCTV keeps every other set's slot.
  sets[1].setOptions({ drawOrder: spriteDrawOrder('flights') + 0.5 });
  const after = [];
  for (let i = 0; i < scene.primitives.length; i++) {
    after.push(scene.primitives.get(i).drawSetId);
  }
  assert.deepEqual(after, [
    'highlight',
    'endpoint',
    'cctv',
    'flights',
    'ais',
    'transit',
  ]);
  for (const set of [highlight, endpoint, ...sets]) set.dispose();
});

test('changing an option rebuilds only the kinds that build it in, in their place', () => {
  const scene = fakeScene();
  scene.primitives = new Cesium.PrimitiveCollection();
  const { draw, frame } = drawOver(scene);
  const below = scene.primitives.add(new Cesium.PrimitiveCollection());
  const set = draw.shapes({ id: 'cells' });
  set.set([
    {
      id: 'a',
      geometry: {
        kind: 'rectangle',
        rect: { west: 0, south: 0, east: 1, north: 1 },
      },
      fill: [1, 0, 0, 0.3],
      height: 'clampGround',
    },
  ]);
  const above = scene.primitives.add(new Cesium.PrimitiveCollection());
  const order = () => {
    const out = [];
    for (let i = 0; i < scene.primitives.length; i++) {
      const p = scene.primitives.get(i);
      out.push(p === below ? 'below' : p === above ? 'above' : p.drawSetId);
    }
    return out;
  };
  // Every ground primitive the set's current host holds, made ready.
  const ready = () => {
    for (let i = 0; i < scene.primitives.length; i++) {
      const host = scene.primitives.get(i);
      if (host.drawSetId !== 'cells') continue;
      for (let j = 0; j < host.length; j++)
        if (host.get(j) instanceof Cesium.GroundPrimitive)
          Object.defineProperty(host.get(j), 'ready', { value: true });
    }
    frame();
  };
  ready();
  assert.deepEqual(order(), ['below', 'cells', 'above']);
  set.setOptions({ pickable: false });
  assert.deepEqual(order(), ['below', 'cells', 'above'], 'stopping picks');
  ready();
  set.setOptions({ pickable: true });
  assert.deepEqual(
    order(),
    ['below', 'cells', 'cells', 'above'],
    'the old ground waits beside the new, in the same place',
  );
  ready();
  assert.deepEqual(order(), ['below', 'cells', 'above'], 'picking again');
  set.dispose();

  // Kinds that do not build an option in are not rebuilt for it.
  const hostOf = (id) => {
    for (let i = 0; i < scene.primitives.length; i++)
      if (scene.primitives.get(i).drawSetId === id)
        return scene.primitives.get(i);
    return null;
  };
  const dots = draw.points({ id: 'dots' });
  dots.set([{ id: 'a', pos: { lon: 0, lat: 0 }, pixelSize: 4, color: '#fff' }]);
  const dotsHost = hostOf('dots');
  dots.setOptions({ pickable: false });
  assert.equal(hostOf('dots'), dotsHost, 'points do not build in picks');
  dots.setOptions({ blend: 'opaque' });
  assert.notEqual(hostOf('dots'), dotsHost, 'points build in their blend');
  dots.dispose();
  const kept = draw.shapes({ id: 'kept' });
  kept.set([]);
  const keptHost = hostOf('kept');
  kept.setOptions({ blend: 'opaque' });
  assert.equal(hostOf('kept'), keptHost, 'shapes do not build in a blend');
  kept.dispose();
  // Models are not loaded again for any of them.
  const fromGltf = Cesium.Model.fromGltfAsync;
  let loads = 0;
  Cesium.Model.fromGltfAsync = () => {
    loads += 1;
    return new Promise(() => {});
  };
  try {
    const models = draw.models({ id: 'models' });
    models.set([
      {
        id: 'm',
        pos: { lon: 0, lat: 0 },
        url: 'model.glb',
        orientation: { heading: 0, pitch: 0, roll: 0 },
      },
    ]);
    models.setOptions({ pickable: false, blend: 'opaque', clampTo: 'terrain' });
    assert.equal(loads, 1, 'a model is loaded once');
    models.dispose();
  } finally {
    Cesium.Model.fromGltfAsync = fromGltf;
  }
});

test('restyling or moving unclamped points changes them in place; a new clamped one rebuilds', () => {
  const { scene, draw } = drawOver();
  const set = draw.points({ id: 'restyled', blend: 'translucent' });
  const dot = (id, lon, extra = {}) => ({
    id,
    pos: { lon, lat: 0, height: 2 },
    pixelSize: 6,
    color: [1, 0, 0, 1],
    ...extra,
  });
  set.set([dot('a', 0), dot('b', 1)]);
  const [host] = scene.added;
  const a = host.get(0);
  set.upsert([
    dot('a', 0, { color: [0, 1, 0, 1], pixelSize: 9, show: false, meta: 7 }),
  ]);
  assert.equal(scene.added[0], host, 'the same collection');
  assert.equal(host.get(0), a, 'the same point');
  assert.ok(Cesium.Color.equals(a.color, Cesium.Color.LIME));
  assert.equal(a.pixelSize, 9);
  assert.equal(a.show, false);
  assert.equal(a.id.meta, 7, 'picks read the new meta');
  assert.equal(set.size(), 2);

  const b = host.get(1);
  set.upsert([dot('b', 2)]);
  assert.equal(scene.added[0], host, 'moved: the same collection');
  assert.equal(host.get(1), b, 'the same point');
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(
      b.position,
      Cesium.Cartesian3.fromDegrees(2, 0, 2),
      1e-6,
    ),
    'where it now is',
  );
  // Clamped now: a billboard dot, so rebuilt.
  set.upsert([dot('b', 2, { height: 'clampGround' })]);
  assert.notEqual(scene.added[0], host, 'clamped: rebuilt');
  set.upsert([dot('b', 2)]);
  const rebuilt = scene.added[0];
  set.upsert([dot('c', 3)]);
  assert.equal(set.size(), 3);
  assert.equal(scene.added[0], rebuilt, 'a new unclamped item joins');
  assert.equal(scene.added[0].length, 3);
  set.upsert([dot('d', 4, { height: 'clampGround' })]);
  assert.notEqual(scene.added[0], rebuilt, 'a new clamped item rebuilds');
  set.dispose();
});

test('unclamped points join and leave their collection in place, and keep what height queries see through', () => {
  const { scene, draw, frame } = drawOver();
  const part = unboundDrawPart(draw);
  const set = draw.points({ id: 'population', blend: 'translucent' });
  const dot = (id, lon) => ({
    id,
    pos: { lon, lat: 0, height: 2 },
    pixelSize: 6,
    color: [1, 0, 0, 1],
  });
  set.upsert([dot('a', 0)]);
  const host = scene.added[0];
  assert.equal(host.length, 1, 'an empty set takes its first point in place');
  assert.equal(host.blendOption, Cesium.BlendOption.TRANSLUCENT);
  set.upsert([dot('b', 1), dot('c', 2)]);
  assert.equal(scene.added[0], host);
  assert.equal(host.length, 3);
  const ids = () => part.sets.get('population').pickIds.map((pick) => pick.id);
  assert.deepEqual(ids(), ['a', 'b', 'c']);
  let version = part.version();
  set.upsert([dot('b', 5)]);
  assert.equal(part.version(), version, 'moved: the same pick ids');
  set.remove(['a', 'zz']);
  assert.equal(scene.added[0], host, 'removed where it is');
  assert.ok(part.version() > version, 'removed: pick ids changed');
  frame();
  assert.equal(host.length, 2);
  assert.deepEqual(ids(), ['b', 'c']);
  assert.equal(set.size(), 2);
  version = part.version();
  set.upsert([dot('a', 0)]);
  assert.ok(part.version() > version, 'added: pick ids changed');
  assert.deepEqual(ids(), ['b', 'c', 'a']);
  // A new id sent twice is drawn once, as the last one.
  set.upsert([
    { ...dot('n', 6), meta: 'first' },
    { ...dot('n', 6), meta: 'last' },
  ]);
  const picks = part.sets.get('population').pickIds;
  assert.deepEqual(
    picks.filter((pick) => pick.id === 'n').map((pick) => pick.meta),
    ['last'],
  );
  set.dispose();
});

test('a point moved in place sets only the members of its look that changed', () => {
  const { scene, draw } = drawOver();
  const set = draw.points({ id: 'per-frame' });
  const item = {
    id: 'a',
    pos: { x: 6378137, y: 0, z: 0 },
    pixelSize: 4,
    color: [1, 1, 1, 0.85],
    scaleByDistance: { near: 100, nearValue: 1.5, far: 9000, farValue: 0.3 },
    fadeByDistance: { near: 100, nearValue: 1, far: 9000, farValue: 0 },
  };
  set.upsert([item]);
  const point = scene.added[0].get(0);
  const written = [];
  for (const key of ['color', 'scaleByDistance', 'translucencyByDistance'])
    Object.defineProperty(point, key, {
      set: () => written.push(key),
      get: () => undefined,
    });
  item.pos.y = 10;
  item.pixelSize = 2;
  set.upsert([item]);
  assert.deepEqual(written, [], 'nothing made anew for an unchanged look');
  assert.equal(point.pixelSize, 2);
  assert.equal(point.position.y, 10);
  item.color = [1, 0, 0, 1];
  item.scaleByDistance = { ...item.scaleByDistance, far: 12000 };
  set.upsert([item]);
  assert.deepEqual(written, ['color', 'scaleByDistance']);
  // A colour changed in the caller's own array still reads as changed.
  item.color[1] = 1;
  set.upsert([item]);
  assert.deepEqual(written, ['color', 'scaleByDistance', 'color']);
  // A frozen colour or curve is kept as it is, and told unchanged by
  // identity; an equal one sent anew still sets nothing.
  item.color = Object.freeze([0, 0, 1, 1]);
  set.upsert([item]);
  set.upsert([item]);
  item.color = Object.freeze([0, 0, 1, 1]);
  set.upsert([item]);
  assert.deepEqual(written, ['color', 'scaleByDistance', 'color', 'color']);
  // A frozen curve read through a getter can change, so it is copied and
  // compared by value.
  let farValue = 0.3;
  item.scaleByDistance = Object.freeze(
    Object.defineProperties(
      {},
      {
        near: { value: 100, enumerable: true },
        nearValue: { value: 1.5, enumerable: true },
        far: { value: 12000, enumerable: true },
        farValue: { get: () => farValue, enumerable: true },
      },
    ),
  );
  set.upsert([item]);
  const writes = written.length;
  set.upsert([item]);
  assert.equal(written.length, writes, 'unchanged');
  farValue = 0.8;
  set.upsert([item]);
  assert.equal(written.at(-1), 'scaleByDistance', 'the change is seen');
  set.dispose();
});

test('a position object changed and sent again moves its point', () => {
  const { scene, draw } = drawOver();
  const set = draw.points({ id: 'moved-in-place' });
  const item = {
    id: 'a',
    pos: { lon: 0, lat: 0 },
    pixelSize: 4,
    color: '#fff',
  };
  set.set([item]);
  const host = scene.added[0];
  item.pos.lon = 90;
  set.upsert([item]);
  assert.equal(scene.added[0], host, 'moved where it is');
  const at = Cesium.Cartographic.fromCartesian(scene.added[0].get(0).position);
  assert.ok(Math.abs(Cesium.Math.toDegrees(at.longitude) - 90) < 1e-9);
  set.dispose();
});

test('a point moved in place is horizon culled where it now is', () => {
  const { scene, draw, frame } = drawOver();
  const set = draw.points({ id: 'culled-moving', horizonCull: true });
  const dot = (lon) => ({
    id: 'a',
    pos: { lon, lat: 0, height: 10 },
    pixelSize: 4,
    color: '#fff',
  });
  // The eye is over lon 0.
  set.set([dot(0)]);
  const point = scene.added[0].get(0);
  frame();
  assert.equal(point.show, true, 'under the eye');
  set.upsert([dot(180)]);
  assert.equal(scene.added[0].get(0), point, 'the same point');
  assert.equal(
    point.show,
    false,
    'hidden at once, as a frame listener moving it after the cull needs',
  );
  frame();
  assert.equal(point.show, false, 'past the horizon');
  set.upsert([dot(1)]);
  assert.equal(point.show, true, 'shown at once');
  frame();
  assert.equal(point.show, true, 'back in view');
  set.dispose();
});

test('an icon moved in place past the horizon is hidden at once', () => {
  const { scene, draw, frame } = drawOver();
  const set = draw.icons({ id: 'culled-icons', horizonCull: true });
  const icon = (lon) => ({
    id: 'a',
    pos: { lon, lat: 0, height: 10 },
    image: { svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
    size: [8, 8],
  });
  // The eye is over lon 0.
  set.set([icon(0)]);
  frame();
  const billboard = scene.added[0].get(0);
  assert.equal(billboard.show, true, 'under the eye');
  set.upsert([icon(180)]);
  assert.equal(scene.added[0].get(0), billboard, 'the same billboard');
  assert.equal(billboard.show, false, 'past the horizon, before a frame');
  set.upsert([icon(1)]);
  assert.equal(billboard.show, true);
  set.dispose();
});

test('points show only within their display range', () => {
  const { scene, draw } = drawOver();
  const set = draw.points({ id: 'ranged' });
  const dot = (id, extra = {}) => ({
    id,
    pos: { lon: 0, lat: 0 },
    pixelSize: 4,
    color: '#fff',
    ...extra,
  });
  set.set([
    dot('near', { displayRange: [0, 2e6] }),
    dot('empty', { displayRange: [5, 5] }),
    dot('clamped', { displayRange: [0, 1e3], height: 'clampGround' }),
  ]);
  const [host] = scene.added;
  const points = host.get(0);
  const dots = host.get(1);
  const near = points.get(0);
  assert.equal(near.distanceDisplayCondition.near, 0);
  assert.equal(near.distanceDisplayCondition.far, 2e6);
  assert.equal(points.get(1).show, false, 'an empty range shows nowhere');
  assert.equal(points.get(1).distanceDisplayCondition, undefined);
  assert.equal(dots.get(0).distanceDisplayCondition.far, 1e3, 'clamped too');
  // Changed and dropped in place.
  set.upsert([dot('near', { displayRange: [10, 20] })]);
  assert.equal(points.get(0), near);
  assert.equal(near.distanceDisplayCondition.far, 20);
  set.upsert([dot('near')]);
  assert.equal(near.distanceDisplayCondition, undefined, 'dropped');
  set.upsert([dot('empty')]);
  assert.equal(points.get(1).show, true, 'no range shows it');
  set.dispose();
});

test('the fire perimeters layer draws holed ground fills and draped fire lines on a viewer of its own', async () => {
  const { createFirePerimetersLayer } =
    await import('../../layers/perimeters/index.js');
  const scene = fakeScene();
  const viewer = { scene };
  const outer = [
    [-108.1, 35.2],
    [-108.0, 35.2],
    [-108.0, 35.3],
    [-108.1, 35.2],
  ];
  const hole = [
    [-108.08, 35.22],
    [-108.02, 35.22],
    [-108.02, 35.25],
    [-108.08, 35.22],
  ];
  const layer = createFirePerimetersLayer({
    source: {
      getSnapshot: async () => [
        { stableId: 'a', containedPct: 0, polygons: [[outer, hole]] },
      ],
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  const all = (host, out = []) => {
    out.push(host);
    if (host instanceof Cesium.PrimitiveCollection)
      for (let i = 0; i < host.length; i++) all(host.get(i), out);
    return out;
  };
  const primitives = scene.added.flatMap((host) => all(host));
  const of = (type) => primitives.filter((p) => p instanceof type);
  const [fill] = of(Cesium.GroundPrimitive);
  assert.equal(fill.classificationType, Cesium.ClassificationType.BOTH);
  const [instance] = fill.geometryInstances;
  assert.equal(instance.id.id, 'fire-perimeter:a:0');
  assert.equal(instance.geometry._polygonHierarchy.holes.length, 1);
  const [line] = of(Cesium.GroundPolylinePrimitive);
  assert.equal(line.classificationType, Cesium.ClassificationType.BOTH);
  assert.equal(line.geometryInstances.length, 1, 'the exterior ring only');
  assert.equal(line.geometryInstances[0].geometry.width, 2);
  assert.equal(line.geometryInstances[0].id.id, 'fire-perimeter:a:0');
  layer.destroy();
  assert.equal(scene.added.length, 0);
});

test('the GNSS layer draws its cells as ground fills that stay out of the pick pass', async (t) => {
  const { createGnssIntegrityLayer } =
    await import('../../layers/gnss/index.js');
  const scene = fakeScene();
  const viewer = { scene };
  const row = (hex, lat, degraded) => ({
    hex,
    lat,
    lon: 30.2,
    nic: degraded ? 0 : 8,
    nacp: degraded ? 0 : 10,
    gpsLost: false,
    degraded,
  });
  const layer = createGnssIntegrityLayer({
    source: {
      getSnapshot: async () => ({
        ageMs: 0,
        rows: [row('a1', 50.1, true), row('a2', 50.1, true), row('a3', 50.2)],
      }),
    },
    viewAnchor: () => ({ latitude: 50, longitude: 30 }),
  });
  layer.init(viewer);
  layer.enable();
  assert.equal(await layer.update(), true);
  const host = scene.added[0];
  const grounds = [];
  for (let i = 0; i < host.length; i++)
    if (host.get(i) instanceof Cesium.GroundPrimitive)
      grounds.push(host.get(i));
  assert.equal(grounds.length, 1);
  const [fill] = grounds;
  assert.equal(fill.allowPicking, false);
  assert.equal(fill.classificationType, Cesium.ClassificationType.BOTH);
  const [instance] = fill.geometryInstances;
  // An H3 hexagon, drawn as a polygon.
  assert.ok(instance.geometry instanceof Cesium.PolygonGeometry);
  assert.equal(instance.id.id, 'gnss-integrity:841e631ffffffff');
  // A ground primitive draws its stencil in the pick pass even unpickable,
  // erasing picks of ground geometry under it; these skip that pass.
  let updates = 0;
  t.mock.method(Cesium.GroundPrimitive.prototype, 'update', () => updates++);
  fill.update({ passes: { pick: true } });
  assert.equal(updates, 0);
  fill.update({ passes: { render: true, pick: false } });
  assert.equal(updates, 1);
  t.mock.restoreAll();
  layer.destroy();
  assert.equal(scene.added.length, 0);
});

test('the context layer draws its static range ring as a haloed line on a viewer of its own', async () => {
  const { createRendering } =
    await import('../../layers/awareness/rendering.js');
  const { createState } = await import('../../layers/awareness/state.js');
  withImageClasses(() => {
    // A viewer whose scene keeps no Cesium primitive collection of its own
    // (this double's `primitives`) gets the ring without its pulses.
    const { scene } = drawOver();
    const state = createState({ services: {} });
    state.viewer = { scene };
    const rendering = createRendering({
      state,
      services: {
        geometry: {},
        render: { governorRequestRender() {} },
      },
      parts: {},
    });
    const subject = (lon) => ({
      layerId: 'military',
      id: 'a',
      position: Cesium.Cartesian3.fromDegrees(lon, 0, 9000),
    });
    rendering.renderVisual(subject(0));
    const linesOf = (from = scene) => {
      const [host] = from.added;
      const lines = [];
      if (!host) return lines;
      // Lines that never settle are drawn by the collection alone.
      const collections =
        host instanceof Cesium.PolylineCollection
          ? [host]
          : Array.from({ length: host.length }, (_, i) => host.get(i));
      for (const collection of collections) {
        if (!(collection instanceof Cesium.PolylineCollection)) continue;
        for (let j = 0; j < collection.length; j++)
          lines.push(collection.get(j));
      }
      return lines.sort((x, y) => y.width - x.width);
    };
    const [core] = linesOf();
    assert.equal(linesOf().length, 1, 'one line, its halo its outline');
    assert.equal(core.width, 4);
    assert.equal(core.material.type, 'PolylineOutline');
    assert.equal(core.material.uniforms.outlineWidth, 1);
    assert.ok(
      core.material.uniforms.color.equalsEpsilon(
        Cesium.Color.fromCssColorString('rgba(98, 181, 255, 0.95)'),
        1e-9,
      ),
    );
    assert.ok(
      core.material.uniforms.outlineColor.equalsEpsilon(
        Cesium.Color.fromCssColorString('rgba(4, 12, 16, 0.8)'),
        1e-9,
      ),
    );
    // A closed ring 250 km from the subject's ground point, 2.5 km up.
    const ground = Cesium.Cartesian3.fromDegrees(0, 0, 2_500);
    assert.equal(core.positions.length, 129);
    for (const position of core.positions) {
      const away = Cesium.Cartesian3.distance(ground, position);
      assert.ok(Math.abs(away - 250_000) < 2_000, `${away}`);
      assert.ok(
        Math.abs(Cesium.Cartographic.fromCartesian(position).height - 2_500) <
          1,
      );
    }
    // Small moves keep the ring; one past 250 m moves it.
    const first = Cesium.Cartesian3.clone(core.positions[0]);
    rendering.renderVisual(subject(0.001));
    assert.ok(Cesium.Cartesian3.equals(linesOf()[0].positions[0], first));
    rendering.renderVisual(subject(0.01));
    assert.ok(!Cesium.Cartesian3.equals(linesOf()[0].positions[0], first));
    // Re-initialized on another viewer, the same subject's ring moves there.
    const other = drawOver().scene;
    state.viewer = { scene: other };
    rendering.renderVisual(subject(0.01));
    assert.equal(scene.added.length, 0, 'gone from the old viewer');
    assert.equal(linesOf(other).length, 1, 'drawn on the new one');
    rendering.clearVisual();
    assert.equal(linesOf(other).length, 0);
    rendering.disposeVisual();
    assert.equal(other.added.length, 0);
  });
});

test('the installations layer draws its named markers as outlined point primitives on a viewer of its own', async () => {
  const { createNamedMarkers, namedPointId } =
    await import('../../layers/installations/namedMarkers.js');
  const scene = fakeScene();
  scene.canvas = { clientWidth: 800, clientHeight: 600 };
  const viewer = { scene };
  const state = { viewer, enabled: false, selectedId: null };
  const markers = createNamedMarkers({
    state,
    services: { render: { governorRequestRender() {} } },
    parts: {
      model: { colorFor: () => [1, 165 / 255, 0, 1] },
      rendering: { installationSurfaceHeightM: () => 40 },
    },
    overlayHost: { setEntries() {}, clearSource() {}, setVisible() {} },
  });
  const records = [
    {
      id: 'a',
      name: 'A',
      namedArea: true,
      areaM2: 2,
      latitude: 30,
      longitude: -97,
      pointOnly: false,
    },
    {
      id: 'b',
      name: 'B',
      namedArea: true,
      areaM2: 1,
      latitude: 31,
      longitude: -98,
      pointOnly: true,
    },
  ];
  markers.sync(records);
  const host = scene.added.find((h) => h.get?.(0)?.id?.set === markers.setId);
  assert.ok(host instanceof Cesium.PointPrimitiveCollection);
  assert.equal(host.show, false, 'hidden while the layer is off');
  assert.equal(host.length, 2);
  const a = host.get(0);
  assert.equal(a.id.id, namedPointId('a'));
  assert.deepEqual(a.id.meta, { installationId: 'a' });
  assert.equal(a.pixelSize, 7);
  assert.equal(a.outlineWidth, 1);
  assert.ok(Cesium.Color.equals(a.outlineColor, Cesium.Color.BLACK));
  assert.ok(Cesium.Color.equals(a.color, new Cesium.Color(1, 165 / 255, 0, 1)));
  assert.equal(a.disableDepthTestDistance, Infinity);
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(
      a.position,
      Cesium.Cartesian3.fromDegrees(-97, 30, 40),
      0,
      1e-6,
    ),
  );
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(
      host.get(1).position,
      Cesium.Cartesian3.fromDegrees(-98, 31, 0),
      0,
      1e-6,
    ),
    'a point-only site sits on the ellipsoid',
  );
  // Selecting a drawn site restyles nothing that moves: the points stay.
  state.selectedId = 'b';
  markers.sync(records);
  assert.equal(scene.added.includes(host), true);
  assert.equal(host.get(0), a);
  // A selected site that is not a named area draws no point.
  state.selectedId = 'c';
  markers.sync([
    ...records,
    {
      id: 'c',
      name: 'C',
      areaM2: 3,
      latitude: 32,
      longitude: -99,
      pointOnly: true,
    },
  ]);
  const rebuilt = scene.added.find(
    (h) => h.get?.(0)?.id?.set === markers.setId,
  );
  const c = [0, 1, 2]
    .map((i) => rebuilt.get(i))
    .find((p) => p.id.id === namedPointId('c'));
  assert.equal(c.show, false);
  markers.destroy();
  assert.equal(scene.added.includes(host), false);
});

test('the installations layer draws its site dots, outlines and selected dot on a viewer of its own', async () => {
  const { createRendering } =
    await import('../../layers/installations/rendering.js');
  const scene = fakeScene();
  const viewer = { scene };
  const record = (id, lon) => ({
    id,
    name: `Site ${id}`,
    class: 'base',
    latitude: 30,
    longitude: lon,
    namedArea: false,
    outlineLines: [
      [
        [lon, 30],
        [lon + 0.01, 30],
      ],
    ],
  });
  const records = [record('a', -97), record('b', -98)];
  const state = {
    viewer,
    enabled: true,
    selectedId: null,
    records,
    recordById: new Map(records.map((r) => [r.id, r])),
    renderedKeys: new Map(),
  };
  const noop = () => {};
  const rendering = createRendering({
    state,
    services: {
      ground: { floorAltitudeM: () => 0, cachedGroundFloor: () => 0 },
      anchors: {},
      render: { governorRequestRender: noop },
      context: {
        registerEntityContext: noop,
        removeEntityContextsForLayer: noop,
        selectEntityContext: noop,
        getSelectedEntityContext: () =>
          state.selectedId ? { id: state.selectedId } : null,
        clearSelectedEntityContextForLayer: noop,
      },
    },
    parts: {
      model: {
        colorFor: (r, alpha = 1) => [1, 165 / 255, 0, alpha],
        installationSourceLabel: () => 'OpenStreetMap',
      },
    },
  });
  rendering.attach(viewer);
  rendering.renderRecords();
  const billboards = (setId) => {
    const out = [];
    const visit = (node) => {
      for (let i = 0; i < (node?.length ?? 0); i += 1) {
        const child = node.get(i);
        if (child?.id?.set === setId) out.push(child);
        else if (typeof child?.get === 'function') visit(child);
      }
    };
    for (const host of scene.added)
      if (host.id?.set === setId) out.push(host);
      else visit(host);
    return out;
  };
  const dotsId = state.sets.dots.id;
  const dots = billboards(dotsId);
  assert.equal(dots.length, 2);
  assert.ok(dots.every((dot) => dot instanceof Cesium.Billboard));
  assert.ok(
    dots.every(
      (dot) => dot.heightReference === Cesium.HeightReference.CLAMP_TO_GROUND,
    ),
  );
  assert.ok(dots.every((dot) => dot.id.meta?.installationId));
  // Selecting a site hides its dot where it is and draws the selected one
  // in its own set: no other dot is drawn again.
  state.selectedId = 'b';
  rendering.renderRecords();
  const after = billboards(dotsId);
  assert.equal(after.length, 2);
  assert.ok(
    after.every((dot, i) => dot === dots[i]),
    'the same billboards',
  );
  assert.equal(after.find((dot) => dot.id.id === 'b').show, false);
  assert.equal(after.find((dot) => dot.id.id === 'a').show, true);
  const [selected] = billboards(state.sets.selected.id);
  assert.ok(selected instanceof Cesium.Billboard);
  assert.equal(selected.id.id, 'b');
  assert.equal(selected.id.meta, dots.find((dot) => dot.id.id === 'b').id.meta);
  rendering.detach();
  assert.equal(scene.added.length, 0, 'gone with the layer');
});

test('the satellites layer draws its dots as one point collection and its rings as depth-fail primitives out of picks', async () => {
  const { createRendering } =
    await import('../../layers/satellites/rendering.js');
  const { POINT_STYLES, TRACKED_ORBIT_COLOR } =
    await import('../../layers/satellites/policy.js');
  const scene = fakeScene();
  const viewer = { scene };
  const state = {
    now: Date.now,
    _points: new Map(),
    _orbitPaths: new Map(),
    _catalog: new Map([[25544, { satrec: {} }]]),
    _viewer: viewer,
    _trackedNorad: null,
    _enabled: false,
  };
  const ring = [
    { x: 7e6, y: 0, z: 0 },
    { x: 0, y: 7e6, z: 0 },
    { x: -7e6, y: 0, z: 0 },
  ];
  const rendering = createRendering({
    state,
    services: { focus: {} },
    parts: { orbits: { computeOrbitPath: () => ring } },
  });
  rendering._attach(viewer);
  rendering._addPoint(25544, { x: 7e6, y: 0, z: 0 }, POINT_STYLES.iss);
  rendering._addPoint(5, { x: 0, y: 7e6, z: 0 }, POINT_STYLES.visual);
  rendering._preRenderTick({ frame: 1 });
  const points = scene.added.find(
    (host) => host instanceof Cesium.PointPrimitiveCollection,
  );
  assert.equal(points.length, 2);
  const iss = points.get(0);
  assert.equal(iss.id.id, '25544');
  assert.deepEqual(iss.id.meta, { noradId: 25544 });
  assert.equal(iss.pixelSize, 12);
  assert.equal(iss.scaleByDistance.nearValue, 1.5);
  assert.equal(iss.scaleByDistance.far, 2e7);
  // Moved in place, both in one write.
  rendering._movePoint(25544, { x: 6.9e6, y: 0, z: 0 });
  rendering._movePoint(5, { x: 0, y: 6.9e6, z: 0 });
  rendering._preRenderTick({ frame: 2 });
  assert.equal(points.get(0), iss);
  assert.equal(iss.position.x, 6.9e6);

  withImageClasses(() => rendering._showOrbitPath(25544, TRACKED_ORBIT_COLOR));
  const all = (host) =>
    host instanceof Cesium.PrimitiveCollection
      ? Array.from({ length: host.length }, (_, i) => all(host.get(i))).flat()
      : [host];
  const primitive = scene.added
    .flatMap(all)
    .find(
      (host) => host instanceof Cesium.Primitive && host.depthFailAppearance,
    );
  assert.ok(primitive, 'a ring with a dimmed part behind the globe');
  assert.equal(primitive.allowPicking, false, 'ring clicks fall through');
  rendering._detach(viewer);
  assert.equal(scene.added.length, 0, 'gone with the layer');
});

test('the ALPR layer draws its badges as icons that follow the ground, restyled in place', async () => {
  const { alprMarkers, createAlprMarkerSet } =
    await import('../../layers/alpr/markerState.js');
  const { MARKER_IMAGE, SELECTED_IMAGE } =
    await import('../../layers/alpr/visuals.js');
  const scene = fakeScene();
  const part = createCesiumDraw({
    scene,
    report: (error) => assert.fail(error),
  });
  const markers = createAlprMarkerSet();
  markers.attach(part.port.icons({ id: 'alpr-cameras:1:markers' }));
  const place = (id, lon, clamped) => {
    const carrier = markers.add(id);
    Object.assign(alprMarkers.write(carrier), {
      position: Cesium.Cartesian3.fromDegrees(lon, 30, clamped ? 0 : 150),
      clamped,
    });
    return carrier;
  };
  const a = place('alpr:a', -97, true);
  place('alpr:b', -97.01, false);
  markers.flush();
  const [host] = scene.added;
  assert.ok(host instanceof Cesium.BillboardCollection);
  assert.equal(host.length, 2);
  const badge = host.get(0);
  assert.equal(badge.id.id, 'alpr:a');
  assert.equal(badge.id.set, 'alpr-cameras:1:markers');
  assert.equal(badge.heightReference, Cesium.HeightReference.CLAMP_TO_GROUND);
  assert.equal(
    host.get(1).heightReference,
    Cesium.HeightReference.NONE,
    'a marker on its floor sits at its height',
  );
  assert.equal(badge.image, MARKER_IMAGE);
  assert.equal(badge.width, 38);
  assert.equal(badge.disableDepthTestDistance, Infinity);
  assert.ok(
    Cesium.NearFarScalar.equals(
      badge.scaleByDistance,
      new Cesium.NearFarScalar(500, 1.15, 40000, 0.45),
    ),
  );

  // Selection swaps the image on the same billboard: no blink.
  alprMarkers.write(a).selected = true;
  markers.changed(a);
  markers.flush();
  assert.equal(scene.added[0], host);
  assert.equal(host.get(0), badge);
  assert.equal(badge.image, SELECTED_IMAGE);
  assert.equal(badge.width, 60);

  // Under a canvas badge: a faint pick target at the canvas anchor.
  const anchor = Cesium.Cartesian3.fromDegrees(-97, 30, 172);
  Object.assign(alprMarkers.write(a), {
    canvasOwned: true,
    canvasPosition: anchor,
  });
  markers.changed(a);
  markers.flush();
  assert.equal(host.get(0), badge, 'still the same billboard');
  assert.equal(badge.color.alpha, 0.01);
  assert.equal(badge.heightReference, Cesium.HeightReference.NONE);
  assert.equal(badge.scaleByDistance, undefined);
  assert.ok(Cesium.Cartesian3.equalsEpsilon(badge.position, anchor, 0, 1e-6));

  // A marker that arrives later joins the same collection.
  place('alpr:c', -97.02, false);
  markers.flush();
  assert.equal(scene.added[0], host, 'appended, not rebuilt');
  assert.equal(host.get(0), badge);
  assert.equal(host.length, 3);

  markers.remove(['alpr:b']);
  assert.equal(scene.added[0], host);
  assert.equal(host.length, 2);
  markers.dispose();
  assert.equal(scene.added.length, 0);
});

/** Run `fn` with the image classes Cesium's materials test uniforms against. */
function withImageClasses(fn) {
  const names = [
    'HTMLCanvasElement',
    'HTMLImageElement',
    'ImageBitmap',
    'OffscreenCanvas',
  ];
  const real = names.map((name) => globalThis[name]);
  for (const name of names) globalThis[name] ??= class {};
  try {
    return fn();
  } finally {
    names.forEach((name, i) => (globalThis[name] = real[i]));
  }
}

test('lines that change only whether they show, or where an undraped one runs, change in place', () =>
  withImageClasses(() => {
    const { scene, draw, frame } = drawOver();
    const set = draw.lines({ id: 'patched' });
    const draped = (id, show = true, meta) => ({
      id,
      positions: [
        { lon: 0, lat: 0 },
        { lon: 1, lat: 1 },
      ],
      widthPx: 2.5,
      mode: 'draped',
      style: { kind: 'solid', color: '#7fe6ed' },
      show,
      meta,
    });
    const stem = (id, height, show = true) => ({
      id,
      positions: [
        Cesium.Cartesian3.fromDegrees(0, 0, 0),
        Cesium.Cartesian3.fromDegrees(0, 0, height),
      ],
      widthPx: 2,
      mode: '3d',
      style: { kind: 'solid', color: [1, 1, 1, 0.5] },
      show,
      meta: height,
    });
    const attributes = new Map();
    const fakeAttributes = (ground) => {
      ground.getGeometryInstanceAttributes = (id) => {
        if (!attributes.has(id.id))
          attributes.set(id.id, { show: new Uint8Array([1]) });
        return attributes.get(id.id);
      };
    };
    set.set([draped('a'), draped('b'), stem('s', 100)]);
    const host = scene.added[0];
    const ground = host.get(1);
    fakeAttributes(ground);
    // Still building: the show waits for the ground, and the build goes on.
    set.upsert([draped('a', false)]);
    assert.equal(scene.added[0], host, 'not rebuilt while its ground builds');
    assert.equal(attributes.size, 0);
    Object.defineProperty(ground, 'ready', { value: true });
    frame();
    assert.deepEqual([...attributes.get('a').show], [0], 'shown once ready');
    set.upsert([draped('b', false)]);
    assert.equal(scene.added[0], host, 'changed in place once ready');
    assert.deepEqual([...attributes.get('b').show], [0]);
    set.upsert([draped('b', true, 'new')]);
    assert.deepEqual([...attributes.get('b').show], [1]);
    const [, idB] = ground.geometryInstances.map((instance) => instance.id);
    assert.equal(idB.meta, 'new', 'picks read the new meta');
    // An undraped line moves and hides in place, and keeps its new meta.
    // Beside the collection, a static batch once the set settles.
    const line = host.get(0).get(0).get(0);
    set.upsert([stem('s', 2500, false)]);
    assert.equal(scene.added[0], host);
    assert.equal(host.get(0).get(0).get(0), line);
    assert.equal(line.show, false);
    assert.equal(line.id.meta, 2500);
    assert.ok(
      Cesium.Cartesian3.equalsEpsilon(
        line.positions[1],
        Cesium.Cartesian3.fromDegrees(0, 0, 2500),
        1e-6,
      ),
    );
    // One item that cannot change in place rebuilds them all, and patches
    // none of the others first.
    set.upsert([
      draped('a'),
      {
        ...draped('b'),
        positions: [
          { lon: 0, lat: 0 },
          { lon: 2, lat: 2 },
        ],
      },
    ]);
    assert.deepEqual([...attributes.get('a').show], [0], 'not patched');
    assert.notEqual(scene.added.at(-1), host, 'a draped line that moves');
    const moved = scene.added.at(-1);
    set.upsert([{ ...stem('s', 2500), widthPx: 3 }]);
    assert.notEqual(scene.added.at(-1), moved, 'a line that looks different');
    // A ground primitive gone from under the set rebuilds too.
    const third = scene.added.at(-1);
    third.get(1).destroy();
    set.upsert([draped('a', false)]);
    assert.notEqual(scene.added.at(-1), third, 'its ground destroyed');
    set.dispose();
  }));

/** A solid 3D stem for the settling tests. */
const settleStem = (id, height, extra = {}) => ({
  id,
  positions: [
    Cesium.Cartesian3.fromDegrees(0, 0, 0),
    Cesium.Cartesian3.fromDegrees(0, 0, height),
  ],
  widthPx: 2,
  mode: '3d',
  style: { kind: 'solid', color: [1, 0, 0, 1] },
  meta: height,
  ...extra,
});

/**
 * A line set over a fake scene with what the settling tests read: its
 * host, the polyline collection, the static batches beside it, frames to
 * settle, and a batch's build finished, its instance attributes kept per
 * batch as a built primitive keeps them.
 */
function settlingSet(id = 'stems') {
  const { scene, draw, frame } = drawOver();
  const set = draw.lines({ id });
  const attributes = new WeakMap();
  const attrs = (primitive, itemId) => attributes.get(primitive).get(itemId);
  return {
    scene,
    set,
    frame,
    host: () => scene.added[0],
    polylines: () => scene.added[0].get(0),
    batches() {
      const host = scene.added[0];
      const found = [];
      for (let i = 1; i < host.length; i++) found.push(host.get(i));
      return found;
    },
    settle() {
      for (let i = 0; i < SETTLE_FRAMES; i++) frame();
    },
    built(primitive) {
      Object.defineProperty(primitive, 'ready', { value: true });
      const own = new Map();
      attributes.set(primitive, own);
      primitive.getGeometryInstanceAttributes = (pickId) => {
        if (!own.has(pickId.id)) {
          const instance = primitive.geometryInstances.find(
            (one) => one.id === pickId,
          );
          if (!instance) return undefined;
          own.set(pickId.id, {
            show: new Uint8Array(instance.attributes.show.value),
            color: new Uint8Array(instance.attributes.color.value),
          });
        }
        return own.get(pickId.id);
      };
    },
    attrs,
  };
}

test('unchanged solid 3D lines settle into a static batch, changed there in place', (t) =>
  withImageClasses(() => {
    timeFrames(t);
    const s = settlingSet();
    const { set, frame } = s;
    const stem = settleStem;
    const glow = {
      id: 'glow',
      positions: stem('g', 1).positions,
      widthPx: 4,
      mode: '3d',
      style: { kind: 'glow', color: '#fff', power: 0.2 },
    };
    set.set([
      stem('a', 100),
      stem('b', 200, { style: { kind: 'solid', color: [0, 1, 0, 0.5] } }),
      stem('c', 300, { show: false }),
      glow,
    ]);
    const host = s.host();
    const polylines = s.polylines();
    assert.ok(polylines instanceof Cesium.PolylineCollection);
    assert.equal(polylines.length, 4, 'drawn by the collection at once');
    for (let i = 0; i < SETTLE_FRAMES - 1; i++) frame();
    assert.equal(host.length, 1, 'not before it settles');
    frame();
    // Opaque and translucent lines draw in passes of their own.
    const [opaque, translucent] = s.batches();
    assert.ok(opaque instanceof Cesium.Primitive);
    assert.equal(opaque.show, false, 'hidden while it builds');
    assert.equal(opaque.appearance.translucent, false);
    assert.equal(translucent.appearance.translucent, true);
    assert.deepEqual(
      opaque.geometryInstances.map((one) => one.id.id),
      ['a', 'c'],
      'every solid line, shown or not; the glow stays in the collection',
    );
    const [a, c] = opaque.geometryInstances;
    assert.ok(a.geometry instanceof Cesium.PolylineGeometry);
    assert.equal(a.geometry._width, 2);
    assert.deepEqual([...c.attributes.show.value], [0]);
    assert.deepEqual([...a.attributes.color.value], [255, 0, 0, 255]);
    // Picks name the set and item, through the same pick ids.
    assert.equal(a.id, polylines.get(0).id);
    assert.deepEqual(drawHitOf({ primitive: opaque, id: a.id }), {
      set: 'stems',
      id: 'a',
      meta: 100,
      surface: false,
    });
    // A line in the collection that moves drops the build, which drew it
    // where it was; one shown, or a glow line changed, does not.
    set.upsert([stem('c', 300)]);
    set.upsert([{ ...glow, widthPx: 4, show: false }]);
    assert.equal(s.host(), host, 'changed in place');
    assert.equal(s.batches().length, 2, 'still building');
    set.upsert([stem('a', 150)]);
    assert.equal(s.batches().length, 0, 'dropped');
    set.upsert([stem('a', 100)]);
    s.settle();
    const [opaqueAgain, translucentAgain] = s.batches();
    s.built(opaqueAgain);
    s.built(translucentAgain);
    frame();
    assert.equal(opaqueAgain.show, true, 'swapped in once built');
    // The glow, hidden, is parked out of the collection, which would draw
    // it on regardless; the batch took the rest.
    assert.equal(polylines.length, 0, 'none left in the collection');
    // Show, colour and meta change in place on the batch.
    set.upsert([
      stem('a', 100, { show: false }),
      stem('c', 300, { style: { kind: 'solid', color: [0, 0, 1, 1] } }),
    ]);
    assert.equal(s.host(), host);
    assert.deepEqual([...s.attrs(opaqueAgain, 'a').show], [0]);
    assert.deepEqual([...s.attrs(opaqueAgain, 'c').color], [0, 0, 255, 255]);
    assert.equal(polylines.length, 0, 'nothing left the batch');
    set.upsert([stem('a', 100, { meta: 'new' })]);
    assert.deepEqual([...s.attrs(opaqueAgain, 'a').show], [1]);
    assert.equal(opaqueAgain.geometryInstances[0].id.meta, 'new');
    // A line that moves leaves the batch, hidden there, for the
    // collection; it settles back with the rest.
    set.upsert([stem('a', 900)]);
    assert.equal(s.host(), host);
    assert.deepEqual([...s.attrs(opaqueAgain, 'a').show], [0]);
    assert.equal(polylines.length, 1);
    const moved = polylines.get(0);
    assert.equal(moved.id.id, 'a');
    assert.ok(
      Cesium.Cartesian3.equalsEpsilon(
        moved.positions[1],
        Cesium.Cartesian3.fromDegrees(0, 0, 900),
        1e-6,
      ),
    );
    // So does one turned translucent.
    set.upsert([
      stem('c', 300, { style: { kind: 'solid', color: [0, 0, 1, 0.4] } }),
    ]);
    assert.equal(polylines.length, 2);
    // Two lines are few beside a batch: they wait longer.
    s.settle();
    assert.equal(s.batches().length, 2, 'not yet');
    for (let i = SETTLE_FRAMES; i < LONG_SETTLE_FRAMES; i++) frame();
    const next = s.batches().slice(2);
    assert.equal(next.length, 2, 'built beside the batches drawing now');
    assert.deepEqual(
      next.flatMap((one) => one.geometryInstances.map((i) => i.id.id)),
      ['a', 'b', 'c'],
    );
    // A batched line shown or hidden while the next batch builds shows
    // there as its item now asks, once it is built.
    set.upsert([
      stem('b', 200, {
        style: { kind: 'solid', color: [0, 1, 0, 0.5] },
        show: false,
      }),
    ]);
    assert.deepEqual([...s.attrs(translucentAgain, 'b').show], [0]);
    assert.equal(s.batches().length, 4, 'the build goes on');
    next.forEach(s.built);
    frame();
    assert.deepEqual(s.batches(), next, 'the old batches are gone');
    assert.equal(opaqueAgain.isDestroyed(), true);
    assert.deepEqual([...s.attrs(next[1], 'b').show], [0]);
    assert.equal(polylines.length, 0);
    // The glow shown again draws in the collection, in place.
    set.upsert([glow]);
    assert.equal(s.host(), host);
    assert.equal(polylines.length, 1);
    assert.equal(polylines.get(0).id.id, 'glow');
    // A line that looks different is still a rebuild.
    set.upsert([stem('b', 200, { widthPx: 5 })]);
    assert.notEqual(s.host(), host);
    set.dispose();
  }));

test('lines settle after the same time at any refresh rate', (t) =>
  withImageClasses(() => {
    timeFrames(t);
    const s = settlingSet();
    s.set.set([settleStem('a', 100)]);
    const host = s.host();
    // Two frames are enough when they are half a second apart.
    frameClock.ms = SETTLE_MS - FRAME_MS - 1;
    s.frame();
    assert.equal(host.length, 1, 'not before the time');
    s.frame();
    assert.equal(host.length, 2, 'building once it has passed');
    s.set.dispose();
  }));

test('many lines left beside a static batch settle as soon as they are unchanged', (t) =>
  withImageClasses(() => {
    timeFrames(t);
    const s = settlingSet();
    const { set } = s;
    const stems = (height) =>
      Array.from({ length: FEW_LOOSE_LINES + 1 }, (_, i) =>
        settleStem(`s${i}`, height + i),
      );
    set.set(stems(100));
    s.settle();
    const [first] = s.batches();
    s.built(first);
    s.frame();
    set.upsert(stems(500));
    assert.equal(s.polylines().length, FEW_LOOSE_LINES + 1, 'all moved');
    s.settle();
    assert.equal(s.batches().length, 2, 'rebuilding at once');
    set.dispose();
  }));

test('an outlined solid line draws one outline material, recoloured in place, and never settles', (t) =>
  withImageClasses(() => {
    timeFrames(t);
    const s = settlingSet();
    const outlined = (core, halo) =>
      settleStem('ring', 100, {
        widthPx: 4,
        style: {
          kind: 'solid',
          color: core,
          outline: { color: halo, widthPx: 1 },
        },
      });
    s.set.set([outlined([0, 0.5, 1, 1], [0, 0, 0, 0.8]), settleStem('a', 200)]);
    const line = () => {
      const polylines = s.polylines();
      for (let i = 0; i < polylines.length; i++)
        if (polylines.get(i).id?.id === 'ring') return polylines.get(i);
      return null;
    };
    const first = line();
    const drawnPositions = first.positions;
    assert.equal(first.material.type, 'PolylineOutline');
    assert.equal(first.material.uniforms.outlineWidth, 1);
    s.set.upsert([outlined([0, 0.5, 1, 0.4], [0, 0, 0, 0.32])]);
    assert.equal(line(), first, 'the same line');
    assert.equal(
      first.positions,
      drawnPositions,
      'positions sent again where they were are not rewritten',
    );
    assert.equal(first.material.uniforms.color.alpha, 0.4);
    assert.ok(
      Math.abs(first.material.uniforms.outlineColor.alpha - 0.32) < 1e-9,
    );
    s.settle();
    const [batch] = s.batches();
    assert.deepEqual(
      batch.geometryInstances.map((one) => one.id.id),
      ['a'],
    );
    s.set.dispose();
  }));

test('a line that moves by as many points is written into the points it draws; by more, it takes new ones', (t) =>
  withImageClasses(() => {
    timeFrames(t);
    const s = settlingSet();
    const style = {
      kind: 'solid',
      color: [0, 0.5, 1, 1],
      outline: { color: [0, 0, 0, 1], widthPx: 1 },
    };
    const front = (positions) => ({
      id: 'front',
      positions,
      widthPx: 4,
      mode: '3d',
      style,
    });
    const at = (...heights) =>
      heights.map((h) => ({ ...Cesium.Cartesian3.fromDegrees(0, 0, h) }));
    // Beside a line that settles, as the ring's fronts are not.
    s.set.set([front(at(10, 20, 30)), settleStem('a', 200)]);
    const polylines = s.polylines();
    let line = null;
    for (let i = 0; i < polylines.length; i++)
      if (polylines.get(i).id?.id === 'front') line = polylines.get(i);
    const points = line.positions;
    const objects = [...points];
    s.set.upsert([front(at(40, 50, 60))]);
    assert.equal(line.positions, points, 'the same points');
    assert.deepEqual(line.positions, objects, 'each the same object');
    const heights = () =>
      line.positions.map((p) =>
        Math.round(Cesium.Cartographic.fromCartesian(p).height),
      );
    assert.deepEqual(heights(), [40, 50, 60]);
    // Packed triples are written in too.
    const packed = new Float64Array(9);
    at(70, 80, 90).forEach((p, i) => packed.set([p.x, p.y, p.z], i * 3));
    s.set.upsert([front(packed)]);
    assert.equal(line.positions, points);
    assert.deepEqual(heights(), [70, 80, 90]);
    // As longitudes and latitudes, converted into the same points.
    s.set.upsert([
      front([
        { lon: 0, lat: 0, height: 1 },
        { lon: 0, lat: 0, height: 2 },
        { lon: 0, lat: 0, height: 3 },
      ]),
    ]);
    assert.equal(line.positions, points);
    assert.deepEqual(heights(), [1, 2, 3]);
    s.set.upsert([front(at(5, 6, 7, 8))]);
    assert.notEqual(line.positions, points, 'more points: new ones');
    assert.deepEqual(heights(), [5, 6, 7, 8]);
    s.set.dispose();
  }));

test('a line under half a pixel wide, which the collection does not draw, never settles', (t) =>
  withImageClasses(() => {
    timeFrames(t);
    const s = settlingSet();
    s.set.set([
      settleStem('thin', 100, { widthPx: 0.25 }),
      settleStem('a', 200),
    ]);
    s.settle();
    const [batch] = s.batches();
    assert.deepEqual(
      batch.geometryInstances.map((one) => one.id.id),
      ['a'],
    );
    s.set.dispose();
  }));

test('a settling line set keeps what was drawn, not the item a caller changes in place', (t) =>
  withImageClasses(() => {
    timeFrames(t);
    const s = settlingSet();
    const { set } = s;
    const a = settleStem('a', 100);
    set.set([a]);
    const host = s.host();
    // In the collection, a colour change takes the polyline's material in
    // place.
    set.upsert([{ ...a, style: { kind: 'solid', color: [0, 1, 0, 1] } }]);
    assert.equal(s.host(), host, 'recoloured in place');
    assert.ok(
      Cesium.Color.equals(
        s.polylines().get(0).material.uniforms.color,
        new Cesium.Color(0, 1, 0, 1),
      ),
    );
    // The same object, changed and sent again, is compared with what was
    // drawn: a new width rebuilds.
    const same = { ...a };
    set.upsert([same]);
    same.widthPx = 6;
    set.upsert([same]);
    assert.notEqual(s.host(), host, 'rebuilt for the new width');
    assert.equal(s.polylines().get(0).width, 6);
    set.dispose();
  }));

test('a settling line set rebuilt or gone while its batch builds, or after the viewer went, lets the batch go', (t) =>
  withImageClasses(() => {
    timeFrames(t);
    const s = settlingSet();
    const { set } = s;
    set.set([settleStem('a', 100), settleStem('b', 200)]);
    s.settle();
    const [building] = s.batches();
    assert.ok(building, 'building');
    // A rebuild draws a new host; the batch goes with the old one.
    const old = s.host();
    set.set([settleStem('a', 100)]);
    assert.ok(!s.scene.added.includes(old), 'the old host is gone');
    assert.equal(old.get(1), building);
    assert.equal(s.batches().length, 0);
    // Its build finishing later changes nothing.
    s.built(building);
    s.frame();
    assert.equal(building.show, false);
    s.settle();
    const [again] = s.batches();
    s.built(again);
    s.frame();
    assert.equal(again.show, true);
    // A viewer destroyed under the set takes its batch with it: an upsert
    // after that rebuilds rather than write to it.
    s.host().destroy();
    assert.equal(again.isDestroyed(), true);
    set.upsert([settleStem('a', 100, { show: false })]);
    assert.equal(s.polylines().get(0).show, false, 'drawn anew, hidden');
    set.dispose();
  }));

test('a static batch that fails to build is reported once, and its lines stay in the collection', (t) =>
  withImageClasses(() => {
    timeFrames(t);
    const scene = fakeScene();
    const reported = [];
    const part = createCesiumDraw({
      scene,
      report: (error) => reported.push(error),
    });
    const afterFrame = () => {
      frameClock.ms += FRAME_MS;
      part.afterRender();
    };
    const set = part.port.lines({ id: 'failing' });
    set.set([settleStem('a', 100)]);
    for (let i = 0; i < SETTLE_FRAMES; i++) afterFrame();
    const host = scene.added[0];
    const batch = host.get(1);
    assert.ok(batch, 'building');
    // Its build throws, as a primitive whose workers failed does: the
    // batch keeps the error rather than throw it every frame.
    batch.update({ passes: { render: true }, mode: Cesium.SceneMode.SCENE3D });
    assert.ok(batch.failed, 'kept');
    afterFrame();
    assert.deepEqual(reported, [batch.failed]);
    assert.equal(host.length, 1, 'the build is gone');
    assert.equal(host.get(0).length, 1, 'the collection draws the line');
    for (let i = 0; i < SETTLE_FRAMES * 2; i++) afterFrame();
    assert.equal(host.length, 1, 'it settles no more');
    assert.equal(reported.length, 1);
    set.dispose();
  }));

test('a draped line with segment colours and shows draws a ground instance a segment, changed in place', () =>
  withImageClasses(() => {
    const { scene, draw, frame } = drawOver();
    const set = draw.lines({ id: 'segments', pickable: false });
    const trail = (alpha, shows) => ({
      id: 'trail',
      positions: [
        { lon: 0, lat: 0 },
        { lon: 0.001, lat: 0 },
        { lon: 0.001, lat: 0 },
        { lon: 0.002, lat: 0 },
      ],
      widthPx: 3,
      mode: 'draped',
      style: { kind: 'solid', color: '#ffffff' },
      segmentColors: [
        [0, 1, 0, alpha],
        [0, 1, 0, alpha],
        [1, 0, 0, alpha],
      ],
      segmentShow: shows,
    });
    set.set([
      trail(0.8, [true, false, false]),
      {
        id: 'plain',
        positions: [
          { lon: 1, lat: 0 },
          { lon: 1.001, lat: 0 },
        ],
        widthPx: 2,
        mode: 'draped',
        style: { kind: 'solid', color: '#7fe6ed' },
      },
    ]);
    const host = scene.added[0];
    const ground = host.get(1);
    assert.ok(ground instanceof Cesium.GroundPolylinePrimitive);
    assert.equal(ground.allowPicking, false);
    // Two segments with length, and the plain line, in one primitive.
    const instances = ground.geometryInstances;
    assert.equal(instances.length, 3);
    const [first, last] = instances;
    assert.equal(first.id.id, 'trail', 'picks read as the line');
    assert.equal(first.id.set, 'segments');
    assert.notEqual(first.id, last.id);
    assert.deepEqual(
      [...first.attributes.color.value],
      [0, 255, 0, Math.round(0.8 * 255)],
    );
    assert.deepEqual([...first.attributes.show.value], [1]);
    assert.deepEqual([...last.attributes.color.value].slice(0, 3), [255, 0, 0]);
    assert.deepEqual([...last.attributes.show.value], [0]);
    const attributes = new Map(
      instances.map((instance) => [
        instance.id,
        {
          color: Uint8Array.from(instance.attributes.color.value),
          show: Uint8Array.from(instance.attributes.show.value),
        },
      ]),
    );
    let writes = 0;
    ground.getGeometryInstanceAttributes = (id) => {
      writes += 1;
      return attributes.get(id);
    };
    // Still building: queued, and written as it swaps in.
    set.upsert([trail(0.5, [true, false, true])]);
    assert.equal(scene.added[0], host, 'not rebuilt');
    assert.equal(writes, 0);
    Object.defineProperty(ground, 'ready', { value: true });
    frame();
    assert.equal(attributes.get(last.id).color[3], Math.round(0.5 * 255));
    assert.deepEqual([...attributes.get(last.id).show], [1]);
    // Ready: only what changed is written.
    writes = 0;
    set.upsert([trail(0.5, [false, false, true])]);
    assert.equal(scene.added[0], host);
    assert.equal(writes, 1);
    assert.deepEqual([...attributes.get(first.id).show], [0]);
    writes = 0;
    set.upsert([trail(0.5, [false, false, true])]);
    assert.equal(writes, 0, 'nothing changed, nothing written');
    // Shown in place after a queued write: the queued one does not return.
    const again = draw.lines({ id: 'segments-again' });
    again.set([trail(0.8, [true, true, true])]);
    const queued = scene.added.at(-1).get(1);
    const shows = new Map(
      queued.geometryInstances.map((instance) => [
        instance.id,
        { color: new Uint8Array(4), show: new Uint8Array([1]) },
      ]),
    );
    queued.getGeometryInstanceAttributes = (id) => shows.get(id);
    again.upsert([trail(0.8, [false, false, false])]);
    Object.defineProperty(queued, 'ready', { value: true });
    again.upsert([trail(0.8, [true, true, true])]);
    frame();
    for (const { show } of shows.values()) assert.deepEqual([...show], [1]);
    again.dispose();
    // A line of no length draws nothing and holds no swap.
    const none = draw.lines({ id: 'segments-none' });
    const still = {
      ...trail(1, [true]),
      positions: [
        { lon: 3, lat: 0 },
        { lon: 3, lat: 0 },
      ],
      segmentColors: ['#fff'],
    };
    none.set([still]);
    const empty = scene.added.at(-1);
    assert.ok(
      empty instanceof Cesium.PolylineCollection,
      'no ground primitive',
    );
    // Its looks changing builds nothing either.
    none.upsert([{ ...still, segmentShow: [false] }]);
    assert.equal(scene.added.at(-1), empty, 'not rebuilt');
    none.upsert([{ ...still, positions: trail(1, []).positions }]);
    assert.notEqual(scene.added.at(-1), empty, 'drawn once it has length');
    none.dispose();
    // Height queries see through every segment.
    const { pickIds } = unboundDrawPart(draw).sets.get('segments');
    assert.ok(pickIds.includes(first.id) && pickIds.includes(last.id));
    set.dispose();
  }));

test('a segmented line of any mode and style draws a primitive a segment, recoloured and shown in place', () =>
  withImageClasses(() => {
    const { draw, scene } = drawOver();
    const set = draw.lines({ id: 'pieces' });
    const line = (colors, shows, extra = {}) => ({
      id: 'p',
      positions: [
        { lon: 0, lat: 0, height: 100 },
        { lon: 0.001, lat: 0, height: 100 },
        { lon: 0.001, lat: 0, height: 100 },
        { lon: 0.002, lat: 0, height: 100 },
      ],
      widthPx: 3,
      mode: '3d',
      style: { kind: 'glow', color: '#ffffff', power: 0.2 },
      segmentColors: colors,
      segmentShow: shows,
      ...extra,
    });
    const red = [1, 0, 0, 1];
    const green = [0, 1, 0, 1];
    set.set([line([red, red, green], [true, true, false])]);
    const host = scene.added[0];
    const pieces = [];
    const walk = (p) => {
      if (p instanceof Cesium.PrimitiveCollection)
        for (let i = 0; i < p.length; i++) walk(p.get(i));
      else if (p instanceof Cesium.Primitive) pieces.push(p);
    };
    walk(host);
    assert.equal(pieces.length, 2, 'a primitive a segment of length');
    const color = (p) => p.appearance.material.uniforms.color;
    assert.deepEqual(
      pieces.map((p) => [color(p).red, color(p).green, p.show]),
      [
        [1, 0, true],
        [0, 1, false],
      ],
    );
    assert.equal(pieces[0].appearance.material.type, 'PolylineGlow');
    const ids = pieces.map((p) => p.geometryInstances.id);
    assert.equal(ids[0].id, 'p', 'a segment picks as its line');
    assert.notEqual(ids[0], ids[1], 'under a pick id of its own');
    set.upsert([line([green, green, red], [true, true, true])]);
    assert.equal(scene.added[0], host, 'not rebuilt');
    assert.deepEqual(
      pieces.map((p) => [color(p).red, color(p).green, p.show]),
      [
        [0, 1, true],
        [1, 0, true],
      ],
    );
    // An arrow's head is on its last segment; a revealed line shows only
    // the pieces it has reached.
    set.set([
      line([red, red, green], [true, true, true], {
        style: { kind: 'arrow', color: '#fff' },
        revealFraction: 0.25,
      }),
    ]);
    pieces.length = 0;
    walk(scene.added[0]);
    const drawn = (p) =>
      p.appearance.material.materials?.revealed ?? p.appearance.material;
    assert.deepEqual(
      pieces.map((p) => [drawn(p).type, p.show]),
      [
        ['Color', true],
        ['PolylineArrow', false],
      ],
    );
    set.dispose();
  }));

test('a draped line shown after it is ready keeps that show through the swap', () =>
  withImageClasses(() => {
    const { draw, frame, scene } = drawOver();
    const set = draw.lines({ id: 'swapped' });
    const draped = (show) => ({
      id: 'a',
      positions: [
        { lon: 0, lat: 0 },
        { lon: 1, lat: 1 },
      ],
      widthPx: 2.5,
      mode: 'draped',
      style: { kind: 'solid', color: '#7fe6ed' },
      show,
    });
    set.set([draped(true)]);
    const ground = scene.added[0].get(1);
    const show = new Uint8Array([1]);
    ground.getGeometryInstanceAttributes = () => ({ show });
    // Hidden while it builds: queued for the swap.
    set.upsert([draped(false)]);
    // Ready, but not yet swapped in, when it is shown again.
    Object.defineProperty(ground, 'ready', { value: true });
    set.upsert([draped(true)]);
    frame();
    assert.deepEqual([...show], [1], 'the newer show, not the queued one');
    set.dispose();
  }));

test('an icon stands off its position by its pixel offset, and back when it has none', () => {
  const { scene, draw } = drawOver();
  const set = draw.icons({ id: 'offset-pins' });
  const icon = (pixelOffset) => ({
    id: 'a',
    pos: { lon: 0, lat: 0 },
    image: 'pin.png',
    size: [8, 8],
    ...(pixelOffset ? { pixelOffset } : {}),
  });
  set.set([icon({ x: 3, y: -4 })]);
  const pin = () => scene.added[0].get(0);
  assert.deepEqual([pin().pixelOffset.x, pin().pixelOffset.y], [3, -4]);
  set.upsert([icon({ x: 0, y: 6 })]);
  assert.deepEqual([pin().pixelOffset.x, pin().pixelOffset.y], [0, 6]);
  set.upsert([icon()]);
  assert.deepEqual([pin().pixelOffset.x, pin().pixelOffset.y], [0, 0]);
  set.dispose();
});

test('an icon turned about an axis stands along it, restyled in place when the axis changes', () => {
  const { scene, draw } = drawOver();
  const set = draw.icons({ id: 'axis-pins' });
  const icon = (alignedAxis) => ({
    id: 'a',
    pos: { lon: 0, lat: 0 },
    image: 'pin.png',
    size: [8, 8],
    rotationMode: 'axis',
    alignedAxis,
  });
  set.set([icon({ x: 0, y: 0, z: 2 })]);
  const pin = () => scene.added[0].get(0);
  const axis = () => [
    pin().alignedAxis.x,
    pin().alignedAxis.y,
    pin().alignedAxis.z,
  ];
  assert.deepEqual(axis(), [0, 0, 1], 'normalised');
  assert.equal(pin().rotation, 0);
  const drawn = pin();
  set.upsert([icon({ x: 0, y: 1, z: 0 })]);
  assert.equal(pin(), drawn, 'the same billboard');
  assert.deepEqual(axis(), [0, 1, 0]);
  set.upsert([{ ...icon(undefined), rotationMode: 'screen' }]);
  assert.deepEqual(axis(), [0, 0, 0], 'upright again');
  set.dispose();
});

test('a wall stands up from the ellipsoid to its positions, with or without a fill', () => {
  const { scene, draw } = drawOver();
  const set = draw.shapes({ id: 'walls' });
  const wall = (id, fill) => ({
    id,
    geometry: {
      kind: 'wall',
      positions: [
        { lon: 0, lat: 0, height: 100 },
        { lon: 0.01, lat: 0, height: 150 },
      ],
    },
    fill,
    outline: [1, 1, 0, 1],
  });
  set.set([wall('filled', [0, 0, 1, 0.5]), wall('outline', null)]);
  const geometries = [];
  const walk = (primitive) => {
    if (!primitive) return;
    if (primitive instanceof Cesium.PrimitiveCollection)
      for (let i = 0; i < primitive.length; i++) walk(primitive.get(i));
    for (const instance of [primitive.geometryInstances ?? []].flat())
      geometries.push([instance.id?.id, instance.geometry.constructor.name]);
  };
  scene.added.forEach(walk);
  assert.deepEqual(geometries.sort(), [
    ['filled', 'WallGeometry'],
    ['filled', 'WallOutlineGeometry'],
    ['outline', 'WallOutlineGeometry'],
  ]);
  set.dispose();
});

test('icons blend as their set says', () => {
  const { scene, draw } = drawOver();
  const set = draw.icons({ id: 'pins', blend: 'translucent' });
  set.set([
    {
      id: 'a',
      pos: { lon: 0, lat: 0 },
      image: 'pin.png',
      size: [6, 6],
    },
  ]);
  assert.equal(scene.added[0].blendOption, Cesium.BlendOption.TRANSLUCENT);
  set.setOptions({ blend: undefined });
  assert.equal(
    scene.added[0].blendOption,
    Cesium.BlendOption.OPAQUE_AND_TRANSLUCENT,
  );
  set.dispose();
});

test('icon sets change their billboards in place: restyled, moved, re-imaged, added and removed', () => {
  const scene = fakeScene();
  const part = createCesiumDraw({
    scene,
    report: (error) => assert.fail(error),
  });
  const set = part.port.icons({ id: 'icons:in-place', horizonCull: true });
  const record = part.sets.get('icons:in-place');
  const icon = (id, lon, extra = {}) => ({
    id,
    pos: { lon, lat: 0 },
    image: 'a.png',
    size: [10, 10],
    ...extra,
  });
  set.set([icon('a', 0), icon('b', 1)]);
  const [host] = scene.added;
  const [a, b] = [host.get(0), host.get(1)];
  const version = part.version();

  set.upsert([
    icon('a', 2, {
      color: [0, 1, 0, 1],
      scale: 2,
      meta: { n: 1 },
      rotationMode: 'screen',
      rotation: 0.5,
      image: 'b.png',
    }),
  ]);
  assert.equal(scene.added[0], host, 'the same collection');
  assert.equal(host.get(0), a, 'the same billboard');
  assert.ok(Cesium.Color.equals(a.color, Cesium.Color.LIME));
  assert.equal(a.width, 20);
  assert.equal(a.rotation, 0.5);
  assert.equal(a.image, 'b.png', 'its image swapped');
  assert.equal(b.image, 'a.png', 'the others keep theirs');
  assert.deepEqual(a.id.meta, { n: 1 }, 'picks read the new meta');
  const moved = Cesium.Cartographic.fromCartesian(a.position);
  assert.ok(Math.abs(Cesium.Math.toDegrees(moved.longitude) - 2) < 1e-9);
  assert.equal(
    part.version(),
    version,
    'changed in place, the pick ids height queries see through are the same',
  );

  // Back to the defaults it dropped.
  set.upsert([icon('a', 2)]);
  assert.equal(a.rotation, 0);
  assert.equal(a.width, 10);

  set.upsert([icon('c', 3)]);
  assert.equal(scene.added[0], host, 'a new icon is added to it');
  assert.equal(host.length, 3);
  const added = part.version();
  assert.ok(added > version, 'a new pick id for height queries to see');
  set.remove(['b']);
  assert.equal(scene.added[0], host, 'and one removed from it');
  assert.equal(host.length, 2);
  assert.ok(part.version() > added, 'and one gone');
  assert.deepEqual(
    record.pickIds.map((id) => id.id).sort(),
    ['a', 'c'],
    'height queries no longer see through what went',
  );
  assert.deepEqual(
    record.placed.map((p) => p.primitive),
    [a, host.get(1)],
    'the horizon cull no longer tests it',
  );

  // Hidden in place, then culled with the rest.
  set.upsert([icon('a', 2, { show: false })]);
  assert.equal(a.show, false);

  // A set in the same order patches; a new order rebuilds.
  set.set([icon('a', 2), icon('c', 3)]);
  assert.equal(scene.added[0], host);
  set.set([icon('c', 3), icon('a', 2)]);
  assert.notEqual(scene.added[0], host, 'reordered: rebuilt');
  assert.equal(scene.added[0].get(0).id.id, 'c');
  set.clear();
  assert.equal(scene.added[0].length, 0);
  set.dispose();
  assert.equal(scene.added.length, 0);
});

test('an icon drawn from an atlas slot takes a re-registered slot in place', () => {
  const scene = fakeScene();
  const part = createCesiumDraw({
    scene,
    report: (error) => assert.fail(error),
  });
  const set = part.port.icons({ id: 'icons:atlas' });
  const icon = (id, slot, lon) => ({
    id,
    pos: { lon, lat: 0 },
    image: { atlas: 'marks', slot },
    size: [8, 8],
  });
  set.set([icon('one', 'dot', 0), icon('two', 'ring', 1)]);
  const [host] = scene.added;
  assert.equal(host.length, 0, 'nothing to draw until the atlas comes');
  part.port.atlas('marks', { dot: 'dot.png' });
  assert.equal(scene.added[0], host);
  const one = host.get(0);
  assert.equal(one.image, 'dot.png');
  part.port.atlas('marks', { dot: 'next.png', ring: 'ring.png' });
  assert.equal(scene.added[0], host, 'not rebuilt');
  assert.equal(host.get(0), one, 'the same billboard');
  assert.equal(one.image, 'next.png');
  assert.equal(host.get(1).image, 'ring.png', 'the slot that came draws');
  const version = part.version();
  part.port.atlas('marks', { dot: 'again.png', ring: 'ring.png' });
  assert.equal(scene.added[0], host, 'new images only: not rebuilt');
  assert.equal(host.get(0), one, 'the same billboard');
  assert.equal(one.image, 'again.png');
  assert.equal(part.version(), version, 'the same pick ids');
  part.port.atlas('marks', { ring: 'ring.png' });
  assert.equal(host.length, 1, 'a slot gone takes its icon down');
  assert.ok(part.version() > version, 'one pick id fewer');
  assert.equal(host.get(0).id.id, 'two');
  // A slot that comes for an icon ahead of one drawn rebuilds, in order.
  part.port.atlas('marks', { dot: 'dot.png', ring: 'ring.png' });
  assert.notEqual(scene.added[0], host);
  assert.deepEqual(
    [scene.added[0].get(0).id.id, scene.added[0].get(1).id.id],
    ['one', 'two'],
  );
  set.dispose();
});

test('an icon set is built anew where changing it in place would draw out of order or keep stale images', () => {
  const scene = fakeScene();
  const part = createCesiumDraw({
    scene,
    report: (error) => assert.fail(error),
  });
  const set = part.port.icons({ id: 'icons:anew' });
  const icon = (id, image = 'a.png') => ({
    id,
    pos: { lon: 0, lat: 0 },
    image,
    size: [8, 8],
  });
  set.set([icon('a'), icon('c')]);
  let host = scene.added[0];
  set.set([icon('a'), icon('b'), icon('c')]);
  assert.notEqual(scene.added[0], host, 'one put between two drawn: rebuilt');
  assert.deepEqual(
    [0, 1, 2].map((i) => scene.added[0].get(i).id.id),
    ['a', 'b', 'c'],
  );

  // A generated image swaps under a new key; a new canvas under the key it
  // had cannot change that key's texture, so it rebuilds.
  const canvas = { width: 8, height: 8 };
  set.set([icon('a', { canvas, key: 'one' })]);
  host = scene.added[0];
  const a = host.get(0);
  set.upsert([icon('a', { canvas, key: 'two' })]);
  assert.equal(scene.added[0], host, 'a new key swaps in place');
  assert.equal(host.get(0), a);
  set.upsert([icon('a', { canvas: { width: 8, height: 8 }, key: 'two' })]);
  assert.notEqual(scene.added[0], host, 'a new canvas, same key: rebuilt');

  // Its collection keeps what it loaded, so cycling images rebuilds now and
  // then, holding only what it draws.
  host = scene.added[0];
  let rebuilds = 0;
  for (let i = 0; i < 200; i++) {
    set.upsert([icon('a', `cycle-${i}.png`)]);
    if (scene.added[0] !== host) {
      rebuilds += 1;
      host = scene.added[0];
    }
  }
  assert.ok(rebuilds >= 2 && rebuilds <= 4, `rebuilt ${rebuilds} times`);
  assert.ok(part.sets.get('icons:anew').imageKeys.size <= 64);

  set.clear();
  assert.notEqual(scene.added[0], host, 'emptied: built anew, empty');
  assert.equal(scene.added[0].length, 0);
  set.dispose();
});

test('icons scale, fade and show by eye distance, and drop the curves in place', () => {
  const scene = fakeScene();
  const part = createCesiumDraw({
    scene,
    report: (error) => assert.fail(error),
  });
  const set = part.port.icons({ id: 'icons:distance' });
  const icon = (extra = {}) => ({
    id: 'a',
    pos: { lon: 0, lat: 0 },
    image: 'a.png',
    size: [8, 8],
    ...extra,
  });
  set.set([
    icon({
      scaleByDistance: { near: 1e3, nearValue: 1.5, far: 1e6, farValue: 0.5 },
      fadeByDistance: { near: 2e3, nearValue: 1, far: 2e6, farValue: 0 },
      displayRange: [10, 5e6],
    }),
  ]);
  const [host] = scene.added;
  const a = host.get(0);
  assert.ok(
    Cesium.NearFarScalar.equals(
      a.scaleByDistance,
      new Cesium.NearFarScalar(1e3, 1.5, 1e6, 0.5),
    ),
  );
  assert.ok(
    Cesium.NearFarScalar.equals(
      a.translucencyByDistance,
      new Cesium.NearFarScalar(2e3, 1, 2e6, 0),
    ),
  );
  assert.equal(a.distanceDisplayCondition.near, 10);
  assert.equal(a.distanceDisplayCondition.far, 5e6);

  set.upsert([icon()]);
  assert.equal(host.get(0), a, 'changed in place');
  assert.equal(a.scaleByDistance, undefined);
  assert.equal(a.translucencyByDistance, undefined);
  assert.equal(a.distanceDisplayCondition, undefined);
  set.upsert([
    icon({
      scaleByDistance: { near: 5, nearValue: 1, far: 5, farValue: 2 },
    }),
  ]);
  assert.equal(a.scaleByDistance, undefined, 'no curve: left out');
  set.upsert([icon({ displayRange: [100, 100] })]);
  assert.equal(a.show, false, 'an empty range shows it nowhere');
  set.dispose();
});

/**
 * The vessels layer over a fake scene, drawing through the draw port, with
 * `sprites` as its sprite-order services.
 */
async function vesselLayerOver(scene, sprites) {
  const { createVesselLayer } = await import('../../layers/vessels/index.js');
  const part = createCesiumDraw({
    scene,
    report: (error) => assert.fail(error),
  });
  const viewer = { scene };
  const noop = () => {};
  const unbind = bindRenderer(viewer, {
    draw: part.port,
    query: { project: () => null, projectMany: (s, out) => out.fill(NaN) },
  });
  const layer = createVesselLayer({
    source: { getSnapshot: async () => ({ records: [] }) },
    services: {
      context: {
        clearSelectedEntityContextForLayer: noop,
        registerEntityContext: () => null,
      },
      trails: {
        createTrail: () => ({ setPositions: noop, clear: noop, destroy: noop }),
      },
      labels: { formatKnots: (knots) => `${knots} kt` },
      picking: { unregisterPickOwner: noop },
      overlay: {
        setOverlayEntries: noop,
        setOverlaySourceVisible: noop,
        clearOverlaySource: noop,
      },
      geoid: {},
      sprites,
      focus: {
        focusNowMs: (now) => now,
        getFocusTarget: () => null,
        focusPassIsNeeded: () => false,
        forgetSpriteFocus: noop,
      },
      worldFocus: {},
      render: {
        holdContinuousRender: noop,
        releaseContinuousRender: noop,
        governorRequestRender: noop,
      },
    },
  });
  return { layer, viewer, part, unbind };
}

test('the vessels layer draws its ships as one GPU icon set that holds them on course', async () => {
  const { IconSetPrimitive } = await import('./iconSetPrimitive.js');
  const { ICON_CULL_LIFT, ICON_ROTATES } =
    await import('../../data/iconSet.js');
  const spriteOrder = await import('../../data/spriteOrder.js');
  const scene = fakeScene();
  const { layer, viewer, part, unbind } = await vesselLayerOver(
    scene,
    spriteOrder,
  );
  try {
    layer.testing._setVesselStateForTest({ viewer, icons: null });
    layer.testing._reconcileVesselsForTest(viewer, [
      { mmsi: '244000001', lat: 51.95, lon: 4.1, heading: 90, speed: 12 },
      { mmsi: '244000002', lat: 51.96, lon: 4.2, course: 200, speed: 2 },
    ]);
    const [host] = scene.added;
    assert.ok(host instanceof IconSetPrimitive, 'one GPU icon set');
    assert.match(host.drawSetId, /^ais-vessels:\d+$/);
    const record = part.sets.get(host.drawSetId);
    const set = record.gpu.set;
    assert.equal(set.count, 2);
    const row = set.row('244000001');
    const tau = set.seconds(Cesium.JulianDate.now());
    assert.equal(set.course(row, tau), 90, 'held on its heading');
    assert.equal(set.course(set.row('244000002'), tau), 200, 'or its course');
    assert.equal(set.width(row), 32);
    assert.ok(Math.abs(set.scale(row) - 0.68) < 1e-6, 'scaled by speed');
    assert.equal(set.flags(row) & ICON_ROTATES, ICON_ROTATES);
    assert.equal(set.flags(row) & ICON_CULL_LIFT, ICON_CULL_LIFT);
    assert.ok(set.depthTestDistance(row) >= 1e30, 'over depth everywhere');
    const at = Cesium.Cartographic.fromCartesian(set.position(row, tau));
    assert.ok(Math.abs(Cesium.Math.toDegrees(at.longitude) - 4.1) < 1e-6);
    assert.ok(Math.abs(Cesium.Math.toDegrees(at.latitude) - 51.95) < 1e-6);
    const facade = { show: true };
    assert.deepEqual(drawHitOf(host._pickObject('244000001', null, facade)), {
      set: host.drawSetId,
      id: '244000001',
      meta: { layer: 'ais-live-vessels', id: '244000001' },
      surface: false,
    });

    // A poll that moves one and drops the other writes rows, not a new host.
    layer.testing._reconcileVesselsForTest(viewer, [
      { mmsi: '244000001', lat: 51.95, lon: 4.12, heading: 95, speed: 12 },
    ]);
    assert.equal(scene.added[0], host);
    assert.equal(set.count, 1);
    assert.equal(set.course(set.row('244000001'), tau), 95);

    // The set stacks at the vessels' place in the sprite order.
    assert.equal(record.spec.drawOrder, spriteOrder.spriteDrawOrder('ais'));

    // Torn down and drawn again: a new set at the same draw order, with
    // the old host gone from the scene.
    layer.destroy(viewer);
    assert.equal(scene.added.length, 0, 'destroyed: the set goes');
    layer.testing._setVesselStateForTest({ viewer, icons: null });
    layer.testing._reconcileVesselsForTest(viewer, [
      { mmsi: '244000003', lat: 51.9, lon: 4.0, heading: 10, speed: 5 },
    ]);
    assert.equal(scene.added.length, 1);
    const [again] = scene.added;
    assert.notEqual(again, host);
    assert.notEqual(again.drawSetId, host.drawSetId, 'a new set id');
    assert.equal(part.sets.has(host.drawSetId), false);
    assert.equal(
      part.sets.get(again.drawSetId).spec.drawOrder,
      spriteOrder.spriteDrawOrder('ais'),
    );
    layer.destroy(viewer);
    assert.equal(scene.added.length, 0);
  } finally {
    unbind();
  }
});

test('the FIRMS layer draws its fire glows as one GPU icon set on a viewer of its own', async (t) => {
  const { createRendering } = await import('../../layers/firms/rendering.js');
  const { createModel } = await import('../../layers/firms/model.js');
  const { createFirmsState } = await import('../../layers/firms/state.js');
  const { IconSetPrimitive } = await import('./iconSetPrimitive.js');
  const { ICON_CULL_LIFT } = await import('../../data/iconSet.js');
  const { GLOW_SPRITE_PX, LOD_LEVELS } =
    await import('../../layers/firms/policy.js');
  // Each glow colour is rasterised on a canvas once.
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const priorDocument = globalThis.document;
  globalThis.document = {
    createElement: () => {
      let stops = [];
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          createRadialGradient: () => ({
            addColorStop: (_, color) => stops.push(color),
          }),
          fillRect() {},
        }),
        toDataURL: () => `data:image/png;base64,AAAA#${stops.join('|')}`,
      };
    },
  };
  t.after(() => {
    if (hadDocument) globalThis.document = priorDocument;
    else delete globalThis.document;
  });
  const scene = fakeScene();
  const viewer = { scene, isDestroyed: () => false };
  const sprites = [];
  const noop = () => {};
  const services = {
    anchors: {
      fireAnchorHeight: () => 40,
      warmFireAnchorFloors: async () => false,
    },
    sprites: {
      spriteDrawOrder: (layerId) => {
        sprites.push(layerId);
        return spriteDrawOrder(layerId);
      },
    },
  };
  const config = {
    overlayHost: { setVisible: noop, clearSource: noop },
  };
  const layerState = createFirmsState({ services, config });
  layerState._viewer = viewer;
  layerState._enabled = true;
  const components = {
    cards: { rebuildAmbientLabels: noop },
    selection: { refreshContextRegistrations: noop },
  };
  const context = { layerState, services, config, components, feed: null };
  components.model = createModel(context);
  const rendering = createRendering(context);
  const fire = (index, lon, frp) => ({
    index,
    lat: 30.2,
    lon,
    frp,
    confidence: 0.9,
    brightness: 340,
    acqMs: 1,
  });
  layerState._firesByFrp = [fire(0, -97.7, 900), fire(1, -97.6, 4)];
  const local = LOD_LEVELS.find((lod) => lod.id === 'local');
  rendering.renderDetections(local, null);

  const [host] = scene.added;
  assert.ok(host instanceof IconSetPrimitive, 'one GPU icon set');
  assert.deepEqual(sprites, ['firms'], 'at the fires’ draw order');
  const set = host.set;
  assert.equal(set.count, 2);
  const strong = set.row('firms-0');
  const weak = set.row('firms-1');
  assert.equal(set.flags(strong) & ICON_CULL_LIFT, ICON_CULL_LIFT);
  assert.ok(set.depthTestDistance(strong) >= 1e30, 'over depth everywhere');
  // One raster per colour at the sprite's size, drawn at the fire's size.
  assert.equal(set.width(strong), GLOW_SPRITE_PX);
  const drawnPx = (row) => set.width(row) * set.scale(row);
  assert.ok(Math.abs(drawnPx(strong) - 56) < 1e-4, `${drawnPx(strong)} px`);
  assert.ok(Math.abs(drawnPx(weak) - 24) < 1e-4, `${drawnPx(weak)} px`);
  assert.notEqual(set.imageFar(strong), set.imageFar(weak), 'red, not yellow');
  const tau = set.seconds(Cesium.JulianDate.now());
  const at = Cesium.Cartographic.fromCartesian(set.position(strong, tau));
  assert.ok(Math.abs(Cesium.Math.toDegrees(at.longitude) + 97.7) < 1e-6);
  assert.ok(Math.abs(at.height - 40) < 1e-3, 'at its anchor');
  assert.deepEqual(
    drawHitOf(host._pickObject('firms-0', null, { show: true })),
    {
      set: host.drawSetId,
      id: 'firms-0',
      meta: { layer: 'firms', id: 'firms-0' },
      surface: false,
    },
  );

  // A rebuild that keeps one fire writes nothing for it and drops the other.
  const written = [];
  const upsert = layerState._icons.upsert.bind(layerState._icons);
  layerState._icons.upsert = (items) => {
    written.push(...items.map((item) => item.id));
    return upsert(items);
  };
  layerState._firesByFrp = [layerState._firesByFrp[0]];
  rendering.renderDetections(local, null);
  assert.equal(set.count, 1);
  assert.equal(set.idAt(0), 'firms-0');
  assert.deepEqual(written, [], 'the kept fire is not written again');
  assert.equal(scene.added[0], host, 'the same host');

  // Hidden with the layer, and gone with it.
  layerState._icons.show = false;
  assert.equal(host.show, false);
  rendering.removeDetectionCollections();
  assert.equal(scene.added.length, 0);
});

test('the Radio layer draws its stations, clusters and selected marker as point and billboard sets', async () => {
  const { withRadioLayer, radioStationRow } =
    await import('../../testSupport/radioLayerHarness.mjs');
  const { radioLayer, radioStationIdFromPick } =
    await import('../../data/radio.js');
  const { fromDegrees, toLonLatH, WGS84 } =
    await import('../../geo/ellipsoid.js');
  const scene = fakeScene();
  const part = createCesiumDraw({
    scene,
    report: (error) => assert.fail(error),
  });
  // A flat projection, 1000 CSS px a degree from (-98, 31) at the top left.
  const renderer = {
    draw: part.port,
    canvas: { clientWidth: 2000, clientHeight: 1000 },
    camera: {
      pose: () => ({ position: fromDegrees(-97, 30, 1e6), height: 1e6 }),
      on: () => () => {},
    },
    query: {
      project(p) {
        const { lon, lat } = toLonLatH(p, WGS84);
        return { x: (lon + 98) * 1000, y: (31 - lat) * 1000 };
      },
    },
  };
  const station = (n, lon, lat) =>
    radioStationRow({
      id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
      name: `Station ${n}`,
      lon,
      lat,
      tags: ['news'],
      streamUrl: `https://radio.example.com/${n}.mp3`,
    });
  const stations = [
    station(1, -97.0, 30.0),
    station(2, -96.98, 30.0),
    station(3, -97.0, 29.98),
    station(4, -96.5, 30.0),
  ];
  await withRadioLayer({ stations, renderer }, async () => {
    const rows = (pattern) => {
      const out = [];
      for (const host of scene.added) {
        const collections =
          host instanceof Cesium.PrimitiveCollection
            ? [host.get(0), host.get(1)]
            : [host];
        for (const collection of collections)
          for (let i = 0; i < (collection?.length ?? 0); i += 1) {
            const primitive = collection.get(i);
            if (pattern.test(primitive.id?.set)) out.push(primitive);
          }
      }
      return out;
    };
    const dots = rows(/^radio:\d+:stations$/);
    assert.equal(dots.length, 4);
    assert.ok(dots.every((dot) => dot instanceof Cesium.PointPrimitive));
    const lone = dots.find((dot) => dot.show);
    assert.equal(
      lone.id.id,
      `radio:${stations[3].id}`,
      'the others are in a cluster',
    );
    assert.equal(lone.pixelSize, 13);
    assert.equal(lone.outlineWidth, 1);
    assert.ok(Math.abs(lone.color.alpha - 0.86) < 1e-6);
    assert.equal(lone.disableDepthTestDistance, Number.POSITIVE_INFINITY);
    assert.equal(lone.distanceDisplayCondition.far, 50_000_000);
    assert.equal(lone.scaleByDistance.nearValue, 1.15);
    assert.equal(
      radioStationIdFromPick({ primitive: lone, id: lone.id }),
      stations[3].id,
    );

    const [cluster] = rows(/^radio:\d+:clusters$/);
    assert.deepEqual(
      cluster.id.meta.stationIds,
      stations.slice(0, 3).map((s) => s.id),
    );
    assert.equal(cluster.pixelSize, 12 + Math.log2(3) * 1.6);
    assert.equal(cluster.outlineWidth, 2);
    assert.equal(
      radioStationIdFromPick({ primitive: cluster, id: cluster.id }),
      stations[0].id,
    );

    radioLayer.selectStation(stations[3].id, { autoplay: false, focus: false });
    const [selected] = rows(/^radio:\d+:selected$/);
    const [bracket] = rows(/^radio:\d+:selected-bracket$/);
    assert.equal(selected.pixelSize, 14);
    assert.equal(selected.id.id, `radio:selected:${stations[3].id}`);
    assert.ok(bracket instanceof Cesium.Billboard);
    assert.equal(bracket.width, 40);
    assert.equal(bracket.scaleByDistance.farValue, 0.72);
    assert.equal(
      radioStationIdFromPick({ primitive: bracket, id: bracket.id }),
      stations[3].id,
    );
  });
  assert.equal(scene.added.length, 0, 'gone with the layer');
});

test('vessels on a host without the sprite order still draw, at the default draw order', async () => {
  const scene = fakeScene();
  const { layer, viewer, part, unbind } = await vesselLayerOver(scene, {});
  const ship = { mmsi: '244000001', lat: 51.95, lon: 4.1, heading: 90 };
  layer.testing._setVesselStateForTest({ viewer, icons: null });
  layer.testing._reconcileVesselsForTest(viewer, [ship]);
  assert.equal(scene.added.length, 1, 'drawn');
  assert.equal(part.sets.get(scene.added[0].drawSetId).spec.drawOrder, 0);
  layer.destroy(viewer);
  unbind();
});

test('an aircraft layer draws its contacts as one GPU icon set moving on the delayed live clock', async () => {
  const { createAircraftIcons } =
    await import('../../data/aircraftIconLayer.js');
  const { IconSetPrimitive } = await import('./iconSetPrimitive.js');
  const { ICON_CULL_LIFT, ICON_RECEDES, ICON_ROTATES } =
    await import('../../data/iconSet.js');
  const { iconAtlas, nearImageSwitchPx } =
    await import('../../data/iconAtlas.js');
  const { aircraftIcon, FLEET_ICON_PX, TRACKED_ICON_PX } =
    await import('../../data/aircraftIcons.js');
  const { aircraftMotionRegime, createMotionRegime, fixEpochMs, julianAt } =
    await import('../../data/aircraftMotionRegime.js');
  const scene = fakeScene();
  const part = createCesiumDraw({
    scene,
    report: (error) => assert.fail(error),
  });
  const viewer = { scene };
  const unbind = bindRenderer(viewer, {
    draw: part.port,
    capabilities: new Set(['columns', 'motionSegments', 'courseGlide']),
    quality: { get: () => ({ pixelRatio: 2 }) },
  });
  const now = Date.now();
  const delayMs = 30_000;
  const fixAt = (lon, ms) => ({
    time: julianAt(ms),
    epochMs: ms,
    position: Cesium.Cartesian3.fromDegrees(lon, 30, 10_000),
    velocity: 250,
    track: 90,
  });
  const state = {
    _viewer: viewer,
    _icons: null,
    _iconFocusActive: 0,
    _positionHistory: new Map([
      ['abc123', [fixAt(-97, now - 40_000), fixAt(-96.9, now - 20_000)]],
    ]),
    _displayCourse: new Map(),
    _groundSnap: { forget() {} },
    _models: new Map(),
    _trackedIcao: null,
    _cockpitContactMode: false,
    _cockpitNearContacts: new Set(),
    records: {
      data: new Map([['abc123', { klass: 'airliner', velocity: 250 }]]),
      missingPolls: new Map(),
      forget() {},
    },
  };
  const parts = {
    motion: {
      _motionRegime: (history, info, renderTime) =>
        aircraftMotionRegime(
          history,
          info,
          renderTime,
          { speed: 'velocity', track: 'true_track' },
          createMotionRegime(),
        ),
      _displayTimeAt: julianAt,
      _fixEpochMs: fixEpochMs,
    },
    rendering: {
      _iconKind: (id, klass) => klass,
      _fleetBillboardScale: () => 1.25,
      _fleetBillboardColor: () => Cesium.Color.WHITE,
      _cockpitContactColor: () => Cesium.Color.CYAN,
      _releaseModel() {},
    },
  };
  const icons = createAircraftIcons({
    state,
    services: { focus: { focusPassIsNeeded: () => false } },
    parts,
    layerId: 'flights',
    renderDelaySec: delayMs / 1000,
    courseMaxDps: 3,
    cockpitContactSizePx: 6,
  });
  try {
    const setId = icons._createIcons(viewer);
    assert.match(setId, /^flights-icons:\d+$/);
    icons._addIcon('abc123');
    // Written together once the task ends.
    await Promise.resolve();
    const [host] = scene.added;
    assert.ok(host instanceof IconSetPrimitive, 'one GPU icon set');
    assert.equal(host.drawSetId, setId);
    const set = part.sets.get(setId).gpu.set;
    assert.equal(set.count, 1);
    const row = set.row('abc123');
    assert.equal(
      set.imageFar(row),
      iconAtlas.slot(aircraftIcon('airliner'), FLEET_ICON_PX),
      'the fleet glyph rasterised at 64 px',
    );
    assert.equal(
      set.imageNear(row),
      iconAtlas.slot(
        aircraftIcon('airliner', TRACKED_ICON_PX),
        TRACKED_ICON_PX,
      ),
      'the near glyph at 192 px',
    );
    assert.equal(set.imageSwitch(row), nearImageSwitchPx(2));
    assert.equal(set.width(row), 20);
    assert.ok(Math.abs(set.scale(row) - 1.25) < 1e-6);
    const flags = set.flags(row);
    assert.equal(flags & ICON_ROTATES, ICON_ROTATES);
    assert.equal(flags & ICON_RECEDES, ICON_RECEDES);
    assert.equal(flags & ICON_CULL_LIFT, ICON_CULL_LIFT);
    assert.ok(set.depthTestDistance(row) >= 1e30, 'over depth everywhere');
    // The set recedes by the aircraft tuning, and follows it when it changes.
    const recession = await import('../../data/aircraftRecession.js');
    assert.equal(
      part.sets.get(setId).spec.recede,
      recession.aircraftRecedeSpec(),
    );
    assert.equal('recede' in part.sets.get(setId).items.get('abc123'), false);
    try {
      recession.setAircraftRecessionParams({ scaleFloor: 0.6 });
      icons._syncRecede();
      assert.equal(host._recedeParams().scaleFloor, 0.6);
    } finally {
      recession.resetAircraftRecessionParams();
      icons._syncRecede();
    }
    assert.equal(host._recedeParams().scaleFloor, 0.45);

    // Drawn where the layer reads it, between its two fixes. The clock
    // holds still while both are read: the contact covers half a metre in
    // about a millisecond, so two readings of a moving clock may not agree.
    const realNow = Date.now;
    const frozen = realNow();
    Date.now = () => frozen;
    try {
      const t = frozen - delayMs;
      const tau = set.seconds(julianAt(t));
      const drawn = set.position(row, tau);
      const read = icons._iconPosition('abc123');
      assert.ok(Cesium.Cartesian3.distance(drawn, read) < 0.5, 'same place');
      const lon = Cesium.Math.toDegrees(
        Cesium.Cartographic.fromCartesian(drawn).longitude,
      );
      assert.ok(lon > -97 && lon < -96.9, 'interpolating the fixes');
      assert.ok(
        Math.abs(set.course(row, tau) - icons._iconCourse('abc123')) < 0.01,
      );
    } finally {
      Date.now = realNow;
    }
    assert.equal(state._icons.expires('abc123'), now - 20_000);
    assert.deepEqual(
      drawHitOf(host._pickObject('abc123', null, { show: true })),
      {
        set: setId,
        id: 'abc123',
        meta: { layer: 'flights', id: 'abc123' },
        surface: false,
      },
    );

    // A restyle that changes nothing writes nothing; hiding it writes it.
    const before = part.sets.get(setId).items.get('abc123');
    icons._applyIconPresentation('abc123');
    await Promise.resolve();
    assert.equal(part.sets.get(setId).items.get('abc123'), before);
    icons._setIconShown('abc123', false);
    await Promise.resolve();
    assert.equal(set.shown(row), false);

    icons._forgetContact('abc123');
    await Promise.resolve();
    assert.equal(set.count, 0);
    icons._disposeIcons();
    assert.equal(scene.added.length, 0, 'disposed: the set goes');
  } finally {
    unbind();
  }
});
test('an extruded outline-only shape draws the volume edges, not a ring at its base', () => {
  const scene = fakeScene();
  const { draw } = drawOver(scene);
  const set = draw.shapes({ id: 'volumes' });
  const ring = [
    { lon: 0, lat: 0, height: 100 },
    { lon: 0.001, lat: 0, height: 100 },
    { lon: 0.001, lat: 0.001, height: 100 },
  ];
  set.set([
    {
      id: 'cage',
      geometry: { kind: 'polygon', rings: [ring] },
      outline: [1, 0.7, 0.3, 0.32],
      outlineOnly: true,
      extrudeHeight: 220,
      height: 'absolute',
    },
  ]);
  const edges = scene.added[0].get(0);
  assert.ok(edges instanceof Cesium.Primitive);
  assert.ok(
    [edges.geometryInstances].flat()[0].geometry instanceof
      Cesium.PolygonOutlineGeometry,
  );
  set.dispose();
});

test('an unclamped shape filled with an image draws a textured primitive and frees its material with its host', () =>
  withImageClasses(() => {
    const scene = fakeScene();
    const draw = createCesiumDraw({
      scene,
      report: (error) => assert.fail(error),
    }).port;
    const set = draw.shapes({ id: 'images' });
    set.set([
      {
        id: 'image',
        geometry: {
          kind: 'rectangle',
          rect: { west: 2, south: 1, east: 2.1, north: 1.1 },
          height: 200,
        },
        fill: { image: 'picture.png', repeat: [2, 3] },
      },
    ]);
    const host = scene.added[0];
    const primitive = host.get(0);
    assert.ok(primitive instanceof Cesium.Primitive);
    const { appearance, geometryInstances } = primitive;
    assert.ok(appearance instanceof Cesium.MaterialAppearance);
    assert.equal(appearance.material.type, 'Image');
    assert.equal(appearance.material.uniforms.image, 'picture.png');
    assert.equal(appearance.isTranslucent(), true, 'its own alpha blends');
    assert.deepEqual(
      appearance.material.uniforms.repeat,
      new Cesium.Cartesian2(2, 3),
    );
    assert.deepEqual(
      [appearance.flat, appearance.faceForward, appearance.translucent],
      [true, true, true],
    );
    assert.ok(geometryInstances.geometry instanceof Cesium.RectangleGeometry);
    // Texture coordinates for the image, as its appearance reads them.
    assert.equal(geometryInstances.geometry._vertexFormat.st, true);
    assert.equal(geometryInstances.id.id, 'image');
    assert.equal(
      drawHitOf({ primitive, id: geometryInstances.id }).set,
      'images',
    );
    const material = appearance.material;
    // As Cesium's collection does, a removed host is destroyed; a
    // rebuild's old host goes with its material.
    scene.primitives.remove = (primitive) => {
      const at = scene.added.indexOf(primitive);
      if (at >= 0) scene.added.splice(at, 1);
      primitive.destroy();
      return at >= 0;
    };
    set.upsert([
      {
        id: 'image',
        geometry: {
          kind: 'rectangle',
          rect: { west: 2, south: 1, east: 2.2, north: 1.1 },
        },
        fill: { image: 'picture.png' },
      },
    ]);
    assert.equal(material.isDestroyed(), true);
    const next = scene.added[0].get(0).appearance.material;
    assert.equal(next.isDestroyed(), false);
    set.dispose();
    assert.equal(scene.added.length, 0);
    assert.equal(next.isDestroyed(), true);
    assert.throws(
      () =>
        draw.shapes({ id: 'patterns' }).set([
          {
            id: 'p',
            geometry: {
              kind: 'rectangle',
              rect: { west: 0, south: 0, east: 1, north: 1 },
            },
            fill: { gradient: 'radial' },
          },
        ]),
      /colours only/,
    );
  }));

test('an unclamped image fill takes a new canvas in place; anything else about it rebuilds', () =>
  withImageClasses(() => {
    const scene = fakeScene();
    const draw = createCesiumDraw({
      scene,
      report: (error) => assert.fail(error),
    }).port;
    const set = draw.shapes({ id: 'band' });
    const canvases = [new HTMLCanvasElement(), new HTMLCanvasElement()];
    const band = (k, extra = {}) => ({
      id: 'band',
      geometry: {
        kind: 'ellipse',
        center: { lon: 10, lat: 20, height: 2500 },
        semiMajor: 50_000,
        semiMinor: 50_000,
      },
      fill: { image: { canvas: canvases[k % 2], key: `band:${k}` } },
      height: 'absolute',
      ...extra,
    });
    set.set([band(0)]);
    const host = scene.added[0];
    const primitive = host.get(0);
    const material = primitive.appearance.material;
    assert.equal(material.uniforms.image, canvases[0]);
    // Not yet drawn, it rebuilds.
    set.upsert([band(1)]);
    assert.notEqual(scene.added[0], host, 'not yet drawn: rebuilt');
    const drawn = scene.added[0].get(0);
    drawn._ready = true;
    const drawnMaterial = drawn.appearance.material;
    // Drawn, a new canvas, its show and its meta change in place; with no
    // drawing context the material takes the canvas itself.
    set.upsert([band(2, { meta: 'm', show: false })]);
    assert.equal(scene.added[0].get(0), drawn, 'changed in place');
    assert.equal(drawnMaterial.uniforms.image, canvases[0]);
    assert.equal(drawn.show, false);
    set.upsert([band(3)]);
    assert.equal(scene.added[0].get(0), drawn);
    assert.equal(drawnMaterial.uniforms.image, canvases[1]);
    assert.equal(drawn.show, true);
    // The same key is the same image: nothing is written.
    drawnMaterial.uniforms.image = 'untouched';
    set.upsert([band(3)]);
    assert.equal(drawnMaterial.uniforms.image, 'untouched');
    // Another shape or height rebuilds.
    set.upsert([{ ...band(4), height: 'clampGround' }]);
    assert.notEqual(scene.added[0].get?.(0), drawn, 'rebuilt');
    set.dispose();
  }));

test('a draped rectangle turns, its image fill with it, on a ground primitive that owns its material', () =>
  withImageClasses(() => {
    const scene = fakeScene();
    const draw = createCesiumDraw({
      scene,
      report: (error) => assert.fail(error),
    }).port;
    const set = draw.shapes({ id: 'overlays' });
    const overlay = (extra = {}) => ({
      id: 'overlay',
      geometry: {
        kind: 'rectangle',
        rect: { west: 2, south: 1, east: 2.1, north: 1.1 },
        rotation: 0.4,
      },
      fill: { image: 'overlay.png' },
      height: 'clampGround',
      ...extra,
    });
    const tinted = {
      id: 'tinted',
      geometry: {
        kind: 'rectangle',
        rect: { west: 2, south: 1, east: 2.1, north: 1.1 },
        rotation: -0.2,
      },
      fill: [1, 0, 0, 0.5],
      height: 'clampGround',
    };
    set.set([overlay(), tinted]);
    const grounds = () => {
      const host = scene.added[0];
      const out = [];
      for (let i = 0; i < host.length; i++)
        if (host.get(i) instanceof Cesium.GroundPrimitive)
          out.push(host.get(i));
      return out;
    };
    const [image, colour] = grounds();
    assert.equal(
      grounds().length,
      2,
      'the image on a ground primitive of its own',
    );
    const { appearance, geometryInstances } = image;
    assert.ok(appearance instanceof Cesium.MaterialAppearance);
    assert.equal(appearance.material.type, 'Image');
    assert.equal(appearance.material.uniforms.image, 'overlay.png');
    const [instance] = geometryInstances;
    assert.equal(instance.id.id, 'overlay');
    assert.equal(instance.geometry._rotation, 0.4);
    assert.equal(instance.geometry._stRotation, 0.4, 'the image turns with it');
    assert.equal(instance.attributes.color, undefined);
    assert.equal(colour.geometryInstances[0].geometry._rotation, -0.2);
    // Hiding it is a change of its show, not a rebuild.
    const host = scene.added[0];
    set.upsert([overlay({ show: false })]);
    assert.equal(scene.added[0], host, 'not rebuilt');
    const material = appearance.material;
    scene.primitives.remove = (primitive) => {
      const at = scene.added.indexOf(primitive);
      if (at >= 0) scene.added.splice(at, 1);
      primitive.destroy();
      return at >= 0;
    };
    set.dispose();
    assert.equal(material.isDestroyed(), true, 'its material goes with it');
    // Not rotated, it is as before.
    const plain = draw.shapes({ id: 'plain' });
    plain.set([
      overlay({
        geometry: {
          kind: 'rectangle',
          rect: { west: 2, south: 1, east: 2.1, north: 1.1 },
        },
      }),
    ]);
    const [flat] = grounds();
    assert.equal(flat.geometryInstances[0].geometry._rotation, 0);
    plain.dispose();
    // An atlas slot fills as the image it holds; one not registered is
    // refused before anything is built.
    const made = scene.added.length;
    assert.throws(
      () =>
        draw
          .shapes({ id: 'atlas' })
          .set([
            overlay(),
            overlay({ id: 'b', fill: { image: { atlas: 'a', slot: 's' } } }),
          ]),
      /atlas a has no slot s registered/,
    );
    assert.equal(scene.added.length, made, 'nothing drawn');
    draw.atlas('a', { s: 'slot.png' });
    const slotted = draw.shapes({ id: 'atlas-registered' });
    slotted.set([
      overlay({ id: 'b', fill: { image: { atlas: 'a', slot: 's' } } }),
    ]);
    assert.ok(scene.added.length > made, 'drawn from the slot');
    slotted.dispose();
  }));

test('scene data packs draw their geometry and media marker through the Cesium draw port on a viewer of its own', async (t) => {
  const names = [
    'HTMLCanvasElement',
    'HTMLImageElement',
    'ImageBitmap',
    'OffscreenCanvas',
  ];
  const real = names.map((name) => globalThis[name]);
  for (const name of names) globalThis[name] ??= class {};
  t.after(() => names.forEach((name, i) => (globalThis[name] = real[i])));
  const { createPackPresentations } =
    await import('../../scenes/dataPacks/presentation.js');
  const scene = fakeScene();
  const viewer = { scene, container: {} };
  const targets = new Map();
  const presentations = createPackPresentations(viewer, targets, {
    store: { publish() {} },
    overlayHost: { setEntries() {}, clearSource() {} },
  });
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'point',
          geometry: { type: 'Point', coordinates: [2, 1, 10] },
        },
        {
          type: 'Feature',
          id: 'line',
          geometry: {
            type: 'LineString',
            coordinates: [
              [2, 1, 5],
              [2.1, 1.1, 5],
            ],
          },
        },
        {
          type: 'Feature',
          id: 'area',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [2, 1, 50],
                [2.1, 1, 50],
                [2.1, 1.1, 50],
                [2, 1, 50],
              ],
            ],
          },
        },
      ],
    }),
  );
  const pack = { id: 'data', attribution: { text: 'Example', license: 'CC0' } };
  const geometry = await presentations.geojson({
    pack,
    asset: { bytes, mimeType: 'application/geo+json' },
    signal: new AbortController().signal,
  });
  const [points, lines, shapes] = scene.added;
  assert.ok(points instanceof Cesium.PointPrimitiveCollection);
  assert.equal(points.get(0).pixelSize, 12);
  assert.equal(points.get(0).outlineWidth, 2);
  assert.ok(Cesium.Color.CYAN.equals(points.get(0).color));
  // The collection, beside where its static batch goes.
  assert.ok(lines.get(0) instanceof Cesium.PolylineCollection);
  assert.equal(lines.get(0).get(0).width, 4);
  const fill = shapes.get(0);
  assert.ok(fill.geometryInstances.geometry instanceof Cesium.PolygonGeometry);
  assert.equal(fill.appearance.translucent, true);
  assert.equal(fill.appearance.flat, true);
  // A click names the feature's set and item, which the targets hold.
  const line = lines.get(0).get(0);
  const hit = drawHitOf({ primitive: line, id: line.id });
  assert.deepEqual(targets.get(JSON.stringify(['data', 'line'])), {
    set: hit.set,
    id: hit.id,
  });
  const media = await presentations.media({
    pack: { ...pack, id: 'sound', placement: { anchorId: 'here' } },
    anchors: [{ id: 'here', lon: 2, lat: 1, alt: 5 }],
    asset: { bytes: new Uint8Array(4), mimeType: 'audio/mpeg' },
    signal: new AbortController().signal,
  });
  const marker = scene.added[3].get(0);
  assert.equal(marker.pixelSize, 16);
  assert.ok(Cesium.Color.fromCssColorString('#ffff00').equals(marker.color));
  geometry.dispose();
  media.dispose();
  assert.equal(scene.added.length, 0);
  assert.equal(targets.size, 0);
});

test('flow lines run their dashes toward the end, draped or not, on the frame clock', () =>
  withImageClasses(() => {
    const scene = fakeScene();
    let asked = 0;
    const request = scene.requestRender;
    scene.requestRender = function () {
      asked += 1;
      return request.call(this);
    };
    const { draw, frame } = drawOver(scene);
    const set = draw.lines({ id: 'flowing' });
    const style = {
      kind: 'flow',
      color: [0.2, 0.8, 1, 0.95],
      repeat: 64,
      duty: 0.46,
      speed: 0.55,
    };
    const positions = [
      { lon: 0, lat: 0 },
      { lon: 1, lat: 1 },
    ];
    set.set([
      { id: 'route', positions, widthPx: 9, mode: 'draped', style },
      {
        id: 'edge',
        positions,
        widthPx: 2,
        mode: 'draped',
        clampTo: 'terrain',
        style: { kind: 'solid', color: '#fff' },
      },
      { id: 'air', positions, widthPx: 3, mode: '3d', style },
    ]);
    const host = scene.added[0];
    const polylines = host.get(0);
    const solid = host.get(1);
    const draped = host.get(2);
    assert.ok(solid.appearance instanceof Cesium.PolylineColorAppearance);
    assert.equal(solid.classificationType, Cesium.ClassificationType.TERRAIN);
    assert.ok(draped instanceof Cesium.GroundPolylinePrimitive);
    assert.ok(draped.appearance instanceof Cesium.PolylineMaterialAppearance);
    assert.equal(draped.classificationType, Cesium.ClassificationType.BOTH);
    assert.equal(draped.geometryInstances[0].geometry.width, 9);
    assert.equal(draped.geometryInstances[0].id.id, 'route');
    const material = draped.appearance.material;
    assert.equal(material.type, 'DrawFlowLine');
    assert.equal(material.uniforms.repeat, 64);
    assert.equal(material.uniforms.duty, 0.46);
    assert.equal(material.uniforms.speed, 0.55);
    assert.ok(
      Cesium.Color.equals(
        material.uniforms.color,
        new Cesium.Color(0.2, 0.8, 1, 0.95),
      ),
    );
    const air = polylines.get(0);
    assert.equal(air.material.type, 'DrawFlowLine', 'an undraped one too');
    // The dashes run on the frame clock.
    material.uniforms.time = -1;
    air.material.uniforms.time = -1;
    asked = 0;
    frame();
    assert.ok(material.uniforms.time >= 0, 'draped: its clock moved');
    assert.ok(
      material.uniforms.time < 1 / 0.55,
      'wrapped to one cell, so the uniform keeps its digits',
    );
    assert.ok(air.material.uniforms.time >= 0, 'undraped: its clock moved');
    assert.ok(asked > 0, 'and it asks for the frames that follow');
    // A shown flow line hides in place once its ground is ready.
    Object.defineProperty(draped, 'ready', { value: true });
    const shown = new Uint8Array([1]);
    draped.getGeometryInstanceAttributes = () => ({ show: shown });
    set.upsert([
      {
        id: 'route',
        positions,
        widthPx: 9,
        mode: 'draped',
        style,
        show: false,
      },
    ]);
    assert.equal(scene.added[0], host, 'changed in place');
    assert.deepEqual([...shown], [0]);
    // Hidden or gone, a set asks for no more frames.
    set.upsert([
      { id: 'air', positions, widthPx: 3, mode: '3d', style, show: false },
    ]);
    asked = 0;
    frame();
    assert.equal(asked, 0, 'its flow lines hidden, it asks for no frames');
    set.upsert([{ id: 'air', positions, widthPx: 3, mode: '3d', style }]);
    asked = 0;
    frame();
    assert.ok(asked > 0, 'shown again, it does');
    set.show = false;
    asked = 0;
    frame();
    assert.equal(asked, 0, 'a hidden set asks for no frames');
    set.show = true;
    set.clear();
    asked = 0;
    frame();
    assert.equal(asked, 0, 'an emptied set asks for none');
    // Patterns drape too, on a ground polyline of their own.
    set.set([
      {
        id: 'pattern',
        positions,
        widthPx: 1,
        mode: 'draped',
        style: { kind: 'pattern', image: 'a.png', repeat: 2 },
      },
    ]);
    const grounds = [];
    const walk = (p) => {
      if (p instanceof Cesium.PrimitiveCollection)
        for (let i = 0; i < p.length; i++) walk(p.get(i));
      else if (p instanceof Cesium.GroundPolylinePrimitive) grounds.push(p);
    };
    walk(scene.added.at(-1));
    assert.equal(grounds.length, 1);
    assert.equal(grounds[0].appearance.material.type, 'Image');
    set.dispose();
  }));

test('a line with a depth-fail colour draws it behind the surface, and moves in place', () =>
  withImageClasses(() => {
    const { scene, draw } = drawOver();
    const set = draw.lines({ id: 'head' });
    const head = (height, extra = {}) => ({
      id: 'gev-trail:head',
      positions: [
        Cesium.Cartesian3.fromDegrees(0, 0, 100),
        Cesium.Cartesian3.fromDegrees(0.01, 0.01, height),
      ],
      widthPx: 2.5,
      mode: 'geodesic',
      style: { kind: 'solid', color: [1, 0, 1, 0.9] },
      depthFail: { kind: 'solid', color: [1, 0, 1, 0.45] },
      meta: height,
      ...extra,
    });
    set.set([
      head(200),
      {
        id: 'plain',
        positions: [
          Cesium.Cartesian3.fromDegrees(0, 0, 0),
          Cesium.Cartesian3.fromDegrees(1, 0, 0),
        ],
        widthPx: 1,
        mode: '3d',
        style: { kind: 'solid', color: '#fff' },
        depthFail: null,
      },
    ]);
    const host = scene.added[0];
    assert.ok(host instanceof Cesium.PrimitiveCollection);
    const polylines = host.get(0);
    const deep = host.get(1);
    assert.equal(polylines.length, 1, 'null: drawn as the plain lines are');
    assert.equal(polylines.get(0).id.id, 'plain');
    const first = deep.get(0);
    assert.ok(first instanceof Cesium.Primitive);
    assert.equal(first.geometryInstances.geometry._width, 2.5);
    const id = first.geometryInstances.id;
    assert.equal(id.id, 'gev-trail:head');
    assert.equal(id.set, 'head');
    assert.ok(
      Cesium.Color.equals(
        first.depthFailAppearance.material.uniforms.color,
        new Cesium.Color(1, 0, 1, 0.45),
      ),
    );
    assert.ok(
      Cesium.Color.equals(
        first.appearance.material.uniforms.color,
        new Cesium.Color(1, 0, 1, 0.9),
      ),
    );
    // Moved: built anew where it now runs, under the same pick id.
    set.upsert([head(300)]);
    assert.equal(scene.added[0], host, 'the set is not rebuilt');
    assert.equal(deep.length, 1, 'the old one goes');
    const moved = deep.get(0);
    assert.notEqual(moved, first);
    assert.equal(moved.geometryInstances.id, id, 'the same pick id');
    assert.equal(id.meta, 300, 'with its new meta');
    const end = moved.geometryInstances.geometry._positions.at(-1);
    assert.ok(
      Cesium.Cartesian3.equalsEpsilon(
        end,
        Cesium.Cartesian3.fromDegrees(0.01, 0.01, 300),
        1e-6,
      ),
    );
    // Positions that make no line draw nothing, until they do again.
    set.upsert([head(300, { positions: [] })]);
    assert.equal(deep.length, 0);
    set.upsert([head(400, { show: false })]);
    assert.equal(deep.length, 1);
    assert.equal(deep.get(0).show, false, 'hidden as asked');
    // A new colour is a new look: rebuilt.
    set.upsert([
      head(400, { depthFail: { kind: 'solid', color: [1, 1, 1, 1] } }),
    ]);
    assert.notEqual(scene.added[0], host);
    set.dispose();
    assert.equal(scene.added.length, 0);
  }));

test('a dashed depth-fail style dashes the parts behind the surface, in its colour', () =>
  withImageClasses(() => {
    const { scene, draw } = drawOver();
    const set = draw.lines({ id: 'band' });
    const band = (extra = {}) => ({
      id: 'band',
      positions: [
        Cesium.Cartesian3.fromDegrees(0, 0, 100),
        Cesium.Cartesian3.fromDegrees(0.01, 0.01, 100),
      ],
      widthPx: 3,
      mode: 'geodesic',
      style: { kind: 'dash', color: [1, 1, 0, 0.9], length: 16 },
      depthFail: { kind: 'dash', color: [0, 1, 1, 0.35], length: 16 },
      ...extra,
    });
    set.set([band()]);
    const host = scene.added[0];
    const deep = host.get(1).get(0);
    const hidden = deep.depthFailAppearance.material;
    assert.equal(hidden.type, 'PolylineDash');
    assert.ok(
      Cesium.Color.equals(
        hidden.uniforms.color,
        new Cesium.Color(0, 1, 1, 0.35),
      ),
    );
    assert.equal(hidden.uniforms.dashLength, 16);
    assert.equal(hidden.uniforms.dashPattern, 255, 'the default pattern');
    // A move keeps the dash; its fields in another order are the same look.
    set.upsert([
      band({ depthFail: { length: 16, color: [0, 1, 1, 0.35], kind: 'dash' } }),
    ]);
    assert.equal(scene.added[0], host, 'not rebuilt');
    assert.equal(
      host.get(1).get(0).depthFailAppearance.material.type,
      'PolylineDash',
    );
    const patternedBand = (fields) =>
      band({ depthFail: { kind: 'dash', color: [0, 1, 1, 0.35], ...fields } });
    set.upsert([patternedBand({ pattern16: 0xf0f0, length: 8 })]);
    const patterned = scene.added[0].get(1).get(0).depthFailAppearance.material;
    assert.equal(patterned.uniforms.dashPattern, 0xf0f0);
    assert.equal(patterned.uniforms.dashLength, 8);
    const again = scene.added[0];
    set.upsert([patternedBand({ length: 8, pattern16: 0xf0f0 })]);
    assert.equal(scene.added[0], again, 'the same dash in another order');
    // Solid behind the surface: a new look.
    set.upsert([
      band({ depthFail: { kind: 'solid', color: [0, 1, 1, 0.35] } }),
    ]);
    assert.notEqual(scene.added[0], host, 'rebuilt');
    const solid = scene.added[0].get(1).get(0).depthFailAppearance.material;
    assert.equal(solid.type, 'Color');
    set.dispose();
  }));

test('a draped flow line still drawing while its rebuilds build keeps flowing', () =>
  withImageClasses(() => {
    const { scene, draw, frame } = drawOver();
    const set = draw.lines({ id: 'reflowing' });
    const route = (lon) => ({
      id: 'route',
      positions: [
        { lon: 0, lat: 0 },
        { lon, lat: 1 },
      ],
      widthPx: 9,
      mode: 'draped',
      style: {
        kind: 'flow',
        color: '#39d0ff',
        repeat: 64,
        duty: 0.46,
        speed: 1,
      },
    });
    set.set([route(1)]);
    const host = scene.added[0];
    const first = host.get(1);
    Object.defineProperty(first, 'ready', { value: true });
    frame();
    // Two rebuilds while the first still draws in their place.
    set.set([route(2)]);
    set.set([route(3)]);
    assert.ok(scene.added.includes(host), 'the first still draws');
    const material = first.appearance.material;
    material.uniforms.time = -1;
    frame();
    assert.ok(material.uniforms.time >= 0, 'and keeps its clock');
    set.dispose();
  }));

test('the directions layer draws its markers, flowing route and maneuver dots on a viewer of its own', async (t) => {
  // Materials check their uniforms against the DOM's image classes.
  const names = [
    'HTMLCanvasElement',
    'HTMLImageElement',
    'ImageBitmap',
    'OffscreenCanvas',
  ];
  const real = names.map((name) => globalThis[name]);
  for (const name of names) globalThis[name] ??= class {};
  t.after(() => names.forEach((name, i) => (globalThis[name] = real[i])));
  {
    const { createDirectionsLayer } =
      await import('../../layers/directions/index.js');
    const { fakeInput } = await import('../../input/testDoubles.mjs');
    const ownership = await import('../../data/inputOwnership.js');
    const scene = fakeScene();
    scene.pickResult = undefined;
    scene.pick = () => scene.pickResult;
    scene.drillPick = () => [];
    const viewer = { scene, isDestroyed: () => false };
    const clicks = fakeInput(viewer);
    const noop = () => {};
    const sprites = [];
    const overlays = [];
    const layer = createDirectionsLayer({
      source: {
        getRoute: async () => ({
          ok: true,
          distanceM: 2000,
          durationS: 200,
          geometry: [
            [-97.74, 30.26],
            [-97.73, 30.27],
            [-97.72, 30.27],
          ],
          steps: [
            { instruction: 'Depart', lat: 30.26, lon: -97.74 },
            { instruction: 'Turn left', lat: 30.27, lon: -97.73 },
            { instruction: 'Arrive', lat: 30.27, lon: -97.72 },
          ],
        }),
      },
      services: {
        render: {
          governorRequestRender: noop,
          holdContinuousRender: noop,
          releaseContinuousRender: noop,
        },
        sprites: {
          spriteDrawOrder: (layerId) => {
            sprites.push(layerId);
            return spriteDrawOrder(layerId);
          },
        },
        picking: { registerPickOwner: noop, unregisterPickOwner: noop },
        overlays: {
          setOverlayEntries: (source, entries) =>
            overlays.push([source, entries]),
          setOverlaySourceVisible: noop,
          clearOverlaySource: noop,
        },
        ground: {
          GROUND_FLOOR_LIFT_M: 2,
          cachedGroundFloor: () => 150,
          warmGroundFloor: noop,
          resolveGroundFloorCells: async () => {},
        },
        input: ownership,
        camera: {},
      },
    });
    ownership.resetPointerOwnership();
    // Let go even when an assertion fails, so nothing leaks into later tests.
    t.after(() => {
      layer.destroy(viewer);
      clicks.destroy();
      ownership.resetPointerOwnership();
    });
    layer.init(viewer);
    layer.enable(viewer);
    layer.placeEndpoint('a', { lat: 30.26, lon: -97.74 });
    layer.placeEndpoint('b', { lat: 30.27, lon: -97.72 });

    const hostOf = (suffix) =>
      scene.added.find((host) => host.drawSetId?.endsWith(suffix));
    // The route is asked for, then drawn.
    const deadline = Date.now() + 5000;
    while (!(hostOf(':route')?.length > 0) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    // A and B: dots on the ground, drawn over everything.
    const markers = hostOf(':markers');
    assert.ok(markers instanceof Cesium.BillboardCollection);
    assert.equal(markers.length, 2);
    const a = markers.get(0);
    assert.equal(a.id.id, 'directions:marker:A');
    assert.equal(a.disableDepthTestDistance, Infinity);
    assert.equal(a.heightReference, Cesium.HeightReference.CLAMP_TO_GROUND);
    // The route: the annotation's flowing dashes, draped on everything.
    const route = hostOf(':route');
    const ground = route.get(1);
    assert.ok(ground instanceof Cesium.GroundPolylinePrimitive);
    assert.equal(ground.classificationType, Cesium.ClassificationType.BOTH);
    assert.equal(ground.geometryInstances[0].geometry.width, 9);
    assert.equal(ground.geometryInstances[0].id.id, 'directions:route');
    const flow = ground.appearance.material.uniforms;
    assert.deepEqual(
      [flow.repeat, flow.duty, flow.speed, flow.color.alpha],
      [64, 0.46, 0.55, 0.95],
    );
    // One maneuver dot, at its junction on the ground floor, at the
    // directions' draw order.
    const steps = hostOf(':steps');
    assert.ok(steps instanceof Cesium.PointPrimitiveCollection);
    assert.equal(steps.blendOption, Cesium.BlendOption.TRANSLUCENT);
    assert.deepEqual(sprites, ['directions']);
    assert.equal(steps.length, 1);
    const dot = steps.get(0);
    assert.equal(dot.id.id, 'directions:step:1');
    assert.equal(dot.show, true);
    assert.equal(dot.pixelSize, 8);
    assert.equal(dot.disableDepthTestDistance, Infinity);
    const at = Cesium.Cartographic.fromCartesian(dot.position);
    assert.ok(Math.abs(at.height - 152) < 1e-6, 'floor plus its lift');

    // A click on the dot opens its card and enlarges it, in place.
    scene.pickResult = { primitive: dot, id: dot.id };
    clicks.click({ x: 10, y: 10 });
    assert.equal(steps.get(0), dot, 'the same point');
    assert.equal(dot.pixelSize, 13);
    const card = overlays.findLast(([source]) => source === 'directions-step');
    assert.equal(card[1][0].id, 'directions-step-1');
    // Empty map closes it.
    scene.pickResult = undefined;
    clicks.click({ x: 10, y: 10 });
    assert.equal(dot.pixelSize, 8);

    layer.disable(viewer);
    assert.equal(hostOf(':markers').length, 0, 'markers cleared');
    layer.destroy(viewer);
    clicks.destroy();
    ownership.resetPointerOwnership();
    assert.equal(scene.added.length, 0, 'every set let go');
  }
});

test('the local ADS-B layer draws its aircraft, 978 MHz rings and trail head on a viewer of its own', async (t) => {
  // Materials check their uniforms against the DOM's image classes.
  const names = [
    'HTMLCanvasElement',
    'HTMLImageElement',
    'ImageBitmap',
    'OffscreenCanvas',
  ];
  const real = names.map((name) => globalThis[name]);
  for (const name of names) globalThis[name] ??= class {};
  t.after(() => names.forEach((name, i) => (globalThis[name] = real[i])));
  await import('./frame.js');
  const { createLocalAdsbLayer } =
    await import('../../layers/localAdsb/index.js');
  const { fakeInput } = await import('../../input/testDoubles.mjs');
  const { toLonLatH } = await import('../../geo/ellipsoid.js');
  const scene = fakeScene();
  // What a frame port over the scene listens to.
  scene.preUpdate = new Cesium.Event();
  scene.forceRender = () => {};
  scene.pick = () => undefined;
  scene.drillPick = () => [];
  const viewer = {
    scene,
    clock: new Cesium.Clock(),
    isDestroyed: () => false,
  };
  const clicks = fakeInput(viewer);
  const noop = () => {};
  const clock = { now: 100_000 };
  const aircraft = (icao, band, lat) => ({
    icao,
    callsign: icao.toUpperCase(),
    lat,
    lon: 0,
    altitudeFt: 10_000,
    groundSpeedKt: 180,
    trackDeg: 0,
    verticalRateFpm: 0,
    lastPositionAt: clock.now,
    lastMessageAt: clock.now,
    messageCount: 3,
    band,
    source: 'feed',
  });
  const records = [
    aircraft('abc123', '1090', 0),
    aircraft('a1b2c3', '978', 0.1),
  ];
  const layer = createLocalAdsbLayer({
    receiver: {
      getState: () => ({ aircraft: [] }),
      subscribe: () => noop,
      setMode: async () => true,
    },
    feeds: {
      getState: () => ({ configured: true, feeds: [], records }),
      subscribe: () => noop,
      start: noop,
      stop: noop,
    },
    services: {
      render: { governorRequestRender: noop },
      context: {
        registerEntityContext: noop,
        selectEntityContext: (carrier) => ({
          id: 'local-adsb:abc123',
          carrier,
        }),
        getSelectedEntityContext: () => ({ id: 'local-adsb:abc123' }),
        clearSelectedEntityContextForLayer: noop,
        removeEntityContextsForLayer: noop,
      },
      picking: { registerPickOwner: noop, unregisterPickOwner: noop },
      trails: await import('../../data/trailRenderer.js'),
    },
    now: () => clock.now,
  });
  layer.init(viewer);
  await layer.enable();
  await layer.update();
  assert.equal(layer.selectAircraft('abc123'), true);

  const hostOf = (suffix) =>
    scene.added.find((host) => host.drawSetId?.endsWith(suffix));
  // Aircraft: magenta icons drawn over depth out to 2,000 km.
  const markers = hostOf(':markers');
  assert.ok(markers instanceof Cesium.BillboardCollection);
  assert.equal(markers.length, 2);
  const icon = markers.get(0);
  assert.equal(icon.id.id, 'local-adsb:abc123');
  assert.equal(icon.disableDepthTestDistance, Infinity);
  assert.equal(icon.distanceDisplayCondition.far, 2_000_000);
  assert.ok(icon.scaleByDistance instanceof Cesium.NearFarScalar);
  assert.deepEqual(
    [icon.scaleByDistance.near, icon.scaleByDistance.nearValue],
    [1000, 3],
  );
  assert.ok(icon.color.equals(Cesium.Color.fromCssColorString('#ff4fd8')));
  // The UAT-only aircraft's ring: an outline, shown as far as it is.
  const rings = hostOf(':rings');
  assert.ok(rings instanceof Cesium.PointPrimitiveCollection);
  assert.equal(rings.length, 1);
  const ring = rings.get(0);
  assert.equal(ring.id.id, 'local-adsb:a1b2c3');
  assert.equal(ring.outlineWidth, 1.5);
  assert.equal(ring.color.alpha, 0);
  assert.equal(ring.distanceDisplayCondition.far, 2_000_000);
  // Selected at its fix, the trail and its head have no length yet.
  const trailHost = () =>
    scene.added.find((host) => host.drawSetId?.startsWith('trail:'));
  assert.equal(trailHost(), undefined);

  // A frame flies them on, in place.
  const before = toLonLatH(icon.position).lat;
  clock.now += 1_000;
  scene.preRender.raiseEvent(scene, Cesium.JulianDate.now());
  assert.equal(markers.get(0), icon, 'the same billboard');
  assert.ok(toLonLatH(icon.position).lat > before);
  assert.equal(rings.get(0).id.id, 'local-adsb:a1b2c3');
  // The head now runs from the fix to the aircraft, dimmed, not hidden,
  // behind the surface.
  const deep = trailHost().get(1);
  assert.equal(deep.length, 1);
  const line = deep.get(0);
  assert.ok(line instanceof Cesium.Primitive);
  assert.match(line.geometryInstances.id.id, /^gev-trail:\d+:head$/);
  const fail = line.depthFailAppearance.material.uniforms.color;
  assert.ok(
    fail.equals(Cesium.Color.fromCssColorString('#ff4fd8').withAlpha(0.45)),
  );

  await layer.disable();
  layer.destroy();
  clicks.destroy();
  assert.equal(hostOf(':markers'), undefined, 'every set let go');
});

/** Run `fn` as if Cesium's approximate terrain heights had loaded. */
function withTerrainHeights(fn) {
  const heights = Cesium.ApproximateTerrainHeights;
  const was = heights._terrainHeights;
  heights._terrainHeights ??= {};
  try {
    return fn();
  } finally {
    heights._terrainHeights = was;
  }
}

test('draped glow and dash lines drape with their materials, each on a ground primitive of its own', () =>
  withImageClasses(() => {
    const { scene, draw } = drawOver();
    const set = draw.lines({ id: 'styled', clampTo: 'terrain' });
    const positions = [
      { lon: 0, lat: 0 },
      { lon: 1, lat: 1 },
    ];
    set.set([
      {
        id: 'core',
        positions,
        widthPx: 5,
        mode: 'draped',
        style: {
          kind: 'glow',
          color: [1, 0.5, 0, 0.9],
          power: 0.24,
          taper: 0.7,
        },
      },
      {
        id: 'halo',
        positions,
        widthPx: 18,
        mode: 'draped',
        clampTo: 'both',
        style: { kind: 'dash', color: '#d8954e', length: 18 },
      },
    ]);
    const host = scene.added[0];
    const [glow, dash] = [host.get(1), host.get(2)];
    for (const ground of [glow, dash]) {
      assert.ok(ground instanceof Cesium.GroundPolylinePrimitive);
      assert.ok(ground.appearance instanceof Cesium.PolylineMaterialAppearance);
      assert.equal(ground.show, false, 'hidden while it builds');
    }
    assert.equal(glow.classificationType, Cesium.ClassificationType.TERRAIN);
    assert.equal(dash.classificationType, Cesium.ClassificationType.BOTH);
    assert.equal(glow.geometryInstances[0].id.id, 'core');
    assert.equal(dash.geometryInstances[0].geometry.width, 18);
    const glowMaterial = glow.appearance.material;
    assert.equal(glowMaterial.type, 'PolylineGlow');
    assert.equal(glowMaterial.uniforms.glowPower, 0.24);
    assert.equal(glowMaterial.uniforms.taperPower, 0.7);
    assert.ok(glowMaterial.uniforms.color instanceof Cesium.Color);
    const dashMaterial = dash.appearance.material;
    assert.equal(dashMaterial.type, 'PolylineDash');
    assert.equal(dashMaterial.uniforms.dashLength, 18);
    assert.ok(
      Cesium.Color.equals(
        dashMaterial.uniforms.gapColor,
        Cesium.Color.TRANSPARENT,
      ),
    );
    set.dispose();
  }));

test('a draped arrow drapes its arrow material on a ground polyline of its own, recoloured in place', () =>
  withImageClasses(() => {
    const { scene, draw } = drawOver();
    const set = draw.lines({ id: 'arrows' });
    const arrow = (color) => ({
      id: 'to',
      positions: [
        { lon: 0, lat: 0 },
        { lon: 0.01, lat: 0.01 },
      ],
      widthPx: 16,
      mode: 'draped',
      style: { kind: 'arrow', color },
    });
    set.set([arrow([0.5, 0.9, 1, 0.95])]);
    const host = scene.added[0];
    const ground = host.get(1);
    assert.ok(ground instanceof Cesium.GroundPolylinePrimitive);
    assert.equal(ground.classificationType, Cesium.ClassificationType.BOTH);
    assert.equal(ground.geometryInstances[0].geometry.width, 16);
    const material = ground.appearance.material;
    assert.equal(material.type, 'PolylineArrow');
    assert.ok(
      Cesium.Color.equals(
        material.uniforms.color,
        new Cesium.Color(0.5, 0.9, 1, 0.95),
      ),
    );
    // Faded, it takes its new colour on the material it has.
    set.upsert([arrow([0.5, 0.9, 1, 0.4])]);
    assert.equal(scene.added[0], host, 'not rebuilt');
    assert.equal(ground.appearance.material, material);
    assert.equal(material.uniforms.color.alpha, 0.4);
    set.dispose();
  }));

test('a split line draws ahead and behind its split with a rim, the split moving in place', () =>
  withImageClasses(() => {
    const { scene, draw } = drawOver();
    const set = draw.lines({ id: 'route', clampTo: 'tiles' });
    const positions = new Float64Array([
      ...Object.values(Cesium.Cartesian3.fromDegrees(0, 0)),
      ...Object.values(Cesium.Cartesian3.fromDegrees(0.01, 0.01)),
    ]);
    const route = (at, reverse) => ({
      id: 'route',
      positions,
      widthPx: 5,
      mode: 'draped',
      style: {
        kind: 'split',
        color: [0.2, 0.6, 1, 1],
        behind: [0.2, 0.6, 1, 0.3],
        at,
        reverse,
        rim: { shade: 0.22, widthFraction: 0.28 },
      },
    });
    set.set([route(-1)]);
    const host = scene.added[0];
    const line = [...Array(host.length).keys()]
      .map((i) => host.get(i))
      .find((p) => p.appearance?.material?.type === 'DrawSplitLine');
    assert.ok(line, 'drawn by the split material');
    const uniforms = line.appearance.material.uniforms;
    assert.deepEqual(
      [uniforms.splitAt, uniforms.direction, uniforms.rimShade],
      [-1, 1, 0.22],
    );
    assert.equal(uniforms.rimFraction, 0.28);
    assert.equal(uniforms.behind.alpha, 0.3);
    assert.ok(line.appearance.material.isTranslucent());
    set.upsert([route(0.4)]);
    assert.ok(!line.isDestroyed(), 'the same ground primitive');
    assert.deepEqual([uniforms.splitAt, uniforms.direction], [0.4, 1]);
    set.upsert([route(0.6, true)]);
    assert.deepEqual([uniforms.splitAt, uniforms.direction], [0.6, -1]);
    set.upsert([route(Number.NaN, true)]);
    assert.deepEqual(
      [uniforms.splitAt, uniforms.direction],
      [-1, 1],
      'no split: all ahead',
    );
    assert.throws(
      () => set.upsert([{ ...route(0.5), mode: 'geodesic' }]),
      TypeError,
      'a split line is draped',
    );
  }));

test('a draped line drawn by its own material changes colour in place; a batched one rebuilds', () =>
  withImageClasses(() => {
    const { scene, draw } = drawOver();
    const set = draw.lines({ id: 'pulsing', clampTo: 'tiles' });
    const positions = new Float64Array([
      ...Object.values(Cesium.Cartesian3.fromDegrees(0, 0)),
      ...Object.values(Cesium.Cartesian3.fromDegrees(0.01, 0.01)),
    ]);
    const jam = (alpha) => ({
      id: 'jam',
      positions,
      widthPx: 9,
      mode: 'draped',
      style: { kind: 'glow', color: [0.9, 0.3, 0.3, alpha], power: 0.25 },
    });
    const slow = (alpha) => ({
      id: 'slow',
      positions,
      widthPx: 4,
      mode: 'draped',
      style: { kind: 'solid', color: [0.9, 0.7, 0.2, alpha] },
    });
    set.set([jam(0.55), slow(0.2)]);
    const host = scene.added[0];
    const glow = [...Array(host.length).keys()]
      .map((i) => host.get(i))
      .find((p) => p.appearance?.material?.type === 'PolylineGlow');
    assert.equal(
      glow.classificationType,
      Cesium.ClassificationType.CESIUM_3D_TILE,
    );
    set.upsert([jam(0.7)]);
    assert.equal(scene.added[0], host, 'the same host');
    assert.equal(glow.appearance.material.uniforms.color.alpha, 0.7);
    assert.ok(!glow.isDestroyed(), 'the same ground primitive');
    // Sent twice in one upsert, the last colour is the one it keeps.
    set.upsert([jam(0.3), jam(0.7)]);
    assert.equal(glow.appearance.material.uniforms.color.alpha, 0.7);
    set.upsert([jam(0.3)]);
    assert.equal(glow.appearance.material.uniforms.color.alpha, 0.3);
    // A style object the caller changes and sends again is read anew.
    const again = jam(0.4);
    set.upsert([again]);
    again.style.color[3] = 0.6;
    set.upsert([again]);
    assert.equal(glow.appearance.material.uniforms.color.alpha, 0.6);
    // Another width is another line: rebuilt.
    set.upsert([{ ...jam(0.7), widthPx: 10 }]);
    assert.notEqual(scene.added[0], host, 'a new width rebuilds');
    const rebuilt = scene.added[0];
    set.upsert([slow(0.4)]);
    assert.notEqual(scene.added[0], rebuilt, 'a batched colour rebuilds');
    set.dispose();
  }));

test('draped glow lines that look alike share one ground primitive and recolour together in place', () =>
  withImageClasses(() => {
    const { scene, draw } = drawOver();
    const set = draw.lines({ id: 'glows', clampTo: 'tiles' });
    const at = (lon) => Cesium.Cartesian3.fromDegrees(lon, 0);
    const glow = (id, lon, alpha, extra = {}) => ({
      id,
      positions: [at(lon), at(lon + 0.01)],
      widthPx: 9,
      mode: 'draped',
      style: { kind: 'glow', color: [0.9, 0.3, 0.3, alpha], power: 0.25 },
      ...extra,
    });
    const grounds = () => {
      const host = scene.added[0];
      return [...Array(host.length).keys()]
        .map((i) => host.get(i))
        .filter((p) => p instanceof Cesium.GroundPolylinePrimitive);
    };
    set.set([glow('a', 0, 0.5), glow('b', 1, 0.5), glow('c', 2, 0.5)]);
    const host = scene.added[0];
    const [batch] = grounds();
    assert.equal(grounds().length, 1, 'one primitive for the three');
    assert.equal(batch.geometryInstances.length, 3);
    const uniforms = batch.appearance.material.uniforms;
    // All recoloured alike: in place, on the one material.
    set.upsert([glow('a', 0, 0.7), glow('b', 1, 0.7), glow('c', 2, 0.7)]);
    assert.equal(scene.added[0], host, 'in place');
    assert.ok(!batch.isDestroyed());
    assert.equal(uniforms.color.alpha, 0.7);
    // A line moved off the batch, sent twice in one upsert, takes its last
    // colour on a material of its own; its peers keep theirs.
    const moved = (alpha) =>
      glow('a', 0, alpha, { positions: [at(0.5), at(0.51)] });
    withTerrainHeights(() => set.upsert([moved(0.2), moved(0.7)]));
    assert.equal(scene.added[0], host, 'moved in place');
    assert.equal(uniforms.color.alpha, 0.7, 'the peers keep their colour');
    // Two recoloured and one not: it would change colour with them, so
    // the set is rebuilt.
    set.upsert([glow('a', 0, 0.2), glow('b', 1, 0.2)]);
    assert.notEqual(scene.added[0], host, 'rebuilt');
    assert.equal(grounds().length, 2, 'one for each look');
    const rebuilt = scene.added[0];
    // Another width is another look: drawn apart.
    set.upsert([glow('c', 2, 0.7, { widthPx: 4 })]);
    assert.notEqual(scene.added[0], rebuilt);
    assert.equal(grounds().length, 2);
    set.dispose();
  }));

test('the traffic layer drapes its heat-lines on the tiles and pulses the jam ones in place', async () => {
  const { createRendering } = await import('../../layers/traffic/rendering.js');
  const policy = await import('../../layers/traffic/policy.js');
  await withImageClasses(() => {
    const { scene, draw } = drawOver();
    const at = (lon) => Cesium.Cartesian3.fromDegrees(lon, 30.26);
    const road = (level, lon) => ({
      flow: { level },
      segmentDist: [100],
      waypoints: [at(lon), at(lon + 0.001)],
    });
    const state = {
      _viewer: {},
      _liveMode: true,
      _presetDots: 'off',
      _heatJam: [],
      _heatLineCount: 0,
      _heatSet: draw.lines({ id: 'traffic:1:heat', clampTo: 'tiles' }),
    };
    const rendering = createRendering({
      state,
      services: {},
      parts: {
        style: { heatlineOn: () => true },
        animation: { syncRenderDemand() {} },
      },
      source: {},
    });
    rendering.rebuildHeatLines([
      road(0.2, -97.74),
      road(0.25, -97.735),
      road(0.6, -97.73),
    ]);
    const host = scene.added[0];
    const grounds = [...Array(host.length).keys()]
      .map((i) => host.get(i))
      .filter((p) => p instanceof Cesium.GroundPolylinePrimitive);
    assert.equal(grounds.length, 2, 'the jam lines glowing, the slow ones');
    assert.ok(
      grounds.every(
        (p) =>
          p.classificationType === Cesium.ClassificationType.CESIUM_3D_TILE,
      ),
      'draped on the tiles alone',
    );
    const glow = grounds.find(
      (p) => p.appearance?.material?.type === 'PolylineGlow',
    );
    assert.ok(glow, 'the jam line glows');
    assert.equal(
      glow.appearance.material.uniforms.color.alpha,
      policy.HEAT_JAM_BASE_ALPHA,
    );
    rendering.pulseHeatLines(260 * (Math.PI / 2));
    assert.equal(scene.added[0], host, 'pulsed where it is');
    assert.ok(!glow.isDestroyed());
    assert.ok(
      Math.abs(
        glow.appearance.material.uniforms.color.alpha -
          (policy.HEAT_JAM_BASE_ALPHA + policy.HEAT_JAM_PULSE_ALPHA),
      ) < 1e-6,
    );
    rendering.removeHeatLines();
    assert.equal(state._heatSet.size(), 0);
    state._heatSet.dispose();
    assert.equal(scene.added.length, 0);
  });
});

test('where the scene cannot drape, draped lines draw over the surface and hide past the horizon', () =>
  withImageClasses(() => {
    const scene = fakeScene();
    scene.frameState.context = { depthTexture: false };
    const { draw, frame } = drawOver(scene);
    assert.equal(draw.clampState(), 'overlay');
    const set = draw.lines({ id: 'heat', clampTo: 'tiles' });
    const at = (lon) => Cesium.Cartesian3.fromDegrees(lon, 0, 0);
    const firstPositions = [at(0), at(0.01)];
    set.set([
      {
        id: 'jam',
        positions: firstPositions,
        widthPx: 4,
        mode: 'draped',
        style: { kind: 'glow', color: [1, 0, 0, 0.8], power: 0.25 },
      },
    ]);
    const host = scene.added[0];
    const all = [];
    const walk = (p) => {
      all.push(p);
      if (typeof p?.get === 'function' && Number.isFinite(p.length))
        for (let i = 0; i < p.length; i++) walk(p.get(i));
    };
    walk(host);
    assert.ok(
      !all.some((p) => p instanceof Cesium.GroundPolylinePrimitive),
      'no ground polyline',
    );
    const line = all.find(
      (p) => p instanceof Cesium.Primitive && p.depthFailAppearance,
    );
    assert.ok(line, 'drawn where the surface hides it too');
    const failColor = line.depthFailAppearance.material.uniforms.color;
    assert.ok(Math.abs(failColor.red - 1) < 1e-6 && failColor.green === 0);
    // The eye over the line's side of the Earth: shown.
    scene.camera.positionWC = new Cesium.Cartesian3(2e7, 0, 0);
    frame();
    assert.equal(line.show, true);
    // The eye over the far side: past the horizon, hidden.
    scene.camera.positionWC = new Cesium.Cartesian3(-2e7, 0, 0);
    frame();
    assert.equal(line.show, false);
    // A recolour where it runs (a pulse) takes the colour in place, and the
    // line stays hidden past the horizon: nothing is built anew.
    const hostBefore = scene.added[0];
    set.upsert([
      {
        id: 'jam',
        positions: firstPositions,
        widthPx: 4,
        mode: 'draped',
        style: { kind: 'glow', color: [1, 0, 0, 0.4], power: 0.25 },
      },
    ]);
    frame();
    assert.equal(line.show, false, 'still past the horizon');
    const after = [];
    const walkAfter = (p) => {
      after.push(p);
      if (typeof p?.get === 'function' && Number.isFinite(p.length))
        for (let i = 0; i < p.length; i++) walkAfter(p.get(i));
    };
    walkAfter(scene.added[0]);
    assert.equal(scene.added[0], hostBefore, 'the set is not rebuilt');
    assert.ok(after.includes(line), 'the same line draws');
    assert.ok(
      Math.abs(line.appearance.material.uniforms.color.alpha - 0.4) < 1e-6,
    );
    assert.ok(
      Math.abs(line.depthFailAppearance.material.uniforms.color.alpha - 0.4) <
        1e-6,
    );
    // In 2D there is no horizon: it shows as asked.
    scene.mode = Cesium.SceneMode.SCENE2D;
    frame();
    assert.equal(line.show, true, 'shown in 2D');
    scene.mode = Cesium.SceneMode.SCENE3D;
    scene.camera.positionWC = new Cesium.Cartesian3(2e7, 0, 0);
    frame();
    // Moved, it alone is built anew, still over the surface and culled.
    set.upsert([
      {
        id: 'jam',
        positions: [at(0), at(0.02)],
        widthPx: 4,
        mode: 'draped',
        style: { kind: 'glow', color: [1, 0, 0, 0.4], power: 0.25 },
      },
    ]);
    assert.equal(scene.added[0], hostBefore, 'patched, not rebuilt');
    const moved = [];
    const walkMoved = (p) => {
      moved.push(p);
      if (typeof p?.get === 'function' && Number.isFinite(p.length))
        for (let i = 0; i < p.length; i++) walkMoved(p.get(i));
    };
    walkMoved(scene.added[0]);
    const rebuilt = moved.find(
      (p) => p instanceof Cesium.Primitive && p.depthFailAppearance,
    );
    assert.ok(rebuilt && rebuilt !== line, 'built anew where it moved');
    assert.ok(!moved.includes(line), 'the old line is gone');
    scene.camera.positionWC = new Cesium.Cartesian3(-2e7, 0, 0);
    frame();
    assert.equal(rebuilt.show, false);
    set.dispose();
    assert.equal(scene.added.length, 0);
  }));

test('where the scene cannot drape, an overlay line is culled by its whole arc, and patched by what its positions hold', () =>
  withImageClasses(() => {
    const scene = fakeScene();
    scene.frameState.context = { depthTexture: false };
    const { draw, frame } = drawOver(scene);
    const set = draw.lines({ id: 'arc', clampTo: 'tiles' });
    const find = () => {
      const all = [];
      const walk = (p) => {
        all.push(p);
        if (typeof p?.get === 'function' && Number.isFinite(p.length))
          for (let i = 0; i < p.length; i++) walk(p.get(i));
      };
      walk(scene.added[0]);
      return all.find(
        (p) => p instanceof Cesium.Primitive && p.depthFailAppearance,
      );
    };
    // Its ends are past the horizon, but the arc runs under the eye.
    const a = Cesium.Cartesian3.fromDegrees(-80, 0, 0);
    const b = Cesium.Cartesian3.fromDegrees(80, 0, 0);
    const positions = new Float64Array([a.x, a.y, a.z, b.x, b.y, b.z]);
    const item = (style) => ({
      id: 'arc',
      positions,
      widthPx: 2,
      mode: 'draped',
      style: { kind: 'solid', color: style },
    });
    set.set([item([1, 0, 0, 1])]);
    scene.camera.positionWC = new Cesium.Cartesian3(2e7, 0, 0);
    frame();
    const line = find();
    assert.equal(line.show, true, 'shown: its middle is in view');
    // The same buffer, changed in place: built anew where it now runs.
    const c = Cesium.Cartesian3.fromDegrees(10, 0, 0);
    positions.set([c.x, c.y, c.z], 3);
    set.upsert([item([1, 0, 0, 1])]);
    const moved = find();
    assert.notEqual(moved, line, 'built anew');
    // Moved past the horizon, then upserted as an ordinary line in view:
    // it is no longer culled by where the overlay was.
    const far = new Float64Array(6);
    const f1 = Cesium.Cartesian3.fromDegrees(179, 0, 0);
    const f2 = Cesium.Cartesian3.fromDegrees(179.5, 0, 0);
    far.set([f1.x, f1.y, f1.z, f2.x, f2.y, f2.z]);
    set.upsert([{ ...item([1, 0, 0, 1]), positions: far }]);
    frame();
    assert.equal(find().show, false, 'past the horizon');
    set.upsert([
      {
        id: 'arc',
        positions: [
          Cesium.Cartesian3.fromDegrees(0, 0, 0),
          Cesium.Cartesian3.fromDegrees(0.5, 0, 0),
        ],
        widthPx: 2,
        mode: '3d',
        depthFail: { kind: 'solid', color: [1, 0, 0, 1] },
        style: { kind: 'solid', color: [1, 0, 0, 1] },
      },
    ]);
    const plain = find();
    frame();
    assert.equal(plain.show, true, 'not culled by the overlay it was');
    set.dispose();
  }));

test('where the scene cannot drape, a segmented draped line runs over its shown segments only', () =>
  withImageClasses(() => {
    const scene = fakeScene();
    scene.frameState.context = { depthTexture: false };
    const { draw } = drawOver(scene);
    const set = draw.lines({ id: 'trail', clampTo: 'tiles' });
    const at = (lon) => Cesium.Cartesian3.fromDegrees(lon, 0, 0);
    const positions = [at(0), at(0.01), at(0.02), at(0.03)];
    const red = [1, 0, 0, 1];
    const find = () => {
      const all = [];
      const walk = (p) => {
        all.push(p);
        if (typeof p?.get === 'function' && Number.isFinite(p.length))
          for (let i = 0; i < p.length; i++) walk(p.get(i));
      };
      walk(scene.added[0]);
      return all.find(
        (p) => p instanceof Cesium.Primitive && p.depthFailAppearance,
      );
    };
    set.set([
      {
        id: 'trail',
        positions,
        widthPx: 2,
        mode: 'draped',
        style: { kind: 'solid', color: red },
        segmentColors: [red, red, red],
        segmentShow: [true, true, false],
      },
    ]);
    const line = find();
    assert.ok(line, 'drawn over the surface');
    const drawn = line.geometryInstances.geometry._positions;
    assert.equal(drawn.length, 3, 'up to its last shown segment');
    assert.ok(Cesium.Cartesian3.equals(drawn[2], positions[2]));
    set.set([
      {
        id: 'trail',
        positions,
        widthPx: 2,
        mode: 'draped',
        style: { kind: 'solid', color: red },
        segmentColors: [red, red, red],
        segmentShow: [false, false, false],
      },
    ]);
    assert.equal(find()?.show ?? false, false, 'hidden with none shown');
    set.dispose();
  }));

test('revealFraction draws a line up to that fraction of its length, and changes in place', () =>
  withImageClasses(() => {
    const { scene, draw } = drawOver();
    const set = draw.lines({ id: 'revealed' });
    const at = (lon) => Cesium.Cartesian3.fromDegrees(lon, 0, 0);
    // Segments a quarter and three quarters of the length.
    const air = (revealFraction, extra = {}) => ({
      id: 'air',
      positions: [at(0), at(1), at(4)],
      widthPx: 3,
      mode: '3d',
      style: { kind: 'solid', color: '#fff' },
      revealFraction,
      ...extra,
    });
    const ground = (revealFraction) => ({
      id: 'ground',
      positions: [
        { lon: 0, lat: 0 },
        { lon: 1, lat: 1 },
      ],
      widthPx: 2,
      mode: 'draped',
      style: { kind: 'solid', color: '#20e7f2' },
      revealFraction,
    });
    set.set([air(0.5), ground(0.25)]);
    const host = scene.added[0];
    const polyline = host.get(0).get(0);
    assert.equal(polyline.material.type, 'DrawRevealLine_solid');
    // Half the length is a third of the way along the second segment,
    // which a polyline's texture spans from 1/2 to 1.
    assert.ok(
      Math.abs(polyline.material.uniforms.reveal - (1 + 1 / 3) / 2) < 1e-3,
    );
    assert.ok(
      Cesium.Color.equals(
        polyline.material.materials.revealed.uniforms.color,
        Cesium.Color.WHITE,
      ),
    );
    // A revealed draped line draws alone, its texture along its length.
    const draped = host.get(1);
    assert.ok(draped instanceof Cesium.GroundPolylinePrimitive);
    assert.equal(draped.appearance.material.type, 'DrawRevealLine_solid');
    assert.equal(draped.appearance.material.uniforms.reveal, 0.25);
    // Revealed further, in place.
    Object.defineProperty(draped, 'ready', { value: true });
    draped.getGeometryInstanceAttributes = () => ({
      show: new Uint8Array([1]),
    });
    set.upsert([air(0.25), ground(0.75)]);
    assert.equal(scene.added[0], host, 'not rebuilt');
    assert.ok(Math.abs(polyline.material.uniforms.reveal - 0.5) < 1e-3);
    assert.equal(draped.appearance.material.uniforms.reveal, 0.75);
    // Nothing at 0, everything at 1.
    set.upsert([air(0), ground(1)]);
    assert.ok(polyline.material.uniforms.reveal < 0);
    assert.ok(draped.appearance.material.uniforms.reveal > 1);
    // Dropping the reveal draws the line whole: a new look, rebuilt.
    set.upsert([air(undefined)]);
    assert.notEqual(scene.added.at(-1), host);
    set.dispose();
  }));

test('revealFraction reveals flow and depth-fail lines too, their clocks still run', () =>
  withImageClasses(() => {
    const { scene, draw, frame } = drawOver();
    const set = draw.lines({ id: 'revealed-styles' });
    const flow = {
      kind: 'flow',
      color: '#39d0ff',
      repeat: 8,
      duty: 0.5,
      speed: 1,
    };
    set.set([
      {
        id: 'route',
        positions: [
          { lon: 0, lat: 0 },
          { lon: 1, lat: 1 },
        ],
        widthPx: 9,
        mode: 'draped',
        style: flow,
        revealFraction: 0.5,
      },
      {
        id: 'head',
        positions: [
          Cesium.Cartesian3.fromDegrees(0, 0, 100),
          Cesium.Cartesian3.fromDegrees(0, 0, 300),
        ],
        widthPx: 2,
        mode: '3d',
        style: { kind: 'solid', color: '#f0f' },
        depthFail: { kind: 'solid', color: [1, 0, 1, 0.45] },
        revealFraction: 0.5,
      },
    ]);
    const host = scene.added[0];
    const route = host.get(1).appearance.material;
    assert.equal(route.type, 'DrawRevealLine_flow');
    const clock = route.materials.revealed;
    assert.equal(clock.type, 'DrawFlowLine');
    clock.uniforms.time = -1;
    frame();
    assert.ok(clock.uniforms.time >= 0, 'the revealed flow keeps its clock');
    const head = host.get(0).get(1).get(0);
    assert.equal(head.appearance.material.uniforms.reveal, 0.5);
    assert.equal(head.depthFailAppearance.material.uniforms.reveal, 0.5);
    assert.ok(
      Cesium.Color.equals(
        head.depthFailAppearance.material.materials.revealed.uniforms.color,
        new Cesium.Color(1, 0, 1, 0.45),
      ),
    );
    set.dispose();
  }));

test('a draped line that moves is drawn where it now is in the same frame, once terrain heights are loaded', () =>
  withImageClasses(() =>
    withTerrainHeights(() => {
      const { scene, draw, frame } = drawOver();
      const set = draw.lines({ id: 'growing' });
      const flow = {
        kind: 'flow',
        color: '#39d0ff',
        repeat: 8,
        duty: 0.5,
        speed: 1,
      };
      const line = (id, lon, extra = {}) => ({
        id,
        positions: [
          { lon: 0, lat: 0 },
          { lon, lat: 1 },
        ],
        widthPx: 3,
        mode: 'draped',
        style: { kind: 'solid', color: '#20e7f2' },
        ...extra,
      });
      set.set([line('a', 1), line('b', 1), line('f', 1, { style: flow })]);
      const host = scene.added[0];
      const batch = host.get(1);
      const own = host.get(2);
      const shows = new Map();
      const attributesOf = (primitive) => {
        primitive.getGeometryInstanceAttributes = (id) => {
          const key = `${primitive.geometryInstances.length}:${id.id}`;
          if (!shows.has(key)) shows.set(key, { show: new Uint8Array([1]) });
          return shows.get(key);
        };
      };
      attributesOf(batch);
      // Moved while its batch still builds: drawn alone, built at once.
      set.upsert([line('a', 2, { meta: 'moved' })]);
      assert.equal(scene.added[0], host, 'the set is not rebuilt');
      const solo = host.get(host.length - 1);
      assert.ok(solo instanceof Cesium.GroundPolylinePrimitive);
      assert.equal(solo.asynchronous, false, 'built in the frame it is drawn');
      assert.equal(solo.geometryInstances[0].id.id, 'a');
      assert.equal(solo.geometryInstances[0].id.meta, 'moved');
      assert.notEqual(solo.show, false, 'shown at once');
      const end = solo.geometryInstances[0].geometry._positions.at(-1);
      assert.ok(
        Cesium.Cartesian3.equalsEpsilon(
          end,
          Cesium.Cartesian3.fromDegrees(2, 1),
          1e-6,
        ),
      );
      // Its place in the batch is hidden once the batch is ready.
      Object.defineProperty(batch, 'ready', { value: true });
      Object.defineProperty(own, 'ready', { value: true });
      frame();
      assert.deepEqual([...shows.get('2:a').show], [0], 'hidden in the batch');
      assert.equal(batch.show, true, 'the batch still draws the rest');
      // Moved again: the one built for it is replaced.
      set.upsert([line('a', 3)]);
      const again = host.get(host.length - 1);
      assert.notEqual(again, solo);
      assert.ok(solo.isDestroyed(), 'the old one goes');
      // A flow line moved keeps flowing on its new material.
      set.upsert([line('f', 2, { style: flow })]);
      assert.ok(own.isDestroyed(), 'its own primitive replaced');
      const moved = host.get(host.length - 1);
      const clock = moved.appearance.material;
      assert.equal(clock.type, 'DrawFlowLine');
      clock.uniforms.time = -1;
      frame();
      assert.ok(clock.uniforms.time >= 0);
      // Positions that make no line draw nothing, until they do.
      const count = host.length;
      set.upsert([line('a', 0, { positions: [{ lon: 0, lat: 0 }] })]);
      assert.equal(host.length, count - 1);
      set.upsert([line('a', 4)]);
      assert.equal(host.length, count);
      // A show change on a ready one is in place.
      const shown = host.get(host.length - 1);
      Object.defineProperty(shown, 'ready', { value: true });
      attributesOf(shown);
      set.upsert([line('a', 4, { show: false })]);
      assert.equal(host.get(host.length - 1), shown);
      assert.deepEqual([...shows.get('1:a').show], [0]);
      set.dispose();
      assert.equal(scene.added.length, 0);
    }),
  ));

test('a draped line that moves before terrain heights load is rebuilt, as before', () =>
  withImageClasses(() => {
    const heights = Cesium.ApproximateTerrainHeights;
    const was = heights._terrainHeights;
    heights._terrainHeights = undefined;
    try {
      const { scene, draw } = drawOver();
      const set = draw.lines({ id: 'early' });
      const line = (lon) => ({
        id: 'a',
        positions: [
          { lon: 0, lat: 0 },
          { lon, lat: 1 },
        ],
        widthPx: 3,
        mode: 'draped',
        style: { kind: 'solid', color: '#fff' },
      });
      set.set([line(1)]);
      const host = scene.added[0];
      set.upsert([line(2)]);
      assert.notEqual(scene.added.at(-1), host, 'rebuilt');
      set.dispose();
    } finally {
      heights._terrainHeights = was;
    }
  }));

test('a clamped point that moves follows the ground where it now is, on the dot it has', () => {
  const { scene, draw } = drawOver();
  const set = draw.points({ id: 'surge' });
  const front = (lon, extra = {}) => ({
    id: 'front',
    pos: { lon, lat: 28 },
    height: 'clampGround',
    pixelSize: 11,
    color: '#e8b47c',
    outlineColor: [0, 0, 0, 0.85],
    outlineWidth: 3,
    ...extra,
  });
  set.set([front(85)]);
  const host = scene.added[0];
  const dot = host.get(0);
  scene.clamped.length = 0;
  set.upsert([front(85.01, { meta: 'next', show: false })]);
  assert.equal(scene.added[0], host, 'not rebuilt');
  assert.equal(host.get(0), dot, 'the same dot');
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(
      dot.position,
      Cesium.Cartesian3.fromDegrees(85.01, 28),
      1e-6,
    ),
  );
  assert.equal(dot.heightReference, Cesium.HeightReference.CLAMP_TO_GROUND);
  assert.ok(scene.clamped.length > 0, 'clamped again where it now is');
  assert.equal(dot.id.meta, 'next');
  assert.equal(dot.show, false);
  // A new look is a new dot image: rebuilt.
  set.upsert([front(85.01, { pixelSize: 14 })]);
  assert.notEqual(scene.added[0], host);
  // So is clamping it no more.
  const clamped = scene.added[0];
  set.upsert([front(85.01, { pixelSize: 14, height: undefined })]);
  assert.notEqual(scene.added[0], clamped);
  set.dispose();
});

test('a revealed polyline maps its length onto its texture as Cesium draws it', () => {
  const p = (x) => new Cesium.Cartesian3(x, 0, 0);
  // Its texture runs evenly over its vertices, neighbours at one place one.
  assert.equal(revealUniform(0.5, [p(0), p(0), p(1), p(2)]), 0.5);
  assert.ok(Math.abs(revealUniform(0.25, [p(0), p(1), p(4)]) - 0.5) < 1e-12);
  assert.equal(revealUniform(0.4), 0.4, 'a ground line: its length');
  assert.equal(revealUniform(0, [p(0), p(1)]), -1);
  assert.equal(revealUniform(1, [p(0), p(1)]), 2);
});

test('a set of draped flow lines only asks for the frames they flow on', () =>
  withImageClasses(() => {
    const scene = fakeScene();
    let asked = 0;
    const request = scene.requestRender;
    scene.requestRender = function () {
      asked += 1;
      return request.call(this);
    };
    const { draw, frame } = drawOver(scene);
    const set = draw.lines({ id: 'draped-flow' });
    set.set([
      {
        id: 'route',
        positions: [
          { lon: 0, lat: 0 },
          { lon: 1, lat: 1 },
        ],
        widthPx: 9,
        mode: 'draped',
        style: {
          kind: 'flow',
          color: '#39d0ff',
          repeat: 8,
          duty: 0.5,
          speed: 1,
        },
      },
    ]);
    asked = 0;
    frame();
    assert.ok(asked > 0, 'it flows on in the frames that follow');
    set.dispose();
  }));

test('a draped line moved while its set rebuilds is no longer drawn where it was', () =>
  withImageClasses(() =>
    withTerrainHeights(() => {
      const { scene, draw, frame } = drawOver();
      const set = draw.lines({ id: 'rebuilding' });
      const line = (id, lon) => ({
        id,
        positions: [
          { lon: 0, lat: 0 },
          { lon, lat: 1 },
        ],
        widthPx: 3,
        mode: 'draped',
        style: { kind: 'solid', color: '#fff' },
      });
      set.set([line('a', 1), line('b', 1)]);
      const first = scene.added[0];
      const ground = first.get(1);
      Object.defineProperty(ground, 'ready', { value: true });
      const shows = new Map();
      ground.getGeometryInstanceAttributes = (id) => {
        if (!shows.has(id.id)) shows.set(id.id, { show: new Uint8Array([1]) });
        return shows.get(id.id);
      };
      frame();
      // Rebuilt: the first host draws on until the new one is ready.
      set.set([line('a', 1), line('b', 1), line('c', 1)]);
      assert.ok(scene.added.includes(first), 'the first still draws');
      set.upsert([line('a', 2)]);
      assert.deepEqual([...shows.get('a').show], [0], 'hidden where it was');
      assert.equal(shows.get('b'), undefined, 'the rest still draw there');
      set.dispose();
    }),
  ));

test('a contact trail draws its history and moving head as depth-fail geodesic lines on a viewer of its own', async () => {
  const { CHUNK_POINTS, createTrail } =
    await import('../../data/trailRenderer.js');
  withImageClasses(() => {
    const scene = fakeScene();
    const viewer = { scene, isDestroyed: () => false };
    const trail = createTrail(viewer, { color: '#00d4ff', width: 2.5 });
    // 400 fixes about a kilometre apart: a degree of arc per step keeps
    // each leg one straight piece.
    const fixes = Array.from({ length: 400 }, (_, i) =>
      Cesium.Cartesian3.fromDegrees(-97 + i * 0.01, 30, 10000),
    );
    trail.setPositions(fixes);
    // The lines drawn now: a set that loses a line is built again.
    const lines = () => {
      const deep = scene.added[0].get(1);
      return Array.from({ length: deep.length }, (_, i) => deep.get(i));
    };
    const positions = (line) => line.geometryInstances.geometry._positions;
    // The history is cut into lines of CHUNK_POINTS fixes that share their
    // boundary points, so the trail has no seam; the newest line grows.
    const cut = lines();
    const body = cut[0];
    assert.ok(body instanceof Cesium.Primitive);
    assert.equal(cut.length, 4, 'three full lines and the newest');
    for (const line of cut.slice(0, 3))
      assert.equal(positions(line).length, CHUNK_POINTS);
    for (let i = 1; i < cut.length; i++)
      assert.ok(
        Cesium.Cartesian3.equalsEpsilon(
          positions(cut[i - 1]).at(-1),
          positions(cut[i])[0],
          0,
          1e-6,
        ),
        'adjacent lines share their boundary point',
      );
    assert.ok(
      Cesium.Color.equals(
        body.depthFailAppearance.material.uniforms.color,
        Cesium.Color.fromCssColorString('#00d4ff').withAlpha(0.4),
      ),
    );
    // A long leg follows the globe instead of chording through it.
    trail.setPositions([
      Cesium.Cartesian3.fromDegrees(-150, 20, 10000),
      Cesium.Cartesian3.fromDegrees(-120, 30, 10000),
    ]);
    assert.equal(lines().length, 1);
    assert.equal(positions(lines()[0]).length, 65, 'a lone leg in 64 steps');
    // A long leg among short ones still takes a step a degree: the newest
    // line's 18 short legs take their share of 64 steps, its long one more.
    trail.setPositions([
      ...fixes,
      Cesium.Cartesian3.fromDegrees(-63, 30, 10000),
    ]);
    const newest = positions(lines().at(-1)).length - 1;
    const longSteps = newest - 18 * Math.ceil(64 / 19);
    assert.ok(longSteps > 25 && longSteps < 40, `${longSteps}`);
    // A history of one line, so the head is the set's second.
    trail.setPositions(fixes.slice(0, 10));
    // The head moves every frame alone, under one pick id.
    const head = (lon) => [
      Cesium.Cartesian3.fromDegrees(-120, 30, 10000),
      Cesium.Cartesian3.fromDegrees(lon, 30, 10000),
    ];
    // Its first head is a new line: the set is built again, once.
    trail.setHead(head(-119.99));
    const host2 = scene.added[0];
    const deep2 = host2.get(1);
    assert.equal(deep2.length, 2);
    const first = deep2.get(1);
    const id = first.geometryInstances.id;
    assert.match(id.id, /^gev-trail:\d+:head$/);
    const history = deep2.get(0);
    trail.setHead(head(-119.98));
    assert.equal(scene.added[0], host2, 'the set is not rebuilt');
    assert.equal(deep2.get(0), history, 'the history is not rebuilt');
    assert.notEqual(deep2.get(1), first);
    assert.equal(deep2.get(1).geometryInstances.id, id);
    // No head for a while: hidden in place.
    trail.setHead(null);
    assert.equal(scene.added[0], host2);
    assert.equal(deep2.get(0), history);
    assert.equal(deep2.get(1).show, false);
    trail.setVisible(false);
    assert.equal(host2.show, false);
    trail.destroy();
    assert.equal(scene.added.length, 0);
  });
});

test('a transit trail moves its head, across subdivisions too, and fades its body in place, frame to frame', async () => {
  const { createContactTrailRenderer } =
    await import('../../data/contactTrailRenderer.js');
  withImageClasses(() =>
    withTerrainHeights(() => {
      const scene = fakeScene();
      const viewer = { scene, isDestroyed: () => false };
      const frame = () => {
        scene.preRender.raiseEvent();
        scene.postRender.raiseEvent();
      };
      const hostOf = (suffix) =>
        scene.added.find((host) => host.drawSetId?.endsWith(suffix));
      // Every ground primitive built so far reads as ready, with attributes.
      const settle = () => {
        for (const host of scene.added)
          for (let i = 0; i < host.length; i++) {
            const part = host.get(i);
            if (!(part instanceof Cesium.GroundPolylinePrimitive)) continue;
            if (part.ready) continue;
            Object.defineProperty(part, 'ready', { value: true });
            const attributes = new Map();
            part.getGeometryInstanceAttributes = (id) => {
              if (!attributes.has(id))
                attributes.set(id, {
                  color: new Uint8Array(4),
                  show: new Uint8Array([1]),
                });
              return attributes.get(id);
            };
          }
        frame();
      };
      const at = (lon) => Cesium.Cartesian3.fromDegrees(lon, 0, 0);
      const renderer = createContactTrailRenderer(viewer);
      renderer.replaceHistory({
        revision: 1,
        segments: [
          {
            fromSeq: 0,
            toSeq: 1,
            fromT: 0,
            toT: 10000,
            positions: [at(0), at(0.0002)],
          },
          {
            fromSeq: 0,
            toSeq: 1,
            fromT: 10000,
            toT: 20000,
            positions: [at(0.0002), at(0.0004)],
          },
        ],
      });
      settle();
      const sample = (t) => ({
        displayT: t,
        fromSeq: 0,
        toSeq: 1,
        fraction: t / 20000,
      });
      renderer.setDisplaySample(sample(5000), at(0.0001));
      settle();
      const body = hostOf(':body'),
        head = hostOf(':head');
      assert.ok(body && head);
      // Into the next subdivision: the head moves there in the same frame.
      const before = scene.added.length;
      renderer.setDisplaySample(sample(12000), at(0.00024));
      assert.equal(scene.added.length, before, 'not built anew');
      assert.equal(hostOf(':head'), head);
      settle();
      const lanes = Array.from({ length: head.length }, (_, i) =>
        head.get(i),
      ).filter((part) => part instanceof Cesium.GroundPolylinePrimitive);
      assert.equal(lanes.length, 1, 'one line, its dark edge in the same pass');
      const added = scene.added.length;
      // A second and a half of frames within the subdivision.
      for (let t = 12016; t < 13500; t += 16)
        renderer.setDisplaySample(
          sample(t),
          at(0.0002 + (0.0002 * (t - 10000)) / 10000),
        );
      frame();
      assert.equal(scene.added.length, added, 'nothing built anew');
      assert.equal(hostOf(':body'), body);
      assert.equal(hostOf(':head'), head);
      for (const lane of lanes) {
        const reveal = lane.appearance.material.uniforms.reveal;
        assert.ok(Math.abs(reveal - 0.348) < 0.01, `revealed to ${reveal}`);
      }
      assert.equal(renderer.diagnostics().rebuilds, 1);
      assert.equal(renderer.diagnostics().headRebuilds, 2, 'one a subdivision');
      renderer.destroy();
    }),
  );
});

test('a segmented line, then plain and moved while its set rebuilds, is hidden segment by segment where it was', () =>
  withImageClasses(() =>
    withTerrainHeights(() => {
      const { scene, draw, frame } = drawOver();
      const set = draw.lines({ id: 'resegmented' });
      const line = (id, lon, extra = {}) => ({
        id,
        positions: [
          { lon: 0, lat: 0 },
          { lon: lon / 2, lat: 0.5 },
          { lon, lat: 1 },
        ],
        widthPx: 3,
        mode: 'draped',
        style: { kind: 'solid', color: '#fff' },
        ...extra,
      });
      set.set([line('a', 1, { segmentShow: [true, true] })]);
      const first = scene.added[0];
      const ground = first.get(1);
      Object.defineProperty(ground, 'ready', { value: true });
      const shows = new Map();
      ground.getGeometryInstanceAttributes = (id) => {
        if (!shows.has(id)) shows.set(id, { show: new Uint8Array([1]) });
        return shows.get(id);
      };
      frame();
      // Plain now: a new look, rebuilt; then moved before that is ready.
      set.upsert([line('a', 1)]);
      assert.ok(scene.added.includes(first), 'the first still draws');
      assert.doesNotThrow(() => set.upsert([line('a', 2)]));
      assert.equal(shows.size, 2, 'both segments');
      for (const { show } of shows.values()) assert.deepEqual([...show], [0]);
      set.dispose();
    }),
  ));

/** `Cesium.Model.fromGltfAsync` replaced by loads a test resolves. */
function fakeModelLoads() {
  const loads = [];
  const real = Cesium.Model.fromGltfAsync;
  Cesium.Model.fromGltfAsync = (options) =>
    new Promise((resolve, reject) => {
      const model = {
        ...options,
        modelMatrix: Cesium.Matrix4.clone(options.modelMatrix),
        ready: false,
        color: undefined,
        colorBlendMode: Cesium.ColorBlendMode.HIGHLIGHT,
        colorBlendAmount: 0.5,
        environmentMapManager: {
          enabled: options.environmentMapOptions?.enabled ?? true,
        },
        readyEvent: new Cesium.Event(),
        errorEvent: new Cesium.Event(),
        boundingSphere: { radius: 10 * (options.scale ?? 1) },
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
        isDestroyed() {
          return this.destroyed;
        },
        update() {},
      };
      loads.push({
        options,
        model,
        resolve: () => resolve(model),
        reject,
        ready() {
          model.ready = true;
          model.readyEvent.raiseEvent(model);
        },
      });
    });
  return { loads, restore: () => (Cesium.Model.fromGltfAsync = real) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('models re-pose and restyle in place; only a new url loads again', async () => {
  const { loads, restore } = fakeModelLoads();
  try {
    const scene = fakeScene();
    const part = createCesiumDraw({
      scene,
      report: (error) => assert.fail(error),
    });
    const set = part.port.models({ id: 'planes' });
    const ready = [];
    set.on('ready', (id) => ready.push(id));
    const plane = (extra = {}) => ({
      id: 'p',
      pos: { lon: 10, lat: 20, height: 100 },
      url: 'a.glb',
      orientation: { heading: 0, pitch: 0, roll: 0 },
      environmentMap: false,
      meta: { n: 1 },
      ...extra,
    });
    set.set([plane()]);
    assert.equal(loads.length, 1);
    assert.equal(loads[0].options.environmentMapOptions.enabled, false);
    assert.equal(loads[0].options.show, false, 'hidden until ready');
    const host = scene.added[0];
    assert.equal(host.loading, 1, 'loading');
    loads[0].resolve();
    await settle();
    const model = loads[0].model;
    assert.equal(model.show, false, 'loaded, not yet ready');
    loads[0].ready();
    assert.deepEqual(ready, ['p'], 'ready once loaded and posed');
    assert.equal(model.show, true);
    assert.equal(host.loading, 0);
    assert.deepEqual(model.id, {
      set: 'planes',
      id: 'p',
      meta: { n: 1 },
    });

    // Moved, turned and restyled: the same model, no load, no ready.
    set.upsert([
      plane({
        pos: { lon: 11, lat: 21, height: 200 },
        orientation: { heading: 1, pitch: 0.1, roll: 0.2 },
        tint: [1, 0, 0, 0.5],
        colorBlend: { mode: 'mix', amount: 0.8 },
        shading: 'unlit',
        environmentMap: true,
        scale: 2,
        minPixelSize: 32,
        maxScale: 50,
        meta: { n: 2 },
      }),
    ]);
    assert.equal(loads.length, 1, 'not loaded again');
    assert.deepEqual(ready, ['p'], 'no second ready');
    const expected = Cesium.Transforms.headingPitchRollToFixedFrame(
      Cesium.Cartesian3.fromDegrees(11, 21, 200),
      new Cesium.HeadingPitchRoll(1, 0.1, 0.2),
    );
    assert.ok(Cesium.Matrix4.equalsEpsilon(model.modelMatrix, expected, 1e-6));
    assert.deepEqual(
      [model.color.red, model.color.green, model.color.blue, model.color.alpha],
      [1, 0, 0, 0.5],
    );
    assert.equal(model.colorBlendMode, Cesium.ColorBlendMode.MIX);
    assert.equal(model.colorBlendAmount, 0.8);
    assert.ok(model.customShader instanceof Cesium.CustomShader, 'unlit');
    assert.equal(model.environmentMapManager.enabled, true);
    assert.equal(model.scale, 2);
    assert.equal(model.minimumPixelSize, 32);
    assert.equal(model.maximumScale, 50);
    assert.deepEqual(model.id.meta, { n: 2 }, 'the pick id follows');
    set.upsert([
      plane({ shading: 'pbr', tint: '#00f', colorBlend: { mode: 'replace' } }),
    ]);
    assert.equal(model.customShader, undefined, 'lit again');
    assert.equal(model.colorBlendMode, Cesium.ColorBlendMode.REPLACE);
    set.upsert([plane({ colorBlend: { mode: 'replace' } })]);
    assert.equal(
      model.colorBlendMode,
      Cesium.ColorBlendMode.HIGHLIGHT,
      'no tint to blend in: its own colour',
    );
    assert.equal(model.color, undefined, 'and no colour of its own');
    set.upsert([plane({ show: false })]);
    assert.equal(model.show, false, 'hidden in place');

    // A new url loads; the old model draws until the new one is ready.
    set.upsert([plane({ url: 'b.glb' })]);
    assert.equal(loads.length, 2);
    loads[1].resolve();
    await settle();
    assert.ok(host.contains(model), 'the old model still draws');
    loads[1].ready();
    assert.equal(host.contains(model), false, 'swapped once ready');
    assert.ok(host.contains(loads[1].model));
    assert.deepEqual(ready, ['p', 'p']);

    // Away and back before the other loads: no second load of the first.
    set.upsert([plane({ url: 'c.glb' })]);
    set.upsert([plane({ url: 'b.glb', pos: { lon: 12, lat: 22 } })]);
    assert.equal(loads.length, 3);
    assert.equal(host.loading, 0, 'the load in between is let go');
    const moved = Cesium.Matrix4.getTranslation(
      loads[1].model.modelMatrix,
      new Cesium.Cartesian3(),
    );
    assert.ok(
      Cesium.Cartesian3.distance(moved, Cesium.Cartesian3.fromDegrees(12, 22)) <
        1e-3,
      'the drawn model kept moving',
    );

    set.remove(['p']);
    assert.equal(host.length, 0, 'removed');
    assert.equal(set.size(), 0);
    set.dispose();
  } finally {
    restore();
  }
});

test('a model load superseded or failed settles once', async () => {
  const { loads, restore } = fakeModelLoads();
  try {
    const scene = fakeScene();
    const part = createCesiumDraw({
      scene,
      report: (error) => assert.fail(error),
    });
    const set = part.port.models({ id: 'm' });
    const item = (url) => ({
      id: 'a',
      pos: { lon: 0, lat: 0 },
      url,
      orientation: { heading: 0, pitch: 0, roll: 0 },
    });
    set.set([item('a.glb')]);
    const host = scene.added[0];
    set.upsert([item('b.glb')]);
    assert.equal(host.loading, 1, 'the first is superseded');
    loads[0].resolve();
    await settle();
    assert.equal(loads[0].model.destroyed, true, 'a stale load is let go');
    loads[1].reject(new Error('no such model'));
    await settle();
    assert.equal(host.loading, 0);
    assert.equal(host.failed, 1, 'kept for whenSettled');
    // A model that fails as it loads is let go once its update is done.
    set.upsert([item('c.glb')]);
    assert.equal(host.failed, 0, 'a new url clears the failure');
    loads[2].resolve();
    await settle();
    const bad = loads[2].model;
    bad.errorEvent.raiseEvent(new Error('bad texture'));
    assert.ok(host.contains(bad), 'not destroyed inside its own update');
    assert.equal(host.failed, 1);
    await settle();
    assert.equal(host.contains(bad), false, 'then let go');
    set.clear();
    assert.equal(host.failed, 0, 'gone with its item');
    set.dispose();
  } finally {
    restore();
  }
});

test('a failed model load fires loadFailed once, after the frame, with why', async () => {
  const { loads, restore } = fakeModelLoads();
  try {
    const scene = fakeScene();
    const part = createCesiumDraw({
      scene,
      report: (error) => assert.fail(error),
    });
    const set = part.port.models({ id: 'm' });
    const failed = [];
    set.on('loadFailed', (id, message) => failed.push([id, message]));
    const item = (id, url) => ({
      id,
      pos: { lon: 0, lat: 0 },
      url,
      orientation: { heading: 0, pitch: 0, roll: 0 },
    });
    // A load that rejects (the glTF did not fetch).
    set.set([item('a', 'a.glb'), item('b', 'b.glb')]);
    loads[0].reject(new Error('404 for a.glb'));
    await settle();
    assert.deepEqual(failed, [['a', '404 for a.glb']]);
    // One that fails in its update: told after that update, not inside it.
    loads[1].resolve();
    await settle();
    loads[1].model.errorEvent.raiseEvent(new Error('bad texture'));
    assert.equal(failed.length, 1, 'not inside the model update');
    await settle();
    assert.deepEqual(failed[1], ['b', 'bad texture']);
    // A listener may change the set: removing and adding again loads at once.
    set.remove(['a']);
    set.upsert([item('a', 'a.glb')]);
    assert.equal(loads.length, 3, 'added again, loaded again');
    // A load superseded before it fails is not told.
    set.upsert([item('a', 'c.glb')]);
    loads[2].reject(new Error('late'));
    await settle();
    assert.equal(failed.length, 2, 'a superseded load does not fire');
    // Nor one whose item went before the failure was told.
    loads[3].reject('plain reason');
    set.remove(['a']);
    await settle();
    assert.equal(failed.length, 2, 'an item gone does not fire');
    set.upsert([item('d', 'd.glb')]);
    loads[4].reject({});
    await settle();
    assert.deepEqual(failed[2], ['d', 'the model did not load']);
    set.dispose();
  } finally {
    restore();
  }
});

test('a failed model load is tried again on a later update, after a wait', async () => {
  const { loads, restore } = fakeModelLoads();
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const scene = fakeScene();
    const part = createCesiumDraw({
      scene,
      report: (error) => assert.fail(error),
    });
    const set = part.port.models({ id: 'm' });
    const item = {
      id: 'a',
      pos: { lon: 0, lat: 0 },
      url: 'a.glb',
      orientation: { heading: 0, pitch: 0, roll: 0 },
    };
    set.upsert([item]);
    const host = scene.added[0];
    loads[0].reject(new Error('network'));
    await settle();
    assert.equal(host.failed, 1);
    now += MODEL_RETRY_MS - 1;
    set.upsert([{ ...item }]);
    assert.equal(loads.length, 1, 'not before the wait');
    now += 1;
    set.upsert([{ ...item }]);
    assert.equal(loads.length, 2, 'the same url again');
    assert.equal(host.failed, 0, 'loading again, not failed');
    assert.equal(host.loading, 1);
    const ready = [];
    set.on('ready', (id) => ready.push(id));
    loads[1].resolve();
    await settle();
    loads[1].ready();
    assert.deepEqual(ready, ['a']);
    set.upsert([{ ...item }]);
    assert.equal(loads.length, 2, 'a loaded model is not loaded again');
    set.dispose();
  } finally {
    Date.now = realNow;
    restore();
  }
});

test('a model past its pixel cap is scaled down each frame; fades and culls too', async () => {
  const { loads, restore } = fakeModelLoads();
  try {
    const scene = fakeScene();
    scene.drawingBufferWidth = 1000;
    scene.drawingBufferHeight = 500;
    let metresPerPixel = 0.1;
    scene.camera.getPixelSize = () => metresPerPixel;
    const part = createCesiumDraw({
      scene,
      report: (error) => assert.fail(error),
    });
    const set = part.port.models({ id: 'm', horizonCull: true });
    const eye = scene.camera.positionWC;
    const at = Cesium.Cartesian3.fromDegrees(0, 0, 1000);
    const distance = Cesium.Cartesian3.distance(eye, at);
    set.set([
      {
        id: 'a',
        pos: { lon: 0, lat: 0, height: 1000 },
        url: 'a.glb',
        orientation: { heading: 0, pitch: 0, roll: 0 },
        scale: 4,
        maxPixelSize: 100,
        fadeByDistance: {
          near: distance - 10,
          nearValue: 1,
          far: distance + 10,
          farValue: 0,
        },
      },
    ]);
    loads[0].resolve();
    await settle();
    const model = loads[0].model;
    loads[0].ready();
    part.beforeRender();
    // Radius 10 m at scale 1: 100 px at 0.1 m/px is 10 m across, scale 0.5.
    assert.ok(Math.abs(model.scale - 0.5) < 1e-9, `capped: ${model.scale}`);
    assert.ok(Math.abs(model.color.alpha - 0.5) < 1e-6, 'faded halfway');
    metresPerPixel = 10;
    part.beforeRender();
    assert.equal(model.scale, 4, 'under the cap: its own scale');
    assert.equal(model.show, true);
    // Behind the earth from an eye on the far side.
    scene.camera.positionWC = new Cesium.Cartesian3(-2e7, 0, 0);
    part.beforeRender();
    assert.equal(model.show, false, 'culled past the horizon');
    set.dispose();
  } finally {
    restore();
  }
});

test('an untinted model drawn fully opaque is given no colour; a fade gives one, and full opacity takes it away again', async () => {
  // A colour on a Cesium model adds a colour stage to every draw of it.
  const { loads, restore } = fakeModelLoads();
  try {
    const scene = fakeScene();
    let metresPerPixel = 0.1;
    scene.camera.getPixelSize = () => metresPerPixel;
    const part = createCesiumDraw({
      scene,
      report: (error) => assert.fail(error),
    });
    const set = part.port.models({ id: 'm' });
    const eye = scene.camera.positionWC;
    const at = Cesium.Cartesian3.fromDegrees(0, 0, 1000);
    const distance = Cesium.Cartesian3.distance(eye, at);
    const item = (extra = {}) => ({
      id: 'a',
      pos: { lon: 0, lat: 0, height: 1000 },
      url: 'a.glb',
      orientation: { heading: 0, pitch: 0, roll: 0 },
      ...extra,
    });
    set.set([item()]);
    loads[0].resolve();
    await settle();
    const model = loads[0].model;
    loads[0].ready();
    part.beforeRender();
    assert.equal(model.color, undefined, 'opaque, untinted: no colour');
    set.upsert([
      item({
        fadeByDistance: {
          near: distance - 10,
          nearValue: 1,
          far: distance + 10,
          farValue: 0,
        },
      }),
    ]);
    part.beforeRender();
    assert.ok(model.color, 'faded: a colour');
    assert.ok(Math.abs(model.color.alpha - 0.5) < 1e-6, 'faded halfway');
    set.upsert([item()]);
    part.beforeRender();
    assert.equal(model.color, undefined, 'opaque again: no colour');
    set.dispose();
  } finally {
    restore();
  }
});

test('models moved every frame keep their shader and pick ids: only a new look or a new model changes them', async () => {
  // A fleet re-poses every model each frame with the same look.
  const { loads, restore } = fakeModelLoads();
  const toCss = Cesium.Color.prototype.toCssHexString;
  let shaderLookups = 0;
  Cesium.Color.prototype.toCssHexString = function () {
    shaderLookups += 1;
    return toCss.call(this);
  };
  try {
    const scene = fakeScene();
    const part = createCesiumDraw({
      scene,
      report: (error) => assert.fail(error),
    });
    const set = part.port.models({ id: 'fleet' });
    const item = (id, lon, extra = {}) => ({
      id,
      pos: { lon, lat: 0, height: 10 },
      url: 'a.glb',
      orientation: { heading: 0, pitch: 0, roll: 0 },
      maskColor: '#ff8800',
      ...extra,
    });
    set.set([item('a', 0), item('b', 1)]);
    for (const load of loads) load.resolve();
    await settle();
    for (const load of loads) load.ready();
    const [a, b] = loads.map((load) => load.model);
    const shader = a.customShader;
    assert.ok(shader instanceof Cesium.CustomShader, 'the mask shader');
    const version = part.version();
    shaderLookups = 0;
    for (let frame = 1; frame <= 5; frame++) {
      set.upsert([item('a', frame * 1e-5), item('b', 1 + frame * 1e-5)]);
      part.beforeRender();
    }
    const moved = Cesium.Matrix4.getTranslation(
      a.modelMatrix,
      new Cesium.Cartesian3(),
    );
    assert.ok(
      Cesium.Cartesian3.distance(
        moved,
        Cesium.Cartesian3.fromDegrees(5e-5, 0, 10),
      ) < 1e-6,
      'moved',
    );
    assert.equal(a.customShader, shader, 'the same shader');
    assert.equal(shaderLookups, 0, 'not looked up again');
    assert.equal(part.version(), version, 'no pick id added or gone');

    // A new mask colour, a new shading and the mask again: each drawn.
    set.upsert([item('a', 0, { maskColor: '#0000ff' })]);
    assert.notEqual(a.customShader, shader, 'a new colour, a new shader');
    assert.equal(b.customShader, shader, 'the other keeps its own');
    set.upsert([item('a', 0, { maskColor: '#0000ff', shading: 'thermal' })]);
    const thermal = a.customShader;
    assert.ok(thermal instanceof Cesium.CustomShader);
    assert.notEqual(thermal, shader);
    set.upsert([item('a', 0)]);
    assert.equal(a.customShader, shader, 'its mask again');
    set.upsert([item('a', 0, { maskColor: undefined })]);
    assert.equal(a.customShader, undefined, 'no mask: lit as it is');

    // A model added changes what height queries see through.
    set.upsert([item('c', 2)]);
    assert.notEqual(part.version(), version, 'a pick id added');
    set.dispose();
  } finally {
    Cesium.Color.prototype.toCssHexString = toCss;
    restore();
  }
});

test('a model poses its named nodes once ready, writes only what changed, and gives a dropped one its own pose back', async () => {
  const { loads, restore } = fakeModelLoads();
  try {
    const part = createCesiumDraw({
      scene: fakeScene(),
      report: (error) => assert.fail(error),
    });
    const set = part.port.models({ id: 'station' });
    const turn = (x) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
    const item = (nodes) => ({
      id: 'iss',
      pos: { lon: 0, lat: 0, height: 400e3 },
      url: 'iss.glb',
      orientation: { heading: 0, pitch: 0, roll: 0 },
      nodes,
    });
    set.upsert([item({ joint: turn(1), other: turn(2), missing: turn(3) })]);
    loads[0].resolve();
    await settle();
    const model = loads[0].model;
    const writes = [];
    const nodes = {};
    for (const name of ['joint', 'other'])
      nodes[name] = {
        originalMatrix: Cesium.Matrix4.fromTranslation(
          new Cesium.Cartesian3(9, 9, 9),
        ),
        set matrix(m) {
          writes.push(name);
          // As Cesium's runtime node does: a copy, not the matrix handed in.
          this.current = Cesium.Matrix4.clone(m);
        },
      };
    model.getNode = (name) => {
      assert.equal(model.ready, true, 'nodes are asked for once ready');
      return nodes[name];
    };
    loads[0].ready();
    assert.deepEqual(writes.sort(), ['joint', 'other'], 'posed when ready');
    assert.equal(nodes.joint.current[12], 1);
    assert.equal(nodes.other.current[12], 2);

    writes.length = 0;
    set.upsert([item({ joint: turn(1), other: turn(5), missing: turn(3) })]);
    assert.deepEqual(writes, ['other'], 'only the node that moved');
    assert.equal(nodes.other.current[12], 5);

    writes.length = 0;
    set.upsert([item({ other: turn(5) })]);
    assert.deepEqual(writes, ['joint'], 'the dropped node, back to its pose');
    assert.equal(nodes.joint.current[12], 9);
    set.dispose();
  } finally {
    restore();
  }
});

test('a model set that recedes fades its models toward the limb with their focus; focus alone dims', async () => {
  const { recedeFactors, recedeFrame, recedeParams, recededAlpha } =
    await import('../recession.js');
  const { loads, restore } = fakeModelLoads();
  try {
    const scene = fakeScene();
    const heightM = 1_000_000;
    scene.camera.positionWC = new Cesium.Cartesian3(6_378_137 + heightM, 0, 0);
    scene.camera.positionCartographic = { height: heightM };
    const part = createCesiumDraw({
      scene,
      report: (error) => assert.fail(error),
    });
    const set = part.port.models({ id: 'm', recede: {} });
    const item = (extra = {}) => ({
      id: 'a',
      pos: { lon: 25, lat: 0, height: 0 },
      url: 'a.glb',
      orientation: { heading: 0, pitch: 0, roll: 0 },
      tint: [1, 0, 0, 0.8],
      focus: 0.5,
      ...extra,
    });
    set.set([item()]);
    loads[0].resolve();
    await settle();
    const model = loads[0].model;
    loads[0].ready();
    part.beforeRender();
    const params = recedeParams({});
    const d = Cesium.Cartesian3.distance(
      scene.camera.positionWC,
      Cesium.Cartesian3.fromDegrees(25, 0, 0),
    );
    const haze = recedeFactors(d, recedeFrame(heightM, params), params).alpha;
    assert.ok(haze < 0.9, `receding: ${haze}`);
    const want = 0.8 * recededAlpha(0.5, haze, params);
    assert.ok(
      Math.abs(model.color.alpha - want) < 1e-6,
      `${model.color.alpha} vs ${want}`,
    );
    assert.equal(model.color.red, 1, 'the tint kept');
    // Not receding: the tint's alpha times the focus.
    set.setOptions({ recede: null });
    part.beforeRender();
    assert.ok(Math.abs(model.color.alpha - 0.4) < 1e-6, `${model.color.alpha}`);
    set.upsert([item({ focus: undefined })]);
    part.beforeRender();
    assert.ok(Math.abs(model.color.alpha - 0.8) < 1e-6);
    // Receding again, over the blend band: only the combined floor holds.
    set.setOptions({ recede: {} });
    scene.camera.positionCartographic = { height: 9_000_000 };
    set.upsert([item({ focus: 0.1 })]);
    part.beforeRender();
    assert.ok(Math.abs(model.color.alpha - 0.8 * 0.2) < 1e-6);
    set.dispose();
  } finally {
    restore();
  }
});

test('a raised polygon outlines its holes as well as its outer ring', () =>
  withImageClasses(() => {
    const { scene, draw } = drawOver();
    const set = draw.shapes({ id: 'raised-holes' });
    const at = ([lon, lat]) => ({ lon, lat, height: 100 });
    const outer = [
      [0, 0],
      [0.01, 0],
      [0.01, 0.01],
      [0, 0.01],
    ].map(at);
    // A triangle, so its line has a length of its own.
    const hole = [
      [0.004, 0.004],
      [0.006, 0.004],
      [0.005, 0.006],
    ].map(at);
    set.set([
      {
        id: 'p',
        geometry: {
          kind: 'polygon',
          rings: [outer, hole],
          perPositionHeight: true,
        },
        fill: [0, 0.5, 1, 0.3],
        outline: [0, 0.5, 1, 1],
        outlineWidth: 1,
        height: 'absolute',
      },
    ]);
    const host = scene.added[0];
    let outlines = null;
    for (let i = 0; i < host.length; i++)
      if (host.get(i) instanceof Cesium.PolylineCollection)
        outlines = host.get(i);
    assert.ok(outlines, 'outlined');
    assert.equal(outlines.length, 2, 'the outer ring and the hole');
    for (const [i, ring] of [outer, hole].entries()) {
      const line = outlines.get(i);
      assert.equal(line.positions.length, ring.length + 1, 'closed');
      const start = Cesium.Cartesian3.fromDegrees(
        ring[0].lon,
        ring[0].lat,
        ring[0].height,
      );
      assert.ok(
        Cesium.Cartesian3.equalsEpsilon(line.positions[0], start, 0, 1e-6),
        `line ${i} runs along its ring`,
      );
      assert.equal(line.width, 1);
      assert.ok(
        Cesium.Color.equals(
          line.material.uniforms.color,
          new Cesium.Color(0, 0.5, 1, 1),
        ),
      );
      assert.equal(line.id.set, 'raised-holes');
      assert.equal(line.id.id, 'p', 'picks as the polygon');
    }
    set.dispose();
  }));

test('quads draw a posed plane and its outline, changed in place', () =>
  withImageClasses(() => {
    const scene = fakeScene();
    const part = createCesiumDraw({
      scene,
      report: (error) => assert.fail(error),
    });
    const set = part.port.quads({ id: 'monitors' });
    const canvas = { width: 4, height: 4 };
    const other = { width: 4, height: 4 };
    const center = { x: 6378137, y: 10, z: 20 };
    const quad = (extra = {}) => ({
      id: 'q',
      center,
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      size: [40, 20],
      source: { canvas },
      alpha: 0.95,
      outline: { color: [0.4, 0.9, 1, 0.55], widthPx: 1 },
      meta: { camera: 'c1' },
      ...extra,
    });
    set.set([quad()]);
    const host = scene.added[0];
    assert.equal(host.length, 2, 'the plane and its outline');
    const [fill, outline] = [host.get(0), host.get(1)];
    assert.ok(fill.geometryInstances.geometry instanceof Cesium.PlaneGeometry);
    assert.ok(
      outline.geometryInstances.geometry instanceof Cesium.PlaneOutlineGeometry,
    );
    assert.deepEqual(fill.geometryInstances.id, {
      set: 'monitors',
      id: 'q',
      meta: { camera: 'c1' },
    });
    // Scaled to its size about its centre, as a plane entity's matrix is.
    const scale = Cesium.Matrix4.getScale(
      fill.modelMatrix,
      new Cesium.Cartesian3(),
    );
    assert.deepEqual([scale.x, scale.y, scale.z], [40, 20, 1]);
    const at = Cesium.Matrix4.getTranslation(
      fill.modelMatrix,
      new Cesium.Cartesian3(),
    );
    assert.deepEqual({ x: at.x, y: at.y, z: at.z }, center);
    const material = fill.appearance.material;
    assert.equal(material.type, 'Image');
    assert.equal(material.uniforms.image, canvas);
    assert.ok(Math.abs(material.uniforms.color.alpha - 0.95) < 1e-12);
    assert.equal(fill.appearance.translucent, true);

    // Moved, resized, faded, hidden and given another canvas: the same plane.
    set.upsert([
      quad({
        center: { x: 6378137, y: 30, z: 20 },
        size: [80, 45],
        alpha: 0.5,
        show: false,
        source: { canvas: other },
        meta: { camera: 'c2' },
      }),
    ]);
    assert.equal(host.get(0), fill, 'changed where it is');
    Cesium.Matrix4.getScale(fill.modelMatrix, scale);
    assert.deepEqual([scale.x, scale.y], [80, 45]);
    assert.ok(
      Cesium.Matrix4.equals(fill.modelMatrix, outline.modelMatrix),
      'the outline follows',
    );
    assert.equal(fill.show, false);
    assert.equal(outline.show, false);
    assert.equal(material.uniforms.image, other, 'the new canvas is read');
    assert.ok(Math.abs(material.uniforms.color.alpha - 0.5) < 1e-12);
    assert.deepEqual(fill.geometryInstances.id.meta, { camera: 'c2' });

    // Unpickable, or without an outline: built anew.
    set.upsert([quad({ outline: null, pickable: false })]);
    assert.equal(host.length, 1, 'no outline');
    assert.notEqual(host.get(0), fill);
    assert.equal(host.get(0).allowPicking, false);
    set.remove(['q']);
    assert.equal(host.length, 0);
    set.dispose();
    assert.equal(scene.added.length, 0);
  }));

test('a video quad keeps frames coming while it plays, read anew at a new size', () =>
  withImageClasses(() => {
    const realVideo = globalThis.HTMLVideoElement;
    globalThis.HTMLVideoElement = class extends EventTarget {};
    try {
      const scene = fakeScene();
      let renders = 0;
      scene.requestRender = () => (renders += 1);
      const part = createCesiumDraw({
        scene,
        report: (error) => assert.fail(error),
      });
      const set = part.port.quads({ id: 'feeds' });
      const video = Object.assign(new globalThis.HTMLVideoElement(), {
        readyState: 4,
        paused: false,
        ended: false,
        videoWidth: 640,
        videoHeight: 360,
      });
      set.set([
        {
          id: 'v',
          center: { x: 6378137, y: 0, z: 0 },
          orientation: { x: 0, y: 0, z: 0, w: 1 },
          size: [16, 9],
          source: { video },
          alpha: 0.95,
        },
      ]);
      const fill = scene.added[0].get(0);
      const first = fill.appearance.material;
      assert.equal(first.uniforms.image, video);
      part.beforeRender();
      renders = 0;
      part.afterRender();
      assert.ok(renders > 0, 'a playing video asks for the next frame');
      // Past the frames a new image needs, a paused video asks for none.
      part.afterRender();
      part.afterRender();
      video.paused = true;
      renders = 0;
      part.afterRender();
      assert.equal(renders, 0, 'a paused video draws no more frames');
      // A new size: a new material reads it, the old one freed once drawn.
      video.videoWidth = 1280;
      video.videoHeight = 720;
      part.beforeRender();
      assert.notEqual(fill.appearance.material, first);
      assert.equal(fill.appearance.material.uniforms.image, video);
      assert.equal(first.isDestroyed(), false, 'kept until the frame drew');
      part.afterRender();
      assert.equal(first.isDestroyed(), true);
      // Paused, it draws again as it plays, with no frame asked for.
      renders = 0;
      video.dispatchEvent(new Event('playing'));
      assert.equal(renders, 1, 'playing again asks for a frame');
      // From the video to a canvas: a material of its own.
      const sized = fill.appearance.material;
      const canvas = { width: 4, height: 4 };
      const quad = {
        id: 'v',
        center: { x: 6378137, y: 0, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
        size: [16, 9],
        source: { canvas },
        alpha: 0.95,
      };
      set.upsert([{ ...quad, show: false }]);
      assert.notEqual(fill.appearance.material, sized);
      assert.equal(fill.appearance.material.uniforms.image, canvas);
      renders = 0;
      video.dispatchEvent(new Event('playing'));
      assert.equal(renders, 0, 'the video it left is no longer heard');
      // Hidden, the frames its image needs wait until it shows.
      part.afterRender();
      part.afterRender();
      part.afterRender();
      set.upsert([quad]);
      renders = 0;
      part.afterRender();
      assert.ok(renders > 0, 'shown, it asks for the frames its image needs');
      set.dispose();
    } finally {
      globalThis.HTMLVideoElement = realVideo;
    }
  }));

test('meshes draw their triangles in the frame at their origin', () =>
  withImageClasses(() => {
    const scene = fakeScene();
    const part = createCesiumDraw({
      scene,
      report: (error) => assert.fail(error),
    });
    const set = part.port.meshes({ id: 'volumes', pickable: false });
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]);
    const indices = new Uint16Array([0, 1, 2, 0, 1, 3]);
    const origin = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 200);
    const mesh = (extra = {}) => ({
      id: 'm',
      origin: { x: origin.x, y: origin.y, z: origin.z },
      positions,
      indices,
      color: [0.2, 0.8, 1, 0.2],
      flat: true,
      ...extra,
    });
    set.set([mesh()]);
    const host = scene.added[0];
    assert.equal(host.length, 1);
    const primitive = host.get(0);
    const geometry = primitive.geometryInstances.geometry;
    assert.equal(
      geometry.attributes.position.componentDatatype,
      Cesium.ComponentDatatype.DOUBLE,
    );
    // In the Earth-fixed frame: the east-north-up offsets about the origin.
    const frame = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
    const values = geometry.attributes.position.values;
    for (let i = 0; i < positions.length; i += 3) {
      const want = Cesium.Matrix4.multiplyByPoint(
        frame,
        new Cesium.Cartesian3(positions[i], positions[i + 1], positions[i + 2]),
        new Cesium.Cartesian3(),
      );
      assert.ok(
        Cesium.Cartesian3.equalsEpsilon(
          new Cesium.Cartesian3(values[i], values[i + 1], values[i + 2]),
          want,
          0,
          1e-6,
        ),
        `vertex ${i / 3} in place`,
      );
    }
    assert.equal(geometry.indices, indices);
    assert.equal(primitive.allowPicking, false, 'an unpickable set');
    assert.equal(primitive.appearance.flat, true);
    assert.equal(primitive.appearance.translucent, true);
    assert.equal(
      primitive.appearance.renderState.cull.enabled,
      false,
      'both faces',
    );
    // Hidden: the same primitive.
    set.upsert([mesh({ show: false })]);
    assert.equal(host.get(0), primitive);
    assert.equal(primitive.show, false);
    // Moved: built anew where it now is.
    const moved = Cesium.Cartesian3.fromDegrees(-97.73, 30.27, 200);
    set.upsert([mesh({ origin: { x: moved.x, y: moved.y, z: moved.z } })]);
    assert.equal(host.length, 1);
    const rebuilt = host.get(0);
    assert.notEqual(rebuilt, primitive);
    const first = rebuilt.geometryInstances.geometry.attributes.position.values;
    assert.ok(
      Cesium.Cartesian3.equalsEpsilon(
        new Cesium.Cartesian3(first[0], first[1], first[2]),
        moved,
        0,
        1e-6,
      ),
      'its origin vertex is the new origin',
    );
    // A new colour builds it anew.
    set.upsert([mesh({ color: '#ff0000' })]);
    assert.equal(host.length, 1);
    assert.notEqual(host.get(0), rebuilt);
    // Lit meshes are closed: their back faces culled.
    set.upsert([mesh({ flat: false })]);
    assert.equal(host.get(0).appearance.closed, true);
    set.clear();
    assert.equal(host.length, 0);
    set.dispose();
  }));

test('an inertial line with a depth-fail style draws behind the surface too, turned with the sky', () =>
  withImageClasses(() => {
    const { scene, draw } = drawOver();
    const set = draw.lines({ id: 'sky-deep' });
    set.set([
      {
        id: 'orbit',
        positions: [
          { x: 7e6, y: 0, z: 0 },
          { x: 0, y: 7e6, z: 0 },
        ],
        widthPx: 2,
        mode: '3d',
        style: { kind: 'solid', color: '#0ff' },
        depthFail: { kind: 'solid', color: '#088' },
        frame: 'inertial',
      },
    ]);
    const found = [];
    const walk = (p) => {
      if (p instanceof Cesium.PrimitiveCollection)
        for (let i = 0; i < p.length; i++) walk(p.get(i));
      else if (p instanceof Cesium.Primitive) found.push(p);
    };
    walk(scene.added[0]);
    assert.equal(found.length, 1);
    assert.ok(found[0].depthFailAppearance, 'drawn behind the surface');
    const expected = Cesium.Matrix3.multiplyByVector(
      Cesium.Transforms.computeTemeToPseudoFixedMatrix(Cesium.JulianDate.now()),
      Cesium.Cartesian3.UNIT_X,
      new Cesium.Cartesian3(),
    );
    const turned = Cesium.Matrix4.multiplyByPointAsVector(
      found[0].modelMatrix,
      Cesium.Cartesian3.UNIT_X,
      new Cesium.Cartesian3(),
    );
    assert.ok(Cesium.Cartesian3.equalsEpsilon(turned, expected, 1e-6));
    set.dispose();
  }));

test('a pattern line draws its image along it, repeated, and an inertial line turns with the sky', (t) =>
  withImageClasses(() => {
    timeFrames(t);
    const { scene, draw, frame } = drawOver();
    const set = draw.lines({ id: 'orbit-rings' });
    const ring = [
      { x: 7e6, y: 0, z: 0 },
      { x: 0, y: 7e6, z: 0 },
      { x: -7e6, y: 0, z: 0 },
    ];
    const pattern = { kind: 'pattern', image: 'marks.png', repeat: 4 };
    set.set([
      { id: 'fixed', positions: ring, widthPx: 3, mode: '3d', style: pattern },
      {
        id: 'sky',
        positions: ring,
        widthPx: 3,
        mode: '3d',
        style: pattern,
        frame: 'inertial',
      },
    ]);
    const host = scene.added[0];
    assert.ok(host instanceof Cesium.PrimitiveCollection);
    const fixed = host.get(0);
    const inertial = host.get(1);
    assert.ok(inertial instanceof Cesium.PolylineCollection);
    const material = fixed.get(0).material;
    assert.equal(material.type, 'Image');
    assert.equal(material.uniforms.image, 'marks.png');
    assert.deepEqual(material.uniforms.repeat, new Cesium.Cartesian2(4, 1));
    assert.equal(material.isTranslucent(), true, 'its image has its alpha');
    assert.equal(inertial.get(0).id.id, 'sky');
    // Turned by sidereal time: the inertial x axis is drawn where the
    // pseudo-fixed frame puts it now.
    const turnedTo = () =>
      Cesium.Matrix4.multiplyByPointAsVector(
        inertial.modelMatrix,
        Cesium.Cartesian3.UNIT_X,
        new Cesium.Cartesian3(),
      );
    const expected = Cesium.Matrix3.multiplyByVector(
      Cesium.Transforms.computeTemeToPseudoFixedMatrix(Cesium.JulianDate.now()),
      Cesium.Cartesian3.UNIT_X,
      new Cesium.Cartesian3(),
    );
    assert.ok(
      Cesium.Cartesian3.equalsEpsilon(turnedTo(), expected, 1e-6),
      'turned as Cesium turns TEME',
    );
    const realNow = Date.now;
    try {
      const at = realNow();
      Date.now = () => at + 3_600_000;
      frame();
      const later = turnedTo();
      // An hour turns the frame about 15 degrees about the pole.
      const angle = Cesium.Cartesian3.angleBetween(later, expected);
      assert.ok(Math.abs(Cesium.Math.toDegrees(angle) - 15.04) < 0.05);
      assert.ok(Math.abs(later.z) < 1e-9);
    } finally {
      Date.now = realNow;
    }
    // Never settled into a static batch; shown and hidden in place. A
    // hidden line that never settles leaves its collection, which would
    // draw it on regardless, until it shows again.
    for (let i = 0; i < SETTLE_FRAMES + 2; i++) frame();
    const sky = (show) => ({
      id: 'sky',
      positions: ring,
      widthPx: 3,
      mode: '3d',
      style: pattern,
      frame: 'inertial',
      show,
    });
    set.upsert([sky(false), { ...sky(false), id: 'fixed', frame: undefined }]);
    assert.equal(scene.added[0], host, 'patched, not rebuilt');
    assert.equal(inertial.length, 0);
    assert.equal(fixed.length, 0);
    set.upsert([sky(true)]);
    assert.equal(scene.added[0], host);
    assert.equal(inertial.length, 1);
    assert.equal(inertial.get(0).show, true);
    assert.equal(inertial.get(0).id.id, 'sky');
    assert.equal(inertial.get(0).material.type, 'Image');
    // Built hidden, it starts out of its collection.
    const later = draw.lines({ id: 'orbit-rings-hidden' });
    later.set([{ ...sky(false), id: 'parked' }]);
    assert.equal(scene.added.at(-1).get(1).length, 0);
    later.upsert([{ ...sky(true), id: 'parked' }]);
    assert.equal(scene.added.at(-1).get(1).length, 1);
    later.dispose();
    set.dispose();
    assert.equal(scene.added.length, 0);
  }));

test('a clamped ellipse with an image fill drapes its material, finely cut so a round image runs round', () =>
  withImageClasses(() => {
    const { scene, draw } = drawOver();
    const set = draw.shapes({ id: 'pad-zone' });
    const zone = {
      id: 'zone',
      geometry: {
        kind: 'ellipse',
        center: { lon: -80.6, lat: 28.6 },
        semiMajor: 500,
        semiMinor: 500,
      },
      fill: { image: 'zone.png' },
      height: 'clampGround',
    };
    set.set([zone]);
    const host = scene.added[0];
    let ground = null;
    for (let i = 0; i < host.length; i++)
      if (host.get(i) instanceof Cesium.GroundPrimitive) ground = host.get(i);
    assert.ok(ground);
    const { appearance } = ground;
    assert.ok(appearance instanceof Cesium.MaterialAppearance);
    assert.equal(appearance.material.type, 'Image');
    assert.equal(appearance.material.uniforms.image, 'zone.png');
    assert.equal(ground.classificationType, Cesium.ClassificationType.BOTH);
    const [instance] = ground.geometryInstances;
    assert.ok(instance.geometry instanceof Cesium.EllipseGeometry);
    assert.ok(
      Math.abs(instance.geometry._granularity - Cesium.Math.toRadians(0.08)) <
        1e-12,
    );
    assert.equal(instance.id.id, 'zone');
    // Hidden and shown in place, once its primitive is ready.
    Object.defineProperty(ground, 'ready', { value: true });
    const shows = { show: Uint8Array.of(1) };
    ground.getGeometryInstanceAttributes = () => shows;
    set.upsert([{ ...zone, show: false }]);
    assert.equal(scene.added[0], host, 'patched, not rebuilt');
    assert.deepEqual([...shows.show], [0]);
    set.dispose();
  }));

test('a clamped fill that moves or resizes is drawn where it now is in the same frame, once terrain heights are loaded', () =>
  withTerrainHeights(() => {
    const { scene, draw, frame } = drawOver();
    const set = draw.shapes({ id: 'dragged' });
    const box = (id, east, extra = {}) => ({
      id,
      geometry: {
        kind: 'rectangle',
        rect: { west: 0, south: 0, east, north: 1 },
      },
      fill: [0.5, 0.9, 1, 0.12],
      height: 'clampGround',
      ...extra,
    });
    set.set([
      box('a', 1),
      box('b', 3, {
        geometry: {
          kind: 'rectangle',
          rect: { west: 2, south: 0, east: 3, north: 1 },
        },
      }),
    ]);
    const host = scene.added[0];
    const groundOf = (h) => {
      for (let i = 0; i < h.length; i++)
        if (h.get(i) instanceof Cesium.GroundPrimitive) return h.get(i);
      return null;
    };
    const batch = groundOf(host);
    const shows = new Map();
    const attributesOf = (primitive) => {
      primitive.getGeometryInstanceAttributes = (id) => {
        const key = `${primitive.geometryInstances.length}:${id.id}`;
        if (!shows.has(key)) shows.set(key, { show: new Uint8Array([1]) });
        return shows.get(key);
      };
    };
    attributesOf(batch);
    // Resized while its batch still builds: drawn alone, built at once.
    set.upsert([box('a', 1.5, { meta: 'dragged' })]);
    assert.equal(scene.added[0], host, 'the set is not rebuilt');
    const solo = host.get(host.length - 1);
    assert.ok(solo instanceof Cesium.GroundPrimitive);
    assert.equal(solo.asynchronous, false, 'built in the frame it is drawn');
    const instance = solo.geometryInstances[0];
    assert.equal(instance.id.id, 'a');
    assert.equal(instance.id.meta, 'dragged');
    assert.equal(
      instance.id,
      batch.geometryInstances.find((i) => i.id.id === 'a').id,
      'the same pick id',
    );
    assert.ok(
      Cesium.Rectangle.equalsEpsilon(
        instance.geometry._rectangle,
        Cesium.Rectangle.fromDegrees(0, 0, 1.5, 1),
        1e-12,
      ),
    );
    // Its place in the batch is hidden once the batch is ready; the rest draws.
    Object.defineProperty(batch, 'ready', { value: true });
    frame();
    assert.deepEqual([...shows.get('2:a').show], [0], 'hidden in the batch');
    assert.equal(shows.get('2:b'), undefined, 'the other untouched');
    // Moved again: the one built for it is replaced.
    set.upsert([box('a', 2)]);
    const again = host.get(host.length - 1);
    assert.notEqual(again, solo);
    assert.ok(solo.isDestroyed(), 'the old one goes');
    // A show change on a ready one is in place; one not yet drawn is built again.
    Object.defineProperty(again, 'ready', { value: true });
    attributesOf(again);
    set.upsert([box('a', 2, { show: false })]);
    assert.equal(host.get(host.length - 1), again);
    assert.deepEqual([...shows.get('1:a').show], [0]);
    // A new item: the set rebuilds.
    set.upsert([box('a', 2), box('z', 3)]);
    assert.notEqual(scene.added.at(-1), host, 'rebuilt');
    set.dispose();
    assert.equal(scene.added.length, 0);
  }));

test('a moved clamped fill is hidden where a rebuild in flight still draws it', () =>
  withTerrainHeights(() => {
    const { scene, draw, frame } = drawOver();
    const set = draw.shapes({ id: 'retiring' });
    const box = (id, east, fill = [0.5, 0.9, 1, 0.12]) => ({
      id,
      geometry: {
        kind: 'rectangle',
        rect: { west: 0, south: 0, east, north: 1 },
      },
      fill,
      height: 'clampGround',
    });
    set.set([box('a', 1)]);
    const first = scene.added[0];
    const groundOf = (h) => {
      for (let i = 0; i < h.length; i++)
        if (h.get(i) instanceof Cesium.GroundPrimitive) return h.get(i);
      return null;
    };
    const old = groundOf(first);
    Object.defineProperty(old, 'ready', { value: true });
    frame();
    const shown = { show: new Uint8Array([1]) };
    old.getGeometryInstanceAttributes = () => shown;
    // A new item rebuilds; the old host draws on until the new is ready.
    set.upsert([box('a', 1, [1, 0, 0, 0.5]), box('z', 0.5)]);
    const second = scene.added.find((p) => p !== first);
    assert.ok(
      second && scene.added.includes(first),
      'both drawn while it builds',
    );
    // Moved meanwhile: drawn alone in the new host, and gone from the old one.
    set.upsert([box('a', 2, [1, 0, 0, 0.5])]);
    assert.ok(second.get(second.length - 1).asynchronous === false);
    assert.deepEqual(
      [...shown.show],
      [0],
      'hidden where the old host draws it',
    );
    set.dispose();
  }));

/** A clamped colour rectangle from 0° to `east`°, for the move tests. */
const groundBox = (id, east, extra = {}) => ({
  id,
  geometry: {
    kind: 'rectangle',
    rect: { west: 0, south: 0, east, north: 1 },
  },
  fill: [0.5, 0.9, 1, 0.12],
  height: 'clampGround',
  ...extra,
});

/** Every ground primitive in a host built, with a show to read and set. */
const groundsReady = (host) => {
  for (let i = 0; i < host.length; i++) {
    const ground = host.get(i);
    if (!(ground instanceof Cesium.GroundPrimitive)) continue;
    Object.defineProperty(ground, 'ready', { value: true });
    const show = { show: new Uint8Array([1]) };
    ground.getGeometryInstanceAttributes = () => show;
  }
};

/** The first ground primitive in a host, or null. */
const firstGround = (host) => {
  for (let i = 0; i < host.length; i++)
    if (host.get(i) instanceof Cesium.GroundPrimitive) return host.get(i);
  return null;
};

test('moved clamped fills go back into a rebuilt batch once they have been still for a while', (t) =>
  withTerrainHeights(() => {
    timeFrames(t);
    const { scene, draw, frame } = drawOver();
    const set = draw.shapes({ id: 'settling' });
    set.set([groundBox('a', 1), groundBox('b', 2)]);
    const host = scene.added[0];
    groundsReady(host);
    frame();
    set.upsert([groundBox('a', 1.5)]);
    for (let i = 0; i < SETTLE_FRAMES - 1; i++) frame();
    // Moved again before it settled: it waits from there.
    set.upsert([groundBox('a', 1.6)]);
    for (let i = 0; i < SETTLE_FRAMES - 1; i++) frame();
    assert.deepEqual(scene.added, [host], 'not rebuilt while it moves');
    frame();
    assert.equal(scene.added.length, 2, 'rebuilt once still');
    const rebuilt = scene.added.find((p) => p !== host);
    const instances = [];
    for (let i = 0; i < rebuilt.length; i++)
      if (rebuilt.get(i) instanceof Cesium.GroundPrimitive)
        instances.push(...rebuilt.get(i).geometryInstances);
    assert.deepEqual(
      instances.map((i) => i.id.id).sort(),
      ['a', 'b'],
      'both in the new batches',
    );
    assert.ok(
      rebuilt.get(0).asynchronous !== false,
      'built as a batch, not alone',
    );
    assert.ok(
      Cesium.Rectangle.equalsEpsilon(
        instances.find((i) => i.id.id === 'a').geometry._rectangle,
        Cesium.Rectangle.fromDegrees(0, 0, 1.6, 1),
        1e-12,
      ),
      'where it last moved',
    );
    // The host drawing it alone draws until the rebuild is ready.
    assert.ok(scene.added.includes(host));
    for (let i = 0; i < SETTLE_FRAMES * 2; i++) frame();
    assert.equal(scene.added.length, 2, 'it settles once');
    set.dispose();
  }));

test('an upsert that would draw more clamped fills alone than MOVING_SHAPES rebuilds instead', () =>
  withTerrainHeights(() => {
    const { scene, draw, frame } = drawOver();
    const set = draw.shapes({ id: 'many', pickable: false });
    const ids = Array.from({ length: MOVING_SHAPES + 1 }, (_, i) => `s${i}`);
    set.set(ids.map((id) => groundBox(id, 1)));
    const host = scene.added[0];
    groundsReady(host);
    frame();
    // A set that does not pick draws one alone without picking.
    set.upsert([groundBox('s0', 1.5)]);
    const solo = host.get(host.length - 1);
    assert.equal(solo.asynchronous, false);
    assert.equal(solo.allowPicking, false);
    assert.deepEqual(scene.added, [host]);
    set.upsert(ids.slice(1, MOVING_SHAPES).map((id) => groundBox(id, 1.5)));
    assert.deepEqual(scene.added, [host], 'MOVING_SHAPES alone at most');
    set.upsert([groundBox(ids.at(-1), 1.5)]);
    assert.equal(scene.added.length, 2, 'one more rebuilds the set');
    set.dispose();
  }));

test('a clamped fill moved before terrain heights load rebuilds its set', () => {
  const heights = Cesium.ApproximateTerrainHeights;
  if (heights.initialized) return;
  const { scene, draw } = drawOver();
  const set = draw.shapes({ id: 'no-heights' });
  set.set([groundBox('a', 1)]);
  const host = scene.added[0];
  set.upsert([groundBox('a', 1.5)]);
  assert.ok(
    !scene.added.includes(host) || scene.added.length > 1,
    'rebuilt, not drawn alone',
  );
  set.dispose();
});

test('a moved clamped fill shows again where the retiring host draws it when the host drawing it alone goes unbuilt', () =>
  withTerrainHeights(() => {
    const { scene, draw, frame } = drawOver();
    const set = draw.shapes({ id: 'twice' });
    set.set([groundBox('a', 1)]);
    const first = scene.added[0];
    const old = firstGround(first);
    Object.defineProperty(old, 'ready', { value: true });
    frame();
    const shown = { show: new Uint8Array([1]) };
    old.getGeometryInstanceAttributes = () => shown;
    set.upsert([groundBox('a', 1), groundBox('z', 0.5)]);
    set.upsert([groundBox('a', 2)]);
    assert.deepEqual([...shown.show], [0], 'hidden while drawn alone');
    // A second rebuild drops the host drawing it alone, still building.
    set.upsert([groundBox('a', 2), groundBox('y', 0.5)]);
    assert.ok(scene.added.includes(first), 'the retiring host draws on');
    assert.equal(scene.added.length, 2);
    assert.deepEqual([...shown.show], [1], 'drawn where it was, not gone');
    set.dispose();
  }));

/** Ground primitives in a host built, each instance's show kept by id. */
const groundsReadyById = (host, shows = new Map()) => {
  for (let i = 0; i < host.length; i++) {
    const ground = host.get(i);
    if (!(ground instanceof Cesium.GroundPrimitive)) continue;
    Object.defineProperty(ground, 'ready', { value: true });
    ground.getGeometryInstanceAttributes = (id) => {
      if (!shows.has(id.id)) {
        const shown = ground.geometryInstances.find((g) => g.id === id)
          ?.attributes.show.value[0];
        shows.set(id.id, { show: new Uint8Array([shown ?? 1]) });
      }
      return shows.get(id.id);
    };
  }
  return shows;
};

test('a hidden clamped fill moved while its set rebuilds stays hidden when a second rebuild comes', () =>
  withTerrainHeights(() => {
    const { scene, draw, frame } = drawOver();
    const set = draw.shapes({ id: 'hidden-twice' });
    set.set([
      groundBox('a', 1, { show: false }),
      groundBox('b', 1, {
        geometry: {
          kind: 'rectangle',
          rect: { west: 5, south: 0, east: 6, north: 1 },
        },
      }),
    ]);
    const first = scene.added[0];
    const shows = groundsReadyById(first);
    frame();
    const b = (fill) =>
      groundBox('b', 1, {
        geometry: {
          kind: 'rectangle',
          rect: { west: 5, south: 0, east: 6, north: 1 },
        },
        fill,
      });
    set.upsert([b([1, 0, 0, 0.5])]);
    set.upsert([groundBox('a', 2, { show: false })]);
    set.upsert([b([0, 1, 0, 0.5])]);
    assert.ok(scene.added.includes(first), 'the retiring host draws on');
    assert.deepEqual([...shows.get('a').show], [0], 'a stays hidden');
    set.dispose();
  }));

test('clamped fills drawn alone by a host still retiring count toward MOVING_SHAPES', () =>
  withTerrainHeights(() => {
    const { scene, draw, frame } = drawOver();
    const set = draw.shapes({ id: 'cap-retiring' });
    const ids = Array.from(
      { length: MOVING_SHAPES * 2 + 1 },
      (_, i) => `s${i}`,
    );
    set.set(ids.map((id) => groundBox(id, 1)));
    const first = scene.added[0];
    groundsReady(first);
    frame();
    // Half the cap moved, then a rebuild while they are drawn alone.
    set.upsert(ids.slice(0, MOVING_SHAPES).map((id) => groundBox(id, 1.5)));
    set.upsert([groundBox('new', 1)]);
    assert.equal(scene.added.length, 2, 'rebuilding, the old host retiring');
    const second = scene.added.find((p) => p !== first);
    const before = second.length;
    // Others moved while it builds: over the cap counted with the retiring
    // host's, so the set rebuilds rather than draw them alone.
    set.upsert([groundBox(ids[MOVING_SHAPES], 1.5)]);
    assert.ok(
      !scene.added.includes(second) || second.length === before,
      'nothing more drawn alone',
    );
    set.dispose();
  }));

test('the recent imagery box preview drags its ground fill and dashed edge frame by frame on a viewer of its own', async () => {
  const { createImageryBoxPreview } =
    await import('../../layers/recentImagery/rendering.js');
  const destroyed = withImageClasses(() =>
    withTerrainHeights(() => {
      const scene = fakeScene();
      const viewer = { scene, isDestroyed: () => false };
      let box = { west: -98, south: 30, east: -97.95, north: 30.05 };
      const preview = createImageryBoxPreview(viewer, () => box);
      preview.setVisible(true);
      const hosts = scene.added.slice();
      assert.equal(hosts.length, 2, 'a fill set and an edge set');
      const groundIn = (host) => {
        for (let i = 0; i < host.length; i++)
          if (host.get(i) instanceof Cesium.GroundPrimitive) return host.get(i);
        return null;
      };
      const fillHost = hosts.find((h) => groundIn(h));
      assert.ok(fillHost, 'the fill is a ground primitive');
      // Each move of the drag is drawn in the frame it is made, in place.
      for (const east of [-97.9, -97.85, -97.8]) {
        box = { ...box, east };
        preview.changed();
        const solo = fillHost.get(fillHost.length - 1);
        assert.ok(solo instanceof Cesium.GroundPrimitive);
        assert.equal(solo.asynchronous, false);
        assert.ok(
          Cesium.Rectangle.equalsEpsilon(
            solo.geometryInstances[0].geometry._rectangle,
            Cesium.Rectangle.fromDegrees(-98, 30, east, 30.05),
            1e-12,
          ),
        );
      }
      assert.deepEqual(scene.added, hosts, 'no set rebuilt');
      const edgeHost = hosts.find((h) => h !== fillHost);
      const edge = edgeHost.get(edgeHost.length - 1);
      assert.ok(edge instanceof Cesium.GroundPolylinePrimitive);
      assert.equal(edge.asynchronous, false);
      assert.equal(edge.appearance.material.type, 'PolylineDash');
      return preview.destroy().then(() => scene.added.length);
    }),
  );
  assert.equal(await destroyed, 0, 'both sets let go');
});

test('icons that only move are moved on the billboards they have, and still restyle', () => {
  const scene = fakeScene();
  const part = createCesiumDraw({
    scene,
    report: (error) => assert.fail(error),
  });
  const set = part.port.icons({ id: 'icons:moving' });
  const icon = (lon, extra = {}) => ({
    id: 'a',
    pos: Cesium.Cartesian3.fromDegrees(lon, 10, 20),
    image: 'a.png',
    size: [20, 20],
    color: [1, 0, 0, 1],
    rotationMode: 'screen',
    rotation: 0.25,
    disableDepthTest: Infinity,
    meta: { lon },
    ...extra,
  });
  set.set([icon(0), { ...icon(5), id: 'b' }]);
  const [host] = scene.added;
  const a = host.get(0);
  const version = part.version();
  // Only moved: its look is not written again.
  let restyles = 0;
  const width = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(a),
    'width',
  );
  Object.defineProperty(a, 'width', {
    get: width.get,
    set(value) {
      restyles += 1;
      width.set.call(this, value);
    },
    configurable: true,
  });
  for (const lon of [1, 2, 3]) set.upsert([icon(lon)]);
  assert.equal(restyles, 0, 'moved, not restyled');
  assert.equal(scene.added[0], host, 'the same collection');
  assert.equal(host.get(0), a, 'the same billboard');
  const at = Cesium.Cartographic.fromCartesian(a.position);
  assert.ok(Math.abs(Cesium.Math.toDegrees(at.longitude) - 3) < 1e-9);
  assert.ok(Math.abs(at.height - 20) < 1e-6);
  assert.equal(a.rotation, 0.25);
  assert.ok(Cesium.Color.equals(a.color, Cesium.Color.RED));
  assert.deepEqual(a.id.meta, { lon: 3 }, 'picks read the latest meta');
  assert.equal(part.version(), version, 'nothing added or removed');

  // A look that changes after moves is drawn, then moves go on from it.
  set.upsert([icon(3, { color: [0, 1, 0, 1], rotation: 1, size: [30, 30] })]);
  assert.equal(restyles, 1, 'restyled once');
  assert.ok(Cesium.Color.equals(a.color, Cesium.Color.LIME));
  assert.equal(a.rotation, 1);
  assert.equal(a.width, 30);
  set.upsert([icon(4, { color: [0, 1, 0, 1], rotation: 1, size: [30, 30] })]);
  assert.ok(Cesium.Color.equals(a.color, Cesium.Color.LIME));
  assert.equal(a.width, 30);
  const moved = Cesium.Cartographic.fromCartesian(a.position);
  assert.ok(Math.abs(Cesium.Math.toDegrees(moved.longitude) - 4) < 1e-9);
  // Turning on screen as it moves is written with the move, not restyled.
  set.upsert([icon(5, { color: [0, 1, 0, 1], rotation: 2, size: [30, 30] })]);
  assert.equal(restyles, 1, 'a screen turn is not a restyle');
  assert.equal(a.rotation, 2);
  set.upsert([icon(5, { color: [0, 1, 0, 1], rotation: 2, size: [31, 30] })]);
  assert.equal(restyles, 2, 'a new size still restyles');
  assert.equal(a.rotation, 2);

  // A course-turned icon's axis follows where it moves.
  const course = (lon) =>
    icon(lon, { rotationMode: 'course', course: 90, rotation: undefined });
  set.upsert([course(4)]);
  set.upsert([course(60)]);
  const north = Cesium.Matrix4.multiplyByPointAsVector(
    Cesium.Transforms.eastNorthUpToFixedFrame(
      Cesium.Cartesian3.fromDegrees(60, 10, 20),
    ),
    Cesium.Cartesian3.UNIT_Y,
    new Cesium.Cartesian3(),
  );
  assert.ok(Cesium.Cartesian3.equalsEpsilon(a.alignedAxis, north, 1e-12));
  assert.equal(a.rotation, -Cesium.Math.toRadians(90));
  // Hidden in place, while it moves.
  set.upsert([{ ...course(61), show: false }]);
  assert.equal(a.show, false);
  set.upsert([{ ...course(62), show: false }]);
  assert.equal(a.show, false);
  set.upsert([course(63)]);
  assert.equal(a.show, true);
  set.dispose();
});

test('icons moved every frame are each read once, and a new image or a new icon still draws', () => {
  const scene = fakeScene();
  const part = createCesiumDraw({
    scene,
    report: (error) => assert.fail(error),
  });
  const set = part.port.icons({ id: 'icons:fleet' });
  // Reads of each item's image: what a moved icon is drawn with is
  // looked up once an update.
  let imageReads = 0;
  const icon = (id, lon) => {
    let image = 'a.png';
    return {
      id,
      pos: { ...Cesium.Cartesian3.fromDegrees(lon, 10) },
      get image() {
        imageReads += 1;
        return image;
      },
      set image(value) {
        image = value;
      },
      size: [20, 20],
      color: '#33ccff',
      rotationMode: 'screen',
      rotation: 0,
      disableDepthTest: Infinity,
      meta: { id },
    };
  };
  const items = [icon('a', 0), icon('b', 1), icon('c', 2)];
  set.set(items);
  const [host] = scene.added;
  const billboards = [0, 1, 2].map((i) => host.get(i));
  const version = part.version();
  imageReads = 0;
  for (let frame = 1; frame <= 4; frame++) {
    for (const item of items) item.pos.x += 1;
    set.upsert(items);
  }
  assert.equal(imageReads, 4 * items.length, 'each image read once a frame');
  assert.equal(scene.added[0], host, 'the same collection');
  billboards.forEach((billboard, i) => {
    assert.equal(host.get(i), billboard, 'the same billboards');
    assert.equal(billboard.position.x, items[i].pos.x, 'moved');
  });
  assert.equal(part.version(), version, 'nothing added or removed');

  // Only some moved: the others stay where they are.
  items[1].pos.x += 1;
  set.upsert([items[1]]);
  assert.equal(billboards[1].position.x, items[1].pos.x);
  // A new image is drawn on the billboard it has.
  items[0].image = 'b.png';
  set.upsert(items);
  assert.equal(host.get(0), billboards[0], 'the same billboard');
  assert.equal(billboards[0].image, 'b.png');
  // An icon added joins after the others.
  set.upsert([...items, icon('d', 3)]);
  assert.equal(host.length, 4);
  assert.notEqual(part.version(), version, 'an icon added');
  set.dispose();
});

test('the transit layer draws its vehicles as two icon sets, moving a marker between them, on a viewer of its own', async () => {
  const { createRendering } = await import('../../layers/transit/rendering.js');
  const { createState } = await import('../../layers/transit/state.js');
  const scene = fakeScene();
  const viewer = { scene };
  const noop = () => {};
  const registered = [];
  const services = {
    overlays: {
      setOverlayEntries: noop,
      setOverlaySourceVisible: noop,
      clearOverlaySource: noop,
    },
    render: {
      governorRequestRender: noop,
      holdContinuousRender: noop,
      releaseContinuousRender: noop,
    },
    sprites: {
      spriteDrawOrder: (layerId) => {
        registered.push(layerId);
        return spriteDrawOrder(layerId);
      },
    },
  };
  const state = createState({ services });
  state._viewer = viewer;
  const rendering = createRendering({
    state,
    services,
    parts: { height: { nearGround: () => false }, trails: { update: noop } },
  });
  rendering.createMarkers(viewer);
  const [stillId, movingId] = rendering.setIds();
  assert.deepEqual(registered, ['transit', 'transit-motion']);
  const hostOf = (setId) => scene.added.find((h) => h.drawSetId === setId);
  assert.ok(hostOf(stillId) instanceof Cesium.BillboardCollection);
  assert.ok(hostOf(movingId) instanceof Cesium.BillboardCollection);
  assert.equal(hostOf(stillId).show, false, 'hidden until the layer shows');
  rendering.showMarkers();

  const at = Cesium.Cartesian3.fromDegrees(-71.06, 42.36, 12);
  const entry = { key: 'mbta:bus', mode: 'bus', toCart: at };
  rendering.addMarker(entry.key, entry);
  entry.marker.show = true;
  entry.marker.rotation = 0.5;
  rendering.markDirty(entry);
  rendering.flushMarkers();
  const still = hostOf(stillId);
  assert.equal(still.length, 1);
  const billboard = still.get(0);
  assert.equal(billboard.id.set, stillId);
  assert.equal(billboard.id.id, entry.key);
  assert.deepEqual(billboard.id.meta, { layer: 'transit', key: entry.key });
  assert.ok(Cesium.Cartesian3.equalsEpsilon(billboard.position, at, 0, 1e-6));
  assert.equal(billboard.rotation, 0.5);
  assert.equal(billboard.show, true);
  assert.equal(billboard.disableDepthTestDistance, Number.POSITIVE_INFINITY);
  assert.equal(billboard.width, entry.marker.width);
  assert.equal(
    rendering.setNameOf(
      drawHitOf({ primitive: billboard, id: billboard.id }).set,
    ),
    'still',
  );

  // Moving it moves the billboard it has.
  entry.marker.position.z += 10;
  rendering.markDirty(entry);
  rendering.flushMarkers();
  assert.equal(still.get(0), billboard);
  assert.ok(Math.abs(billboard.position.z - (at.z + 10)) < 1e-6);

  // Starting to move takes it to the moving set and out of the still one.
  entry.animated = true;
  rendering.markDirty(entry);
  rendering.flushMarkers();
  const moving = hostOf(movingId);
  assert.equal(moving.length, 1);
  assert.equal(moving.get(0).id.id, entry.key);
  assert.equal(moving.get(0).id.set, movingId);
  const stillNow = hostOf(stillId);
  const keysInStill = [];
  for (let i = 0; i < stillNow.length; i += 1)
    keysInStill.push(stillNow.get(i).id?.id);
  assert.deepEqual(keysInStill, [], 'no longer drawn in the still set');

  // Markers taken out in one task go in one removal, at its end.
  const other = { key: 'mbta:tram', mode: 'tram', toCart: at };
  rendering.addMarker(other.key, other);
  other.animated = true;
  rendering.markDirty(other);
  rendering.flushMarkers();
  assert.equal(moving.length, 2);
  const removals = [];
  const remove = state._movingIcons.remove;
  state._movingIcons.remove = function (ids) {
    removals.push([...ids]);
    return remove.call(this, ids);
  };
  rendering.removeMarker(entry);
  rendering.removeMarker(other);
  assert.equal(removals.length, 0, 'not yet');
  await Promise.resolve();
  assert.deepEqual(removals, [[entry.key, other.key]]);
  assert.equal(hostOf(movingId).length, 0);
  rendering.destroyMarkers(viewer);
  assert.equal(hostOf(stillId), undefined);
  assert.equal(hostOf(movingId), undefined);
});

test('a clustered icon set draws one icon a cluster in place of its members, made again as the camera moves', () => {
  const scene = fakeScene();
  scene.camera.directionWC = new Cesium.Cartesian3(-1, 0, 0);
  scene.camera.positionCartographic = { height: 1000 };
  scene.canvas = { clientWidth: 400, clientHeight: 300 };
  // Window positions: a degree of longitude is `spread` pixels.
  let spread = 1;
  const transforms = Cesium.SceneTransforms;
  const project = transforms.worldToWindowCoordinates;
  transforms.worldToWindowCoordinates = (_, position, result) => {
    const at = Cesium.Cartographic.fromCartesian(position);
    result ??= new Cesium.Cartesian2();
    result.x = 200 + Cesium.Math.toDegrees(at.longitude) * spread;
    result.y = 150 - Cesium.Math.toDegrees(at.latitude) * spread;
    return result;
  };
  try {
    const part = createCesiumDraw({
      scene,
      report: (error) => {
        throw error;
      },
      capabilities: new Set(['cluster']),
    });
    const counts = [];
    const set = part.port.icons({
      id: 'clustered',
      cluster: {
        pixelRange: 10,
        minimumSize: 2,
        icon: (count) => (counts.push(count), undefined),
      },
    });
    const icon = (id, lon) => ({
      id,
      pos: { lon, lat: 0 },
      image: { svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
      size: [8, 8],
      meta: { id },
    });
    set.set([icon('a', 0), icon('b', 2), icon('c', 4)]);
    part.beforeRender();
    const members = scene.added[0];
    const clusters = scene.added.at(-1);
    assert.notEqual(
      clusters,
      members,
      'cluster icons are a collection of their own',
    );
    assert.deepEqual(
      [0, 1, 2].map((i) => members.get(i).show),
      [false, false, false],
      'members are not drawn',
    );
    assert.equal(clusters.length, 1);
    assert.deepEqual(counts, [3]);
    const { id } = clusters.get(0);
    assert.deepEqual([id.set, id.id, id.meta], ['clustered', 'a', { id: 'a' }]);
    assert.deepEqual(id.cluster.ids, ['a', 'b', 'c'], 'seed first');
    const mean = Cesium.Cartographic.fromCartesian(
      new Cesium.Cartesian3(
        id.cluster.position.x,
        id.cluster.position.y,
        id.cluster.position.z,
      ),
    );
    assert.ok(Math.abs(Cesium.Math.toDegrees(mean.longitude) - 2) < 1e-6);
    // Not made again while nothing moved.
    part.beforeRender();
    assert.deepEqual(counts, [3]);
    // The camera moved: apart, each is its own.
    spread = 100;
    scene.camera.positionWC = new Cesium.Cartesian3(2e7, 1, 0);
    part.beforeRender();
    assert.equal(clusters.length, 0);
    assert.deepEqual(
      [0, 1, 2].map((i) => members.get(i).show),
      [true, true, true],
    );
    set.dispose();
    assert.ok(!scene.added.includes(clusters), 'let go with the set');
  } finally {
    transforms.worldToWindowCoordinates = project;
  }
});

test('a points set takes columns as rows, over the items it holds', () => {
  const { scene, draw } = drawOver();
  const set = draw.points({ id: 'column-dots' });
  set.set([
    { id: 'a', pos: { lon: 0, lat: 0 }, pixelSize: 4, color: '#fff' },
    { id: 'gone', pos: { lon: 1, lat: 0 }, pixelSize: 4, color: '#fff' },
  ]);
  const at = Cesium.Cartesian3.fromDegrees(10, 20);
  set.setColumns({
    ids: ['a'],
    positions: new Float64Array([at.x, at.y, at.z]),
    colors: new Uint8Array([255, 0, 0, 255]),
    shown: new Uint8Array([1]),
    meta: [{ m: 1 }],
  });
  assert.equal(set.size(), 1, 'rows not named are gone');
  const point = scene.added[0].get(0);
  assert.ok(Cesium.Cartesian3.equalsEpsilon(point.position, at, 0, 1e-6));
  assert.deepEqual(
    [point.color.red, point.color.green, point.color.alpha],
    [1, 0, 1],
  );
  assert.equal(point.pixelSize, 4, 'kept from the item');
  assert.deepEqual(drawHitOf({ id: point.id })?.meta, { m: 1 });
  set.dispose();
});

test('a draped line in the sky’s frame drapes where the sky is, again as its clock moves on', () => {
  const { scene, draw, frame } = drawOver();
  const realNow = Date.now;
  let now = Date.UTC(2026, 0, 1);
  Date.now = () => now;
  try {
    const set = draw.lines({ id: 'sky-track' });
    const given = [
      Cesium.Cartesian3.fromDegrees(0, 0),
      Cesium.Cartesian3.fromDegrees(1, 0),
    ];
    set.set([
      {
        id: 'track',
        positions: given,
        widthPx: 3,
        mode: 'draped',
        style: { kind: 'solid', color: '#fff' },
        frame: 'inertial',
        meta: { m: 1 },
      },
    ]);
    const grounds = () => {
      const found = [];
      for (const host of scene.added)
        for (let i = 0; i < (host.length ?? 0); i++)
          if (host.get(i) instanceof Cesium.GroundPolylinePrimitive)
            found.push(host.get(i));
      return found;
    };
    const start = (ground) =>
      Cesium.Math.toDegrees(
        Cesium.Cartographic.fromCartesian(
          ground.geometryInstances[0].geometry._positions[0],
        ).longitude,
      );
    const [first] = grounds();
    assert.ok(first, 'draped');
    assert.equal(first.geometryInstances[0].id.id, 'track');
    assert.deepEqual(first.geometryInstances[0].id.meta, { m: 1 });
    const turned = start(first);
    assert.ok(
      Math.abs(turned) > 1,
      `turned off where it was given (${turned})`,
    );
    // Within a step, nothing is draped again.
    now += 500;
    frame();
    assert.equal(grounds().at(-1), first);
    // A minute later the sky has turned a quarter of a degree west.
    now += 60_000;
    frame();
    const again = grounds().at(-1);
    assert.notEqual(again, first, 'draped again');
    const moved = start(again) - turned;
    assert.ok(Math.abs(moved + 0.2507) < 0.01, `moved ${moved}°`);
    assert.equal(set.size(), 1);
    set.dispose();
  } finally {
    Date.now = realNow;
  }
});

test('image fills pulse their alpha through their material, clamped or not', () =>
  withImageClasses(() => {
    const { scene, draw, frame } = drawOver();
    const set = draw.shapes({ id: 'pulsing-images' });
    const animate = { property: 'alpha', from: 0.3, to: 0.3, periodMs: 1000 };
    const rect = (west) => ({
      kind: 'rectangle',
      rect: { west, south: 0, east: west + 1, north: 1 },
    });
    set.set([
      {
        id: 'flat',
        geometry: rect(0),
        fill: { image: 'pad.png' },
        height: 'absolute',
        animate,
      },
      {
        id: 'draped',
        geometry: rect(4),
        fill: { image: 'pad.png' },
        height: 'clampGround',
        animate,
      },
    ]);
    frame();
    const materials = [];
    const walk = (primitive) => {
      if (primitive instanceof Cesium.PrimitiveCollection)
        for (let i = 0; i < primitive.length; i++) walk(primitive.get(i));
      else if (primitive?.appearance?.material?.type === 'Image')
        materials.push(primitive.appearance.material);
    };
    scene.added.forEach(walk);
    assert.equal(materials.length, 2, 'both drawn');
    for (const material of materials)
      assert.equal(
        Math.round(material.uniforms.color.alpha * 100) / 100,
        0.3,
        'pulsed',
      );
    set.dispose();
  }));

test('a material drawing a blob from an atlas slot keeps that blob alive after the slot changes', async () => {
  const v8 = await import('node:v8');
  const vm = await import('node:vm');
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const create = URL.createObjectURL;
  URL.createObjectURL = () => `blob:test/${Math.random()}`;
  const names = [
    'HTMLCanvasElement',
    'HTMLImageElement',
    'ImageBitmap',
    'OffscreenCanvas',
  ];
  const real = names.map((name) => globalThis[name]);
  for (const name of names) globalThis[name] ??= class {};
  try {
    const scene = fakeScene();
    const part = createCesiumDraw({
      scene,
      report: (error) => assert.fail(error),
    });
    const refs = {};
    // Made in a function of their own, so nothing here holds the blobs.
    (() => {
      const fillBlob = new Blob(['fill']);
      const lineBlob = new Blob(['line']);
      refs.fill = new WeakRef(fillBlob);
      refs.line = new WeakRef(lineBlob);
      part.port.atlas('pics', {
        fill: { blob: fillBlob },
        line: { blob: lineBlob },
      });
    })();
    const shapes = part.port.shapes({ id: 'blob-fills' });
    shapes.set([
      {
        id: 'image',
        geometry: {
          kind: 'rectangle',
          rect: { west: 2, south: 1, east: 2.1, north: 1.1 },
          height: 200,
        },
        fill: { image: { atlas: 'pics', slot: 'fill' } },
      },
    ]);
    const lines = part.port.lines({ id: 'blob-lines' });
    lines.set([
      {
        id: 'pattern',
        positions: [
          { lon: 0, lat: 0, height: 10 },
          { lon: 1, lat: 1, height: 10 },
        ],
        widthPx: 2,
        style: {
          kind: 'pattern',
          image: { atlas: 'pics', slot: 'line' },
          repeat: 2,
        },
      },
    ]);
    // The slots move on: nothing in the atlas holds the first blobs now.
    part.port.atlas('pics', {
      fill: { blob: new Blob(['b']) },
      line: { blob: new Blob(['c']) },
    });
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      gc();
    }
    assert.ok(refs.fill.deref(), 'the fill’s material still has its blob');
    assert.ok(refs.line.deref(), 'the pattern’s material still has its blob');
    shapes.dispose();
    lines.dispose();
  } finally {
    URL.createObjectURL = create;
    names.forEach((name, i) => (globalThis[name] = real[i]));
  }
});

test('a quad that moves from a blob to a URL lets the blob go once its old material is freed', async () => {
  const v8 = await import('node:v8');
  const vm = await import('node:vm');
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      gc();
    }
  };
  const create = URL.createObjectURL;
  URL.createObjectURL = () => `blob:test/${Math.random()}`;
  const names = [
    'HTMLCanvasElement',
    'HTMLImageElement',
    'ImageBitmap',
    'OffscreenCanvas',
  ];
  const real = names.map((name) => globalThis[name]);
  for (const name of names) globalThis[name] ??= class {};
  try {
    const scene = fakeScene();
    const part = createCesiumDraw({
      scene,
      report: (error) => assert.fail(error),
    });
    const set = part.port.quads({ id: 'feeds' });
    const quad = (source) => ({
      id: 'q',
      center: { x: 6378137, y: 10, z: 20 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      size: [40, 20],
      source,
    });
    const refs = {};
    // Made in a function of its own, so nothing here holds the blob.
    (() => {
      const blob = new Blob(['frame']);
      refs.blob = new WeakRef(blob);
      set.set([quad({ image: { blob } })]);
    })();
    await settle();
    assert.ok(refs.blob.deref(), 'held while its material draws it');
    set.set([quad({ image: 'https://example.test/still.png' })]);
    await settle();
    assert.ok(refs.blob.deref(), 'held while the old material may draw');
    part.afterRender();
    await settle();
    assert.equal(refs.blob.deref(), undefined, 'let go with the old material');
    set.dispose();
  } finally {
    URL.createObjectURL = create;
    names.forEach((name, i) => (globalThis[name] = real[i]));
  }
});

test('a set disposed by one of its listeners tells the later ones nothing more', async () => {
  const { loads, restore } = fakeModelLoads();
  try {
    const plane = (id) => ({
      id,
      pos: { lon: 0, lat: 0, height: 10 },
      url: 'a.glb',
    });
    const loaded = async (load) => {
      load.resolve();
      await settle();
      load.ready();
    };

    // Disposed by its handle, from its first ready listener.
    const part = createCesiumDraw({
      scene: fakeScene(),
      report: (error) => assert.fail(error),
    });
    const set = part.port.models({ id: 'planes' });
    const heard = [];
    set.on('ready', () => set.dispose());
    set.on('ready', (id) => heard.push(id));
    set.on('loadFailed', (id) => heard.push(`failed ${id}`));
    set.set([plane('p')]);
    await loaded(loads[0]);
    assert.deepEqual(heard, [], 'the second listener does not run');

    // Every set, when the port is disposed from a ready listener.
    const gone = createCesiumDraw({
      scene: fakeScene(),
      report: (error) => assert.fail(error),
    });
    const other = gone.port.models({ id: 'planes' });
    const late = [];
    other.on('ready', () => gone.dispose({ removeHosts: true }));
    other.on('ready', (id) => late.push(id));
    other.set([plane('q')]);
    await loaded(loads[1]);
    assert.deepEqual(late, [], 'nothing after the port is gone');
  } finally {
    restore();
  }
});

test('a disposed set, and every set once the port is disposed, does nothing on later calls', async () => {
  const { loads, restore } = fakeModelLoads();
  try {
    const items = {
      points: { id: 'a', pos: { lon: 0, lat: 0 }, pixelSize: 4, color: '#fff' },
      lines: {
        id: 'a',
        positions: [
          { lon: 0, lat: 0 },
          { lon: 1, lat: 1 },
        ],
        widthPx: 2,
        style: { kind: 'solid', color: '#fff' },
      },
      icons: {
        id: 'a',
        pos: { lon: 0, lat: 0 },
        image: 'data:image/png;base64,iVBORw0KGgo=',
      },
      shapes: {
        id: 'a',
        geometry: {
          kind: 'ellipse',
          center: { lon: 0, lat: 0 },
          semiMajor: 1000,
          semiMinor: 1000,
        },
        fill: [1, 0, 0, 0.5],
      },
      models: { id: 'a', pos: { lon: 0, lat: 0, height: 10 }, url: 'a.glb' },
    };
    const lateCalls = (set, item) => {
      set.set([item]);
      set.upsert([{ ...item, id: 'b' }]);
      set.show = true;
      set.setOptions({ clampTo: 'terrain', pickable: false, drawOrder: 3 });
      set.setOptions({ show: true });
      set.setColumns?.({
        ids: ['c'],
        positions: new Float64Array([6378137, 0, 0]),
      });
      set.remove(['a']);
      set.clear();
      assert.equal(typeof set.on('ready', () => {}), 'function');
    };

    // Disposed by its handle.
    const scene = fakeScene();
    const part = createCesiumDraw({
      scene,
      report: (error) => assert.fail(error),
    });
    for (const [kind, item] of Object.entries(items)) {
      const set = part.port[kind]({ id: kind });
      set.dispose();
      lateCalls(set, item);
      assert.equal(scene.added.length, 0, `${kind}: nothing drawn`);
      assert.equal(part.sets.size, 0, `${kind}: no set live`);
      set.dispose();
    }
    // A newer set under the same id is not changed by the old handle.
    const old = part.port.points({ id: 'same' });
    old.dispose();
    const newer = part.port.points({ id: 'same' });
    old.set([items.points]);
    assert.equal(newer.size(), 0, 'the newer set keeps its items');
    newer.dispose();

    // Every set, once the port is disposed (its renderer destroyed), and a
    // set asked for after that.
    const held = fakeScene();
    const gone = createCesiumDraw({
      scene: held,
      report: (error) => assert.fail(error),
    });
    const before = Object.keys(items).map((kind) => [
      kind,
      gone.port[kind]({ id: kind }),
    ]);
    gone.dispose({ removeHosts: true });
    for (const [kind, set] of before) lateCalls(set, items[kind]);
    for (const [kind, item] of Object.entries(items))
      lateCalls(gone.port[kind]({ id: `${kind}:late` }), item);
    assert.equal(held.added.length, 0, 'nothing drawn after the port is gone');
    assert.equal(gone.sets.size, 0, 'no set live after the port is gone');
    assert.equal(loads.length, 0, 'no model loads');
  } finally {
    restore();
  }
});
