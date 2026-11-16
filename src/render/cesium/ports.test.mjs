import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import {
  cesiumCapabilities,
  createCesiumPorts,
  listenerList,
} from './ports.js';
import { updateCameraChanged } from './internals.js';
import { createNativeClick } from './nativeClick.js';

test('capabilities follow what the scene supports', () => {
  const effects = [
    'followFrame',
    'followAutodetect',
    'cameraChangeThreshold',
    'columns',
    'motionSegments',
    'courseGlide',
    'cluster',
    'styles',
    'bloom',
    'sharpen',
    'screenModulation',
    'photoreal',
    'terrain',
    'imageryOnTiles',
    'splitSwipe',
    'imageHooks',
    'imageryFrames',
    'surfaceIdentity',
    'surfaceShading',
    'vectorBase',
  ];
  const globe = { show: true };
  const draw = ['models', 'modelAtmosphere', 'quads', 'meshes', 'fields'];
  assert.deepEqual(cesiumCapabilities({}), [...draw, ...effects]);
  // A scene with a globe reads its visibility back.
  assert.deepEqual(cesiumCapabilities({ globe }), [
    ...draw,
    ...effects,
    'globeVisibility',
  ]);
  assert.deepEqual(cesiumCapabilities({ pickPositionSupported: true }), [
    ...draw,
    ...effects,
    'pickPosition',
    'occlusionTest',
  ]);
  assert.deepEqual(
    cesiumCapabilities({
      globe,
      pickPositionSupported: true,
      sampleHeightSupported: true,
    }),
    [
      ...draw,
      ...effects,
      'globeVisibility',
      'pickPosition',
      'occlusionTest',
      'sampleHeight',
      'finestHeights',
      'rayCast',
    ],
  );
});

test('a caller can ask for fewer capabilities, never more', () => {
  const scene = { pickPositionSupported: true, sampleHeightSupported: true };
  assert.deepEqual(cesiumCapabilities(scene, ['models', 'rayCast']), [
    'models',
    'rayCast',
  ]);
  assert.deepEqual(cesiumCapabilities({}, new Set(['sampleHeight'])), []);
  // The zoom-out guard needs the scene's own controller and frame events.
  assert.ok(
    cesiumCapabilities({
      screenSpaceCameraController: {},
      preRender: {},
    }).includes('keepEarthFramed'),
  );
  assert.ok(!cesiumCapabilities({ preRender: {} }).includes('keepEarthFramed'));
});

test('a listener list keeps the listener rules', () => {
  const errors = [];
  const list = listenerList((error) => errors.push(error));
  const seen = [];
  let offB = () => {};
  list.on(() => {
    seen.push('a');
    offB();
    list.on(() => seen.push('late'));
  });
  offB = list.on(() => seen.push('b'));
  list.on(() => {
    throw new Error('listener');
  });
  const c = () => seen.push('c');
  list.on(c);
  const offC2 = list.on(c);
  list.fire();
  assert.deepEqual(seen, ['a', 'c', 'c']);
  assert.equal(errors.length, 1);
  offC2();
  seen.length = 0;
  list.fire();
  assert.deepEqual(seen, ['a', 'c', 'late']);
  list.clear();
  assert.equal(list.size, 0);
});

test('a listener that clears its list stops the rest of the event', () => {
  const list = listenerList((error) => {
    throw error;
  });
  const seen = [];
  list.on(() => {
    seen.push('a');
    list.clear();
  });
  list.on(() => seen.push('b'));
  list.fire();
  assert.deepEqual(seen, ['a']);
});

