import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  frameForTarget,
  mountNavControl,
  orbitCameraPosition,
  plausibleTarget,
  TILT_IDLE_MS,
} from './navControl.js';
import { createPinia } from 'pinia';
import { useNavControlStore } from '../stores/navControl.js';
import { readCameraTargetFrame } from '../cameraOrientationControls.js';
import { TOP_DOWN_PITCH } from './navMath.js';

const DEG = Math.PI / 180;
const GROUND = Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 0);

// ── a real Cesium camera orbiting a fixed ground point ───────────────────
function createViewer({ pick = GROUND, ground = GROUND } = {}) {
  const scene = {
    canvas: { clientWidth: 1200, clientHeight: 800, width: 1200, height: 800 },
    drawingBufferWidth: 1200,
    drawingBufferHeight: 800,
    mapProjection: new Cesium.GeographicProjection(Cesium.Ellipsoid.WGS84),
    globe: { ellipsoid: Cesium.Ellipsoid.WGS84, pick: () => pick },
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    pickPositionSupported: false,
    pickPosition: () => null,
    requestRender: () => {},
    preRender: new Cesium.Event(),
    preUpdate: new Cesium.Event(),
  };
  const camera = new Cesium.Camera(scene);
  scene.camera = camera;
  camera.getPickRay = () => ({});
  camera.pickEllipsoid = () => ground;
  const viewer = {
    camera,
    scene,
    trackedEntity: undefined,
    trackedEntityChanged: new Cesium.Event(),
  };
  return viewer;
}

function orbit(viewer, { heading = 30, pitch = -45, range = 1_000 } = {}) {
  viewer.camera.lookAt(
    GROUND,
    new Cesium.HeadingPitchRange(heading * DEG, pitch * DEG, range),
  );
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
}

