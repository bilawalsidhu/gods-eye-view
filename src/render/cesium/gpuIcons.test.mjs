import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { createCesiumDraw } from './draw.js';
import { drawHitOf } from './drawHit.js';
import { IconSetPrimitive } from './iconSetPrimitive.js';
import { MAX_ICON_SLOTS } from '../../data/iconAtlas.js';
import {
  ICON_CULL_LIFT,
  ICON_RECEDES,
  ICON_ROTATES,
} from '../../data/iconSet.js';
import {
  iconCourse,
  iconPosition,
  motionPosition,
} from '../motion/iconMotion.js';

/** A scene with what the draw port touches, and a frame time to set. */
function fakeScene() {
  const added = [];
  return {
    added,
    renders: 0,
    camera: { positionWC: new Cesium.Cartesian3(2e7, 0, 0) },
    frameState: { time: Cesium.JulianDate.now() },
    primitives: {
      add: (primitive) => (added.push(primitive), primitive),
      remove: (primitive) => {
        const at = added.indexOf(primitive);
        if (at >= 0) added.splice(at, 1);
        return at >= 0;
      },
      length: 0,
    },
    requestRender() {
      this.renders += 1;
    },
    isDestroyed: () => false,
  };
}

function drawOver(options = {}) {
  const scene = fakeScene();
  const part = createCesiumDraw({
    scene,
    report: (error) => assert.fail(error),
    ...options,
  });
  return { scene, part, draw: part.port };
}

const AT = Cesium.Cartesian3.fromDegrees(4.1, 51.95, 2);
const ecef = (c) => ({ x: c.x, y: c.y, z: c.z });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const julian = (ms) => Cesium.JulianDate.fromDate(new Date(ms));

/** The record's icon set, and where a row is drawn at epoch ms `ms`. */
function rows(part, id) {
  const set = part.sets.get(id).gpu.set;
  return {
    set,
    position: (rowId, ms) =>
      set.position(set.row(rowId), set.seconds(julian(ms))),
    course: (rowId, ms) => set.course(set.row(rowId), set.seconds(julian(ms))),
  };
}

const icon = (id, extra = {}) => ({
  id,
  pos: ecef(AT),
  image: 'ship.png',
  size: [32, 32],
  ...extra,
});

