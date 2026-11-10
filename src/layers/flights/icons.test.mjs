import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createFlightState } from './state.js';
import { createIcons } from './icons.js';
import { createContactIcons } from '../../data/aircraftIconLayer.js';

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

function setup({ focus, motion = {}, rendering = {} } = {}) {
  const svc = services(focus);
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