/** A manual clock and timers so animation and press-and-hold are deterministic. */
function createClock() {
  let time = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    now: () => time,
    timers: {
      setTimeout: (fn, delay) => {
        pending.set(nextId, { fn, at: time + delay, every: 0 });
        return nextId++;
      },
      setInterval: (fn, delay) => {
        pending.set(nextId, { fn, at: time + delay, every: delay });
        return nextId++;
      },
      clearTimeout: (id) => pending.delete(id),
      clearInterval: (id) => pending.delete(id),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    advance(ms, onFrame) {
      const end = time + ms;
      while (time < end) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        const step = due ? Math.max(time, due[1].at) : end;
        time = step;
        onFrame?.();
        if (due && pending.has(due[0])) {
          const [id, timer] = due;
          timer.fn();
          if (timer.every) timer.at += timer.every;
          else pending.delete(id);
        } else if (!due) break;
      }
      time = end;
      onFrame?.();
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

function setup(options = {}) {
  const viewer = createViewer(options.viewer);
  orbit(viewer, options.view);
  const clock = createClock();
  const navigations = [];
  const nav = useNavControlStore(createPinia());
  const handle = mountNavControl({
    viewer,
    store: nav,
    now: clock.now,
    timers: clock.timers,
    runNavigation:
      options.runNavigation ||
      ((noun, navigate) => {
        navigations.push(noun);
        return navigate();
      }),
  });
  const frame = () => readCameraTargetFrame(viewer);
  const settle = (ms = 1_000) =>
    clock.advance(ms, () => viewer.scene.preUpdate.raiseEvent());
  /** A button's keyboard activation, which acts once. */
  const activate = (name) => nav.act('activate', name);
  return { viewer, clock, handle, nav, navigations, frame, settle, activate };
}

test('camera moveEnd leaves the tilt read until the camera has been still', () => {
  const { viewer, handle, clock } = setup();
  let reads = 0;
  viewer.scene.globe.pick = () => {
    reads++;
    return GROUND;
  };
  viewer.camera.moveEnd.raiseEvent();
  assert.equal(reads, 0, 'moveEnd must not synchronously read the target');
  assert.equal(clock.pendingCount, 1);
  clock.advance(TILT_IDLE_MS - 1);
  assert.equal(reads, 0, 'nothing is read while other observers re-aim');
  // Another camera move restarts the wait, and still leaves one read pending.
  viewer.camera.moveEnd.raiseEvent();
  assert.equal(clock.pendingCount, 1, 'repeated events share one read');
  clock.advance(TILT_IDLE_MS - 1);
  assert.equal(reads, 0, 'the wait restarted');
  clock.advance(1);
  assert.equal(reads, 1, 'the target is read once the camera has been still');
  assert.equal(clock.pendingCount, 0);
  viewer.camera.moveEnd.raiseEvent();
  assert.equal(clock.pendingCount, 1);
  handle.destroy();
  assert.equal(clock.pendingCount, 0, 'destroy cancels a pending read');
});

test('the owner mounts once per viewer, publishes a view and detaches on destroy', () => {
  const { handle, viewer, clock, nav } = setup();
  const { tilt, ...rest } = nav.view;
  assert.deepEqual(rest, { heading: 30, following: false, dragging: false });
  assert.ok(Math.abs(tilt - 45) <= 1, `tilt ${tilt}`);

  // A second mount for the same viewer returns the live owner.
  const again = mountNavControl({ viewer, store: nav, timers: clock.timers });
  assert.equal(again, handle);

  handle.destroy();
  assert.equal(nav.view, null, 'the control goes with its owner');
  handle.destroy(); // idempotent
  const remounted = mountNavControl({
    viewer,
    store: nav,
    timers: clock.timers,
  });
  assert.notEqual(remounted, handle);
  assert.equal(nav.view.heading, 30);
  remounted.destroy();
});

test('the store needs an owner and a viewer', () => {
  assert.throws(() => mountNavControl({}), TypeError);
  const { viewer } = setup();
  assert.throws(() => mountNavControl({ viewer: {} }), TypeError);
  assert.throws(() => mountNavControl({ viewer: createViewer() }), TypeError);
  assert.ok(viewer);
});

test('the view follows the camera heading and a tracked entity', () => {
  const { viewer, nav, settle, activate } = setup({ view: { heading: 40 } });
  assert.equal(nav.view.heading, 40);
  activate('north');
  settle();
  viewer.scene.preRender.raiseEvent(); // the next drawn frame
  assert.equal(nav.view.heading, 0);
  viewer.trackedEntity = { position: undefined };
  viewer.trackedEntityChanged.raiseEvent();
  assert.equal(nav.view.following, true);
});

test('zoom buttons move the real camera toward and away from the target', () => {
  const { activate, frame, settle } = setup({ view: { range: 1_000 } });
  activate('zoom-in');
  settle();
  assert.ok(Math.abs(frame().range - 700) < 1, `range ${frame().range}`);
  activate('zoom-out');
  settle();
  assert.ok(Math.abs(frame().range - 1_000) < 2, `range ${frame().range}`);
});

test('zoom keeps the heading and pitch of the view', () => {
  const { activate, frame, settle } = setup({
    view: { heading: 120, pitch: -35, range: 2_000 },
  });
  activate('zoom-in');
  settle();
  const after = frame();
  assert.ok(Math.abs(Cesium.Math.toDegrees(after.heading) - 120) < 0.01);
  assert.ok(Math.abs(Cesium.Math.toDegrees(after.pitch) + 35) < 0.01);
});

test('holding a zoom button repeats until released, within the clamp', () => {
  const { nav, frame, settle, clock } = setup({ view: { range: 1_000 } });
  nav.act('press', 'zoom-in');
  settle(380 + 130 * 3 + 20); // first repeat delay, then three repeats
  nav.act('release');
  assert.equal(clock.pendingCount, 0, 'release cancels the repeat timers');
  settle(1_000); // let the last step finish easing
  const held = frame().range;
  // The press plus three repeats is four steps of 30 percent.
  assert.ok(held <= 1_000 * 0.7 ** 3, `repeated while held: ${held}`);
  assert.ok(held >= 1_000 * 0.7 ** 6, `not runaway: ${held}`);
  settle(2_000);
  assert.equal(frame().range, held, 'no more steps after release');
});

test('holding zoom-in never goes below the minimum distance', () => {
  const { nav, frame, settle } = setup({ view: { range: 200 } });
  nav.act('press', 'zoom-in');
  settle(5_000);
  nav.act('release');
  assert.ok(frame().range >= 39.9, `range ${frame().range}`);
});

test('tilt buttons change the pitch in 10 degree steps and stop at the ends', () => {
  const { activate, frame, settle } = setup({
    view: { pitch: -45, range: 4_000 },
  });
  activate('tilt-up');
  settle();
  assert.ok(Math.abs(Cesium.Math.toDegrees(frame().pitch) + 35) < 0.05);
  activate('tilt-down');
  activate('tilt-down');
  settle();
  assert.ok(Math.abs(Cesium.Math.toDegrees(frame().pitch) + 55) < 0.05);
  for (let i = 0; i < 12; i++) activate('tilt-up');
  settle();
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(frame().pitch) + 10) < 0.05,
    `pitch stops at the horizon limit: ${Cesium.Math.toDegrees(frame().pitch)}`,
  );
  for (let i = 0; i < 12; i++) activate('tilt-down');
  settle();
  assert.ok(Math.abs(Cesium.Math.toDegrees(frame().pitch) + 89) < 0.05);
});

