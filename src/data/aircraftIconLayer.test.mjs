import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COAST_FLOOR_LOOKAHEAD_MS,
  createAircraftIcons,
  createContactIcons,
  floorCoastArc,
} from './aircraftIconLayer.js';
import { COAST_FLOOR_LIFT_M, recoveryMs } from './motionModel.js';
import { fromDegrees, toCartographicRadians } from '../geo/ellipsoid.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import { createDisplayDelay } from './displayDelay.js';
import { aircraftIcon, FLEET_ICON_PX } from './aircraftIcons.js';
import { ROTOR_STILL_FRAME } from './rotorFrames.js';

const WORLD_MS = Date.UTC(2026, 10, 1, 12, 0);

test('following the world clock, contacts draw at the world’s time on the scene clock', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: WORLD_MS + 86_400_000 });
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  let following = false;
  const state = {
    _viewer: viewer,
    now: () => (following ? WORLD_MS : Date.now()),
  };
  const icons = createAircraftIcons({
    state,
    services: { focus: { focusPassIsNeeded: () => false } },
    parts: {},
    layerId: 'flights',
    renderDelaySec: 30,
    followsClock: () => following,
    courseMaxDps: 3,
    cockpitContactSizePx: 8,
  });
  icons._createIcons(viewer);
  const set = draw.find('flights-icons:');
  // Live: a poll interval behind real time, on the delayed live clock.
  assert.deepEqual(set.spec.motionClock, { kind: 'live', delayMs: 30_000 });
  assert.equal(icons._displayMs(), Date.now() - 30_000);
  following = true;
  assert.equal(icons._displayMs(), WORLD_MS, 'the world’s time, no delay');
  icons._syncMotionClock();
  assert.deepEqual(set.spec.motionClock, { kind: 'scene' });
  following = false;
  icons._syncMotionClock();
  assert.deepEqual(set.spec.motionClock, { kind: 'live', delayMs: 30_000 });
  icons._disposeIcons();
});

test('as the display delay moves, the renderer’s live clock and the layer’s display time move with it; the world clock ignores it', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: WORLD_MS });
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  let following = false;
  const state = { _viewer: viewer, now: () => Date.now() };
  const delay = createDisplayDelay({ floorMs: 30_000, pollMs: 30_000 });
  const icons = createAircraftIcons({
    state,
    services: { focus: { focusPassIsNeeded: () => false } },
    parts: {},
    layerId: 'flights',
    displayDelay: delay,
    followsClock: () => following,
    courseMaxDps: 3,
    cockpitContactSizePx: 8,
  });
  icons._createIcons(viewer);
  const set = draw.find('flights-icons:');
  assert.deepEqual(set.spec.motionClock, { kind: 'live', delayMs: 30_000 });
  // Reports 90 s old every 30 s: the delay heads for about two minutes.
  for (let i = 0; i < 20; i++)
    delay.noteReport(WORLD_MS, WORLD_MS - 90_000, WORLD_MS - 120_000);
  delay.settle(WORLD_MS);
  t.mock.timers.setTime(WORLD_MS + 10_000);
  icons._syncMotionClock();
  // 10 s at 0.2 s/s: 2 s more, on both the renderer's clock and the layer's.
  assert.deepEqual(set.spec.motionClock, { kind: 'live', delayMs: 32_000 });
  assert.equal(icons._displayMs(), Date.now() - 32_000);
  // Following the world clock: no delay, and it is not moved on meanwhile.
  following = true;
  t.mock.timers.setTime(WORLD_MS + 20_000);
  icons._syncMotionClock();
  assert.deepEqual(set.spec.motionClock, { kind: 'scene' });
  assert.equal(icons._displayMs(), Date.now());
  assert.equal(delay.currentMs, 32_000);
  following = false;
  icons._syncMotionClock();
  assert.deepEqual(set.spec.motionClock, { kind: 'live', delayMs: 34_000 });
  icons._disposeIcons();
});