/** A widget whose scene records what the query port asks of it. */
function fakeWidget(overrides = {}) {
  const listeners = new Set();
  const event = () => ({
    addEventListener(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  });
  const calls = [];
  const primitives = [];
  const scene = {
    camera: {
      moveStart: event(),
      moveEnd: event(),
      pickEllipsoid: () => undefined,
    },
    primitives: {
      add: (p) => primitives.push(p),
      remove: (p) => primitives.splice(primitives.indexOf(p), 1),
    },
    requestRender() {},
    preUpdate: event(),
    postUpdate: event(),
    preRender: event(),
    postRender: event(),
    sampleHeightSupported: true,
    pickPositionSupported: true,
    globe: { show: true, getHeight: () => 0 },
    sampleHeight(carto, exclude) {
      calls.push({ exclude, globe: scene.globe.show });
      return 10;
    },
    drillPick: () => [],
    pick: () => undefined,
    ...overrides,
  };
  return { widget: { scene, clock: {} }, scene, calls };
}

const all = new Set(['models', 'pickPosition', 'sampleHeight', 'rayCast']);
const point = (id) => ({
  id,
  pos: { x: 6378137, y: 0, z: 0 },
  pixelSize: 4,
  color: '#fff',
});

test('height queries see through very large sets, built once per change', () => {
  const { widget, calls } = fakeWidget();
  const ports = createCesiumPorts(widget, { capabilities: all });
  const big = ports.draw.points({ id: 'big' });
  big.set(Array.from({ length: 150_000 }, (_, i) => point(String(i))));
  assert.equal(ports.query.sampleHeightNow({ lon: 0, lat: 0 }), 10);
  assert.equal(calls[0].exclude.length, 150_000, 'every item seen through');
  ports.query.sampleHeightNow({ lon: 1, lat: 1 });
  assert.ok(calls.slice(1).every((c) => c.exclude === calls[0].exclude));
  big.setOptions({ includeInHeightQueries: true });
  ports.query.sampleHeightNow({ lon: 0, lat: 0 });
  assert.equal(calls.at(-1).exclude.length, 0, 'a ground set is not');
  ports.query.sampleHeightNow({ lon: 0, lat: 0 }, { exclude: ['big'] });
  assert.equal(calls.at(-1).exclude.length, 150_000, 'unless excluded');
  ports.dispose();
});

test('tiles are sampled with the globe hidden, and the globe comes back', () => {
  const { widget, scene, calls } = fakeWidget();
  const ports = createCesiumPorts(widget, { capabilities: all });
  ports.query.sampleHeightNow({ lon: 0, lat: 0 }, { against: 'tiles' });
  assert.equal(calls[0].globe, false);
  assert.equal(scene.globe.show, true);
  ports.dispose();
});

test('drillPick: limit 0 is none, each item once, unpickable skipped', () => {
  let picked = [];
  const { widget } = fakeWidget({ drillPick: () => picked });
  const ports = createCesiumPorts(widget, { capabilities: all });
  const set = ports.draw.points({ id: 's' });
  set.set([point('a'), point('b'), { ...point('c'), pickable: false }]);
  const id = (item) => ({ id: { set: 's', id: item } });
  picked = [id('a'), id('a'), id('c'), id('b')];
  assert.deepEqual(ports.query.drillPick(1, 1, { limit: 0 }), []);
  assert.deepEqual(
    ports.query.drillPick(1, 1).map((h) => h.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    ports.query.drillPick(1, 1, { limit: 1 }).map((h) => h.id),
    ['a'],
  );
  ports.dispose();
});

test('pick under something unpickable stops at what hides the rest', () => {
  let picked = [];
  const { widget } = fakeWidget({
    pick: () => picked[0],
    drillPick: () => picked,
    pickPosition: () => ({ x: 1, y: 2, z: 3 }),
  });
  const ports = createCesiumPorts(widget, { capabilities: all });
  const set = ports.draw.points({ id: 's', pickable: false });
  set.set([point('top')]);
  const under = ports.draw.points({ id: 'u' });
  under.set([point('under')]);
  const top = { id: { set: 's', id: 'top' } };
  picked = [top, { id: { set: 'u', id: 'under' } }];
  assert.equal(ports.query.pick(1, 1).id, 'under');
  picked = [top, { primitive: 'a tile' }, { id: { set: 'u', id: 'under' } }];
  const hit = ports.query.pick(1, 1);
  assert.equal(hit.surface, true, 'the tile hides it: the surface');
  ports.dispose();
});

test('a surface hit over the ellipsoid makes its depth pick only when its position is read', () => {
  let depthPicks = 0;
  const { widget, scene } = fakeWidget({
    pickPosition: () => (depthPicks++, { x: 6378200, y: 0, z: 0 }),
  });
  scene.camera.pickEllipsoid = () => ({ x: 6378137, y: 0, z: 0 });
  const ports = createCesiumPorts(widget, { capabilities: all });
  const hit = ports.query.pick(1, 1);
  assert.equal(hit.surface, true);
  assert.equal(depthPicks, 0, 'no depth pass for a click nobody grounds');
  assert.equal(hit.position.x, 6378200, 'the rendered surface, once read');
  assert.equal(hit.position.x, 6378200);
  assert.equal(depthPicks, 1);
  // Over the sky the depth pick decides whether there is a surface at all.
  scene.camera.pickEllipsoid = () => undefined;
  scene.pickPosition = () => undefined;
  assert.equal(ports.query.pick(1, 1), null);
  ports.dispose();
});

test('a sky pick makes no depth pass unless something may be there', () => {
  let depthPicks = 0;
  let globeHit = null;
  let picked;
  const { widget, scene } = fakeWidget({
    pick: () => picked,
    pickPosition: () => (depthPicks++, { x: 6378200, y: 0, z: 0 }),
  });
  scene.camera.pickEllipsoid = () => undefined;
  scene.camera.getPickRay = () => ({
    origin: { x: 7e6, y: 0, z: 0 },
    direction: { x: 0, y: 1, z: 0 },
  });
  scene.globe.pick = () => globeHit;
  const ports = createCesiumPorts(widget, { capabilities: all });
  assert.equal(ports.query.pick(1, 1), null, 'nothing there: the sky');
  assert.equal(depthPicks, 0);
  // A mountain above the horizon: a globe tile on the ray.
  globeHit = { x: 6378000, y: 0, z: 0 };
  assert.equal(ports.query.pick(1, 1).surface, true);
  assert.equal(depthPicks, 1);
  // Something drawn outside the sets against the sky.
  globeHit = null;
  picked = { primitive: {} };
  ports.query.pick(1, 1);
  assert.equal(depthPicks, 2);
  // A failing depth pick finds no surface, so what was picked is still read.
  scene.pickPosition = () => {
    throw new Error('no depth');
  };
  assert.equal(ports.query.pick(1, 1), null);
  // A throwing camera answers nothing rather than failing the pick.
  picked = undefined;
  scene.camera.pickEllipsoid = () => {
    throw new Error('no camera');
  };
  assert.equal(ports.query.pick(1, 1), null);
  ports.dispose();
});

test("an empty click's renderer pick and its own Cesium pick are one pass", () => {
  let passes = 0;
  const { widget, scene } = fakeWidget({
    pick: () => (passes++, undefined),
    pickPosition: () => (passes++, { x: 6378200, y: 0, z: 0 }),
  });
  scene.camera.pickEllipsoid = () => ({ x: 6378137, y: 0, z: 0 });
  const ports = createCesiumPorts(widget, { capabilities: all });
  assert.equal(ports.query.pick(4, 5).surface, true);
  const click = createNativeClick(scene, { x: 4, y: 5 });
  assert.equal(click.foreign(), null);
  assert.equal(click.native.pick, undefined);
  assert.equal(passes, 1);
  ports.dispose();
});

test('rayCast answers against the surface asked for', async () => {
  const seen = [];
  const { widget } = fakeWidget({
    pickFromRay: () => {
      seen.push(widget.scene.globe.show);
      return { position: { x: 6378137, y: 0, z: 0 } };
    },
  });
  widget.scene.globe.pick = () => ({ x: 6378000, y: 0, z: 0 });
  const ports = createCesiumPorts(widget, { capabilities: all });
  const ray = {
    origin: { x: 7e6, y: 0, z: 0 },
    direction: { x: -1, y: 0, z: 0 },
  };
  assert.equal(
    (await ports.query.rayCast(ray, { against: 'terrain' })).x,
    6378000,
  );
  assert.equal(
    (await ports.query.rayCast(ray, { against: 'tiles' })).x,
    6378137,
  );
  assert.deepEqual(seen, [false], 'tiles cast with the globe hidden');
  assert.equal(
    await ports.query.rayCast(ray, { maxDistance: 100 }),
    null,
    'beyond maxDistance',
  );
  ports.dispose();
});

test('clampToSurface misses a position it cannot read, not the batch', async () => {
  const { widget } = fakeWidget({
    sampleHeightMostDetailed: async (cartos) => {
      for (const c of cartos) c.height = 5;
      return cartos;
    },
  });
  const ports = createCesiumPorts(widget, { capabilities: all });
  const [bad, nan, good] = await ports.query.clampToSurface([
    { x: Infinity, y: 0, z: 0 },
    { x: NaN, y: 0, z: 0 },
    { x: 6378137, y: 0, z: 0 },
  ]);
  assert.equal(bad, null);
  assert.equal(nan, null);
  assert.ok(Math.abs(Math.hypot(good.x, good.y, good.z) - 6378142) < 1e-6);
  ports.dispose();
});

/** A widget whose scene events can be raised by hand. */
function tickingWidget() {
  const events = {};
  const event = (name) => {
    const list = (events[name] = []);
    return {
      addEventListener(cb) {
        list.push(cb);
        return () => list.splice(list.indexOf(cb), 1);
      },
    };
  };
  const camera = new Cesium.Camera({
    canvas: { clientWidth: 100, clientHeight: 100 },
    drawingBufferWidth: 100,
    drawingBufferHeight: 100,
    mapProjection: new Cesium.GeographicProjection(),
  });
  const seen = Cesium.Camera.clone(camera);
  let requested = 0;
  const scene = {
    camera,
    _view: { _cameraClone: seen },
    _frameState: { afterRender: [] },
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    primitives: { add() {}, remove() {} },
    tweens: new Cesium.TweenCollection(),
    requestRender() {
      requested += 1;
      scene._renderRequested = true;
    },
    preUpdate: event('preUpdate'),
    postUpdate: event('postUpdate'),
    preRender: event('preRender'),
    postRender: event('postRender'),
  };
  const widget = {
    scene,
    clock: { currentTime: Cesium.JulianDate.now() },
    useDefaultRenderLoop: true,
    _renderLoopRunning: true,
  };
  const raise = (name) => {
    // `end`: the tick empties its after-render queue, as Scene#render does.
    if (name === 'end') {
      for (const fn of scene._frameState.afterRender.splice(0)) fn();
      return;
    }
    for (const cb of [...events[name]]) cb(scene, widget.clock.currentTime);
  };
  return { widget, scene, raise, requests: () => requested };
}

test('preUpdate says whether the tick draws, as Cesium decides it', () => {
  const { widget, scene, raise } = tickingWidget();
  const ports = createCesiumPorts(widget, { capabilities: all });
  const seen = [];
  ports.frame.on('preUpdate', (t) => seen.push(t.rendering));
  raise('preUpdate');
  ports.frame.requestRender('r');
  raise('preUpdate');
  scene._renderRequested = false;
  scene.camera.position = new Cesium.Cartesian3(1, 2, 3);
  raise('preUpdate');
  scene.camera.position = Cesium.Cartesian3.clone(
    scene._view._cameraClone.position,
  );
  scene.requestRenderMode = false;
  raise('preUpdate');
  assert.deepEqual(seen, [false, true, true, true]);
  ports.dispose();
});

test('preUpdate counts what earlier listeners did this tick', () => {
  const { widget, scene, raise } = tickingWidget();
  const ports = createCesiumPorts(widget, { capabilities: all });
  const seen = [];
  ports.frame.on('preUpdate', (t) => seen.push(['before', t.rendering]));
  ports.frame.on('preUpdate', () => {
    scene.camera.position = new Cesium.Cartesian3(7, 8, 9);
  });
  ports.frame.on('preUpdate', (t) => seen.push(['after', t.rendering]));
  raise('preUpdate');
  assert.deepEqual(seen, [
    ['before', false],
    ['after', true],
  ]);
  ports.dispose();
});

test('holds are counted per reason and switch the loop to every frame', () => {
  const { widget, scene, raise } = tickingWidget();
  const ports = createCesiumPorts(widget, { capabilities: all });
  const a = ports.frame.holdContinuous('a');
  const a2 = ports.frame.holdContinuous('a');
  assert.equal(scene.requestRenderMode, false);
  assert.deepEqual(ports.frame.diagnostics().holds, ['a', 'a']);
  a();
  a();
  assert.equal(scene.requestRenderMode, false, 'one hold of a still out');
  a2();
  assert.equal(scene.requestRenderMode, true);
  assert.deepEqual(ports.frame.diagnostics().holds, []);
  ports.frame.requestRender('x');
  ports.frame.requestRender('x');
  assert.deepEqual(ports.frame.diagnostics().pendingReasons, ['x']);
  raise('preUpdate');
  raise('preRender');
  raise('postRender');
  const d = ports.frame.diagnostics();
  assert.deepEqual(d.pendingReasons, [], 'a drawn frame answers them');
  assert.equal(d.frames, 1);
  assert.equal(d.rendered, 1);
  assert.equal(ports.frame.mode(), 'demand');
  ports.dispose();
});

test('suspend stops the loop at once and resumes it; target fps caps it', () => {
  const { widget, requests } = tickingWidget();
  const ports = createCesiumPorts(widget, { capabilities: all });
  ports.frame.suspend(true);
  assert.equal(widget.useDefaultRenderLoop, false);
  assert.equal(
    widget._renderLoopRunning,
    true,
    'the queued callback stops the loop itself',
  );
  assert.equal(ports.frame.diagnostics().suspended, true);
  const before = requests();
  ports.frame.suspend(false);
  assert.equal(widget.useDefaultRenderLoop, true);
  assert.equal(requests(), before + 1, 'a frame on resume');
  ports.frame.setTargetFps(30);
  assert.equal(widget.targetFrameRate, 30);
  assert.equal(ports.frame.diagnostics().targetFps, 30);
  ports.frame.setTargetFps(0);
  assert.equal(widget.targetFrameRate, undefined, '0 is the display rate');
  ports.dispose();
});

test('with an idle rate, idle ticks at it and anything held draws at the display rate', () => {
  const { widget } = tickingWidget();
  widget.targetFrameRate = 60;
  const ports = createCesiumPorts(widget, { capabilities: all, idleFps: 60 });
  assert.equal(widget.targetFrameRate, 60, 'idle: the idle rate');
  assert.equal(ports.frame.diagnostics().targetFps, 0, 'no cap of its own');
  const release = ports.frame.holdContinuous('flights');
  assert.equal(widget.targetFrameRate, undefined, 'held: the display rate');
  release();
  assert.equal(widget.targetFrameRate, 60);
  // A cap holds while held, and idle ticks at the lower of the two.
  ports.frame.setTargetFps(30);
  assert.equal(widget.targetFrameRate, 30);
  const again = ports.frame.holdContinuous('flights');
  assert.equal(widget.targetFrameRate, 30);
  ports.frame.setTargetFps(120);
  assert.equal(widget.targetFrameRate, 120);
  again();
  assert.equal(widget.targetFrameRate, 60);
  assert.equal(ports.frame.diagnostics().targetFps, 120);
  ports.dispose();
});

test('rendering holds the tick’s answer once the tick is over', () => {
  const { widget, scene, raise } = tickingWidget();
  const ports = createCesiumPorts(widget, { capabilities: all });
  const kept = [];
  ports.frame.on('preUpdate', (t) => kept.push(t));
  ports.frame.requestRender('r');
  raise('preUpdate');
  raise('preRender');
  scene._renderRequested = false;
  raise('postRender');
  raise('preUpdate');
  scene.requestRenderMode = false;
  raise('preUpdate');
  assert.deepEqual(
    kept.map((t) => t.rendering),
    [true, false, true],
    'drawn, not drawn, and the live tick',
  );
  ports.dispose();
});

test('a reason given while a frame draws waits for the next one', () => {
  const { widget, raise } = tickingWidget();
  const ports = createCesiumPorts(widget, { capabilities: all });
  ports.frame.requestRender('before');
  ports.frame.on('preRender', () => ports.frame.requestRender('during'));
  raise('preUpdate');
  raise('preRender');
  raise('postRender');
  assert.deepEqual(ports.frame.diagnostics().pendingReasons, ['during']);
  ports.dispose();
});

test('the same reason given again while it is answered stays pending', () => {
  const { widget, raise } = tickingWidget();
  const ports = createCesiumPorts(widget, { capabilities: all });
  ports.frame.requestRender('animation');
  ports.frame.requestRender('animation');
  assert.deepEqual(ports.frame.diagnostics().pendingReasons, ['animation']);
  ports.frame.on('preRender', () => ports.frame.requestRender('animation'));
  raise('preUpdate');
  raise('preRender');
  raise('postRender');
  assert.deepEqual(ports.frame.diagnostics().pendingReasons, ['animation']);
  ports.dispose();
});

test('scene time past maximumRenderTimeChange draws', () => {
  const { widget, scene, raise } = tickingWidget();
  const ports = createCesiumPorts(widget, { capabilities: all });
  const seen = [];
  ports.frame.on('preUpdate', (t) => seen.push(t.rendering));
  scene.maximumRenderTimeChange = 1;
  scene._lastRenderTime = Cesium.JulianDate.addSeconds(
    widget.clock.currentTime,
    -0.5,
    new Cesium.JulianDate(),
  );
  raise('preUpdate');
  scene._lastRenderTime = Cesium.JulianDate.addSeconds(
    widget.clock.currentTime,
    -2,
    new Cesium.JulianDate(),
  );
  raise('preUpdate');
  assert.deepEqual(seen, [false, true]);
  ports.dispose();
});

test('holds work from a scene that already draws every frame', () => {
  const { widget, scene } = tickingWidget();
  scene.requestRenderMode = false;
  const ports = createCesiumPorts(widget, { capabilities: all });
  const release = ports.frame.holdContinuous('a');
  ports.frame.holdContinuous('b');
  ports.frame.holdContinuous('b');
  assert.deepEqual(ports.frame.diagnostics().holds.sort(), ['a', 'b', 'b']);
  release();
  assert.equal(scene.requestRenderMode, false, 'b still holds');
  ports.dispose();
});

test('a tick that did not draw says so once it is over', () => {
  const { widget, scene, raise } = tickingWidget();
  const ports = createCesiumPorts(widget, { capabilities: all });
  let kept;
  ports.frame.on('preUpdate', (t) => (kept = t));
  raise('preUpdate');
  raise('end');
  assert.equal(kept.rendering, false);
  scene.requestRender();
  assert.equal(kept.rendering, false, 'a later request is the next tick’s');
  raise('preUpdate');
  assert.equal(kept.rendering, true, 'the request draws the next tick');
  const live = kept;
  ports.dispose();
  // The port no longer sees the tick through, so it does not claim a draw.
  assert.equal(live.rendering, false, 'disposal settles the tick under way');
});

test('releasing the last hold asks for one more frame', () => {
  const { widget, scene, requests } = tickingWidget();
  const ports = createCesiumPorts(widget, { capabilities: all });
  const a = ports.frame.holdContinuous('a');
  const b = ports.frame.holdContinuous('b');
  const before = requests();
  a();
  assert.equal(requests(), before, 'a hold still out draws anyway');
  b();
  assert.equal(requests(), before + 1);
  assert.equal(scene.requestRenderMode, true);
  b();
  assert.equal(requests(), before + 1, 'a second release does nothing');
  ports.dispose();
});

test('the loop starts on demand and never draws for scene time alone', () => {
  const { widget, scene } = tickingWidget();
  scene.requestRenderMode = false;
  scene.maximumRenderTimeChange = 0;
  widget.targetFrameRate = 60;
  const ports = createCesiumPorts(widget, { capabilities: all });
  assert.equal(scene.requestRenderMode, true);
  assert.equal(scene.maximumRenderTimeChange, Infinity);
  assert.equal(ports.frame.diagnostics().targetFps, 60, 'the widget’s cap');
  ports.dispose();
});

/** A city view over Austin, looking part-way down. */
function cityView(camera) {
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 2000),
    orientation: { heading: 0, pitch: -0.5, roll: 0 },
  });
}

