import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import {
  cesiumCapabilities,
  createCesiumPorts,
  listenerList,
} from './ports.js';
import { updateCameraChanged } from './internals.js';

test('capabilities follow what the scene supports', () => {
  const effects = ['styles', 'bloom', 'sharpen'];
  assert.deepEqual(cesiumCapabilities({}), ['models', ...effects]);
  assert.deepEqual(cesiumCapabilities({ pickPositionSupported: true }), [
    'models',
    ...effects,
    'pickPosition',
  ]);
  assert.deepEqual(
    cesiumCapabilities({
      pickPositionSupported: true,
      sampleHeightSupported: true,
    }),
    [
      'models',
      ...effects,
      'pickPosition',
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
    camera: { moveStart: event(), moveEnd: event() },
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
  const out = new Float64Array(3);
  ports.query.sampleHeightNowMany(new Float64Array(6), out);
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
  const ports = createCesiumPorts(widget, { capabilities: all });
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

test('camera events: Cesium’s moves relayed, a throw reported, off and dispose stop them', () => {
  const { widget, scene, raise } = tickingWidget();
  cityView(scene.camera);
  const ports = createCesiumPorts(widget, { capabilities: all });
  const errors = [];
  ports.on('error', (e) => errors.push(e.message));
  const seen = [];
  ports.camera.on('moveStart', () => {
    throw new Error('first');
  });
  const off = ports.camera.on('moveStart', () => seen.push('start'));
  ports.camera.on('moveEnd', () => seen.push('end'));
  ports.camera.on('changed', () => seen.push('changed'), { threshold: 0.01 });
  scene.camera.moveStart.raiseEvent();
  scene.camera.moveEnd.raiseEvent();
  assert.deepEqual(seen, ['start', 'end']);
  assert.deepEqual(errors, ['first']);
  off();
  scene.camera.moveStart.raiseEvent();
  assert.deepEqual(seen, ['start', 'end']);
  assert.throws(() => ports.camera.on('turned', () => {}), /Unknown camera event/);
  ports.dispose();
  scene.camera.moveEnd.raiseEvent();
  scene.camera.lookRight(1);
  raise('postUpdate');
  assert.deepEqual(seen, ['start', 'end'], 'nothing after dispose');
});

test('pose: degrees, and NaN where Cesium has no cartographic position', () => {
  const { widget, scene } = tickingWidget();
  cityView(scene.camera);
  const ports = createCesiumPorts(widget, { capabilities: all });
  const pose = ports.camera.pose();
  assert.ok(Math.abs(pose.lon + 97.74) < 1e-9 && Math.abs(pose.lat - 30.27) < 1e-9);
  assert.ok(Math.abs(pose.height - 2000) < 1e-6);
  scene.camera.position = new Cesium.Cartesian3(0, 0, 0);
  const centre = ports.camera.pose();
  assert.ok(Number.isNaN(centre.lon) && Number.isNaN(centre.height));
  ports.dispose();
});

test('a camera listener that disposes the port stops the rest of its event', () => {
  const { widget, scene } = tickingWidget();
  const ports = createCesiumPorts(widget, { capabilities: all });
  const seen = [];
  ports.camera.on('moveStart', () => ports.dispose());
  ports.camera.on('moveStart', () => seen.push('second'));
  scene.camera.moveStart.raiseEvent();
  assert.deepEqual(seen, []);
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

test('an icon draws its atlas slot once the atlas has it, and again when it changes', () => {
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
  ports.draw.atlas('conf', { dot: 'next.png', ring: 'ring.png' });
  assert.notEqual(list.at(-1), first, 'rebuilt');
  assert.deepEqual(
    [list.at(-1).get(0).image, list.at(-1).get(1).image],
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
