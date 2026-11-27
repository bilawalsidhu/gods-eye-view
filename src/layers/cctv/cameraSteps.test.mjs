// The Data Layers row's ‹ Prev · Next › for Cameras: the walk through the
// cameras nearest the view that voice next/prev take too.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createControls } from './controls.js';
import { createNavigation } from './navigation.js';
import { CCTV_FOCUS_RESULT } from './policy.js';

// Cameras north of the view centre (0, 0), one degree apart, listed out of
// distance order.
const CAMERAS = [
  { id: 'c3', lat: 3, lon: 0 },
  { id: 'c1', lat: 1, lon: 0 },
  { id: 'c4', lat: 4, lon: 0 },
  { id: 'c2', lat: 2, lon: 0 },
];

function rig({ enabled = true, activeId = null, cameras = CAMERAS } = {}) {
  const records = cameras.map((camera) => ({ camera }));
  const state = {
    _enabled: enabled,
    _records: records,
    _recordById: new Map(records.map((r) => [r.camera.id, r])),
    _activeCameraId: activeId,
    _cameraWalk: null,
    _listeners: new Set(),
    _viewer: null,
  };
  const selected = [];
  let eye = { lat: 0, lon: 0 };
  const parts = {
    model: {
      eyePose: () => eye,
      haversineKm: (lat1, lon1, lat2, lon2) =>
        Math.hypot(lat1 - lat2, lon1 - lon2),
    },
    selection: {
      setActiveCamera(id) {
        selected.push(id);
        state._activeCameraId = id;
      },
    },
    presentation: {
      notifyListeners() {
        for (const listener of [...state._listeners]) listener({});
      },
    },
  };
  const context = {
    state,
    services: {
      render: {
        holdContinuousRender() {},
        releaseContinuousRender() {},
      },
      activation: { CCTV_ACTIVATION_RESULT: {} },
    },
    parts,
    source: {},
  };
  parts.navigation = createNavigation(context);
  const { methods } = createControls(context);
  const chip = (id) => methods.getRowControls().chips.find((c) => c.id === id);
  return {
    state,
    methods,
    parts,
    selected,
    chip,
    moveView(at) {
      eye = at;
    },
  };
}

test('next steps through the cameras nearest the view, nearest first', () => {
  const r = rig();
  for (let i = 0; i < 4; i += 1) r.chip('next-camera').onClick();
  assert.deepEqual(r.selected, ['c1', 'c2', 'c3', 'c4']);
  r.chip('next-camera').onClick();
  assert.equal(r.selected.at(-1), 'c1', 'after the last comes the nearest');
});

test('previous steps back along the same order', () => {
  const r = rig({ activeId: 'c3' });
  r.chip('previous-camera').onClick();
  r.chip('previous-camera').onClick();
  assert.deepEqual(r.selected, ['c2', 'c1']);
  r.chip('previous-camera').onClick();
  assert.equal(r.selected.at(-1), 'c4', 'before the nearest is the last');
});

test('a walk keeps its order while flights move the view', () => {
  const r = rig();
  r.chip('next-camera').onClick();
  // Flying to c1 centres the view on it; the walk does not reorder.
  r.moveView({ lat: 1, lon: 0 });
  r.chip('next-camera').onClick();
  r.moveView({ lat: 2, lon: 0 });
  r.chip('previous-camera').onClick();
  assert.deepEqual(r.selected, ['c1', 'c2', 'c1']);
});

test('picking another camera starts a new walk from the view', () => {
  const r = rig();
  r.chip('next-camera').onClick();
  r.state._activeCameraId = 'c4';
  r.moveView({ lat: 4, lon: 0 });
  // Nearest c4 first: next is c3, where the old walk would wrap to c1.
  r.chip('next-camera').onClick();
  assert.deepEqual(r.selected, ['c1', 'c3']);
});

test('a step flies to the camera unless told not to', () => {
  const r = rig();
  const still = r.methods.stepNearbyCamera(1, { focus: false });
  assert.deepEqual(still, { cameraId: 'c1', focusResult: null });
  // With no viewer to fly, the flight reports nothing to frame.
  const flown = r.methods.stepNearbyCamera(1);
  assert.equal(flown.cameraId, 'c2');
  assert.equal(flown.focusResult, CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA);
});

test('the steps are offered only while Cameras is on with cameras to step to', () => {
  assert.equal(rig({ enabled: false }).methods.getRowControls(), null);
  assert.equal(
    rig({ cameras: CAMERAS.slice(0, 1) }).methods.getRowControls(),
    null,
  );
  const chips = rig().methods.getRowControls().chips;
  assert.deepEqual(
    chips.map(({ id, label, icon, action }) => ({ id, label, icon, action })),
    [
      {
        id: 'previous-camera',
        label: 'Previous camera',
        icon: 'chevron_left',
        action: true,
      },
      {
        id: 'next-camera',
        label: 'Next camera',
        icon: 'chevron_right',
        action: true,
      },
    ],
  );
  const off = rig({ enabled: false });
  assert.equal(off.methods.stepNearbyCamera(1), null, 'no step while off');
  assert.deepEqual(off.selected, []);
});