/** How often Cesium's own `changed` fires at one threshold, over `steps`. */
function cesiumChangedCount(threshold, steps) {
  const { scene } = tickingWidget();
  const camera = scene.camera;
  cityView(camera);
  camera.percentageChanged = threshold;
  let count = 0;
  camera.changed.addEventListener(() => (count += 1));
  updateCameraChanged(camera);
  for (const step of steps) {
    step(camera);
    updateCameraChanged(camera);
  }
  return count;
}

test('changed fires per listener, at each threshold as Cesium would', () => {
  const steps = [
    ...Array.from({ length: 24 }, () => (c) => c.lookRight(0.05)),
    ...Array.from({ length: 12 }, () => (c) => c.twistLeft(0.2)),
    ...Array.from({ length: 10 }, () => (c) => c.moveForward(400)),
  ];
  const { widget, scene, raise } = tickingWidget();
  cityView(scene.camera);
  const ports = createCesiumPorts(widget, {
    capabilities: new Set([...all, 'cameraChangeThreshold']),
  });
  const counts = { 0.5: 0, 0.1: 0 };
  for (const t of [0.5, 0.1])
    ports.camera.on('changed', () => (counts[t] += 1), { threshold: t });
  raise('postUpdate');
  for (const step of steps) {
    step(scene.camera);
    raise('postUpdate');
  }
  assert.ok(counts[0.1] > counts[0.5], JSON.stringify(counts));
  for (const t of [0.5, 0.1])
    assert.equal(counts[t], cesiumChangedCount(t, steps), `threshold ${t}`);
  ports.dispose();
});

