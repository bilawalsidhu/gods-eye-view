import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { createCesiumDraw } from './draw.js';
import { drawHitOf } from './drawHit.js';
import { IconSetPrimitive } from '../../data/iconSetPrimitive.js';
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
  assert.equal(host.drawSetId, 'gpu:switch', 'named for sprite ordering');
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

test('an item’s look goes into its row: size, scale, tint, focus, flags, proxy, depth and images', () => {
  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:look', horizonCull: true });
  set.set([
    icon('a', {
      motion: { kind: 'hold', courseDeg: 10 },
      size: [20, 24],
      scale: 1.5,
      alpha: 0.5,
      color: [1, 0, 0, 1],
      focus: 0.25,
      recede: true,
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
  set.upsert([
    icon('a', { motion: { kind: 'hold' }, meta: { n: 2 }, lodGroup: 'g' }),
  ]);
  assert.deepEqual(drawHitOf(picked).meta, { n: 2 });
  assert.equal(drawHitOf(picked).lodGroup, 'g');
});

test('a course glides at its rate with courseGlide, and eases over courseBlendMs without it', () => {
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

  // Without the capability: the blend over courseBlendMs instead.
  const without = drawOver({
    capabilities: new Set(['motionSegments', 'columns']),
  });
  const blended = without.draw.icons({ id: 'gpu:blend' });
  const blend = (courseDeg) =>
    icon('a', {
      motion: { kind: 'hold', courseDeg },
      courseBlendMs: 2000,
      courseGlide: { fromCourseDeg: 180, t0, rateDps: 1 },
    });
  blended.set([blend(0)]);
  const r = rows(without.part, 'gpu:blend');
  assert.ok(
    Math.abs(r.course('a', Date.now())) < 0.01,
    'new: on course at once, its glide ignored',
  );
  blended.upsert([blend(60)]);
  const at = Date.now();
  assert.ok(Math.abs(r.course('a', at + 1000) - 30) < 1, 'halfway at 1 s');
  assert.ok(Math.abs(r.course('a', at + 2500) - 60) < 0.01, 'there by 2 s');
});

test('without motionSegments, motion is ignored: billboards at the item’s place', () => {
  const { scene, draw } = drawOver({ capabilities: new Set() });
  const set = draw.icons({ id: 'gpu:none' });
  set.set([icon('a', { motion: { kind: 'hold' } })]);
  assert.ok(scene.added[0] instanceof Cesium.BillboardCollection);
  assert.equal(set.setColumns, undefined, 'no columns either');
});

test('GPU icon sets refuse what they cannot draw, changing nothing', () => {
  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:refuse' });
  set.set([icon('a', { motion: { kind: 'hold' } })]);
  for (const extra of [
    { height: 'clampGround' },
    { fadeByDistance: { near: 1, nearValue: 1, far: 2, farValue: 0 } },
    { displayRange: [0, 10] },
    { pixelOffset: { x: 1, y: 0 } },
    { eyeOffset: { x: 0, y: 0, z: 5 } },
    { anchor: 'bottom' },
    { rotationMode: 'axis' },
    { rotationMode: 'screen', rotation: 1 },
    { image: { blob: {} } },
  ])
    assert.throws(
      () => set.upsert([icon('b', { motion: { kind: 'hold' }, ...extra })]),
      /GPU icons have no/,
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
  // A course blend under way: frames until it ends.
  set.set([
    icon('a', { motion: { kind: 'hold', courseDeg: 0 }, courseBlendMs: 2000 }),
  ]);
  set.upsert([
    icon('a', { motion: { kind: 'hold', courseDeg: 50 }, courseBlendMs: 2000 }),
  ]);
  const blending = scene.renders;
  part.afterRender();
  assert.equal(scene.renders, blending + 1, 'blending: another frame');
});

test('a course blend goes on through writes that keep its course, columns that only hide included', () => {
  const { part, draw } = drawOver({
    capabilities: new Set(['motionSegments', 'columns']),
  });
  const set = draw.icons({ id: 'gpu:blend-keep' });
  const item = (courseDeg) =>
    icon('a', { motion: { kind: 'hold', courseDeg }, courseBlendMs: 2000 });
  set.set([item(0)]);
  set.upsert([item(60)]);
  const at = Date.now();
  const r = rows(part, 'gpu:blend-keep');
  const halfway = r.course('a', at + 1000);
  // The same course again, then a column that only hides and shows it.
  set.upsert([{ ...item(60), alpha: 0.5 }]);
  set.setColumns({ ids: ['a'], shown: new Uint8Array([1]) });
  assert.ok(
    Math.abs(r.course('a', at + 1000) - halfway) < 1,
    'not restarted from where it is now',
  );
  assert.ok(Math.abs(r.course('a', at + 2500) - 60) < 0.01, 'there by 2 s');
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

test('a course blend alone moves a set onto the GPU only when all of it can go', () => {
  const { scene, part, draw } = drawOver();
  const stays = draw.icons({ id: 'gpu:blend-stays' });
  stays.set([icon('a', { anchor: 'bottom', courseBlendMs: 500 })]);
  assert.equal(part.sets.get('gpu:blend-stays').gpu, undefined, 'billboards');
  const goes = draw.icons({ id: 'gpu:blend-goes' });
  goes.set([icon('a', { courseBlendMs: 500 })]);
  assert.ok(part.sets.get('gpu:blend-goes').gpu, 'on the GPU');
  // A blend GPU icons do not draw is refused, not ignored.
  const additive = draw.icons({ id: 'gpu:additive', blend: 'additive' });
  assert.throws(
    () => additive.set([icon('a', { motion: { kind: 'hold' } })]),
    /additive blend/,
  );
  assert.ok(scene.added.length >= 2);
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

test('a course blend starts from the course shown, as the shared evaluator reads it', () => {
  const t0 = Date.now();
  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:blend-parity' });
  const motion = { kind: 'hold', courseDeg: 0 };
  const item = (courseDeg) =>
    icon('a', {
      motion: { ...motion, courseDeg },
      rotationMode: 'course',
      courseBlendMs: 4000,
    });
  set.set([item(0)]);
  set.upsert([item(80)]);
  const { course } = rows(part, 'gpu:blend-parity');
  // Partway through, a new course: the next blend starts where this one is.
  const before = course('a', Date.now());
  set.upsert([item(150)]);
  const at = Date.now();
  const turn = (x, y) => Math.abs(((x - y + 540) % 360) - 180);
  assert.ok(
    turn(course('a', at), before) < 0.5,
    `no jump: ${before} then ${course('a', at)}`,
  );
  assert.ok(Math.abs(course('a', at + 10_000) - 150) < 0.01, 'then there');
  assert.ok(at - t0 < 4000, 'the test ran inside the first blend');
});

test('a row keeps the course it showed when its item’s motion is changed in place', () => {
  const { part, draw } = drawOver();
  const set = draw.icons({ id: 'gpu:in-place' });
  const motion = { kind: 'hold', courseDeg: 0 };
  const item = icon('a', {
    motion,
    rotationMode: 'course',
    courseBlendMs: 2000,
  });
  set.set([item]);
  motion.courseDeg = 90;
  set.upsert([item]);
  const { course } = rows(part, 'gpu:in-place');
  const at = Date.now();
  assert.ok(
    course('a', at) < 1,
    `blends from 0, not from 90: ${course('a', at)}`,
  );
  assert.ok(Math.abs(course('a', at + 2500) - 90) < 0.01, 'there by 2 s');
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
  const { contextIconSlots } = await import('../../data/iconSetPrimitive.js');
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