test('the top-down button returns to straight down', () => {
  const { activate, frame, settle } = setup({ view: { pitch: -25 } });
  activate('top-down');
  settle();
  assert.ok(Math.abs(frame().pitch - TOP_DOWN_PITCH) < 1e-3);
});

test('north-up turns the shorter way and keeps pitch and range', () => {
  const { activate, frame, settle } = setup({
    view: { heading: 350, pitch: -40, range: 1_500 },
  });
  activate('north');
  settle();
  const after = frame();
  const heading = Cesium.Math.toDegrees(after.heading);
  assert.ok(heading < 0.05 || heading > 359.95, `heading ${heading}`);
  assert.ok(Math.abs(Cesium.Math.toDegrees(after.pitch) + 40) < 0.05);
  assert.ok(Math.abs(after.range - 1_500) < 1);
});

test('dragging the ring a quarter turn clockwise turns the heading by 90 degrees', () => {
  const { nav, viewer, frame } = setup({
    view: { heading: 0, pitch: -45, range: 1_000 },
  });
  // Ring centre is (140,140). Start at 3 o'clock, end at 6 o'clock.
  const at = (clientX, clientY) => ({
    centerX: 140,
    centerY: 140,
    clientX,
    clientY,
  });
  assert.equal(nav.act('ringStart', at(180, 140)), true);
  assert.equal(nav.view.dragging, true);
  nav.act('ringMove', { clientX: 170, clientY: 168 });
  nav.act('ringMove', { clientX: 140, clientY: 180 });
  nav.act('ringEnd');
  assert.equal(nav.view.dragging, false);
  const heading = Cesium.Math.toDegrees(frame().heading);
  assert.ok(Math.abs(heading - 270) < 0.1, `heading ${heading}`);
  assert.ok(Math.abs(Cesium.Math.toDegrees(frame().pitch) + 45) < 0.05);
  assert.ok(Math.abs(frame().range - 1_000) < 1);
  assert.equal(
    nav.view.heading,
    Math.round(Cesium.Math.toDegrees(viewer.camera.heading)) % 360,
  );
  assert.equal(nav.view.heading, 270);
});

test('a refused ring drag never starts and moves nothing', () => {
  const { nav, viewer } = setup({ runNavigation: () => false });
  const before = Cesium.Cartesian3.clone(viewer.camera.positionWC);
  const at = { centerX: 140, centerY: 140, clientX: 180, clientY: 140 };
  assert.equal(nav.act('ringStart', at), false);
  nav.act('ringMove', { clientX: 140, clientY: 180 });
  nav.act('ringEnd');
  assert.equal(nav.view.dragging, false);
  assert.ok(
    Cesium.Cartesian3.distance(before, viewer.camera.positionWC) < 1e-6,
  );
});

