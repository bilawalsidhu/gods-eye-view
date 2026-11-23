import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import {
  OPENING,
  eyeCoverScale,
  globeRadiusPx,
  heightForGlobeRadius,
  openingPlaying,
  openingPose,
  openingStage,
  openingWanted,
  playOpeningIntro,
} from './openingIntro.js';

const LENS = { fovy: Math.PI / 4, viewportHeight: 800 };
const TARGET = { lon: 10.4, lat: 51.1, height: 23e6, heading: 0, pitch: -1 };
const LANDED = { lon: TARGET.lon, lat: TARGET.lat, height: TARGET.height };
const END_MS = OPENING.centreMs + OPENING.flightStartMs + OPENING.flightMs + 1;

test('the words fade, then the eye opens past the screen before the globe arrives', () => {
  const start = openingStage(0);
  assert.equal(start.text, 1);
  assert.equal(start.shut, false);
  assert.equal(start.pupilOpacity, 1);
  assert.equal(start.flight, 0);
  assert.equal(openingStage(OPENING.textMs).text, 0, 'the words go first');
  assert.ok(openingStage(OPENING.textMs).centre < 0.5);
  const centred = openingStage(OPENING.centreMs);
  assert.equal(centred.text, 0);
  assert.equal(centred.centre, 1);
  assert.equal(centred.shut, true, 'shut but for the eye');
  assert.equal(centred.eyeGrowth, 0);
  const half = openingStage(OPENING.centreMs + OPENING.eyeMs / 2);
  assert.ok(half.eyeGrowth > 0 && half.eyeGrowth < 0.5, 'it speeds up');
  assert.equal(half.pupilOpacity, 1, 'the planet stays in the pupil');
  const open = openingStage(OPENING.centreMs + OPENING.eyeMs);
  assert.equal(open.eyeGrowth, 1);
  assert.equal(open.eyeOpen, true);
  assert.equal(open.eyeOpacity, 0);
  assert.equal(open.shutterOpacity, 0);
  const real = openingStage(OPENING.centreMs + OPENING.pupilMs[1]);
  assert.equal(real.pupilOpacity, 0);
  assert.ok(real.flight > 0 && real.flight < 1);
  assert.equal(openingStage(END_MS).done, true);
});

test("the eye's window reaches past the corners of any screen", () => {
  const radius = 40;
  for (const view of [
    { width: 1280, height: 720 },
    { width: 375, height: 812 },
    { width: 3840, height: 1600 },
  ]) {
    const scale = eyeCoverScale(radius, view);
    assert.ok(radius * scale > Math.hypot(view.width, view.height) / 2);
  }
});

test('the flight turns west to east, slows and stops over the target', () => {
  const far = 4e8;
  const start = openingPose(0, { target: TARGET, farHeight: far });
  assert.ok(Math.abs(start.height - far) < 1);
  assert.equal(start.lat, 0);
  const end = openingPose(1, { target: TARGET, farHeight: far });
  assert.ok(Math.abs(end.lon - TARGET.lon) < 1e-9);
  assert.ok(Math.abs(end.lat - TARGET.lat) < 1e-9);
  assert.ok(Math.abs(end.height - TARGET.height) < 1e-3);
  // Unwrapped longitude falls all the way (the camera moves west, so the
  // surface turns east), fastest at first.
  let previous = Infinity;
  let previousStep = Infinity;
  for (let i = 0; i <= 10; i++) {
    const f = i / 10;
    const unwrapped = TARGET.lon + OPENING.spinDeg * (1 - (1 - (1 - f) ** 3));
    assert.ok(unwrapped <= previous);
    if (i > 0) {
      const step = previous - unwrapped;
      assert.ok(step <= previousStep + 1e-9, 'the turn slows');
      previousStep = step;
    }
    previous = unwrapped;
    const pose = openingPose(f, { target: TARGET, farHeight: far });
    assert.ok(pose.lon >= -180 && pose.lon < 180);
  }
});

test('a view at an angle is reached by turning over the last part', () => {
  const angled = {
    lon: 2.35,
    lat: 48.86,
    height: 5000,
    heading: 5.5,
    pitch: -0.5,
  };
  const far = 4e8;
  const early = openingPose(0.5, { target: angled, farHeight: far });
  assert.ok(Math.abs(early.heading) < 1e-12);
  assert.equal(early.pitch, -Math.PI / 2, 'straight down while far out');
  const end = openingPose(1, { target: angled, farHeight: far });
  // 5.5 rad turns the short way round: -0.78 rad.
  assert.ok(Math.abs(end.heading - (5.5 - 2 * Math.PI)) < 1e-9);
  assert.ok(Math.abs(end.pitch - angled.pitch) < 1e-9);
  assert.ok(Math.abs(end.height - angled.height) < 1e-6);
});