test('without cameraChangeThreshold every changed listener fires at 0.5', () => {
  const steps = Array.from({ length: 24 }, () => (c) => c.lookRight(0.05));
  const { widget, scene, raise } = tickingWidget();
  cityView(scene.camera);
  const before = scene.camera.percentageChanged;
  const ports = createCesiumPorts(widget, { capabilities: all });
  const counts = { 0.5: 0, 0.1: 0 };
  for (const t of [0.5, 0.1])
    ports.camera.on('changed', () => (counts[t] += 1), { threshold: t });
  raise('postUpdate');
  for (const step of steps) {
    step(scene.camera);
    raise('postUpdate');
  }
  assert.equal(counts[0.1], counts[0.5], JSON.stringify(counts));
  assert.equal(counts[0.5], cesiumChangedCount(0.5, steps));
  // Cesium's own threshold, shared with everyone else, is left as it was.
  assert.equal(scene.camera.percentageChanged, before);
  ports.dispose();
});

test('camera events: moves measured each tick by the given clock, a throw reported, off and dispose stop them', () => {
  const { widget, scene, raise } = tickingWidget();
  cityView(scene.camera);
  const clock = { ms: 0 };
  const ports = createCesiumPorts(widget, {
    capabilities: all,
    now: () => clock.ms,
  });
  const errors = [];
  ports.on('error', (e) => errors.push(e.message));
  const seen = [];
  ports.camera.on('moveStart', () => {
    throw new Error('first');
  });
  const off = ports.camera.on('moveStart', () => seen.push('start'));
  ports.camera.on('moveEnd', () => seen.push('end'));
  const tick = (ms) => {
    clock.ms += ms;
    raise('postUpdate');
  };
  tick(16);
  scene.camera.lookRight(0.01);
  tick(16);
  assert.deepEqual(seen, ['start']);
  assert.deepEqual(errors, ['first']);
  // Cesium's own events are not relayed: it times them by the system clock.
  scene.camera.moveEnd.raiseEvent();
  tick(499);
  assert.deepEqual(seen, ['start'], 'still within 500 ms of the move');
  tick(1);
  assert.deepEqual(seen, ['start', 'end']);
  off();
  scene.camera.lookRight(0.01);
  tick(16);
  assert.deepEqual(seen, ['start', 'end']);
  assert.throws(
    () => ports.camera.on('turned', () => {}),
    /Unknown camera event/,
  );
  ports.dispose();
  tick(600);
  scene.camera.lookRight(1);
  tick(16);
  tick(600);
  assert.deepEqual(seen, ['start', 'end'], 'nothing after dispose');
});

