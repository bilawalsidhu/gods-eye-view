// src/layers/satellites/stationPanel.test.mjs — the STATION section's
// presenter, over a stand-in station description.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { ISS_COMMAND_ZOOM_RANGE_M } from './issCommand.js';
import { createStationPanel } from './stationPanel.js';

/**
 * A camera port that follows what it is told to and keeps a follow offset,
 * as the renderer's does once the follow has framed the eye.
 */
function fakeFollowCamera({ eye, offset }) {
  const camera = {
    eye,
    offset,
    followed: null,
    followFramed: false,
    offsetsSet: [],
    pose: () => ({ position: { ...camera.eye } }),
    followOffset: {
      get: () => (camera.followFramed ? { ...camera.offset } : null),
      set(next) {
        camera.offset = { ...next };
        camera.offsetsSet.push({ ...next });
      },
    },
  };
  return camera;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture() {
  const calls = [];
  const articulation = {
    isSunlit: () => true,
    isLive: () => false,
    setTelemetryAllowed: (allowed) => calls.push(['telemetry', allowed]),
  };
  let selected = false;
  let held = false;
  let position = null;
  let telemetry = { state: 'live', poseAgeMs: 3000, liveUntilMs: null };
  const station = {
    key: 'test',
    title: 'TEST',
    selected: () => selected,
    subjectName: () => 'TEST STATION',
    articulation: () => articulation,
    telemetry: () => telemetry,
    position: () => position,
    zoomLabel: 'Zoom to the station',
    notes: {
      live: 'Joints on live telemetry.',
      computed: 'Computed, not live telemetry.',
    },
    groups: [
      {
        id: 'sun',
        label: 'Sun position',
        kind: 'choices',
        choices: [
          {
            id: 'follow',
            label: 'Follow',
            isDefault: true,
            apply: () => calls.push(['sun', 'follow']),
          },
          {
            id: 'ahead',
            label: 'Ahead',
            apply: () => calls.push(['sun', 'ahead']),
          },
        ],
      },
      {
        id: 'arm',
        label: 'Arm',
        kind: 'sliders',
        resume: 'Resume',
        sliders: [
          {
            id: 'shoulder',
            label: 'Shoulder',
            min: -120,
            max: 120,
            apply: (a, v) => calls.push(['shoulder', v]),
          },
          {
            id: 'elbow',
            label: 'Elbow',
            min: -90,
            max: 90,
            apply: (a, v) => calls.push(['elbow', v]),
          },
        ],
        resumeApply: () => calls.push(['resume']),
      },
    ],
    automatic: () => calls.push(['automatic']),
  };
  const layerState = { _enabled: true, _viewer: null };
  const parts = { cockpit: { _cockpitHeld: () => held } };
  const panel = createStationPanel({
    state: layerState,
    parts,
    stations: [station],
  });
  const views = [];
  panel.methods.subscribeStationPanel((view) => views.push(view));
  const actions = panel.methods.getStationActions();
  return {
    panel,
    actions,
    calls,
    views,
    view: () => views.at(-1),
    layerState,
    select: (on) => (selected = on),
    hold: (on) => (held = on),
    setTelemetry: (next) => (telemetry = next),
    setPosition: (next) => (position = next),
  };
}

test('the zoom is offered, and runs, only while the follow camera is on the station', async (t) => {
  const f = fixture();
  t.after(() => f.panel._destroyStationPanel());
  const viewer = {};
  const camera = fakeFollowCamera({
    eye: { x: 5000, y: 0, z: 0 },
    offset: { x: 3000, y: 4000, z: 0 },
  });
  const frames = [];
  const { unbind } = bindFakeDraw(viewer, {
    camera,
    frame: { requestRender: (reason) => frames.push(reason) },
  });
  t.after(unbind);
  const target = { key: 'satellites:25544' };
  f.layerState._viewer = viewer;
  f.layerState._followTarget = target;
  f.setPosition({ x: 0, y: 0, z: 0 });
  f.select(true);
  f.panel._syncStationPanel();
  assert.equal(f.view().zoom.offered, false, 'still flying to the station');
  assert.equal(f.actions.zoomStation(), false);
  camera.followed = { key: 'flights:other' };
  camera.followFramed = true;
  f.panel._syncStationPanel();
  assert.equal(f.view().zoom.offered, false, 'following something else');
  camera.followed = target;
  camera.followFramed = false;
  f.panel._syncStationPanel();
  assert.equal(f.view().zoom.offered, false, 'the follow has not framed yet');
  camera.followFramed = true;
  f.panel._syncStationPanel();
  assert.equal(f.view().zoom.offered, true);
  assert.equal(f.actions.zoomStation(), true);
  await sleep(120);
  const ranges = camera.offsetsSet.map((o) => Math.hypot(o.x, o.y, o.z));
  assert.ok(ranges.length >= 3, 'the zoom stepped the follow offset');
  for (let i = 0; i < ranges.length; i++) {
    const before = i === 0 ? 5000 : ranges[i - 1];
    assert.ok(
      ranges[i] < before,
      `step ${i} came in: ${before} -> ${ranges[i]}`,
    );
    assert.ok(ranges[i] >= ISS_COMMAND_ZOOM_RANGE_M, 'never past the range');
  }
  // The bearing is kept: the offset only shortens.
  const last = camera.offsetsSet.at(-1);
  assert.ok(Math.abs(last.x / last.y - 3 / 4) < 1e-9);
  assert.equal(last.z, 0);
  // The follow ending stops the zoom where it is.
  camera.followed = null;
  const steps = camera.offsetsSet.length;
  await sleep(50);
  assert.equal(camera.offsetsSet.length, steps);
  camera.followed = target;
  camera.eye = { x: 300, y: 0, z: 0 };
  f.panel._syncStationPanel();
  assert.equal(f.view().zoom.offered, false, 'close in, the zoom goes');
  assert.ok(frames.length === 0 || frames.every((r) => r === 'station-panel'));
});

test('a new subscriber gets the current view at once: nothing while no station is selected', () => {
  const f = fixture();
  assert.deepEqual(f.views, [null]);
  f.panel._syncStationPanel();
  assert.deepEqual(f.views, [null], 'unchanged nothing is not re-published');
  f.panel._destroyStationPanel();
});

test('selecting the station publishes it in Automatic with its defaults', (t) => {
  const f = fixture();
  t.after(() => f.panel._destroyStationPanel());
  f.select(true);
  f.panel._syncStationPanel();
  const view = f.view();
  assert.equal(view.key, 'test');
  assert.equal(view.title, 'TEST');
  assert.equal(view.subject, 'TEST STATION');
  assert.equal(view.mode, 'automatic');
  assert.deepEqual(view.telemetry, {
    state: 'live',
    poseAgeMs: 3000,
    liveUntilMs: null,
  });
  assert.equal(view.sunlit, true);
  assert.match(view.note, /Computed, not live telemetry/);
  assert.deepEqual(
    view.groups[0].choices.map((c) => [c.id, c.active]),
    [
      ['follow', true],
      ['ahead', false],
    ],
  );
  assert.deepEqual(
    view.groups[1].sliders.map((s) => s.value),
    [0, 0],
  );
  assert.equal(view.groups[1].resume, 'Resume');
  assert.deepEqual(view.zoom, { offered: false, label: 'Zoom to the station' });
  assert.deepEqual(f.calls, [], 'Automatic touches nothing on entry');
});

test('Manual pauses telemetry and offers the controls; Automatic hands the joints back', (t) => {
  const f = fixture();
  t.after(() => f.panel._destroyStationPanel());
  f.select(true);
  f.panel._syncStationPanel();
  assert.equal(f.actions.setStationMode('manual'), true);
  assert.equal(f.view().mode, 'manual');
  assert.equal(f.view().sunlit, null, "the Sun line is Automatic's");
  assert.deepEqual(f.calls, [['telemetry', false]]);
  assert.equal(f.actions.setStationMode('manual'), true, 'again is a no-op');
  assert.equal(f.calls.length, 1);
  assert.equal(f.actions.chooseStation('sun', 'ahead'), true);
  assert.equal(f.view().groups[0].choices[1].active, true);
  assert.equal(f.actions.setStationMode('automatic'), true);
  assert.equal(f.view().mode, 'automatic');
  assert.deepEqual(f.calls.at(-1), ['automatic']);
  assert.equal(f.view().groups[0].choices[0].active, true, 'choices reset');
});

test('choices apply to the articulation; an unknown choice is refused', (t) => {
  const f = fixture();
  t.after(() => f.panel._destroyStationPanel());
  f.select(true);
  f.panel._syncStationPanel();
  assert.equal(f.actions.chooseStation('sun', 'ahead'), true);
  assert.deepEqual(f.calls, [['sun', 'ahead']]);
  assert.equal(f.actions.chooseStation('sun', 'nowhere'), false);
  assert.equal(f.actions.chooseStation('arm', 'ahead'), false);
});

test('sliders clamp to their range and refuse non-numbers', (t) => {
  const f = fixture();
  t.after(() => f.panel._destroyStationPanel());
  f.select(true);
  f.panel._syncStationPanel();
  assert.equal(f.actions.slideStation('shoulder', '45'), true);
  assert.equal(f.actions.slideStation('elbow', 500), true);
  assert.equal(f.actions.slideStation('elbow', 'abc'), false);
  assert.equal(f.actions.slideStation('wrist', 10), false);
  assert.deepEqual(f.calls, [
    ['shoulder', 45],
    ['elbow', 90],
  ]);
  assert.deepEqual(
    f.view().groups[1].sliders.map((s) => s.value),
    [45, 90],
  );
  assert.equal(f.actions.resumeStationArm('arm'), true);
  assert.deepEqual(f.calls.at(-1), ['resume']);
  assert.deepEqual(
    f.view().groups[1].sliders.map((s) => s.value),
    [0, 0],
  );
  assert.equal(
    f.actions.resumeStationArm('sun'),
    false,
    'choices have no resume',
  );
});

test('leaving the station in Manual hands its joints back and takes the section down', (t) => {
  const f = fixture();
  t.after(() => f.panel._destroyStationPanel());
  f.select(true);
  f.panel._syncStationPanel();
  f.actions.setStationMode('manual');
  f.actions.slideStation('shoulder', 30);
  f.select(false);
  f.panel._syncStationPanel();
  assert.equal(f.view(), null);
  assert.deepEqual(f.calls.at(-1), ['automatic']);
  f.select(true);
  f.panel._syncStationPanel();
  assert.equal(f.view().mode, 'automatic');
  assert.deepEqual(
    f.view().groups[1].sliders.map((s) => s.value),
    [0, 0],
  );
});

test('the section is away while the Cockpit holds the rail, and while the layer is off', (t) => {
  const f = fixture();
  t.after(() => f.panel._destroyStationPanel());
  f.select(true);
  f.hold(true);
  f.panel._syncStationPanel();
  assert.equal(f.view(), null);
  f.hold(false);
  f.panel._syncStationPanel();
  assert.equal(f.view().key, 'test');
  f.layerState._enabled = false;
  f.panel._syncStationPanel();
  assert.equal(f.view(), null);
});

test('every sync re-reads the telemetry status for the status line', (t) => {
  const f = fixture();
  t.after(() => f.panel._destroyStationPanel());
  f.select(true);
  f.panel._syncStationPanel();
  f.setTelemetry({
    state: 'unavailable',
    poseAgeMs: 61_000,
    liveUntilMs: null,
  });
  f.panel._syncStationPanel();
  assert.equal(f.view().telemetry.state, 'unavailable');
});

test('actions without a station are refused; destroy publishes nothing', () => {
  const f = fixture();
  assert.equal(f.actions.setStationMode('manual'), false);
  assert.equal(f.actions.chooseStation('sun', 'ahead'), false);
  assert.equal(f.actions.slideStation('shoulder', 1), false);
  assert.equal(f.actions.resumeStationArm('arm'), false);
  assert.equal(f.actions.zoomStation(), false);
  f.select(true);
  f.panel._syncStationPanel();
  assert.ok(f.view());
  f.panel._destroyStationPanel();
  assert.equal(f.view(), null);
});

test('frame after frame, the section is republished only when the age crosses a whole second', (t) => {
  const f = fixture();
  t.after(() => f.panel._destroyStationPanel());
  f.select(true);
  f.setTelemetry({ state: 'live', poseAgeMs: 3010, liveUntilMs: null });
  f.panel._syncStationPanel();
  const published = f.views.length;
  assert.equal(f.view().telemetry.poseAgeMs, 3000, 'in whole seconds');
  // The tick runs every frame; the age moves by milliseconds.
  for (const age of [3020, 3150, 3600, 3999]) {
    f.setTelemetry({ state: 'live', poseAgeMs: age, liveUntilMs: null });
    f.panel._syncStationPanel();
  }
  assert.equal(f.views.length, published, 'nothing new to show');
  f.setTelemetry({ state: 'live', poseAgeMs: 4001, liveUntilMs: null });
  f.panel._syncStationPanel();
  assert.equal(f.views.length, published + 1);
  assert.equal(f.view().telemetry.poseAgeMs, 4000);
});
