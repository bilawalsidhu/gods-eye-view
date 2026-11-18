import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createFlightState } from './state.js';
import { createIcons } from './icons.js';
import { createContactIcons } from '../../data/aircraftIconLayer.js';
import { layerPlacement } from '../../data/placementProvider.js';
import {
  aircraftMotionRegime,
  createMotionRegime,
  fixEpochMs,
} from '../../data/aircraftMotionRegime.js';
import { mergeAircraftTimelineFixes } from '../../data/timelineHistory.js';
import { julianFromEpochMs } from '../../geo/julian.js';
import { TIMELINE_UNSEEN_MS } from '../../time/timelineFixes.js';

function services(focus = {}) {
  return {
    focus: {
      focusPassIsNeeded: () => true,
      focusAlphaNeedsWrite: (a, b) => Math.abs(a - b) > 1e-3,
      spriteFocusAtRest: () => false,
      ...focus,
    },
    groundSnap: { createGroundSnap: () => ({ clear() {}, forget() {} }) },
  };
}

function setup({ focus, motion = {}, rendering = {}, placement = null } = {}) {
  const svc = {
    ...services(focus),
    ...(placement ? { placement: layerPlacement(placement, 'aircraft') } : {}),
  };
  const flightState = createFlightState({ services: svc });
  flightState._icons = createContactIcons();
  const parts = {
    motion: {
      _displayTimeAt: (ms) => Cesium.JulianDate.fromDate(new Date(ms)),
      _fixEpochMs: (fix) => Cesium.JulianDate.toDate(fix.time).getTime(),
      ...motion,
    },
    rendering: { _modelOwnsVisual: () => false, ...rendering },
  };
  const icons = createIcons({ flightState, services: svc, parts });
  return { flightState, icons, set: flightState._icons };
}

function hold(set, id, position, course = 0, show = false) {
  set.put(
    {
      id,
      pos: { x: position.x, y: position.y, z: position.z },
      motion: { kind: 'hold', courseDeg: course },
      course,
      size: [20, 20],
      scale: 1,
      show,
      focus: 1,
      meta: { layer: 'flights', id },
    },
    { expiresAt: Infinity },
  );
  return id;
}

const at = (lon, h = 1000) => Cesium.Cartesian3.fromDegrees(lon, 30, h);

test('focus advances for drawn rows and for rows a fleet model draws for', () => {
  const advanced = [];
  const { flightState, icons, set } = setup({
    focus: {
      nearFarScalarValueAtDistance: () => 1,
      advanceSpriteFocus(meta) {
        advanced.push(meta.id);
        return { factor: 0.4, active: true };
      },
    },
  });
  hold(set, 'drawn', at(0), 0, true);
  const modeled = hold(set, 'modeled', at(0.1));
  hold(set, 'hidden', at(0.2));
  flightState._models.set('modeled', {});

  icons._focusIcons(0, 0, {});
  assert.deepEqual(advanced, ['drawn', 'modeled']);
  assert.ok(
    Math.abs(set.focus(modeled) - 0.4) < 1e-6,
    "the model's alpha reads it",
  );
  assert.equal(flightState._iconFocusActive, 2);
});

test('settling a pinned grounded contact re-floors it where it is now, nose kept', () => {
  const taxied = at(0.01, 100);
  const floored = at(0.01, 131.5);
  const { flightState, icons, set } = setup({
    motion: {
      _motionRegime: () => ({
        kind: 'fix',
        fix: { position: taxied, time: Cesium.JulianDate.now() },
        speed: 0,
        heading: 200,
        turnRateDps: 0,
        minDt: -60,
        maxDt: 60,
      }),
      _deadReckon(icao24, result) {
        flightState._drCourseDeg = 200;
        flightState._drSpeedMps = 0;
        flightState._drCourseHold = true;
        return Cesium.Cartesian3.clone(taxied, result);
      },
      _floorGroundedDisplayPosition: () => floored,
    },
  });
  // Pinned before it was tracked, 1 km back, facing 10°.
  const row = hold(set, 'g', at(0, 131.5), 10);
  flightState._floorPinned.add('g');
  flightState._grounded.add('g');
  flightState.records.data.set('g', { onGround: true });
  flightState._positionHistory.set('g', [{}]);

  icons._settleIcon('g', { fromCourseDeg: 123 });
  const t = icons._displayMs();
  assert.ok(Cesium.Cartesian3.distance(set.position(row, t), floored) < 0.01);
  assert.ok(Math.abs(set.course(row, t) - 123) < 1e-3, 'tracked nose kept');
  assert.ok(flightState._floorPinned.has('g'), 'pinned on the new floor');
});