test('a new field of view is a move: moveStart, then moveEnd 500 ms on', () => {
  const { widget, scene, raise } = tickingWidget();
  cityView(scene.camera);
  const clock = { ms: 0 };
  const ports = createCesiumPorts(widget, {
    capabilities: all,
    now: () => clock.ms,
  });
  const seen = [];
  ports.camera.on('moveStart', () => seen.push('start'));
  ports.camera.on('moveEnd', () => seen.push('end'));
  raise('postUpdate');
  // A resize: the eye stays where it is.
  scene.camera.frustum.aspectRatio = 2;
  clock.ms += 16;
  raise('postUpdate');
  assert.deepEqual(seen, ['start']);
  clock.ms += 500;
  raise('postUpdate');
  assert.deepEqual(seen, ['start', 'end']);
  ports.dispose();
});

test('dispose gives the scene back Cesium’s own tween clock', () => {
  const { widget, scene } = tickingWidget();
  const own = scene.tweens.update;
  const ports = createCesiumPorts(widget, { capabilities: all });
  assert.notEqual(scene.tweens.update, own);
  ports.dispose();
  assert.equal(scene.tweens.update, own);
});

test('moveEnd waits for a still camera: rounding in Cesium’s vectors is no move', () => {
  const { widget, scene, raise } = tickingWidget();
  cityView(scene.camera);
  const clock = { ms: 0 };
  const ports = createCesiumPorts(widget, {
    capabilities: all,
    now: () => clock.ms,
  });
  const seen = [];
  ports.camera.on('moveEnd', () => seen.push('end'));
  raise('postUpdate');
  scene.camera.lookRight(0.01);
  raise('postUpdate');
  for (let i = 0; i < 40; i++) {
    // The same view, derived again: off in the last bits.
    const d = scene.camera.direction;
    const nudge = (i % 2 ? 1 : -1) * 4 * Number.EPSILON * Math.abs(d.x);
    scene.camera.direction = new Cesium.Cartesian3(d.x + nudge, d.y, d.z);
    clock.ms += 16;
    raise('postUpdate');
  }
  assert.deepEqual(seen, ['end']);
  ports.dispose();
});