test('a coasting icon is kept above rising ground, as the CPU coast is', () => {
  const T0 = WORLD_MS;
  let now = T0;
  const cosLat = Math.cos((30 * Math.PI) / 180);
  const metresEast = (lonDeg) => lonDeg * 111_320 * cosLat;
  // A slope rising east from 100 m out, half a metre per metre.
  const ground = (_lat, lon) => Math.max(0, (metresEast(lon) - 100) * 0.5);
  const fix = { epochMs: T0, position: fromDegrees(0, 30, 100) };
  const state = {
    now: () => now,
    _icons: createContactIcons(),
    _positionHistory: new Map([['c', [fix]]]),
    records: { data: new Map([['c', {}]]) },
  };
  const icons = createAircraftIcons({
    state,
    services: {
      focus: { focusPassIsNeeded: () => false },
      groundFloor: { cachedGroundFloor: ground },
    },
    parts: {
      motion: {
        _displayTimeAt: (ms) => ms,
        _fixEpochMs: (f) => f.epochMs,
        // Coasting east past its only fix at 100 m/s, for five minutes.
        _motionRegime: () => ({
          kind: 'fix',
          fix,
          speed: 100,
          heading: 90,
          turnRateDps: 0,
          minDt: -60,
          maxDt: 300,
        }),
      },
    },
    layerId: 'flights',
    renderDelaySec: 30,
    followsClock: () => true,
    courseMaxDps: 3,
    cockpitContactSizePx: 8,
  });
  state._icons.put(
    {
      id: 'c',
      pos: fix.position,
      motion: { kind: 'hold', courseDeg: 90 },
      course: 90,
      size: [20, 20],
    },
    { expiresAt: -Infinity },
  );
  icons._planIcon('c');
  // The fleet pass, every 80 ms for 12 s: the icon never sinks into the
  // slope, and over open ground it coasts level.
  let lowest = Infinity;
  for (now = T0; now <= T0 + 12_000; now += 80) {
    icons._replanExpired(now);
    const p = icons._iconPosition('c');
    const carto = toCartographicRadians(p);
    const floor = ground(0, (carto.lon * 180) / Math.PI) + COAST_FLOOR_LIFT_M;
    lowest = Math.min(lowest, carto.height - floor);
    if (now - T0 <= 2_000)
      assert.ok(Math.abs(carto.height - 100) < 0.1, 'level over open ground');
    assert.ok(Math.abs(icons._iconCourse('c') - 90) < 1e-6, 'nose east');
  }
  assert.ok(lowest > -0.05, `at most 5 cm under the floor (${lowest} m)`);
  // 1.2 km east, the slope is at 550 m: it rode up the slope.
  now = T0 + 12_000;
  icons._replanExpired(now);
  const end = toCartographicRadians(icons._iconPosition('c'));
  const east = metresEast((end.lon * 180) / Math.PI);
  assert.ok(Math.abs(east - 1_200) < 5, `1.2 km east (${east} m)`);
  assert.ok(end.height > 550, `on the slope (${end.height} m)`);
});

test('a coast over known ground that never rises is planned once', () => {
  const fix = { position: fromDegrees(0, 30, 100) };
  const arc = {
    kind: 'arc',
    fix: fix.position,
    t0: 0,
    minDtS: -60,
    maxDtS: 5,
    speedMps: 100,
    trackDeg: 90,
    turnRateDps: 0,
  };
  assert.deepEqual(
    floorCoastArc(arc, 0, () => 0),
    { expiresAt: Infinity },
  );
  assert.deepEqual(
    floorCoastArc(arc, 0, () => null),
    { expiresAt: COAST_FLOOR_LOOKAHEAD_MS },
    'unknown ground is read again',
  );
  assert.equal(
    floorCoastArc({ ...arc, fix: fromDegrees(0, 30, 10_000) }, 0, () => 0),
    null,
    'a cruise above any terrain never reads it',
  );
  // Stopped at the end of its coast, under ground that rose since.
  const held = floorCoastArc(arc, 6_000, () => 200);
  assert.equal(held.motion.kind, 'hold');
  assert.ok(
    Math.abs(toCartographicRadians(held.pos).height - 201.5) < 1e-6,
    'held on the ground where the coast stopped',
  );
});

