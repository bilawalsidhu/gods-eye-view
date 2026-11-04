import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createFlightState } from './state.js';
import { createIcons } from './icons.js';
import { createIconSet } from '../../data/iconSet.js';
import { writeHoldSegment } from '../../data/iconSegment.js';

function services(focus = {}) {
  return {
    focus: { focusPassIsNeeded: () => true, ...focus },
    groundSnap: { createGroundSnap: () => ({ clear() {}, forget() {} }) },
  };
}

function setup({ focus, motion = {}, rendering = {} } = {}) {
  const svc = services(focus);
  const flightState = createFlightState({ services: svc });
  flightState._icons = createIconSet();
  const parts = {
    motion,
    rendering: { _modelOwnsVisual: () => false, ...rendering },
  };
  const icons = createIcons({ flightState, services: svc, parts });
  return { flightState, icons, set: flightState._icons };
}

function hold(set, id, position, course = 0) {
  const row = set.add(id, { layer: 'flights', id });
  writeHoldSegment(set.segments, row, position, course);
  set.segmentWritten(row);
  return row;
}

const at = (lon, h = 1000) => Cesium.Cartesian3.fromDegrees(lon, 30, h);

test('focus advances for drawn rows and for rows a fleet model draws for', () => {
  const advanced = [];
  const { flightState, icons, set } = setup({
    focus: {
      nearFarScalarValueAtDistance: () => 1,
      advanceProjectedSpriteFocus(meta) {
        advanced.push(meta.id);
        return { factor: 0.4, active: true };
      },
    },
  });
  set.setShown(hold(set, 'drawn', at(0)), true);
  const modeled = hold(set, 'modeled', at(0.1));
  hold(set, 'hidden', at(0.2));
  flightState._models.set('modeled', {});

  icons._focusIcons(0, {}, { positionWC: at(0, 50_000) }, 0, {});
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
  const tau = icons._displayTau();
  assert.ok(Cesium.Cartesian3.distance(set.position(row, tau), floored) < 0.01);
  assert.ok(Math.abs(set.course(row, tau) - 123) < 1e-3, 'tracked nose kept');
  assert.ok(flightState._floorPinned.has('g'), 'pinned on the new floor');
});

test('a contact that comes back dimmed re-arms the idle focus pass', () => {
  const advanced = [];
  const { flightState, icons, set } = setup({
    focus: {
      focusPassIsNeeded: (target, active) => target != null || active > 0,
      nearFarScalarValueAtDistance: () => 1,
      advanceProjectedSpriteFocus(meta) {
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
  icons._focusIcons(0, {}, { positionWC: at(0, 50_000) }, 0, null);
  assert.deepEqual(advanced, ['was-tracked']);
  assert.equal(set.focus(row), 1);
});