test('pose: degrees, and NaN where Cesium has no cartographic position', () => {
  const { widget, scene } = tickingWidget();
  cityView(scene.camera);
  const ports = createCesiumPorts(widget, { capabilities: all });
  const pose = ports.camera.pose();
  assert.ok(
    Math.abs(pose.lon + 97.74) < 1e-9 && Math.abs(pose.lat - 30.27) < 1e-9,
  );
  assert.ok(Math.abs(pose.height - 2000) < 1e-6);
  scene.camera.position = new Cesium.Cartesian3(0, 0, 0);
  const centre = ports.camera.pose();
  assert.ok(Number.isNaN(centre.lon) && Number.isNaN(centre.height));
  ports.dispose();
});

test('a camera listener that disposes the port stops the rest of its event', () => {
  const { widget, scene, raise } = tickingWidget();
  cityView(scene.camera);
  const ports = createCesiumPorts(widget, { capabilities: all });
  const seen = [];
  ports.camera.on('moveStart', () => {
    seen.push('first');
    ports.dispose();
  });
  ports.camera.on('moveStart', () => seen.push('second'));
  raise('postUpdate');
  scene.camera.lookRight(0.01);
  raise('postUpdate');
  assert.deepEqual(seen, ['first']);
});

test('viewRectangle is in degrees, around the point below a downward eye', () => {
  const { widget, scene } = tickingWidget();
  scene.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 5000),
  });
  const ports = createCesiumPorts(widget, { capabilities: all });
  const rect = ports.camera.viewRectangle();
  assert.ok(
    rect.west < -97.74 && rect.east > -97.74 && rect.east - rect.west < 0.2,
    JSON.stringify(rect),
  );
  assert.ok(rect.south < 30.27 && rect.north > 30.27, JSON.stringify(rect));
  ports.dispose();
});