test('a contact that comes back dimmed re-arms the idle focus pass', () => {
  const advanced = [];
  const { flightState, icons, set } = setup({
    focus: {
      focusPassIsNeeded: (target, active) => target != null || active > 0,
      nearFarScalarValueAtDistance: () => 1,
      advanceSpriteFocus(meta) {
        advanced.push(meta.id);
        return { factor: 1, active: false, transitioning: false };
      },
    },
    motion: { _motionRegime: () => null },
  });
  const row = hold(set, 'was-tracked', at(0));
  set.setFocus(row, 0.2);
  flightState._iconFocusActive = 0;
  icons._settleIcon('was-tracked');
  set.setShown(row, true);
  icons._focusIcons(0, 0, null);
  assert.deepEqual(advanced, ['was-tracked']);
  assert.equal(set.focus(row), 1);
});

// Upstream re-reckoned contacts hidden behind the horizon only one fleet tick
// in 13. Here no contact's motion waits on a tick: a row's position is its
// motion at the instant drawn, hidden or not, and a hidden row's ended motion
// is planned again with every other. Shown again, it is where dead reckoning
// puts it now, not where it was hidden.
test('a hidden contact shown again is where dead reckoning puts it now', (t) => {
  const t0 = Date.UTC(2026, 10, 9, 12);
  t.mock.timers.enable({ apis: ['Date'], now: t0 });
  const a = at(0);
  const b = at(0.01);
  const fix = (position, ms) => ({
    position,
    time: Cesium.JulianDate.fromDate(new Date(ms)),
  });
  const coastMps = 250;
  const { flightState, icons, set } = setup({
    motion: {
      // Shown at the first fix when first planned 2 s on: it eases onto the
      // path toward where it is on it then.
      _deadReckon: () => null,
      _displayTimeAt: (ms) => Cesium.JulianDate.fromDate(new Date(ms)),
      // Between the two fixes until the newer one, then a coast past it.
      _motionRegime: (_history, _info, renderTime) => {
        const ms = Cesium.JulianDate.toDate(renderTime).getTime();
        return ms < t0 + 10_000
          ? {
              kind: 'between',
              a: fix(a, t0),
              b: fix(b, t0 + 10_000),
              span: 10,
              speed: 100,
              trackFrom: 90,
              trackTo: 90,
              chordCourse: 90,
              blend: 1,
            }
          : {
              kind: 'fix',
              fix: fix(b, t0 + 10_000),
              speed: coastMps,
              heading: 90,
              turnRateDps: 0,
              minDt: -60,
              maxDt: 120,
            };
      },
    },
  });
  const delay = Date.now() - icons._displayMs();
  t.mock.timers.setTime(t0 + delay + 2_000);
  hold(set, 'c', a, 90, true);
  flightState._positionHistory.set('c', [{}, {}]);
  flightState.records.data.set('c', {});
  // Planned between the fixes, then hidden at 2 s.
  icons._planIcon('c');
  set.setShown('c', false);
  const hiddenAt = set.position('c', icons._displayMs());
  // 40 s later: the between motion ended while hidden and is planned again.
  t.mock.timers.setTime(t0 + delay + 42_000);
  const now = icons._displayMs();
  assert.deepEqual([...set.due(now)], ['c'], 'its motion ended while hidden');
  icons._replanExpired(now);
  assert.deepEqual([...set.due(now)], [], 'planned again though hidden');
  set.setShown('c', true);
  const shown = set.position('c', now);
  // On the coast: 32 s past the newer fix at 250 m/s.
  const travelled = Cesium.Cartesian3.distance(b, shown);
  assert.ok(
    Math.abs(travelled - 32 * coastMps) < 50,
    `coasted ${travelled.toFixed(0)} m past the fix`,
  );
  assert.ok(
    Cesium.Cartesian3.distance(hiddenAt, shown) > 8_000,
    'not where it was hidden',
  );
});