test('ring arrow keys turn the view and Home faces north', () => {
  const { nav, frame, settle } = setup({ view: { heading: 40 } });
  assert.equal(nav.act('ringKey', 'ArrowRight'), true);
  settle();
  assert.ok(Math.abs(Cesium.Math.toDegrees(frame().heading) - 55) < 0.05);
  nav.act('ringKey', 'Home');
  settle();
  const heading = Cesium.Math.toDegrees(frame().heading);
  assert.ok(heading < 0.05 || heading > 359.95, `heading ${heading}`);
  assert.equal(nav.act('ringKey', 'a'), false, 'other keys are not the ring');
});

test('the tilt slider sets the pitch directly and the clamp applies', () => {
  const { nav, frame, viewer } = setup({
    view: { heading: 25, pitch: -45, range: 3_000 },
  });
  nav.act('sliderStart');
  nav.act('sliderInput', 60); // 60 degrees from top-down => -29 degrees
  assert.equal(nav.view.tilt, 60, 'the handle shows what was asked for');
  const after = frame();
  assert.ok(Math.abs(Cesium.Math.toDegrees(after.pitch) + 29) < 0.05);
  assert.ok(Math.abs(Cesium.Math.toDegrees(after.heading) - 25) < 0.05);
  assert.ok(Math.abs(after.range - 3_000) < 1);
  nav.act('sliderInput', 500);
  assert.ok(Math.abs(Cesium.Math.toDegrees(frame().pitch) + 10) < 0.05);
  nav.act('sliderInput', 0);
  assert.ok(Math.abs(Cesium.Math.toDegrees(frame().pitch) + 89) < 0.05);
  assert.ok(viewer.camera.positionCartographic.height > 0);
  nav.act('sliderEnd');
  assert.equal(nav.view.tilt, 0, 'the settled camera is shown again');
});

test('look around turns the gaze without moving the camera', () => {
  const { activate, viewer } = setup({ view: { heading: 30, pitch: -45 } });
  const before = Cesium.Cartesian3.clone(viewer.camera.positionWC);
  const headingBefore = viewer.camera.heading;
  activate('look-left');
  assert.ok(
    Cesium.Cartesian3.distance(before, viewer.camera.positionWC) < 1e-3,
    'camera stays where it is',
  );
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(headingBefore - viewer.camera.heading) - 3) <
      0.05,
  );
});

test('every action goes through the navigation policy; a refusal leaves the camera alone', () => {
  const calls = [];
  const { nav, viewer, settle } = setup({
    runNavigation: (noun) => {
      calls.push(noun);
      return false; // e.g. cockpit owns the camera
    },
  });
  const before = Cesium.Cartesian3.clone(viewer.camera.positionWC);
  for (const name of ['zoom-in', 'tilt-up', 'north', 'top-down', 'look-left'])
    nav.act('activate', name);
  nav.act('ringKey', 'ArrowLeft');
  settle();
  assert.deepEqual(calls, Array(6).fill('camera'));
  assert.ok(
    Cesium.Cartesian3.distance(before, viewer.camera.positionWC) < 1e-6,
    'refused navigation does not move the camera',
  );
});

test('a wild centre pick falls back to the ground under the centre', () => {
  // 13 km below the ellipsoid, as a depth glitch returns while tiles stream.
  const wild = Cesium.Cartesian3.fromDegrees(-97.6, 30.5, -13_000);
  assert.equal(plausibleTarget(wild), false);
  assert.equal(plausibleTarget(GROUND), true);
  assert.equal(plausibleTarget(null), false);
  const { activate, viewer, settle } = setup({
    viewer: { pick: wild, ground: GROUND },
    view: { range: 1_000 },
  });
  activate('zoom-in');
  settle();
  const height = viewer.camera.positionCartographic.height;
  assert.ok(height > 0, `camera stays above ground, height ${height}`);
  const frame = frameForTarget(viewer.camera, GROUND);
  assert.ok(Math.abs(frame.range - 700) < 1, `range ${frame.range}`);
});