test('a camera gone from the catalog ends the walk instead of selecting it', () => {
  const r = rig();
  r.chip('next-camera').onClick();
  const c2 = r.state._recordById.get('c2');
  r.state._recordById.delete('c2');
  assert.equal(r.methods.stepNearbyCamera(1), null);
  assert.deepEqual(r.selected, ['c1']);
  // The next step starts a new walk from the view: from c4, nearest c4
  // comes first, where the old walk would have gone on to c2.
  r.state._recordById.set('c2', c2);
  r.moveView({ lat: 4, lon: 0 });
  r.chip('next-camera').onClick();
  assert.deepEqual(r.selected, ['c1', 'c4']);
});

test("with Context's Cameras list, a walk steps through that list in its order", () => {
  const r = rig({
    cameras: [...CAMERAS, { id: 'far', lat: 40, lon: 0 }],
  });
  // Context lists the cameras within 2.5 (test units) of (2, 0).
  const area = { lat: 2, lon: 0, radiusKm: 2.5 };
  r.methods.setNearbyArea(area);
  for (let i = 0; i < 5; i += 1) r.chip('next-camera').onClick();
  assert.deepEqual(r.selected, ['c2', 'c3', 'c1', 'c4', 'c2']);
  assert.ok(!r.selected.includes('far'), 'nothing outside the list');
  // With no list, a new walk takes the cameras nearest the view again: from
  // 'far', far then c4, c3, where the list would have started at c2.
  r.methods.setNearbyArea(null);
  r.state._activeCameraId = 'far';
  r.moveView({ lat: 40, lon: 0 });
  r.chip('next-camera').onClick();
  r.chip('next-camera').onClick();
  assert.deepEqual(r.selected.slice(-2), ['c4', 'c3']);
});

test("Prev/Next and auto-hop walk the order Context's card lists", () => {
  const r = rig();
  // The card lists c1..c4 searched and sorted its own way.
  r.methods.setNearbyArea({
    lat: 2,
    lon: 0,
    radiusKm: 2.5,
    order: ['c4', 'c1', 'c3'],
  });
  r.chip('next-camera').onClick();
  r.chip('next-camera').onClick();
  r.chip('previous-camera').onClick();
  assert.deepEqual(r.selected, ['c4', 'c1', 'c4']);
  r.state._autoHop = true;
  r.state._lastHopAt = 0;
  r.state._autoHopSec = 1;
  r.parts.model.currentViewContext = () => 'view';
  r.parts.navigation.maybeAutoHop(10_000);
  assert.equal(r.selected.at(-1), 'c1', 'the hop takes the next listed camera');
});

test('timed hops stay inside a filtered list until it closes', () => {
  const r = rig({ activeId: 'c2' });
  r.state._autoHop = true;
  r.state._autoHopSec = 1;
  r.state._lastHopAt = 0;
  r.parts.model.currentViewContext = () => 'view';
  const area = { lat: 2, lon: 0, radiusKm: 2.5 };
  const hop = (order, now) => {
    r.methods.setNearbyArea({ ...area, order });
    r.parts.navigation.maybeAutoHop(now);
  };
  hop([], 1000);
  hop(['c2'], 2000);
  assert.deepEqual(r.selected, [], 'no other listed camera');
  hop(['c4'], 3000);
  hop(['c4'], 4000);
  assert.deepEqual(r.selected, ['c4'], 'the sole match is selected once');
  hop(['c4', 'removed', 'c1'], 5000);
  assert.deepEqual(
    r.selected,
    ['c4', 'c1'],
    'skip a missing camera within the list',
  );
  hop(null, 6000);
  assert.deepEqual(r.selected, ['c4', 'c1', 'c4'], 'catalog cycling resumes');
});

test('results A/B/C becoming A/C restart the walk; a recentre keeps it', () => {
  const area = { lat: 2, lon: 0, radiusKm: 2.5 };
  const narrowed = rig();
  narrowed.methods.setNearbyArea({ ...area, order: ['c1', 'c2', 'c3'] });
  narrowed.chip('next-camera').onClick();
  assert.deepEqual(narrowed.selected, ['c1']);
  // The search drops B: the next step goes to C, not B.
  narrowed.methods.setNearbyArea({
    ...area,
    order: ['c1', 'c3'],
    restart: true,
  });
  narrowed.chip('next-camera').onClick();
  assert.deepEqual(narrowed.selected, ['c1', 'c3']);
  // A recentre re-sorts the list but keeps the walk under way.
  const moved = rig();
  moved.methods.setNearbyArea({ ...area, order: ['c1', 'c2', 'c3'] });
  moved.chip('next-camera').onClick();
  moved.methods.setNearbyArea({ ...area, lat: 2.1, order: ['c3', 'c1', 'c2'] });
  moved.chip('next-camera').onClick();
  assert.deepEqual(moved.selected, ['c1', 'c2']);
});

test('the steps are withdrawn while the listed cameras offer nowhere to go', () => {
  const { methods, state } = rig({ activeId: 'c1' });
  let repaints = 0;
  state._panel = { invalidate: () => repaints++ };
  const list = (order) =>
    methods.setNearbyArea({ lat: 2, lon: 0, radiusKm: 2.5, order });
  list(['c1']);
  assert.equal(methods.getRowControls(), null);
  assert.equal(repaints, 1);
  list([]);
  assert.equal(methods.getRowControls(), null);
  assert.equal(repaints, 1);
  list(['c1', 'c3']);
  assert.equal(methods.getRowControls().chips.length, 2);
  assert.equal(repaints, 2);
});
