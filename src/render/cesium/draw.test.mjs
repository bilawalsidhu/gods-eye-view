import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { bindRenderer, drawOf, findDraw } from '../rendererOf.js';
import { createCesiumDraw, revealUniform, unboundDrawPart } from './draw.js';
import { drawHitOf } from './drawHit.js';
import { MODEL_RETRY_MS } from './drawModels.js';

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
function drawOver(scene = fakeScene()) {
  const viewer = { scene };
  const draw = drawOf(viewer);
  return {
    scene,
    draw,
    frame() {
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
    lodGroup: undefined,
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
  assert.throws(
    () => set.set([{ ...disc('o', 0), outline: '#fff' }]),
    /no clamped outlines/,
  );
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
  // Anything else rebuilds: a new colour, a new item.
  set.upsert([{ ...fill('a', true), fill: [0, 1, 0, 0.3] }]);
  assert.notEqual(scene.added.at(-1), moved, 'a new look rebuilds');
  const rebuilt = scene.added.at(-1);
  Object.defineProperty(groundOf(rebuilt), 'ready', { value: true });
  frame();
  set.upsert([fill('c', true)]);
  assert.notEqual(scene.added.at(-1), rebuilt, 'a new item rebuilds');
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
      fill('c', 2, false, { fill: { preset: 'radialRim' } }),
      fill('d', 3, false, {
        geometry: {
          kind: 'ellipse',
          center: { lon: 3, lat: 0 },
          semiMajor: { byCameraHeight: { factor: 1, min: 1, max: 2 } },
          semiMinor: 1000,
        },
      }),
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
  assert.throws(
    () => set.set([{ ...disc, fill: { preset: 'radialRim' } }]),
    /colours only/,
  );
  assert.throws(
    () =>
      set.set([
        {
          ...disc,
          geometry: {
            ...disc.geometry,
            semiMajor: { byCameraHeight: { factor: 1, min: 1, max: 2 } },
          },
        },
      ]),
    /fixed ellipse radii/,
  );
  set.dispose();
});

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

test('a rebuilt set keeps its place among the scene primitives, and names its host', async () => {
  const {
    registerSpriteSet,
    registerSpriteCollection,
    restoreSpriteOrder,
    unregisterSpriteCollection,
  } = await import('../../data/spriteOrder.js');
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

  // The sprite order finds the set's host by its id, whichever host it is.
  const cctv = registerSpriteCollection('cctv', below);
  const flights = registerSpriteCollection('flights', above);
  const entry = registerSpriteSet('bikeshare', 'kept');
  scene.primitives.raiseToTop(below);
  assert.deepEqual(order(), ['kept', 'above', 'below']);
  restoreSpriteOrder({ scene });
  assert.deepEqual(order(), ['below', 'kept', 'above']);
  unregisterSpriteCollection('bikeshare', entry);
  unregisterSpriteCollection('cctv', cctv);
  unregisterSpriteCollection('flights', flights);
  set.dispose();
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

test('restyling or moving unclamped points changes them in place; a new one rebuilds', () => {
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
  assert.notEqual(scene.added[0], rebuilt, 'a new item rebuilds');
  assert.equal(scene.added[0].length, 3);
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
  assert.ok(instance.geometry instanceof Cesium.RectangleGeometry);
  assert.equal(instance.id.id, 'gnss-integrity:280:420');
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

test('the fires layer draws its heat cells as ground fills through the Cesium draw port', async (t) => {
  const { createFirmsHeatmapLayer } =
    await import('../../data/firmsHeatmap.js');
  const { unregisterSpriteCollection } =
    await import('../../data/spriteOrder.js');
  const { fakeInput } = await import('../../input/testDoubles.mjs');
  const { bindFakeCesiumScene } =
    await import('../../testSupport/fakeCesiumScene.mjs');
  const saved = globalThis.window;
  globalThis.window = new EventTarget();
  const scene = fakeScene();
  // The layer keeps its detection icons over other sprites.
  scene.primitives.contains = (p) => scene.added.includes(p);
  scene.primitives.raiseToTop = () => {};
  // Far out, where the layer draws heat cells rather than detections.
  const viewer = {
    scene,
    camera: {
      moveEnd: new Cesium.Event(),
      positionWC: Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 2e7),
      directionWC: new Cesium.Cartesian3(0, 0, -1),
      positionCartographic: Cesium.Cartographic.fromDegrees(-97.7, 30.2, 2e7),
    },
  };
  // The real Cesium draw port; camera and frame from the viewer double.
  const { unbind } = bindFakeCesiumScene(viewer, { draw: drawOf(viewer) });
  const input = fakeInput(viewer);
  const raw = (lat, lon, frp) => ({
    lat,
    lon,
    frp,
    confidence: 'h',
    brightness: 340,
    daynight: 'D',
    acqDate: '2026-08-03',
    acqTime: '0412',
    instrument: 'VIIRS',
    satellite: 'N20',
  });
  const layer = createFirmsHeatmapLayer({
    id: 'firms',
    name: 'FIRMS',
    feed: {
      getSnapshot: async () => ({
        fires: [raw(30.5, -98.2, 1500), raw(-12.1, 131.4, 5)],
        fetchedAt: Date.now(),
      }),
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  t.after(() => {
    input.destroy();
    unbind();
    unregisterSpriteCollection('firms');
    if (saved === undefined) delete globalThis.window;
    else globalThis.window = saved;
  });
  layer.init(viewer);
  await layer.enable(viewer);
  const all = (host, out = []) => {
    out.push(host);
    if (host instanceof Cesium.PrimitiveCollection)
      for (let i = 0; i < host.length; i++) all(host.get(i), out);
    return out;
  };
  const grounds = () =>
    scene.added
      .flatMap((host) => all(host))
      .filter((p) => p instanceof Cesium.GroundPrimitive);
  const instances = grounds().flatMap((g) => g.geometryInstances);
  assert.equal(instances.length, 2, 'one fill per cell');
  for (const instance of instances) {
    assert.ok(instance.geometry instanceof Cesium.RectangleGeometry);
    assert.match(instance.id.set, /^firms:\d+:cells$/);
  }
  assert.equal(grounds()[0].classificationType, Cesium.ClassificationType.BOTH);
  layer.destroy(viewer);
  assert.equal(grounds().length, 0);
});

test('the context layer draws its rim as an outlined ellipse on a viewer of its own', async () => {
  const { createRendering } =
    await import('../../layers/awareness/rendering.js');
  const { createState } = await import('../../layers/awareness/state.js');
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
  const outlineOf = () => {
    const [host] = scene.added;
    const primitives = [];
    for (let i = 0; i < host.length; i++) primitives.push(host.get(i));
    const outline = primitives.find(
      (p) =>
        p instanceof Cesium.Primitive &&
        p.geometryInstances.geometry instanceof Cesium.EllipseOutlineGeometry,
    );
    assert.ok(outline, 'an outline geometry, as the entity drew');
    assert.ok(
      !primitives.some(
        (p) =>
          p instanceof Cesium.Primitive &&
          p.geometryInstances.geometry instanceof Cesium.EllipseGeometry,
      ),
      'and no fill',
    );
    return outline;
  };
  const outline = outlineOf();
  const { geometry, attributes } = outline.geometryInstances;
  assert.equal(geometry._semiMajorAxis, 250_000);
  assert.equal(geometry._height, 2_500);
  const center = Cesium.Cartographic.fromCartesian(geometry._center);
  assert.ok(Math.abs(center.longitude) < 1e-9);
  assert.deepEqual(
    [...attributes.color.value],
    [0x62, 0xb5, 0xff, Math.round(0.72 * 255)],
  );
  // Small moves keep the ring; one past 250 m moves it.
  rendering.renderVisual(subject(0.001));
  assert.equal(outlineOf(), outline);
  rendering.renderVisual(subject(0.01));
  assert.notEqual(outlineOf(), outline);
  // Re-initialized on another viewer, the same subject's rim moves there.
  const other = drawOver().scene;
  state.viewer = { scene: other };
  rendering.renderVisual(subject(0.01));
  assert.equal(scene.added.length, 0, 'gone from the old viewer');
  assert.equal(other.added.length, 1, 'drawn on the new one');
  rendering.clearVisual();
  assert.equal(other.added[0].length, 1, 'only the empty polyline collection');
  rendering.disposeVisual();
  assert.equal(other.added.length, 0);
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
    const line = host.get(0).get(0);
    set.upsert([stem('s', 2500, false)]);
    assert.equal(scene.added[0], host);
    assert.equal(host.get(0).get(0), line);
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
    // Undraped segmented lines are refused, and the set keeps drawing.
    assert.throws(
      () => set.upsert([{ ...trail(1, [true, true, true]), mode: '3d' }]),
      /segments of draped solid lines only/,
    );
    assert.equal(scene.added[0], host);
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
  const { IconSetPrimitive } = await import('../../data/iconSetPrimitive.js');
  const { ICON_CULL_LIFT, ICON_ROTATES } =
    await import('../../data/iconSet.js');
  const spriteOrder = await import('../../data/spriteOrder.js');
  const scene = fakeScene();
  const registered = [];
  const { layer, viewer, part, unbind } = await vesselLayerOver(scene, {
    registerSpriteSet(layerId, setId) {
      registered.push([layerId, setId]);
      return spriteOrder.registerSpriteSet(layerId, setId);
    },
  });
  const military = { name: 'military' };
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

    // The sprite order finds the host by its set id and stacks it under the
    // military sprites.
    assert.deepEqual(registered, [['ais', host.drawSetId]]);
    spriteOrder.registerSpriteCollection('military', military);
    const stack = (list) => ({
      scene: {
        primitives: {
          get: (i) => list[i],
          get length() {
            return list.length;
          },
          contains: (p) => list.includes(p),
          raiseToTop(p) {
            list.splice(list.indexOf(p), 1);
            list.push(p);
          },
        },
      },
    });
    const order = [military, host, { name: 'other' }];
    spriteOrder.restoreSpriteOrder(stack(order));
    assert.deepEqual(
      order.map((p) => p.name ?? p.drawSetId),
      ['other', host.drawSetId, 'military'],
    );

    // Torn down and drawn again: a new set, registered in the old one's
    // place, with the old host gone from the scene.
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
    assert.deepEqual(registered.at(-1), ['ais', again.drawSetId]);
    const stray = { name: 'stray' };
    const next = [military, again, stray];
    spriteOrder.restoreSpriteOrder(stack(next));
    assert.deepEqual(next, [stray, again, military], 'the new host is raised');
    layer.destroy(viewer);
    assert.equal(scene.added.length, 0);
  } finally {
    spriteOrder.unregisterSpriteCollection('military', military);
    spriteOrder.unregisterSpriteCollection('ais');
    unbind();
  }
});

test('vessels on a host with no sprite-set registry still draw, and say so once', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const scene = fakeScene();
  const { layer, viewer, unbind } = await vesselLayerOver(scene, {});
  const ship = { mmsi: '244000001', lat: 51.95, lon: 4.1, heading: 90 };
  layer.testing._setVesselStateForTest({ viewer, icons: null });
  layer.testing._reconcileVesselsForTest(viewer, [ship]);
  assert.equal(scene.added.length, 1, 'drawn');
  layer.destroy(viewer);
  layer.testing._setVesselStateForTest({ viewer, icons: null });
  layer.testing._reconcileVesselsForTest(viewer, [ship]);
  const said = warnings.filter((w) => w.includes('registerSpriteSet'));
  assert.equal(said.length, 1, 'once, not per set');
  layer.destroy(viewer);
  unbind();
});

test('an aircraft layer draws its contacts as one GPU icon set moving on the delayed live clock', async () => {
  const { createAircraftIcons } =
    await import('../../data/aircraftIconLayer.js');
  const { IconSetPrimitive } = await import('../../data/iconSetPrimitive.js');
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

    // Drawn where the layer reads it, between its two fixes.
    const t = Date.now() - delayMs;
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
    assert.deepEqual(
      appearance.material.uniforms.repeat,
      new Cesium.Cartesian2(2, 3),
    );
    assert.deepEqual(
      [appearance.flat, appearance.faceForward, appearance.translucent],
      [true, true, true],
    );
    assert.ok(geometryInstances.geometry instanceof Cesium.RectangleGeometry);
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
            fill: {
              preset: 'radialRim',
              color: '#fff',
              rimColor: '#000',
              rimWidth: 1,
            },
          },
        ]),
      /colours only/,
    );
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
  assert.ok(lines instanceof Cesium.PolylineCollection);
  assert.equal(lines.get(0).width, 4);
  const fill = shapes.get(0);
  assert.ok(fill.geometryInstances.geometry instanceof Cesium.PolygonGeometry);
  assert.equal(fill.appearance.translucent, true);
  assert.equal(fill.appearance.flat, true);
  // A click names the feature's set and item, which the targets hold.
  const hit = drawHitOf({ primitive: lines.get(0), id: lines.get(0).id });
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
    // Arrows and patterns are not draped.
    assert.throws(
      () =>
        set.set([
          {
            id: 'arrow',
            positions,
            widthPx: 1,
            mode: 'draped',
            style: { kind: 'arrow', color: '#fff' },
          },
        ]),
      /drapes solid, glow, dash and flow lines only/,
    );
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
      depthFailColor: [1, 0, 1, 0.45],
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
        depthFailColor: null,
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
    set.upsert([head(400, { depthFailColor: [1, 1, 1, 1] })]);
    assert.notEqual(scene.added[0], host);
    set.dispose();
    assert.equal(scene.added.length, 0);
  }));