test('with no ground under the centre the control works in place', () => {
  const { activate, viewer, settle } = setup({
    viewer: { pick: null, ground: null },
    view: { heading: 90, pitch: -30 },
  });
  const before = Cesium.Cartesian3.clone(viewer.camera.positionWC);
  activate('north');
  settle();
  assert.ok(
    Cesium.Cartesian3.distance(before, viewer.camera.positionWC) < 1e-3,
  );
  assert.ok(
    Cesium.Math.toDegrees(viewer.camera.heading) < 0.05 ||
      Cesium.Math.toDegrees(viewer.camera.heading) > 359.95,
  );
});

test('orbitCameraPosition agrees with Cesium lookAt', () => {
  const viewer = createViewer();
  orbit(viewer, { heading: 135, pitch: -35, range: 2_500 });
  const mine = orbitCameraPosition(GROUND, {
    heading: 135 * DEG,
    pitch: -35 * DEG,
    range: 2_500,
  });
  assert.ok(Cesium.Cartesian3.distance(mine, viewer.camera.positionWC) < 0.01);
});

test('destroy stops animation, hold timers and listeners', () => {
  const { nav, handle, clock, viewer } = setup({ view: { range: 1_000 } });
  nav.act('press', 'zoom-in');
  assert.ok(clock.pendingCount > 0);
  handle.destroy();
  assert.equal(clock.pendingCount, 0);
  const position = Cesium.Cartesian3.clone(viewer.camera.positionWC);
  viewer.scene.preUpdate.raiseEvent();
  assert.ok(
    Cesium.Cartesian3.distance(position, viewer.camera.positionWC) < 1e-6,
  );
});

test('on wide screens the control sits above the bottom-right corner row', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(
    new URL('./navControl.css', import.meta.url),
    'utf8',
  );
  // #corner-actions (POWER UP chip + language picker) sits at z-index 150 in
  // the very corner; the control must clear it rather than hide under it.
  const rule = css.match(
    /@media \(min-width: 901px\)\s*\{\s*\.gev-nav\s*\{([^}]*)\}/,
  );
  assert.ok(rule, 'a wide-screen rule lifts the control');
  assert.match(rule[1], /bottom:\s*calc\(\s*max\(58px/);
});

test('the application shell mounts the owner on the page store and releases it', async () => {
  const { StyleManager } = await import('../applicationShell.js');
  const { applicationPinia } = await import('../vueRuntime.js');
  const nav = useNavControlStore(applicationPinia());
  const viewer = createViewer();
  orbit(viewer);
  const runs = [];
  const shell = {
    viewer,
    _navigation: {
      runOrientation: (noun, navigate) => {
        runs.push(noun);
        return navigate();
      },
    },
  };
  StyleManager.prototype._initNavControl.call(shell);
  assert.ok(nav.view, 'the page store shows the control');
  assert.equal(nav.view.heading, 30);
  assert.equal(nav.act('activate', 'north'), true);
  assert.deepEqual(runs, ['camera'], 'actions use the shell navigation policy');
  // Mounting again replaces the first owner and keeps one control.
  const first = shell._navControl;
  StyleManager.prototype._initNavControl.call(shell);
  assert.equal(first.destroyed, true);
  assert.ok(nav.view);
  shell._navControl.destroy();
  assert.equal(nav.view, null);
});

test('mounting the navigation control leaves the shell’s Tilt and North-up buttons toasting', async () => {
  const { StyleManager } = await import('../applicationShell.js');
  const { applicationPinia } = await import('../vueRuntime.js');
  const { useGlobeActionsStore } = await import('../stores/globeActions.js');
  const globe = useGlobeActionsStore(applicationPinia());
  const viewer = createViewer();
  orbit(viewer, { heading: 40 });
  const toasts = [];
  const shell = {
    viewer,
    _navigation: { runOrientation: (_noun, navigate) => navigate() },
    _showToast: (text) => toasts.push(text),
  };
  StyleManager.prototype._initCameraOrientationControls.call(shell);
  StyleManager.prototype._initNavControl.call(shell);
  globe.act('northUp');
  assert.deepEqual(toasts, ['North up'], 'the orientation buttons still toast');
  shell._cameraOrientationControls.destroy();
  globe.detach(shell._orientationToken);
  shell._navControl.destroy();
});
