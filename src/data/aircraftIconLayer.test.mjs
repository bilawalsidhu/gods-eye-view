import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COAST_FLOOR_LOOKAHEAD_MS,
  createAircraftIcons,
  createContactIcons,
  floorCoastArc,
} from './aircraftIconLayer.js';
import { COAST_FLOOR_LIFT_M } from './motionModel.js';
import { fromDegrees, toCartographicRadians } from '../geo/ellipsoid.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import { createDisplayDelay } from './displayDelay.js';

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
