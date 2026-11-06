import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import {
  cesiumCapabilities,
  createCesiumPorts,
  listenerList,
} from './ports.js';

test('capabilities follow what the scene supports', () => {
  assert.deepEqual(cesiumCapabilities({}), ['models']);
  assert.deepEqual(cesiumCapabilities({ pickPositionSupported: true }), [
    'models',
    'pickPosition',
  ]);
  assert.deepEqual(
    cesiumCapabilities({
      pickPositionSupported: true,
      sampleHeightSupported: true,
    }),
    ['models', 'pickPosition', 'sampleHeight', 'finestHeights', 'rayCast'],
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
    camera: {},
    primitives: {
      add: (p) => primitives.push(p),
      remove: (p) => primitives.splice(primitives.indexOf(p), 1),
    },
    requestRender() {},
    preUpdate: event(),
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