test('only airborne helicopters in view turn their rotor, written when the frame steps', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: WORLD_MS });
  const here = fromDegrees(0, 30, 300);
  const away = fromDegrees(90, 30, 300);
  const records = new Map([
    ['h1', { klass: 'helicopter', onGround: false }],
    ['h2', { klass: 'helicopter', onGround: true }],
    ['p1', { klass: 'airliner', onGround: false }],
    ['h3', { klass: 'helicopter', onGround: false }],
  ]);
  const state = {
    now: () => Date.now(),
    _icons: createContactIcons(),
    _positionHistory: new Map(),
    _cockpitNearContacts: new Set(),
    records: { data: records, missingPolls: new Map() },
  };
  const icons = createAircraftIcons({
    state,
    services: { focus: { focusPassIsNeeded: () => false } },
    parts: {
      rendering: {
        _iconKind: (_id, klass) => klass,
        _fleetBillboardColor: () => [1, 1, 1, 1],
        _fleetBillboardScale: () => 1,
      },
    },
    layerId: 'flights',
    courseMaxDps: 3,
    cockpitContactSizePx: 8,
  });
  for (const id of records.keys()) {
    state._icons.put(
      {
        id,
        pos: id === 'h3' ? away : here,
        motion: { kind: 'hold', courseDeg: 0 },
        size: [20, 20],
      },
      { expiresAt: Infinity },
    );
    icons._applyIconPresentation(id);
  }
  const image = (id) => state._icons.item(id).image;
  // The grounded helicopter holds the still frame.
  assert.equal(
    image('h2'),
    aircraftIcon('helicopter', FLEET_ICON_PX, ROTOR_STILL_FRAME),
  );
  const h3Before = image('h3');
  const writes = new Map();
  const update = state._icons.update;
  state._icons.update = (id, patch, options) => {
    writes.set(id, (writes.get(id) ?? 0) + 1);
    return update(id, patch, options);
  };
  // The fleet pass, every 80 ms for a second; h3 is out of view.
  const inView = (p) => Math.abs(p.x - here.x) < 1;
  const seen = new Set();
  for (let step = 0; step <= 12; step++) {
    if (step) t.mock.timers.tick(80);
    icons._turnRotors(Date.now(), Date.now(), inView);
    seen.add(image('h1'));
  }
  // Through every frame, written only on the steps its frame changed.
  assert.equal(seen.size, 3);
  for (const frame of [0, 1, 2])
    assert.ok(seen.has(aircraftIcon('helicopter', FLEET_ICON_PX, frame)));
  assert.ok(
    writes.get('h1') >= 8 && writes.get('h1') <= 11,
    `${writes.get('h1')} writes`,
  );
  assert.equal(writes.get('h2') ?? 0, 0, 'grounded: frozen');
  assert.equal(writes.get('p1') ?? 0, 0, 'not a helicopter');
  assert.equal(writes.get('h3') ?? 0, 0, 'out of view');
  assert.equal(image('h3'), h3Before);
  // Landing freezes it on the still frame.
  records.get('h1').onGround = true;
  icons._applyIconPresentation('h1');
  const landed = writes.get('h1');
  t.mock.timers.tick(400);
  icons._turnRotors(Date.now(), Date.now(), inView);
  assert.equal(writes.get('h1'), landed);
  assert.equal(
    image('h1'),
    aircraftIcon('helicopter', FLEET_ICON_PX, ROTOR_STILL_FRAME),
  );
});

/** An icon layer over helicopters `ids`, all at `here`, for the rotor tests. */
function rotorFixture(records, positions, tracking = {}) {
  const state = {
    now: () => Date.now(),
    _icons: createContactIcons(),
    _positionHistory: new Map(),
    _cockpitNearContacts: new Set(),
    records: { data: records, missingPolls: new Map() },
  };
  const icons = createAircraftIcons({
    state,
    services: { focus: { focusPassIsNeeded: () => false } },
    parts: {
      rendering: {
        _iconKind: (_id, klass) => klass,
        _fleetBillboardColor: () => [1, 1, 1, 1],
        _fleetBillboardScale: () => 1,
      },
      tracking,
    },
    layerId: 'flights',
    courseMaxDps: 3,
    cockpitContactSizePx: 8,
  });
  for (const id of records.keys()) {
    state._icons.put(
      {
        id,
        pos: positions[id],
        motion: { kind: 'hold', courseDeg: 0 },
        size: [20, 20],
      },
      { expiresAt: Infinity },
    );
    icons._applyIconPresentation(id);
  }
  return { state, icons };
}

test('a tracked helicopter that lands shows the still frame at once', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: WORLD_MS });
  const records = new Map([['h1', { klass: 'helicopter', onGround: false }]]);
  let synced = 0;
  const { state, icons } = rotorFixture(
    records,
    { h1: fromDegrees(0, 30, 300) },
    { _syncTrackedBillboardImage: () => synced++ },
  );
  state._trackedIcao = 'h1';
  assert.equal(icons._rotorsTurning(), true);
  records.get('h1').onGround = true;
  icons._applyIconPresentation('h1');
  assert.equal(synced, 1, 'the tracked billboard is given its images again');
  assert.equal(icons._rotorsTurning(), false);
  assert.equal(
    icons._fleetLook('h1').image,
    aircraftIcon('helicopter', FLEET_ICON_PX, ROTOR_STILL_FRAME),
  );
  // Taxiing faster than 1 m/s, its rotor turns again, as the model's does.
  records.get('h1').velocity = 5;
  icons._applyIconPresentation('h1');
  assert.equal(icons._rotorsTurning(), true);
  records.get('h1').velocity = 0;
  icons._applyIconPresentation('h1');
  assert.equal(synced, 2);
  assert.equal(icons._rotorsTurning(), false);
  // An untracked one landing does not touch the tracked billboard.
  records.get('h1').onGround = false;
  icons._applyIconPresentation('h1');
  state._trackedIcao = null;
  records.get('h1').onGround = true;
  icons._applyIconPresentation('h1');
  assert.equal(synced, 2);
});