test('the far start draws the globe the size of the pupil', () => {
  for (const radius of [12, 20, 64]) {
    const height = heightForGlobeRadius(radius, LENS);
    assert.ok(Math.abs(globeRadiusPx(height, LENS) - radius) < 1e-6);
  }
  assert.ok(globeRadiusPx(4e8, LENS) < globeRadiusPx(23e6, LENS));
});

test('reduced motion, Stories links and ?intro=0 open without it', () => {
  const win = (search, reduced = false) => ({
    location: { search },
    matchMedia: () => ({ matches: reduced }),
  });
  assert.equal(openingWanted(win('')), true);
  assert.equal(openingWanted(win('', true)), false);
  assert.equal(openingWanted(win('?intro=0')), false);
  assert.equal(openingWanted(win('?story=abc')), false);
  assert.equal(openingWanted(win('?stories')), false);
  assert.equal(openingWanted(win('?intro=1')), true);
});

// A loading screen and a camera port; the test runs the frames by hand.
function stage() {
  const window = new Window({ width: 1280, height: 800 });
  const doc = window.document;
  doc.body.innerHTML = `
    <div id="cesiumContainer"></div>
    <div id="loading-screen"><span class="loader-logo"><svg>
      <path id="outer_eye" d="M0,10C0,0,20,0,20,10C20,20,0,20,0,10ZM5,10h1"/>
      <path id="inner_eye"/>
      <path id="globe"/><path id="globe_cage"/>
    </svg></span></div>`;
  const screen = doc.getElementById('loading-screen');
  let now = 0;
  let frames = [];
  window.performance.now = () => now;
  window.requestAnimationFrame = (fn) => frames.push(fn);
  window.cancelAnimationFrame = () => {
    frames = [];
  };
  window.matchMedia = () => ({ matches: false });
  const views = [];
  const commandListeners = new Set();
  const camera = {
    pose: () => ({ ...TARGET, fovy: Math.PI / 4 }),
    setView(spec) {
      views.push(spec);
      for (const cb of commandListeners) cb({ kind: 'setView' });
    },
    onCommand(cb) {
      commandListeners.add(cb);
      return () => commandListeners.delete(cb);
    },
  };
  return {
    window,
    screen,
    views,
    camera,
    commandListeners,
    play: () =>
      playOpeningIntro({
        viewer: {},
        loadingScreen: screen,
        win: window,
        camera,
      }),
    advance(ms) {
      now += ms;
      const run = frames;
      frames = [];
      for (const fn of run) fn();
    },
    otherMove: () => {
      for (const cb of [...commandListeners]) cb({ kind: 'flyTo' });
    },
  };
}

test('the opening runs to the start view, then hides the cover', async () => {
  const s = stage();
  const opening = s.play();
  assert.ok(opening);
  assert.equal(openingPlaying(), true);
  assert.ok(s.screen.classList.contains('opening'));
  assert.ok(s.views[0].destination.height > TARGET.height * 2, 'far start');
  const shutter = s.screen.querySelector('[data-opening-shutter]');
  assert.ok(shutter, 'the cover around the eye');
  assert.match(
    shutter.getAttribute('d'),
    /ZM341,382a226,226 0 1,0 452,0a226,226 0 1,0 -452,0Z$/,
    'the empty circle inside the ring',
  );
  assert.equal(shutter.getAttribute('fill-rule'), 'evenodd');
  s.advance(OPENING.centreMs);
  assert.equal(s.screen.style.getPropertyValue('--opening-veil'), '0');
  s.advance(Math.max(OPENING.eyeMs, OPENING.pupilMs[1]));
  assert.ok(s.screen.classList.contains('hidden'));
  s.advance(OPENING.flightMs);
  await opening.done;
  const last = s.views.at(-1);
  assert.deepEqual(last.destination, LANDED);
  assert.equal(last.orientation.heading, TARGET.heading);
  assert.equal(last.orientation.pitch, TARGET.pitch);
  assert.equal(openingPlaying(), false);
  assert.equal(s.commandListeners.size, 0);
});

test('a camera held in a target frame plays no opening', () => {
  const s = stage();
  s.camera.pose = () => ({ ...TARGET, frameIsIdentity: false });
  assert.equal(s.play(), null);
  assert.ok(!s.screen.classList.contains('opening'));
});

test("the person's input skips to the start view", async () => {
  const s = stage();
  const opening = s.play();
  s.advance(2000);
  s.window.dispatchEvent(new s.window.Event('keydown'));
  await opening.done;
  assert.deepEqual(s.views.at(-1).destination, LANDED);
  assert.ok(s.screen.classList.contains('hidden'));
  assert.equal(openingPlaying(), false);
});

test('another camera move stops it where it is', async () => {
  const s = stage();
  const opening = s.play();
  s.advance(2000);
  const count = s.views.length;
  s.otherMove();
  await opening.done;
  s.advance(1000);
  assert.equal(s.views.length, count, 'no more frames');
  assert.ok(s.screen.classList.contains('hidden'));
});