/** A scene's primitives as Cesium lists them: `length` and `get`. */
function listedPrimitives(list) {
  return {
    get length() {
      return list.length;
    },
    get: (i) => list[i],
    add: (p) => list.push(p),
    remove: (p) => list.splice(list.indexOf(p), 1),
  };
}

test('clampState drapes without tiles and overlays shown ones, told on change', () => {
  const { widget, scene, raise } = tickingWidget();
  const list = [];
  scene.primitives = listedPrimitives(list);
  const ports = createCesiumPorts(widget, { capabilities: all });
  assert.equal(ports.draw.clampState(), 'draped', 'nothing but the ellipsoid');
  const told = [];
  const off = ports.draw.on('clampState', (state) => told.push(state));
  raise('postRender');
  assert.deepEqual(told, [], 'not on subscribing, nor without a change');
  const tileset = Object.create(Cesium.Cesium3DTileset.prototype);
  tileset.show = true;
  list.push(tileset);
  assert.equal(ports.draw.clampState(), 'overlay', 'the port drapes no tiles');
  raise('postRender');
  raise('postRender');
  assert.deepEqual(told, ['overlay'], 'told once, after a drawn frame');
  tileset.show = false;
  raise('postRender');
  assert.deepEqual(told, ['overlay', 'draped'], 'hidden tiles take nothing');
  off();
  tileset.show = true;
  raise('postRender');
  assert.equal(told.length, 2, 'off stops it');
  assert.equal(typeof ports.draw.on('ready', () => {}), 'function');
  ports.dispose();
});

test('an icon draws its atlas slot once the atlas has it, and swaps it when it changes', () => {
  const { widget, scene } = tickingWidget();
  const list = [];
  scene.primitives = listedPrimitives(list);
  // What a billboard reads of its scene as it is added.
  scene.frameState = { mode: Cesium.SceneMode.SCENE3D };
  const ports = createCesiumPorts(widget, { capabilities: all });
  const icon = (id, slot) => ({
    id,
    pos: { x: 6378137, y: 0, z: 0 },
    image: { atlas: 'conf', slot },
    size: [4, 4],
  });
  const icons = ports.draw.icons({ id: 'icons' });
  icons.set([icon('one', 'dot'), icon('two', 'ring')]);
  assert.equal(icons.size(), 2);
  assert.equal(list.at(-1).length, 0, 'no atlas yet: nothing drawn');
  ports.draw.atlas('conf', { dot: 'dot.png' });
  const first = list.at(-1);
  assert.equal(first.length, 1, 'the slot it has draws');
  assert.equal(first.get(0).image, 'dot.png');
  ports.draw.atlas('other', { dot: 'other.png' });
  assert.equal(list.at(-1), first, 'another atlas leaves the set alone');
  const dot = first.get(0);
  ports.draw.atlas('conf', { dot: 'next.png', ring: 'ring.png' });
  assert.equal(list.at(-1), first, 'changed in place');
  assert.equal(first.get(0), dot, 'the same billboard, its image swapped');
  assert.deepEqual(
    [first.get(0).image, first.get(1).image],
    ['next.png', 'ring.png'],
  );
  ports.dispose();
});