test('a helicopter out of view is judged once per rotor frame, not every pass', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: WORLD_MS });
  const records = new Map();
  const positions = {};
  for (let i = 0; i < 300; i++) {
    const id = `h${i}`;
    records.set(id, { klass: 'helicopter', onGround: false });
    positions[id] = fromDegrees(90, 30, 300);
  }
  const { state, icons } = rotorFixture(records, positions);
  let judged = 0;
  const inView = () => {
    judged++;
    return false;
  };
  const writes = [];
  const update = state._icons.update;
  state._icons.update = (id, ...rest) => {
    writes.push(id);
    return update(id, ...rest);
  };
  // Passes 10 ms apart for 2 s: 200 passes over 300 helicopters, all out of
  // view. Each is judged at most once per frame step (20 steps), and not on
  // a step back onto the frame it is drawn at.
  for (let pass = 0; pass < 200; pass++) {
    t.mock.timers.tick(10);
    icons._turnRotors(Date.now(), Date.now(), inView);
  }
  assert.ok(judged <= 300 * 21, `${judged} judgements`);
  assert.ok(judged >= 300 * 10, `${judged} judgements`);
  assert.equal(writes.length, 0, 'none in view: no image written');
});

test('back at live, a placed contact eases from where it is drawn over a recovery, nose along the way', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: WORLD_MS });
  const drawnAt = fromDegrees(0, 30, 3_000);
  const SPEED = 200;
  // The placement has it 2 km east of where it is drawn, flying east.
  const placedAt = (wallMs) => {
    const east = 2_000 + (SPEED * (wallMs - WORLD_MS)) / 1000;
    return fromDegrees(east / (111_320 * Math.cos(Math.PI / 6)), 30, 3_000);
  };
  const plan = (handover, keep = {}) => {
    const state = {
      now: () => Date.now(),
      _icons: createContactIcons(),
      _positionHistory: new Map([['c', [{ epochMs: WORLD_MS }]]]),
      records: { data: new Map([['c', {}]]) },
    };
    const icons = createAircraftIcons({
      state,
      services: { focus: { focusPassIsNeeded: () => false } },
      parts: {
        motion: { _displayTimeAt: (ms) => ms, _fixEpochMs: (f) => f.epochMs },
      },
      layerId: 'flights',
      courseMaxDps: 3,
      cockpitContactSizePx: 8,
      placeAt: (_id, wallMs, _info, _history, out) => {
        Object.assign(out, placedAt(wallMs));
        return { courseDeg: 90, speedMps: SPEED };
      },
    });
    state._icons.put(
      {
        id: 'c',
        pos: drawnAt,
        motion: { kind: 'hold', courseDeg: 0 },
        course: 0,
        size: [20, 20],
      },
      { expiresAt: -Infinity },
    );
    icons._planIcon('c', handover ? { handover: true } : undefined);
    keep.icons = icons;
    return state._icons;
  };
  const metres = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  const eased = plan(true);
  const end = eased.expires('c');
  assert.equal(end, WORLD_MS + recoveryMs(2_000, SPEED));
  assert.ok(end - WORLD_MS > 1_000, 'longer than a placed plan');
  assert.ok(metres(eased.position('c', WORLD_MS, {}), drawnAt) < 1);
  assert.ok(metres(eased.position('c', end, {}), placedAt(end)) < 1);
  // The nose points along the way from where it is drawn to where it goes.
  assert.ok(Math.abs(eased.course('c', WORLD_MS) - 90) < 1);

  const plain = plan(false);
  assert.ok(
    metres(plain.position('c', WORLD_MS, {}), placedAt(WORLD_MS)) < 1,
    'without the handover it is drawn where it is placed',
  );

  // The next answer comes 15 s in, the ease still running: it eases on from
  // where it is drawn then, not cut to where it is placed.
  const keep = {};
  const easing = plan(true, keep);
  const firstEnd = easing.expires('c');
  assert.ok(firstEnd - WORLD_MS > 15_000, 'an ease longer than a poll');
  t.mock.timers.tick(15_000);
  const at = Date.now();
  const drawnThen = easing.position('c', at, {});
  keep.icons._planIcon('c');
  assert.ok(metres(easing.position('c', at, {}), drawnThen) < 1);
  const reEnd = easing.expires('c');
  assert.ok(reEnd > at + 1_000, 'eases on');
  assert.ok(metres(easing.position('c', reEnd, {}), placedAt(reEnd)) < 1);
  // Once it has caught up, the next answer draws it where it is placed.
  t.mock.timers.tick(reEnd - at + 1);
  keep.icons._planIcon('c');
  assert.ok(
    metres(easing.position('c', Date.now(), {}), placedAt(Date.now())) < 1,
  );
});