test('a depth-fail dash dashes the parts behind the surface, in the depth-fail colour', () =>
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
      depthFailColor: [0, 1, 1, 0.35],
      depthFailDash: { length: 16 },
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
    set.upsert([band({ depthFailDash: { length: 16 } })]);
    assert.equal(scene.added[0], host, 'not rebuilt');
    assert.equal(
      host.get(1).get(0).depthFailAppearance.material.type,
      'PolylineDash',
    );
    set.upsert([band({ depthFailDash: { pattern16: 0xf0f0, length: 8 } })]);
    const patterned = scene.added[0].get(1).get(0).depthFailAppearance.material;
    assert.equal(patterned.uniforms.dashPattern, 0xf0f0);
    assert.equal(patterned.uniforms.dashLength, 8);
    const again = scene.added[0];
    set.upsert([band({ depthFailDash: { length: 8, pattern16: 0xf0f0 } })]);
    assert.equal(scene.added[0], again, 'the same dash in another order');
    // Without it the hidden parts are solid; the change is a new look.
    set.upsert([band({ depthFailDash: undefined })]);
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
          registerSpriteSet: (layerId, setId) => {
            sprites.push([layerId, setId]);
            return { drawSetId: setId };
          },
          unregisterSpriteCollection: noop,
          restoreSpriteOrder: noop,
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
    // One maneuver dot, at its junction on the ground floor, in the sprite
    // order.
    const steps = hostOf(':steps');
    assert.ok(steps instanceof Cesium.PointPrimitiveCollection);
    assert.equal(steps.blendOption, Cesium.BlendOption.TRANSLUCENT);
    assert.deepEqual(sprites, [['directions', steps.drawSetId]]);
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
        depthFailColor: [1, 0, 1, 0.45],
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
  const { createTrail } = await import('../../data/trailRenderer.js');
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
    const host = scene.added[0];
    const deep = host.get(1);
    const body = deep.get(0);
    assert.ok(body instanceof Cesium.Primitive);
    assert.equal(body.geometryInstances.geometry._positions.length, 400);
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
    const long = deep.get(0);
    const arc = long.geometryInstances.geometry._positions;
    assert.equal(arc.length, 65, 'a lone leg in 64 steps');
    // A long leg among short ones still takes a step a degree.
    trail.setPositions([
      ...fixes,
      Cesium.Cartesian3.fromDegrees(-63, 30, 10000),
    ]);
    const mixed = deep.get(0).geometryInstances.geometry._positions;
    assert.ok(
      mixed.length > 400 + 25 && mixed.length < 400 + 40,
      `${mixed.length}`,
    );
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
      assert.equal(lanes.length, 2, 'a backing lane and a line lane');
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
      lodGroup: undefined,
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
    assert.equal(model.color.alpha, 1);
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