test('a moving item takes its icon set onto the GPU, in its billboards’ place', () => {
  const { scene, part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:switch', horizonCull: true });
  set.set([icon('a')]);
  assert.ok(scene.added[0] instanceof Cesium.BillboardCollection);
  set.upsert([icon('b', { motion: { kind: 'hold', courseDeg: 30 } })]);
  assert.equal(scene.added.length, 1, 'one host');
  const host = scene.added[0];
  assert.ok(host instanceof IconSetPrimitive, 'drawn by the GPU icon set');
  assert.equal(host.drawSetId, 'gpu:switch', 'named for finding its host');
  const { set: rowsOf, course } = rows(part, 'gpu:switch');
  assert.equal(rowsOf.count, 2, 'the items it had are rows too');
  assert.equal(set.size(), 2);
  assert.equal(course('b', Date.now()), 30);
  // It stays on the GPU: still items draw as holds where they are.
  set.set([icon('c')]);
  assert.equal(scene.added[0], host);
  assert.equal(rowsOf.count, 1);
  assert.ok(distance(rows(part, 'gpu:switch').position('c', 0), AT) < 0.01);
  set.remove(['c']);
  assert.equal(rowsOf.count, 0);
  set.dispose();
  assert.equal(scene.added.length, 0, 'disposed: gone from the scene');
});

test('segments draw where the contract’s motion puts them, on the scene clock', () => {
  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:motion', motionClock: { kind: 'scene' } });
  // Near the set's epoch (now), as live times are: segment times are float32.
  const t0 = Date.now();
  const fix = ecef(Cesium.Cartesian3.fromDegrees(4.1, 51.95, 12000));
  const to = ecef(Cesium.Cartesian3.fromDegrees(4.3, 51.95, 12000));
  const motions = {
    lerp: { kind: 'lerp', from: fix, to, t0, t1: t0 + 10000 },
    arc: {
      kind: 'arc',
      fix,
      t0,
      speedMps: 150,
      trackDeg: 20,
      turnRateDps: 3,
      climbMps: 12,
      minDtS: -10,
      maxDtS: 20,
    },
    straight: {
      kind: 'arc',
      fix,
      t0,
      speedMps: 200,
      trackDeg: 90,
      turnRateDps: 0,
      climbMps: -5,
      minDtS: 0,
      maxDtS: 10,
    },
    hold: { kind: 'hold', courseDeg: 45 },
  };
  set.set(
    Object.entries(motions).map(([id, motion]) => ({
      ...icon(id),
      pos: fix,
      motion,
    })),
  );
  const { position } = rows(part, 'gpu:motion');
  for (const dt of [-30000, -5000, 0, 2500, 8000, 15000, 60000])
    for (const [id, motion] of Object.entries(motions)) {
      const want = motionPosition(motion, fix, t0 + dt);
      const off = distance(position(id, t0 + dt), want);
      assert.ok(off < 0.1, `${id} at ${dt} ms: ${off} m off`);
    }
});

test('a set’s motion clock is the frame’s scene time, or wall time less its delay', () => {
  const { scene, part, draw } = drawOver();
  const live = draw.icons({
    id: 'gpu:live',
    motionClock: { kind: 'live', delayMs: 2000 },
  });
  live.set([icon('a', { motion: { kind: 'hold' } })]);
  const host = part.sets.get('gpu:live').host;
  const lag =
    Date.now() - Cesium.JulianDate.toDate(host.renderTime({})).getTime();
  assert.ok(Math.abs(lag - 2000) < 50, `lags ${lag} ms`);
  const sceneSet = draw.icons({
    id: 'gpu:scene',
    motionClock: { kind: 'scene' },
  });
  sceneSet.set([icon('a', { motion: { kind: 'hold' } })]);
  const frameState = { time: julian(Date.UTC(2020, 0, 1)) };
  const sceneHost = part.sets.get('gpu:scene').host;
  assert.ok(
    Cesium.JulianDate.equals(sceneHost.renderTime(frameState), frameState.time),
  );
  assert.equal(scene.frameState.time instanceof Cesium.JulianDate, true);
});

test('a live clock’s new delay is read the next frame with nothing restyled', () => {
  const { part, draw } = drawOver();
  const live = draw.icons({
    id: 'gpu:delay',
    motionClock: { kind: 'live', delayMs: 2000 },
  });
  live.set([icon('a', { motion: { kind: 'hold' } })]);
  const record = part.sets.get('gpu:delay');
  let restyles = 0;
  const restyle = record.gpu.restyle;
  record.gpu.restyle = () => ((restyles += 1), restyle());
  live.setOptions({ motionClock: { kind: 'live', delayMs: 5000 } });
  assert.equal(restyles, 0, 'a delay alone restyles nothing');
  const lag =
    Date.now() - Cesium.JulianDate.toDate(record.host.renderTime({})).getTime();
  assert.ok(Math.abs(lag - 5000) < 50, `lags ${lag} ms`);
  live.setOptions({ motionClock: { kind: 'scene' } });
  assert.equal(restyles, 1, 'a clock of another kind still restyles');
});

test('rows moving on a live clock keep frames coming until their segments end', () => {
  const { scene, part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:animate' });
  const now = Date.now();
  const to = ecef(Cesium.Cartesian3.fromDegrees(4.2, 51.95, 2));
  set.set([
    icon('a', {
      motion: { kind: 'lerp', from: ecef(AT), to, t0: now, t1: now + 60000 },
    }),
  ]);
  const before = scene.renders;
  part.afterRender();
  assert.equal(scene.renders, before + 1, 'still moving: another frame');
  set.set([icon('a', { motion: { kind: 'hold' } })]);
  const held = scene.renders;
  part.afterRender();
  assert.equal(scene.renders, held, 'held: no frames asked for');
  // A scene clock moves with the scene's own time.
  set.setOptions({ motionClock: { kind: 'scene' } });
  set.set([
    icon('a', {
      motion: { kind: 'lerp', from: ecef(AT), to, t0: now, t1: now + 60000 },
    }),
  ]);
  const onScene = scene.renders;
  part.afterRender();
  assert.equal(scene.renders, onScene);
});

test('a live set whose owner asks for its frames asks for none itself', () => {
  const { scene, part, draw } = drawOver();
  const set = draw.icons({
    id: 'gpu:owned',
    motionClock: { kind: 'live', delayMs: 2000, frames: 'owner' },
  });
  const now = Date.now();
  const to = ecef(Cesium.Cartesian3.fromDegrees(4.2, 51.95, 2));
  set.set([
    icon('a', {
      motion: { kind: 'lerp', from: ecef(AT), to, t0: now, t1: now + 60000 },
    }),
  ]);
  const moving = scene.renders;
  part.afterRender();
  assert.equal(scene.renders, moving, 'moving rows ask for no frame');
  set.setOptions({
    motionClock: { kind: 'live', delayMs: 3000, frames: 'owner' },
  });
  assert.equal(scene.renders, moving, 'a new delay asks for no frame');
  // A row restyled in place, as the owner does when a frame begins (a
  // helicopter's rotor), asks for none either: that frame draws it.
  set.upsert([
    icon('a', {
      scale: 2,
      motion: { kind: 'lerp', from: ecef(AT), to, t0: now, t1: now + 60000 },
    }),
  ]);
  assert.equal(scene.renders, moving, 'a write in place asks for no frame');
  set.setOptions({ motionClock: { kind: 'live', delayMs: 4000 } });
  part.afterRender();
  assert.ok(scene.renders > moving, 'back to the set: frames again');
});

test('a set that recedes draws on the GPU, every row receding by the set’s parameters, and changes live', () => {
  const { scene, part, draw } = drawOver();
  // An item's own `recede` is not the contract's: it changes nothing.
  const still = draw.icons({ id: 'gpu:still' });
  still.set([icon('a', { recede: true })]);
  assert.ok(
    !(scene.added.at(-1) instanceof IconSetPrimitive),
    'still icons stay billboards',
  );
  const set = draw.icons({
    id: 'gpu:recede',
    recede: { scaleFloor: 0.6 },
  });
  set.set([icon('a'), icon('b')]);
  const host = scene.added.at(-1);
  assert.ok(host instanceof IconSetPrimitive, 'on the GPU, though still');
  const { set: s } = rows(part, 'gpu:recede');
  for (const id of ['a', 'b'])
    assert.equal(s.flags(s.row(id)) & ICON_RECEDES, ICON_RECEDES, id);
  assert.equal(host._recedeParams().scaleFloor, 0.6);
  assert.equal(host._recedeParams().alphaFloor, 0.35, 'the rest the defaults');
  set.setOptions({ recede: null });
  for (const id of ['a', 'b'])
    assert.equal(s.flags(s.row(id)) & ICON_RECEDES, 0, `${id} no longer`);
  assert.equal(host._recedeParams(), null);
  // A billboard set told to recede goes onto the GPU, its icons with it.
  still.setOptions({ recede: {} });
  const moved = part.sets.get('gpu:still').gpu;
  assert.ok(moved, 'on the GPU now');
  assert.equal(moved.set.count, 1);
  assert.equal(
    moved.set.flags(moved.set.row('a')) & ICON_RECEDES,
    ICON_RECEDES,
  );
});

test('an item’s look goes into its row: size, scale, tint, focus, flags, proxy, depth and images', () => {
  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:look', horizonCull: true, recede: {} });
  set.set([
    icon('a', {
      motion: { kind: 'hold', courseDeg: 10 },
      size: [20, 24],
      scale: 1.5,
      alpha: 0.5,
      color: [1, 0, 0, 1],
      focus: 0.25,
      rotationMode: 'course',
      pickProxy: { size: [48, 40] },
      disableDepthTest: Infinity,
      scaleByDistance: { near: 1000, nearValue: 3, far: 8e6, farValue: 0.5 },
      imageLod: { near: 'ship-large.png', switchPx: 60 },
    }),
    icon('b', { motion: { kind: 'hold' }, show: false }),
  ]);
  const { set: s } = rows(part, 'gpu:look');
  const a = s.row('a');
  assert.equal(s.width(a), 20);
  assert.equal(s.height(a), 24);
  assert.equal(s.scale(a), 1.5);
  assert.equal(s.alpha(a), 0.5);
  assert.ok(Cesium.Color.equals(s.color(a), Cesium.Color.RED));
  assert.equal(s.focus(a), 0.25);
  assert.equal(s.flags(a) & ICON_ROTATES, ICON_ROTATES);
  assert.equal(s.flags(a) & ICON_RECEDES, ICON_RECEDES);
  assert.equal(s.flags(a) & ICON_CULL_LIFT, ICON_CULL_LIFT, 'culled lifted');
  assert.equal(s.pickProxyWidth(a), 48);
  assert.equal(s.pickProxyHeight(a), 40);
  assert.ok(s.depthTestDistance(a) >= 1e30, 'over depth everywhere');
  assert.equal(s.scaleByDistance(a).nearValue, 3);
  assert.equal(s.imageSwitch(a), 60);
  assert.notEqual(s.imageNear(a), s.imageFar(a), 'a near image of its own');
  assert.equal(s.shown(a), true);
  const b = s.row('b');
  assert.equal(s.shown(b), false);
  assert.equal(s.depthTestDistance(b), 0, 'depth-tested by default');
  assert.equal(s.flags(b) & ICON_ROTATES, 0, 'upright by default');
  assert.equal(s.focus(b), 1);
  assert.equal(s.imageNear(b), s.imageFar(b));

  // The cull lift follows the set's horizon cull.
  set.setOptions({ horizonCull: false });
  assert.equal(s.flags(a) & ICON_CULL_LIFT, 0);
  assert.equal(part.sets.get('gpu:look').host._cull(), false);
  set.setOptions({ horizonCull: true });
  assert.equal(s.flags(a) & ICON_CULL_LIFT, ICON_CULL_LIFT);
  assert.equal(part.sets.get('gpu:look').host._cull(), true);
});

test('a row picks as a draw-set item, with the meta its item has now', () => {
  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:pick' });
  set.set([icon('a', { motion: { kind: 'hold' }, meta: { n: 1 } })]);
  const host = part.sets.get('gpu:pick').host;
  const facade = { show: true };
  const picked = host._pickObject('a', null, facade);
  assert.equal(picked.primitive, facade, 'drill picks hide it by its facade');
  assert.deepEqual(drawHitOf(picked), {
    set: 'gpu:pick',
    id: 'a',
    meta: { n: 1 },
    surface: false,
  });
  set.upsert([icon('a', { motion: { kind: 'hold' }, meta: { n: 2 } })]);
  assert.deepEqual(drawHitOf(picked).meta, { n: 2 });
});

test('a course glides at its rate with courseGlide, and turns at once without it', () => {
  const t0 = Date.now();
  const glideItem = (rateDps) =>
    icon('a', {
      motion: { kind: 'hold', courseDeg: 90 },
      rotationMode: 'course',
      courseGlide: { fromCourseDeg: 0, t0, rateDps },
    });
  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:glide' });
  set.set([glideItem(10)]);
  const { course } = rows(part, 'gpu:glide');
  assert.ok(Math.abs(course('a', t0 + 3000) - 30) < 0.01, 'at 10°/s');
  assert.ok(Math.abs(course('a', t0 + 20000) - 90) < 0.01, 'then on course');
  set.set([glideItem(0)]);
  assert.ok(Math.abs(course('a', t0 + 20000) - 0) < 0.01, '0°/s holds');

  // Without the capability: the glide is ignored and the course turns at once.
  const without = drawOver({
    capabilities: new Set(['motionSegments', 'columns']),
  });
  const turned = without.draw.icons({ id: 'gpu:turn' });
  const turn = (courseDeg) =>
    icon('a', {
      motion: { kind: 'hold', courseDeg },
      courseGlide: { fromCourseDeg: 180, t0, rateDps: 1 },
    });
  turned.set([turn(0)]);
  const r = rows(without.part, 'gpu:turn');
  assert.ok(
    Math.abs(r.course('a', Date.now())) < 0.01,
    'new: on course at once, its glide ignored',
  );
  turned.upsert([turn(60)]);
  assert.ok(Math.abs(r.course('a', Date.now()) - 60) < 0.01, 'turned at once');
});

test('without motionSegments, motion is ignored: billboards at the item’s place', () => {
  const { scene, draw } = drawOver({ capabilities: new Set() });
  const set = draw.icons({ id: 'gpu:none' });
  set.set([icon('a', { motion: { kind: 'hold' } })]);
  assert.ok(scene.added[0] instanceof Cesium.BillboardCollection);
  assert.equal(set.setColumns, undefined, 'no columns either');
});

test('on WebGL 1, GPU icon sets refuse what their rows read from extras, changing nothing', () => {
  const { part, draw, scene } = drawOver();
  scene.context = { webgl2: false };
  const set = draw.icons({ id: 'gpu:refuse' });
  set.set([icon('a', { motion: { kind: 'hold' } })]);
  for (const extra of [
    { height: 'clampGround' },
    { fadeByDistance: { near: 1, nearValue: 1, far: 2, farValue: 0 } },
    { displayRange: [0, 10] },
    { pixelOffset: { x: 1, y: 0 } },
    { anchor: 'bottom' },
    { rotationMode: 'axis' },
    { rotationMode: 'screen', rotation: 1 },
  ])
    assert.throws(
      () => set.upsert([icon('b', { motion: { kind: 'hold' }, ...extra })]),
      /GPU icons have no .* on WebGL 1/,
      JSON.stringify(extra),
    );
  assert.equal(set.size(), 1);
  assert.equal(rows(part, 'gpu:refuse').set.count, 1);
  // A billboard set refuses to move over when what it holds cannot.
  const billboards = draw.icons({ id: 'gpu:stay' });
  billboards.set([icon('a', { anchor: 'bottom' })]);
  assert.throws(
    () => billboards.upsert([icon('b', { motion: { kind: 'hold' } })]),
    /anchors/,
  );
  assert.equal(part.sets.get('gpu:stay').gpu, undefined);
  assert.equal(billboards.size(), 1);
});

test('offsets, anchors, rotations, fades and display ranges go into a row’s extras', () => {
  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:extras' });
  // A billboard set holding them moves over whole.
  set.set([icon('a', { anchor: 'top', pixelOffset: { x: 3, y: -4 } })]);
  set.upsert([
    icon('b', {
      motion: { kind: 'hold' },
      anchor: 'bottom',
      rotationMode: 'screen',
      rotation: 0.5,
      fadeByDistance: { near: 10, nearValue: 1, far: 1e5, farValue: 0 },
      displayRange: [5, 2e6],
    }),
    icon('c', {
      motion: { kind: 'hold' },
      rotationMode: 'axis',
      alignedAxis: { x: 0, y: 0, z: 4 },
    }),
    icon('d', { motion: { kind: 'hold' }, displayRange: [10, 10] }),
  ]);
  const { set: s } = rows(part, 'gpu:extras');
  const a = s.row('a');
  assert.deepEqual(s.offset(a), { x: 3, y: -4 });
  assert.equal(s.anchor(a), -1, 'top');
  const b = s.row('b');
  assert.equal(s.anchor(b), 1, 'bottom');
  assert.equal(s.rotation(b), 0.5);
  assert.deepEqual(s.fade(b), {
    near: 10,
    nearValue: 1,
    far: 1e5,
    farValue: 0,
  });
  assert.deepEqual(s.displayRange(b), [5, 2e6]);
  assert.equal(s.shown(b), true);
  const c = s.row('c');
  assert.deepEqual(s.axis(c), { x: 0, y: 0, z: 1 }, 'normalised');
  assert.equal(s.rotation(c), 0);
  assert.equal(s.shown(s.row('d')), false, 'an empty range shows nowhere');
  // Dropped in place, each goes back to none.
  set.upsert([icon('b', { motion: { kind: 'hold' } })]);
  assert.equal(s.anchor(b), 0);
  assert.equal(s.rotation(b), 0);
  assert.deepEqual(s.fade(b), { near: 0, nearValue: 0, far: 0, farValue: 0 });
  assert.deepEqual(s.displayRange(b), [0, 0]);
  // A row moved by a removal keeps its own.
  set.remove(['a']);
  assert.deepEqual(s.axis(s.row('c')), { x: 0, y: 0, z: 1 });
});

test('clamped rows stand on the ground sampled under their segment ends, after a frame', () => {
  const { part, draw, scene } = drawOver();
  // Terrain rising 1 m a hundredth of a degree east.
  const asked = [];
  scene.globe = {
    tilesLoaded: false,
    getHeight: (carto) => {
      asked.push(carto);
      return Cesium.Math.toDegrees(carto.longitude) * 100;
    },
  };
  const set = draw.icons({ id: 'gpu:ground', clampTo: 'terrain' });
  const from = Cesium.Cartesian3.fromDegrees(4, 52, 900);
  const to = Cesium.Cartesian3.fromDegrees(5, 52, 900);
  const t0 = Date.now();
  set.set([
    icon('a', {
      height: 'clampGround',
      motion: { kind: 'lerp', from, to, t0, t1: t0 + 1000 },
    }),
    icon('b', { height: 'relativeGround', motion: { kind: 'hold' } }),
    icon('c', { motion: { kind: 'hold' } }),
  ]);
  const { set: s } = rows(part, 'gpu:ground');
  const a = s.row('a');
  assert.deepEqual(s.groundHeights(a), [0, 0], 'none sampled while drawing');
  assert.equal(asked.length, 0);
  const renders = scene.renders;
  part.afterRender();
  const [g0, g1] = s.groundHeights(a);
  assert.ok(
    Math.abs(g0 - 400) < 1e-3 && Math.abs(g1 - 500) < 1e-3,
    `${g0} ${g1}`,
  );
  const [span0, span1] = s.groundSpan(a);
  assert.ok(distance(span0, from) < 1 && distance(span1, to) < 1, 'its ends');
  assert.equal(s.groundMode(a), 1, 'clamped');
  assert.equal(s.groundMode(s.row('b')), 2, 'relative');
  assert.equal(s.groundMode(s.row('c')), 0, 'absolute');
  assert.ok(scene.renders > renders, 'a frame for the new ground');
  // Sampled once: no samples in frames after.
  const once = asked.length;
  assert.equal(once, 3, 'two ends, and a held row’s one');
  part.afterRender();
  assert.equal(asked.length, once);
  // Its tiles loaded: sampled again.
  scene.globe.tilesLoaded = true;
  part.afterRender();
  assert.equal(asked.length, once * 2);
  // Unclamped, it drops its ground.
  set.upsert([icon('a', { motion: { kind: 'hold' } })]);
  assert.equal(s.groundMode(a), 0);
  assert.deepEqual(s.groundHeights(a), [0, 0]);
});

test('ground samples are budgeted across frames, the drawn surface the fewest', () => {
  const { part, draw, scene } = drawOver();
  let terrain = 0;
  let surface = 0;
  scene.globe = { getHeight: () => (terrain++, 10) };
  scene.sampleHeightSupported = true;
  scene.sampleHeight = () => (surface++, 30);
  const set = draw.icons({ id: 'gpu:budget' });
  const n = 300;
  set.set(
    Array.from({ length: n }, (_, i) =>
      icon(`r${i}`, { height: 'clampGround', motion: { kind: 'hold' } }),
    ),
  );
  const { set: s } = rows(part, 'gpu:budget');
  part.afterRender();
  assert.ok(
    terrain + surface <= 256,
    `at most 256 a frame: ${terrain} ${surface}`,
  );
  assert.equal(surface, 8, 'eight on the drawn surface');
  const heights = () =>
    [...Array(n).keys()].map((i) => s.groundHeights(s.row(`r${i}`))[0]);
  assert.equal(heights().filter((h) => h === 30).length, 8);
  assert.equal(
    heights().filter((h) => h === 10).length,
    248,
    'the rest on terrain for now',
  );
  for (let i = 0; i < 60; i++) part.afterRender();
  assert.ok(
    heights().every((h) => h === 30),
    'in time all on the drawn surface',
  );
});

test('a GPU icon set clusters its rows where their segments put them in the frame', () => {
  const transforms = Cesium.SceneTransforms;
  const project = transforms.worldToWindowCoordinates;
  // Window positions: a degree of longitude is `spread` pixels.
  let spread = 1;
  transforms.worldToWindowCoordinates = (_, position, result) => {
    const at = Cesium.Cartographic.fromCartesian(position);
    result ??= new Cesium.Cartesian2();
    result.x = 200 + Cesium.Math.toDegrees(at.longitude) * spread;
    result.y = 150 - Cesium.Math.toDegrees(at.latitude) * spread;
    return result;
  };
  try {
    const { part, draw, scene } = drawOver({
      capabilities: new Set(['motionSegments', 'columns', 'cluster']),
    });
    scene.camera.directionWC = new Cesium.Cartesian3(-1, 0, 0);
    scene.camera.positionCartographic = { height: 1000 };
    scene.canvas = { clientWidth: 400, clientHeight: 300 };
    const t0 = Cesium.JulianDate.toDate(scene.frameState.time).getTime();
    const counts = [];
    const set = draw.icons({
      id: 'gpu:cluster',
      motionClock: { kind: 'scene' },
      cluster: {
        pixelRange: 10,
        minimumSize: 2,
        icon: (count) => (counts.push(count), 'badge.png'),
      },
    });
    // Each given far apart, each moving to within a few pixels of the rest.
    const mover = (id, lon) => {
      const from = ecef(Cesium.Cartesian3.fromDegrees(lon * 40, 30));
      const to = ecef(Cesium.Cartesian3.fromDegrees(lon, 0));
      return icon(id, {
        pos: from,
        size: [8, 8],
        meta: { id },
        motion: { kind: 'lerp', from, to, t0, t1: t0 + 1000 },
      });
    };
    set.set([mover('a', 0), mover('b', 2), mover('c', 4)]);
    // At the start, apart: no cluster.
    part.beforeRender();
    const { set: s } = rows(part, 'gpu:cluster');
    assert.deepEqual(counts, []);
    assert.ok(['a', 'b', 'c'].every((id) => s.shown(s.row(id))));
    // At the end, together.
    scene.frameState.time = julian(t0 + 5000);
    part.beforeRender();
    assert.deepEqual(counts, [3]);
    assert.ok(
      ['a', 'b', 'c'].every((id) => !s.shown(s.row(id))),
      'members are not drawn',
    );
    const clusters = part.sets.get('gpu:cluster').clusterHost;
    assert.equal(clusters.length, 1);
    const { id, width } = clusters.get(0);
    assert.equal(width, 8, 'at its seed’s size');
    assert.deepEqual(id.cluster.ids, ['a', 'b', 'c'], 'seed first');
    const mean = Cesium.Cartographic.fromCartesian(
      new Cesium.Cartesian3(
        id.cluster.position.x,
        id.cluster.position.y,
        id.cluster.position.z,
      ),
    );
    assert.ok(Math.abs(Cesium.Math.toDegrees(mean.longitude) - 2) < 1e-3);
    // Held still, not made again.
    part.beforeRender();
    assert.deepEqual(counts, [3]);
    // The camera moved: apart, each drawn again.
    spread = 100;
    scene.camera.positionWC = new Cesium.Cartesian3(2e7, 1, 0);
    part.beforeRender();
    assert.equal(clusters.length, 0);
    assert.ok(['a', 'b', 'c'].every((id) => s.shown(s.row(id))));
    // A member hidden by its item stays hidden out of a cluster.
    set.upsert([{ ...mover('b', 2), show: false }]);
    part.beforeRender();
    assert.equal(s.shown(s.row('b')), false);
    set.dispose();
    assert.ok(!scene.added.includes(clusters), 'let go with the set');
  } finally {
    transforms.worldToWindowCoordinates = project;
  }
});

test('a clustered GPU icon set clusters again after static column changes', () => {
  const transforms = Cesium.SceneTransforms;
  const project = transforms.worldToWindowCoordinates;
  transforms.worldToWindowCoordinates = (_, position, result) => {
    const at = Cesium.Cartographic.fromCartesian(position);
    result ??= new Cesium.Cartesian2();
    result.x = 200 + Cesium.Math.toDegrees(at.longitude) * 100;
    result.y = 150 - Cesium.Math.toDegrees(at.latitude) * 100;
    return result;
  };
  try {
    const { part, draw, scene } = drawOver({
      capabilities: new Set(['columns', 'cluster']),
    });
    scene.camera.directionWC = new Cesium.Cartesian3(-1, 0, 0);
    scene.camera.positionCartographic = { height: 1000 };
    scene.canvas = { clientWidth: 400, clientHeight: 300 };
    const counts = [];
    const set = draw.icons({
      id: 'gpu:cluster-columns',
      cluster: {
        pixelRange: 10,
        minimumSize: 2,
        icon: (count) => (counts.push(count), 'badge.png'),
      },
    });
    const at = (lon) => ecef(Cesium.Cartesian3.fromDegrees(lon, 0));
    set.set([
      icon('a', { pos: at(0), size: [8, 8] }),
      icon('b', { pos: at(1), size: [8, 8] }),
    ]);
    set.setColumns({ ids: ['a', 'b'] });
    // Apart (100 px a degree): no cluster.
    part.beforeRender();
    assert.deepEqual(counts, []);
    const flat = (...points) =>
      new Float64Array(points.flatMap((p) => [p.x, p.y, p.z]));
    // Positions only, nothing moving, the camera still: together now.
    set.setColumns({ ids: ['a', 'b'], positions: flat(at(0), at(0.01)) });
    part.beforeRender();
    assert.deepEqual(counts, [2], 'clustered where the columns put them');
    // Shown only: one hidden, no cluster left.
    set.setColumns({ ids: ['a', 'b'], shown: new Uint8Array([1, 0]) });
    part.beforeRender();
    assert.equal(part.sets.get('gpu:cluster-columns').clusterHost.length, 0);
    set.dispose();
  } finally {
    transforms.worldToWindowCoordinates = project;
  }
});

test('columns update rows by index: positions, courses, shown, scales, tints and meta', () => {
  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:columns' });
  const b = ecef(Cesium.Cartesian3.fromDegrees(4.2, 51.9, 2));
  set.set([icon('a', { meta: 1 }), icon('b', { pos: b, meta: 2 })]);
  assert.ok(part.sets.get('gpu:columns').gpu === undefined, 'billboards');
  set.setColumns({
    ids: ['a', 'b'],
    positions: new Float64Array([b.x, b.y, b.z, AT.x, AT.y, AT.z]),
    courses: new Float32Array([15, 25]),
    shown: new Uint8Array([1, 0]),
    scales: new Float32Array([2, 3]),
    alphas: new Float32Array([0.5, 1]),
    colors: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
    meta: [{ k: 'a' }, { k: 'b' }],
  });
  const r = rows(part, 'gpu:columns');
  const now = Date.now();
  assert.ok(distance(r.position('a', now), b) < 0.01, 'a moved to b');
  assert.ok(distance(r.position('b', now), AT) < 0.01, 'b moved to a');
  assert.equal(r.course('a', now), 15);
  assert.equal(r.set.shown(r.set.row('b')), false);
  assert.equal(r.set.scale(r.set.row('b')), 3);
  assert.equal(r.set.alpha(r.set.row('a')), 0.5);
  assert.ok(
    Cesium.Color.equals(r.set.color(r.set.row('b')), Cesium.Color.BLUE),
  );
  const host = part.sets.get('gpu:columns').host;
  assert.deepEqual(drawHitOf(host._pickObject('b', null, {})).meta, {
    k: 'b',
  });
  assert.equal(r.set.width(r.set.row('a')), 32, 'the item’s look is kept');

  // Dirty runs, for the same ids, rewrite only those rows (end included).
  const scales = new Float32Array([4, 5]);
  set.setColumns({ ids: ['a', 'b'], scales, dirty: [{ start: 1, end: 1 }] });
  assert.equal(r.set.scale(r.set.row('a')), 2, 'not in the run: as it was');
  assert.equal(r.set.scale(r.set.row('b')), 5);

  // New ids: rows not named go, new ones come (drawn once they have a look).
  set.setColumns({
    ids: ['b', 'c'],
    positions: new Float64Array([AT.x, AT.y, AT.z, b.x, b.y, b.z]),
    dirty: [{ start: 0, end: 0 }],
  });
  assert.equal(set.size(), 2);
  assert.equal(r.set.row('a'), -1, 'a went');
  assert.ok(distance(r.position('c', now), b) < 0.01, 'c written in full');
  assert.equal(r.set.imageFar(r.set.row('c')), -1, 'no image: not drawn');
});

test('a row hidden by its column keeps its segment, and shows where it would be', () => {
  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:shown', motionClock: { kind: 'scene' } });
  const t0 = Date.now();
  const to = ecef(Cesium.Cartesian3.fromDegrees(4.3, 51.95, 2));
  const motion = { kind: 'lerp', from: ecef(AT), to, t0, t1: t0 + 10000 };
  set.set([icon('m', { motion })]);
  set.setColumns({ ids: ['m'], shown: new Uint8Array([0]) });
  const r = rows(part, 'gpu:shown');
  assert.equal(r.set.shown(0), false);
  set.setColumns({ ids: ['m'], shown: new Uint8Array([1]) });
  const want = motionPosition(motion, ecef(AT), t0 + 7000);
  assert.ok(distance(r.position('m', t0 + 7000), want) < 0.1);
});

test('re-registering an atlas rewrites the GPU rows drawing from it', () => {
  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:atlas' });
  set.set([
    icon('a', {
      motion: { kind: 'hold' },
      image: { atlas: 'ships', slot: 'x' },
    }),
  ]);
  const r = rows(part, 'gpu:atlas');
  assert.equal(r.set.imageFar(0), -1, 'not registered yet: not drawn');
  const before = part.version();
  draw.atlas('ships', { x: 'ship-x.png' });
  assert.ok(r.set.imageFar(0) >= 0, 'drawn once it is');
  assert.ok(part.version() > before);
});

test('held rows still turning keep frames coming until their course settles', () => {
  const { scene, part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:turning' });
  const now = Date.now();
  set.set([
    icon('a', {
      motion: { kind: 'hold', courseDeg: 90 },
      rotationMode: 'course',
      courseGlide: { fromCourseDeg: 0, t0: now, rateDps: 10 },
    }),
  ]);
  const before = scene.renders;
  part.afterRender();
  assert.equal(scene.renders, before + 1, 'gliding: another frame');
  // A glide long since over: settled, no frames.
  set.set([
    icon('a', {
      motion: { kind: 'hold', courseDeg: 90 },
      rotationMode: 'course',
      courseGlide: { fromCourseDeg: 0, t0: now - 60000, rateDps: 10 },
    }),
  ]);
  const settled = scene.renders;
  part.afterRender();
  assert.equal(scene.renders, settled);
});

test('an icon set refuses, changing nothing, images the shared atlas has no room for', () => {
  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:atlas-room' });
  set.set([icon('a', { motion: { kind: 'hold' } })]);
  const many = Array.from({ length: MAX_ICON_SLOTS + 16 }, (_, i) =>
    icon(`m${i}`, { image: `room-${i}.png`, motion: { kind: 'hold' } }),
  );
  assert.throws(() => set.upsert(many), /no room for/);
  assert.equal(set.size(), 1);
  assert.equal(rows(part, 'gpu:atlas-room').set.count, 1);
});

test('focus fades a billboard icon as it fades a GPU one', () => {
  const { scene, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:focus-billboard' });
  set.set([icon('a', { focus: 0.25, alpha: 0.8 })]);
  const billboards = scene.added[0];
  assert.ok(billboards instanceof Cesium.BillboardCollection);
  assert.ok(Math.abs(billboards.get(0).color.alpha - 0.2) < 1e-6);
  set.upsert([icon('a', { focus: 3 })]);
  assert.equal(billboards.get(0).color.alpha, 1, 'at most no fade');
});

test('an icon set stays on billboards until an item needs the GPU', () => {
  const { scene, part, draw } = drawOver();
  const stays = draw.icons({ id: 'gpu:stays' });
  stays.set([icon('a', { anchor: 'bottom' })]);
  assert.equal(part.sets.get('gpu:stays').gpu, undefined, 'billboards');
  // Every blend moves over: it is turned where the commands are drawn.
  const additive = draw.icons({ id: 'gpu:additive', blend: 'additive' });
  additive.set([icon('a', { motion: { kind: 'hold' } })]);
  assert.ok(part.sets.get('gpu:additive').gpu, 'on the GPU');
  assert.ok(scene.added.length >= 1);
});

test('a write that moves a row as it already moves keeps its segment', () => {
  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:keep-segment' });
  const item = icon('a', { motion: { kind: 'hold', courseDeg: 40 } });
  set.set([item]);
  const { set: rowsSet } = rows(part, 'gpu:keep-segment');
  rowsSet.dirty.segments.clear();
  rowsSet.dirty.style.clear();
  set.upsert([{ ...item, focus: 0.5, motion: { ...item.motion } }]);
  assert.ok(rowsSet.dirty.segments.empty, 'no segment written');
  assert.ok(!rowsSet.dirty.style.empty, 'its focus is');
  set.upsert([{ ...item, motion: { kind: 'hold', courseDeg: 41 } }]);
  assert.ok(!rowsSet.dirty.segments.empty, 'a new course is');
});

test('rows draw where the shared evaluator puts them, with the course it gives', () => {
  const t0 = Date.now();
  const fix = ecef(Cesium.Cartesian3.fromDegrees(-97.04, 32.9, 10_500));
  const to = { x: fix.x + 4000, y: fix.y - 2500, z: fix.z + 1200 };
  const items = [
    icon('hold', {
      motion: { kind: 'hold', courseDeg: 300 },
      courseGlide: { fromCourseDeg: 10, t0, rateDps: 7 },
    }),
    icon('lerp', {
      course: 15,
      motion: {
        kind: 'lerp',
        from: fix,
        to,
        t0: t0 - 3000,
        t1: t0 + 9000,
        courseSlopeDeg: -40,
      },
    }),
    icon('step', {
      motion: { kind: 'lerp', from: fix, to, t0: t0 + 2000, t1: t0 },
    }),
    icon('arc', {
      motion: {
        kind: 'arc',
        fix,
        t0,
        speedMps: 240,
        trackDeg: 355,
        turnRateDps: -3,
        climbMps: 12,
        minDtS: -30,
        maxDtS: 90,
      },
      courseGlide: { fromCourseDeg: 200, t0: t0 + 1000, rateDps: 4 },
    }),
    icon('straight', {
      motion: {
        kind: 'arc',
        fix,
        t0,
        speedMps: 80,
        trackDeg: 45,
        turnRateDps: 0.003,
        minDtS: 0,
        maxDtS: 60,
      },
      courseGlide: { fromCourseDeg: 90, t0, rateDps: 0 },
    }),
    // An exact half turn: either way is a turn; both read the same one.
    icon('half', {
      motion: { kind: 'hold', courseDeg: 0.7 },
      courseGlide: { fromCourseDeg: 180.7, t0, rateDps: 10 },
    }),
  ];
  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:shared', motionClock: { kind: 'scene' } });
  set.set(items);
  const { position, course } = rows(part, 'gpu:shared');
  for (const item of items)
    for (const dt of [
      -40_000, -1000, 0, 1, 1500, 2001, 5000, 30_000, 200_000,
    ]) {
      const t = t0 + dt;
      const drawnAt = position(item.id, t);
      const shared = iconPosition(item, t);
      assert.ok(
        distance(drawnAt, shared) < 0.1,
        `${item.id} at ${dt} ms: ${distance(drawnAt, shared)} m apart`,
      );
      const turn = Math.abs(
        ((course(item.id, t) - iconCourse(item, t) + 540) % 360) - 180,
      );
      assert.ok(turn < 1e-3, `${item.id} at ${dt} ms: ${turn}° apart`);
    }
});

test('a row takes its item’s motion changed in place', () => {
  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:in-place' });
  const motion = { kind: 'hold', courseDeg: 0 };
  const item = icon('a', { motion, rotationMode: 'course' });
  set.set([item]);
  motion.courseDeg = 90;
  set.upsert([item]);
  const { course } = rows(part, 'gpu:in-place');
  assert.ok(
    Math.abs(course('a', Date.now()) - 90) < 0.01,
    'the written copy is not the item, so the change is seen',
  );
});

test('GPU icons take blobs and keyed canvases into the atlas, an atlas slot of each too', async () => {
  const { iconAtlas } = await import('../../data/iconAtlas.js');
  const { part, draw } = drawOver();
  const blob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], {
    type: 'image/svg+xml',
  });
  const canvas = { width: 16, height: 16 };
  draw.atlas('gpu:kinds', { blob: { blob }, canvas: { canvas, key: 'sq' } });
  const set = draw.icons({ id: 'gpu:kinds' });
  const moving = { motion: { kind: 'hold' }, size: [20, 20] };
  set.set([
    icon('blob', { image: { blob }, ...moving }),
    icon('canvas', { image: { canvas, key: 'sq' }, ...moving }),
    icon('atlas-blob', {
      image: { atlas: 'gpu:kinds', slot: 'blob' },
      ...moving,
    }),
    icon('atlas-canvas', {
      image: { atlas: 'gpu:kinds', slot: 'canvas' },
      ...moving,
    }),
  ]);
  const { set: rowsOf } = rows(part, 'gpu:kinds');
  const far = (id) => rowsOf.imageFar(rowsOf.row(id));
  assert.ok(far('blob') >= 0 && far('canvas') >= 0);
  assert.notEqual(far('blob'), far('canvas'));
  assert.equal(far('atlas-blob'), far('blob'), 'one slot per blob');
  assert.equal(far('atlas-canvas'), far('canvas'), 'one slot per canvas key');
  assert.ok(iconAtlas.has('\u0000key\u0000sq', 20), 'the canvas by its key');
  assert.throws(
    () => set.upsert([icon('bad', { image: { nope: 1 }, ...moving })]),
    /an image is a URL, SVG, blob, keyed canvas or atlas slot/,
  );
  assert.equal(set.size(), 4, 'refused, changing nothing');
  set.dispose();
});

test('an SVG takes the atlas at its own size, other images at the item’s', async () => {
  const { iconAtlas } = await import('../../data/iconAtlas.js');
  const { svgRasterPx } = await import('./gpuIcons.js');
  const svg = (w, h, extra = '') =>
    `<svg xmlns="http://www.w3.org/2000/svg" ${extra} width="${w}" height="${h}" viewBox="0 0 10 10"><rect stroke-width="9"/></svg>`;
  const b64 = (text) => 'data:image/svg+xml;base64,' + btoa(text);
  const enc = (text) =>
    'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
  assert.equal(svgRasterPx(b64(svg(192, 192, 'stroke-width="3"'))), 192);
  assert.equal(
    svgRasterPx(
      enc(
        `<!-- <svg width="4096" height="4096"> -->${svg(32, 32, 'data-x="a>b"')}`,
      ),
    ),
    32,
    'the root, past comments and quoted >',
  );
  assert.equal(svgRasterPx(enc(svg(1024, 1024))), 256, 'at most 256 px');
  assert.equal(svgRasterPx(enc(svg('48px', 30))), 48, 'px, the larger side');
  assert.equal(svgRasterPx(enc(svg('50%', 30))), null, 'not pixels');
  assert.equal(
    svgRasterPx(enc('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    null,
    'no size',
  );
  assert.equal(svgRasterPx('ship.png'), null);
  assert.equal(svgRasterPx('data:image/svg+xml;base64,@@@'), null);

  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:raster' });
  const far = b64(svg(64, 64));
  const near = b64(svg(192, 192));
  set.set([
    icon('a', {
      image: far,
      size: [20, 20],
      imageLod: { near, switchPx: 30 },
      motion: { kind: 'hold' },
    }),
    icon('b', {
      image: 'gpu-raster.png',
      size: [24, 18],
      motion: { kind: 'hold' },
    }),
    icon('c', {
      image: { svg: svg(40, 40) },
      size: [20, 20],
      motion: { kind: 'hold' },
    }),
  ]);
  const { set: rowsOf } = rows(part, 'gpu:raster');
  const a = rowsOf.row('a');
  assert.ok(iconAtlas.has(far, 64) && iconAtlas.has(near, 192));
  assert.equal(rowsOf.imageFar(a), iconAtlas.slot(far, 64), 'far at 64 px');
  assert.equal(rowsOf.imageNear(a), iconAtlas.slot(near, 192), 'near at 192');
  assert.equal(rowsOf.width(a), 20, 'drawn at its size');
  assert.equal(
    rowsOf.imageFar(rowsOf.row('b')),
    iconAtlas.slot('gpu-raster.png', 24),
    'a URL at the item’s larger side',
  );
  assert.ok(
    iconAtlas.has(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg(40, 40))}`,
      40,
    ),
    'an svg ref at its own',
  );
});

test('an image switch in CSS pixels stands for the aircraft layers’ 76 device pixels', async () => {
  const { NEAR_IMAGE_DEVICE_PX, nearImageSwitchPx } =
    await import('../../data/iconAtlas.js');
  assert.equal(NEAR_IMAGE_DEVICE_PX, 76);
  assert.equal(nearImageSwitchPx(2), 38);
  const display = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 2;
  try {
    assert.equal(
      nearImageSwitchPx(),
      76,
      'the scene’s ratio, not the display’s',
    );
  } finally {
    globalThis.devicePixelRatio = display;
  }
  assert.equal(nearImageSwitchPx(0), 76, 'no ratio: 1');
  assert.equal(nearImageSwitchPx(NaN), 76);
  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:switch-px' });
  set.set([
    icon('a', {
      motion: { kind: 'hold' },
      imageLod: { near: 'near.png', switchPx: nearImageSwitchPx(2) },
    }),
  ]);
  const { set: rowsOf } = rows(part, 'gpu:switch-px');
  // Stored as given: the shader (not run here) switches past it in CSS
  // pixels, the drawn width over the scene's pixel ratio.
  assert.equal(rowsOf.imageSwitch(rowsOf.row('a')), 38);
});

test('the atlas holds more than 64 images, every one addressed on WebGL 2', async () => {
  const { addressableIconSlots, MIN_ICON_SLOTS } =
    await import('../../data/iconAtlas.js');
  assert.ok(MAX_ICON_SLOTS > 64);
  assert.equal(addressableIconSlots(256), MAX_ICON_SLOTS, 'WebGL 2’s least');
  assert.equal(addressableIconSlots(4096), MAX_ICON_SLOTS);
  assert.equal(addressableIconSlots(128), MIN_ICON_SLOTS, 'WebGL 1’s least');
  assert.equal(addressableIconSlots(200), 120);
  const { contextIconSlots } = await import('./iconSetPrimitive.js');
  const limits = Cesium.ContextLimits;
  const vectors = limits._maximumVertexUniformVectors;
  try {
    limits._maximumVertexUniformVectors = 4095;
    assert.equal(contextIconSlots({}), MAX_ICON_SLOTS);
    limits._maximumVertexUniformVectors = 128;
    assert.equal(contextIconSlots({}), MIN_ICON_SLOTS);
  } finally {
    limits._maximumVertexUniformVectors = vectors;
  }
  assert.equal(contextIconSlots(undefined), MAX_ICON_SLOTS, 'no context');
  // A scene whose context addresses fewer refuses past them, as before.
  const small = drawOver();
  // (No context created here: ContextLimits leave the least.)
  small.scene.context = {};
  const tight = small.draw.icons({ id: 'gpu:tight-context' });
  assert.throws(
    () =>
      tight.set(
        Array.from({ length: MIN_ICON_SLOTS + 1 }, (_, i) =>
          icon(`t${i}`, { image: `tight-${i}.png`, motion: { kind: 'hold' } }),
        ),
      ),
    /no room for .* \(at most 64 in all\)/,
  );
  assert.equal(addressableIconSlots(0), MIN_ICON_SLOTS, 'no context yet');
  assert.equal(addressableIconSlots(NaN), MIN_ICON_SLOTS);
  // A set of more images than 64 is drawn, not refused.
  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:many-images' });
  const items = Array.from({ length: 70 }, (_, i) =>
    icon(`i${i}`, { image: `many-${i}.png`, motion: { kind: 'hold' } }),
  );
  set.set(items);
  const { set: rowsOf } = rows(part, 'gpu:many-images');
  assert.equal(rowsOf.count, 70);
  const slots = new Set(
    items.map((item) => rowsOf.imageFar(rowsOf.row(item.id))),
  );
  assert.equal(slots.size, 70, 'each its own slot');
});

test('a GPU icon set asks the frame port for its atlas frames, under its own reason', async () => {
  const { iconAtlas } = await import('../../data/iconAtlas.js');
  const onChange = iconAtlas.onChange;
  const heard = [];
  iconAtlas.onChange = (listener) => (heard.push(listener), () => {});
  try {
    const reasons = [];
    const { scene, draw } = drawOver({
      requestRender: (reason) => reasons.push(reason),
    });
    const set = draw.icons({ id: 'gpu:reason' });
    set.set([icon('a', { motion: { kind: 'hold' } })]);
    assert.equal(heard.length, 1, 'its host listens for packed images');
    const before = scene.renders;
    heard[0]();
    assert.deepEqual(reasons, ['icons:gpu:reason']);
    assert.equal(scene.renders, before, 'through the frame port only');
    set.dispose();

    // With no frame port, the scene's own request, as before.
    const bare = drawOver();
    const bareSet = bare.draw.icons({ id: 'gpu:bare' });
    bareSet.set([icon('a', { motion: { kind: 'hold' } })]);
    assert.equal(heard.length, 2);
    const was = bare.scene.renders;
    heard[1]();
    assert.equal(bare.scene.renders, was + 1);
    bareSet.dispose();
  } finally {
    iconAtlas.onChange = onChange;
  }
});

test('a live motion clock reads the date the draw port is given', () => {
  const t0 = Date.UTC(2031, 0, 2, 3, 4, 5);
  let date = t0 + 4000;
  const { part, draw } = drawOver({ date: () => date });
  const set = draw.icons({
    id: 'gpu:dated',
    motionClock: { kind: 'live', delayMs: 1000 },
  });
  const to = ecef(Cesium.Cartesian3.fromDegrees(4.2, 51.95, 2));
  const item = icon('a', {
    motion: { kind: 'lerp', from: ecef(AT), to, t0, t1: t0 + 10_000 },
  });
  set.set([item]);
  const at = (ms) => iconPosition(item, ms);
  assert.ok(
    distance(part.drawnPosition({ set: 'gpu:dated', id: 'a' }), at(t0 + 3000)) <
      0.1,
  );
  date = t0 + 8000;
  assert.ok(
    distance(part.drawnPosition({ set: 'gpu:dated', id: 'a' }), at(t0 + 7000)) <
      0.1,
  );
});