test('setTime moves scene time and draws it, leaving the clock running or not', () => {
  const { widget, scene } = tickingWidget();
  let requested = 0;
  scene.requestRender = () => (requested += 1);
  widget.clock.shouldAnimate = true;
  const ports = createCesiumPorts(widget, { capabilities: all });
  const t = Date.UTC(2026, 5, 21, 12);
  ports.frame.setTime(t);
  assert.equal(ports.frame.time(), t);
  assert.equal(widget.clock.shouldAnimate, true, 'still running');
  assert.equal(requested, 1, 'one frame asked for');
  assert.deepEqual(ports.frame.diagnostics().pendingReasons, ['time']);
  ports.dispose();
});

test('whenSettled waits for shown 3D tiles, not for a hidden globe', async () => {
  const { widget, scene, raise } = tickingWidget();
  const list = [];
  scene.primitives = listedPrimitives(list);
  scene.globe = { show: false, tilesLoaded: false };
  // Each asked-for frame is drawn soon after.
  scene.requestRender = () => setTimeout(() => raise('postRender'), 1);
  const ports = createCesiumPorts(widget, { capabilities: all });
  const tileset = Object.create(Cesium.Cesium3DTileset.prototype);
  Object.defineProperty(tileset, 'tilesLoaded', { value: false });
  tileset.show = true;
  list.push(tileset);
  const result = await ports.whenSettled({ timeoutMs: 60 });
  assert.equal(result.state, 'timeout');
  assert.ok(result.blockers.includes('tiles'), result.blockers.join());
  assert.ok(!result.blockers.includes('globe'), 'a hidden globe loads nothing');
  tileset.show = false;
  scene.globe.show = true;
  const shown = await ports.whenSettled({ timeoutMs: 60 });
  assert.ok(!shown.blockers.includes('tiles'), 'hidden tiles load nothing');
  assert.ok(shown.blockers.includes('globe'), 'a shown globe still loading');
  ports.dispose();
});

test('whenSettled under way fails as destroyed once the ports are disposed', async () => {
  const { widget, scene, raise } = tickingWidget();
  scene.primitives = listedPrimitives([]);
  scene.requestRender = () => setTimeout(() => raise('postRender'), 1);
  const ports = createCesiumPorts(widget, { capabilities: all });
  const pending = ports.whenSettled({ timeoutMs: 5000 });
  setTimeout(() => ports.dispose(), 5);
  assert.deepEqual(await pending, { state: 'failed', blockers: ['destroyed'] });
});

test('whenSettled settles once shown tiles have loaded under a hidden globe', async () => {
  const { widget, scene, raise } = tickingWidget();
  const list = [];
  scene.primitives = listedPrimitives(list);
  scene.globe = { show: false, tilesLoaded: false };
  scene.requestRender = () => setTimeout(() => raise('postRender'), 1);
  const tileset = Object.create(Cesium.Cesium3DTileset.prototype);
  Object.defineProperty(tileset, 'tilesLoaded', { value: true });
  tileset.show = true;
  list.push(tileset);
  const ports = createCesiumPorts(widget, { capabilities: all });
  // The loop ticks without drawing.
  const ticker = setInterval(() => raise('preUpdate'), 5);
  try {
    assert.deepEqual(await ports.whenSettled({ timeoutMs: 2000 }), {
      state: 'settled',
      blockers: [],
    });
  } finally {
    clearInterval(ticker);
    ports.dispose();
  }
});

test('releaseUnused trims the tiles caches, the globe after the next drawn frame', () => {
  const { widget, scene, raise } = tickingWidget();
  const list = [];
  scene.primitives = listedPrimitives(list);
  const trimmed = [];
  scene.globe = {
    show: true,
    _surface: {
      _tileReplacementQueue: { trimTiles: (n) => trimmed.push(`globe ${n}`) },
    },
  };
  const tileset = Object.create(Cesium.Cesium3DTileset.prototype);
  tileset.trimLoadedTiles = () => trimmed.push('tileset');
  list.push(tileset);
  const ports = createCesiumPorts(widget, { capabilities: all });
  ports.releaseUnused();
  ports.releaseUnused();
  assert.deepEqual(trimmed, ['tileset', 'tileset'], 'the globe waits');
  assert.ok(ports.frame.diagnostics().pendingReasons.includes('releaseUnused'));
  raise('postRender');
  raise('postRender');
  assert.deepEqual(trimmed, ['tileset', 'tileset', 'globe 0'], 'once');
  scene.globe.show = false;
  ports.releaseUnused();
  raise('postRender');
  assert.equal(trimmed.at(-1), 'tileset', 'a hidden globe is left alone');
  scene.globe.show = true;
  ports.releaseUnused();
  ports.dispose();
  raise('postRender');
  assert.equal(trimmed.at(-1), 'tileset', 'nothing once disposed');
  ports.releaseUnused();
  assert.equal(trimmed.length, 5, 'nor a release after');
});