test('a live contact a placement places is drawn along where it places it', (t) => {
  const t0 = Date.UTC(2026, 10, 9, 12);
  t.mock.timers.enable({ apis: ['Date'], now: t0 });
  const asked = [];
  let places = true;
  const regimes = [];
  const { flightState, icons, set } = setup({
    placement: {
      layer: () => ({
        place(id, wallMs) {
          asked.push(wallMs);
          if (!places) return null;
          // A degree of longitude every 10 s, at its own height and course.
          return {
            lat: 30,
            lon: (wallMs - t0) / 10_000,
            altitudeM: 2000,
            courseDeg: 90 + (wallMs - t0) / 1000,
            speedMps: 200,
          };
        },
      }),
    },
    motion: {
      _motionRegime: () => {
        regimes.push(1);
        return {
          kind: 'fix',
          fix: { position: at(5), time: null },
          speed: 0,
          heading: 10,
        };
      },
      _fixEpochMs: () => t0,
    },
  });
  hold(set, 'p', at(0), 0, true);
  flightState._positionHistory.set('p', [{ position: at(0) }]);
  flightState.records.data.set('p', { renderAltitudeM: 1000 });
  const now = icons._displayMs();
  const leadMs = Date.now() - now;
  icons._planIcon('p');
  // Asked for the wall times the segment's ends stand for.
  assert.deepEqual(asked, [now + leadMs, now + 1000 + leadMs]);
  assert.equal(regimes.length, 0, 'its own motion is not planned');
  const item = set.item('p');
  assert.equal(item.motion.kind, 'lerp');
  assert.ok(
    Cesium.Cartesian3.distance(
      item.motion.from,
      Cesium.Cartesian3.fromDegrees((now + leadMs - t0) / 10_000, 30, 2000),
    ) < 1e-6,
  );
  assert.ok(
    Cesium.Cartesian3.distance(
      item.motion.to,
      Cesium.Cartesian3.fromDegrees(
        (now + 1000 + leadMs - t0) / 10_000,
        30,
        2000,
      ),
    ) < 1e-6,
  );
  assert.equal(item.motion.t0, now);
  assert.equal(item.motion.t1, now + 1000);
  assert.ok(Math.abs(item.motion.courseSlopeDeg - 1) < 1e-9);
  assert.equal(set.expires('p'), now + 1000);

  // No answer: the layer's own motion plans it.
  places = false;
  icons._planIcon('p');
  assert.equal(regimes.length, 1);
  assert.equal(set.item('p').motion.kind, 'hold');

  // Following the world clock, the placement is not asked.
  places = true;
  asked.length = 0;
  flightState.timeline = { active: () => true };
  icons._planIcon('p');
  assert.deepEqual(asked, []);
});

/**
 * A layer following the world clock at `world.ms`, its contacts placed by
 * the shared regime on their own fixes around the time.
 */
function clockSetup(world) {
  const fields = { speed: 'velocity', track: 'true_track' };
  const { flightState, icons, set } = setup({
    motion: {
      _displayTimeAt: (ms) => julianFromEpochMs(ms),
      _fixEpochMs: fixEpochMs,
      _deadReckon: () => null,
      _motionRegime: (history, info, renderTime) =>
        aircraftMotionRegime(
          history,
          info,
          renderTime,
          fields,
          createMotionRegime(),
        ),
    },
  });
  flightState.timeline = { active: () => true };
  flightState.now = () => world.ms;
  return { flightState, icons, set };
}

/** A contact's row, never planned, and its own fixes at `times` (ms). */
function onFixes(flightState, set, id, times) {
  set.put(
    {
      id,
      pos: { x: 0, y: 0, z: 0 },
      motion: { kind: 'hold', courseDeg: 0 },
      course: 0,
      size: [20, 20],
      show: true,
      focus: 1,
      meta: { layer: 'flights', id },
    },
    { expiresAt: -Infinity },
  );
  flightState.records.data.set(id, { velocity: 100 });
  const history = mergeAircraftTimelineFixes(
    [],
    {
      fixes: times.map((atMs, i) => ({
        atMs,
        lat: 30,
        lon: i * 0.05,
        altitudeM: null,
      })),
    },
    { renderAltitudeM: 3_000 },
    100,
    times[0],
  );
  flightState._positionHistory.set(id, history);
  return history;
}

test('following the clock, a contact is not drawn before it was there, and is from its warm-up on', () => {
  const first = Date.UTC(2026, 10, 9, 12);
  const world = { ms: first - 10 * 60_000 };
  const { flightState, icons, set } = clockSetup(world);
  onFixes(flightState, set, 'c', [first, first + 60_000]);
  icons._planIcon('c');
  assert.equal(set.shown('c'), false, 'ten minutes before its first fix');
  assert.equal(set.expires('c'), first - TIMELINE_UNSEEN_MS);

  // Half a minute before its first fix it is drawn, reaching it.
  world.ms = first - 30_000;
  icons._replanExpired(world.ms);
  assert.equal(set.shown('c'), true);

  // The clock moved back: not there yet again.
  world.ms = first - 5 * 60_000;
  icons._replanExpired(world.ms);
  assert.equal(set.shown('c'), false);
});

test('following the clock, a move back within the fixes draws a contact where it was then', () => {
  const t0 = Date.UTC(2026, 10, 9, 12);
  const world = { ms: t0 + 100_000 };
  const { flightState, icons, set } = clockSetup(world);
  const history = onFixes(flightState, set, 'c', [
    t0,
    t0 + 60_000,
    t0 + 120_000,
  ]);
  icons._planIcon('c');
  icons._replanExpired(world.ms);
  // Back to half way between the first two fixes.
  world.ms = t0 + 30_000;
  icons._replanExpired(world.ms);
  const drawn = set.position('c', world.ms);
  const half = Cesium.Cartesian3.distance(
    history[0].position,
    history[1].position,
  );
  for (const fix of history.slice(0, 2))
    assert.ok(
      Math.abs(Cesium.Cartesian3.distance(drawn, fix.position) - half / 2) <
        half * 0.05,
      'half way between its first two fixes',
    );
});
