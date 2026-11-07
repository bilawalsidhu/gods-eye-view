import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { bindRenderer, drawOf, findDraw } from '../rendererOf.js';
import './draw.js';

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

test('restyling points that stay put changes them in place; moving one rebuilds', () => {
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

  set.upsert([dot('b', 2)]);
  assert.notEqual(scene.added[0], host, 'moved: rebuilt');
  set.upsert([dot('c', 3)]);
  assert.equal(set.size(), 3, 'a new item rebuilds too');
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
  assert.notEqual(scene.added[0], host, 'rebuilt where it now is');
  const at = Cesium.Cartographic.fromCartesian(scene.added[0].get(0).position);
  assert.ok(Math.abs(Cesium.Math.toDegrees(at.longitude) - 90) < 1e-9);
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
