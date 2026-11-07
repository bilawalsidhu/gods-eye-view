import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { bindRenderer, drawOf, findDraw } from '../rendererOf.js';
import { createCesiumDraw } from './draw.js';
import { drawHitOf } from './drawHit.js';

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
  frame();
  assert.equal(point.show, false, 'past the horizon');
  set.upsert([dot(1)]);
  frame();
  assert.equal(point.show, true, 'back in view');
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
  assert.ok(part.version() > version, 'height queries see the change');

  // Back to the defaults it dropped.
  set.upsert([icon('a', 2)]);
  assert.equal(a.rotation, 0);
  assert.equal(a.width, 10);

  set.upsert([icon('c', 3)]);
  assert.equal(scene.added[0], host, 'a new icon is added to it');
  assert.equal(host.length, 3);
  set.remove(['b']);
  assert.equal(scene.added[0], host, 'and one removed from it');
  assert.equal(host.length, 2);
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
  part.port.atlas('marks', { ring: 'ring.png' });
  assert.equal(host.length, 1, 'a slot gone takes its icon down');
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
      iconAtlas.slot(aircraftIcon('airliner', TRACKED_ICON_PX), TRACKED_ICON_PX),
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
    assert.ok(Math.abs(set.course(row, tau) - icons._iconCourse('abc123')) < 0.01);
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
      { id: 'route', positions, widthPx: 9, mode: 'draped', style, show: false },
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
    // Other styles still drape only solid.
    assert.throws(
      () =>
        set.set([
          {
            id: 'dash',
            positions,
            widthPx: 1,
            mode: 'draped',
            style: { kind: 'dash', color: '#fff', length: 8 },
          },
        ]),
      /drapes solid and flow lines only/,
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
