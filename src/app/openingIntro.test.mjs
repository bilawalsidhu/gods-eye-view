import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import {
  OPENING,
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

test('the arcs fly out and the words fade before the globe arrives', () => {
  const start = openingStage(0);
  assert.equal(start.text, 1);
  assert.equal(start.veil, 1);
  assert.equal(start.pupilOpacity, 1);
  assert.equal(start.flight, 0);
  const centred = openingStage(OPENING.centreMs);
  assert.equal(centred.text, 0);
  assert.equal(centred.centre, 1);
  const arcsGone = openingStage(OPENING.centreMs + OPENING.arcsMs);
  assert.equal(arcsGone.arcsOpacity, 0);
  assert.ok(arcsGone.arcsScale > 5);
  const real = openingStage(OPENING.centreMs + OPENING.pupilMs[1]);
  assert.equal(real.pupilOpacity, 0);
  assert.equal(real.veil, 0);
  assert.ok(real.flight > 0 && real.flight < 1);
  assert.equal(openingStage(END_MS).done, true);
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
      <path id="outer_eye"/><path id="inner_eye"/>
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
  s.advance(OPENING.centreMs + OPENING.pupilMs[1]);
  assert.ok(s.screen.classList.contains('hidden'));
  s.advance(OPENING.flightMs);
  await opening.done;
  const last = s.views.at(-1);
  assert.deepEqual(last.destination, LANDED);
  assert.equal(last.orientation.pitch, TARGET.pitch);
  assert.equal(openingPlaying(), false);
  assert.equal(s.commandListeners.size, 0);
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
