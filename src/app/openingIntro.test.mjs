import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import {
  OPENING,
  globeRadiusPx,
  heightForGlobeRadius,
  openingFlight,
  openingPlaying,
  openingStage,
  openingWanted,
  playOpeningIntro,
} from './openingIntro.js';

const LENS = { fovy: Math.PI / 4, viewportHeight: 800 };
const TARGET = { lon: 10.4, lat: 51.1, height: 23e6, heading: 0, pitch: -1 };
const LANDED = { lon: TARGET.lon, lat: TARGET.lat, height: TARGET.height };
const PLANET_FLIGHT_MS = OPENING.zoomMs + OPENING.spinMs;

test('the words fade, then the eye opens past the screen before the globe arrives', () => {
  const start = openingStage(0);
  assert.equal(start.text, 1);
  assert.equal(start.shut, false);
  assert.equal(start.pupilOpacity, 1);
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
  assert.equal(open.eyeOpacity, 0);
  assert.equal(open.shutterOpacity, 0);
  const real = openingStage(OPENING.centreMs + OPENING.pupilMs[1]);
  assert.equal(real.pupilOpacity, 0);
});

const FAR = 4e8;
const PLANET = { lon: 10.4, lat: 51.1, height: 23e6 };
const unwrap = (lon, near) => lon + 360 * Math.round((near - lon) / 360);

test('the globe grows to the planet first, then turns there to a stop', () => {
  const flight = openingFlight({ target: PLANET, farHeight: FAR });
  assert.equal(flight.ms, PLANET_FLIGHT_MS, 'nothing to close in on');
  const start = flight.pose(0);
  assert.ok(Math.abs(start.height - FAR) < 1);
  assert.equal(start.lat, 0);
  assert.ok(
    Math.abs(flight.pose(OPENING.zoomMs).height - PLANET.height) < 1,
    'the whole planet first',
  );
  // Unwrapped longitude falls all the way (the camera moves west, so the
  // surface turns east), from halfway through the zoom, slowing to a stop.
  const spinFrom = OPENING.zoomMs / 2;
  let previous = PLANET.lon + OPENING.spinDeg;
  let previousStep = Infinity;
  for (let i = 0; i <= 100; i++) {
    const at = spinFrom + ((flight.ms - spinFrom) * i) / 100;
    const pose = flight.pose(at);
    if (at >= OPENING.zoomMs)
      assert.ok(Math.abs(pose.height - PLANET.height) < 1, 'turns at size');
    assert.ok(pose.lon >= -180 && pose.lon < 180);
    const lon = unwrap(pose.lon, previous);
    const step = previous - lon;
    assert.ok(step >= -1e-9, 'west to east');
    if (i > 1) assert.ok(step <= previousStep + 1e-9, 'the turn slows');
    previous = lon;
    previousStep = step;
  }
  assert.ok(Math.abs(previous - PLANET.lon) < 1e-9, 'one whole turn');
  const end = flight.pose(flight.ms);
  assert.ok(Math.abs(end.lon - PLANET.lon) < 1e-9);
  assert.ok(Math.abs(end.lat - PLANET.lat) < 1e-9);
  assert.equal(end.pitch, -Math.PI / 2);
});

test('a closer view at an angle is closed in on after the turn', () => {
  const angled = {
    lon: 2.35,
    lat: 48.86,
    height: 5000,
    heading: 5.5,
    pitch: -0.5,
  };
  const flight = openingFlight({ target: angled, farHeight: FAR });
  assert.ok(flight.ms > PLANET_FLIGHT_MS);
  assert.ok(flight.ms <= PLANET_FLIGHT_MS + OPENING.approachMs[1]);
  const turned = flight.pose(PLANET_FLIGHT_MS);
  assert.ok(Math.abs(turned.height - 23e6) < 1, 'over the whole planet');
  assert.ok(Math.abs(turned.lon - angled.lon) < 1e-9);
  assert.ok(Math.abs(turned.lat - angled.lat) < 1e-9);
  assert.ok(Math.abs(turned.heading) < 1e-12);
  assert.equal(turned.pitch, -Math.PI / 2, 'straight down until then');
  const end = flight.pose(flight.ms);
  // 5.5 rad turns the short way round: -0.78 rad.
  assert.ok(Math.abs(end.heading - (5.5 - 2 * Math.PI)) < 1e-9);
  assert.ok(Math.abs(end.pitch - angled.pitch) < 1e-9);
  assert.ok(Math.abs(end.height - angled.height) < 1e-6);
  assert.ok(Math.abs(end.lon - angled.lon) < 1e-9);
});

test('a view further out than the planet turns at that height', () => {
  const far = { lon: -97.74, lat: 0, height: 2.8e8 };
  const flight = openingFlight({ target: far, farHeight: FAR });
  assert.equal(flight.ms, PLANET_FLIGHT_MS);
  assert.ok(Math.abs(flight.pose(OPENING.zoomMs).height - far.height) < 1);
  assert.ok(Math.abs(flight.pose(flight.ms).height - far.height) < 1);
});

test('the far start draws the globe the size of the pupil', () => {
  for (const radius of [12, 20, 64]) {
    const height = heightForGlobeRadius(radius, LENS);
    assert.ok(Math.abs(globeRadiusPx(height, LENS) - radius) < 1e-6);
  }
  assert.ok(globeRadiusPx(4e8, LENS) < globeRadiusPx(23e6, LENS));
});

test('reduced motion, embedded views, Stories links and ?intro=0 open without it', () => {
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
  assert.equal(openingWanted(win('?embed=1')), false);
  globalThis.GEV_EMBED_INLINE = true;
  try {
    assert.equal(openingWanted(win('')), false);
  } finally {
    delete globalThis.GEV_EMBED_INLINE;
  }
});

// A loading screen and a camera port; the test runs the frames by hand.
function stage({
  target = TARGET,
  width = 1280,
  height = 800,
  fovy = Math.PI / 4,
  planet = null,
} = {}) {
  const window = new Window({ width, height });
  const doc = window.document;
  doc.body.innerHTML = `
    <style>.cls-4 { opacity: 0.63; }</style>
    <div id="cesiumContainer"></div>
    <div id="loading-screen"><span class="loader-logo"><svg>
      <path id="outer_eye" d="M0,10C0,0,20,0,20,10C20,20,0,20,0,10ZM5,10h1"/>
      <path id="inner_eye"/>
      <path id="globe"/><path id="globe_cage" class="cls-4"/>
    </svg></span></div>`;
  const screen = doc.getElementById('loading-screen');
  doc.getElementById('cesiumContainer').getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width,
    height,
  });
  if (planet) {
    doc.getElementById('globe').getBoundingClientRect = () => ({
      left: (width - planet) / 2,
      top: (height - planet) / 2,
      width: planet,
      height: planet,
    });
  }
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
  let current = { ...target, fovy };
  const camera = {
    pose: () => ({ ...current }),
    rawMove(pose) {
      current = { ...pose, fovy };
    },
    setView(spec) {
      views.push(spec);
      current = { ...spec.destination, ...spec.orientation, fovy };
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
    doc,
    current: () => current,
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
    advanceTo(ms, stepMs = 1000 / 60) {
      while (now < ms) this.advance(Math.min(stepMs, ms - now));
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
  s.advance(10000);
  await opening.done;
  const last = s.views.at(-1);
  assert.deepEqual(last.destination, LANDED);
  assert.equal(last.orientation.heading, TARGET.heading);
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

const HOME = { ...TARGET, pitch: -Math.PI / 2, roll: 0 };
const CLOSE = {
  lon: 2.3522,
  lat: 48.8566,
  height: 5000,
  heading: 0,
  pitch: -0.61,
  roll: Math.PI / 6,
};

test("a move made on the renderer's own camera stops it there", async () => {
  const s = stage({ target: HOME });
  const opening = s.play();
  s.advance(2000);
  const park = { ...HOME, lon: -121.49, lat: 38.5816, height: 900 };
  s.camera.rawMove(park);
  s.advance(16);
  assert.equal(s.current().lat, park.lat);
  s.advanceTo(15000);
  await opening.done;
  assert.equal(s.current().lat, park.lat);
});

test('a shared roll survives the landing and a skip', async () => {
  for (const skip of [false, true]) {
    const s = stage({ target: CLOSE });
    const opening = s.play();
    if (skip) {
      s.advance(2000);
      s.window.dispatchEvent(new s.window.Event('keydown'));
    } else {
      s.advanceTo(15000);
    }
    await opening.done;
    assert.ok(Math.abs(s.views.at(-1).orientation.roll - CLOSE.roll) < 1e-9);
  }
});

test('a view at or below the ellipsoid plays no opening', () => {
  for (const height of [-100, 0]) {
    const s = stage({ target: { ...CLOSE, lon: 35.5, lat: 31.5, height } });
    assert.equal(s.play(), null);
    assert.equal(s.views.length, 0);
    assert.equal(s.screen.classList.contains('opening'), false);
  }
});

test('a view just below the planet height lands without a jump', async () => {
  const target = { ...HOME, lon: 10, lat: 50, height: 21e6 };
  const flight = openingFlight({ target, farHeight: FAR });
  const s = stage({ target });
  const opening = s.play();
  s.advanceTo(OPENING.centreMs + OPENING.flightStartMs + flight.ms + 50, 1);
  await opening.done;
  assert.equal(s.views.at(-1).destination.height, target.height);
  assert.ok(Math.abs(s.views.at(-2).destination.height - target.height) < 1000);
});

test('on any screen the drawn planet matches the globe once the logo is centred', () => {
  for (const [width, height] of [
    [1280, 800],
    [2560, 1440],
    [3440, 1440],
    [3840, 2160],
  ]) {
    const fovy = 2 * Math.atan((Math.tan(Math.PI / 6) * height) / width);
    const s = stage({ target: HOME, width, height, fovy, planet: 64 });
    const opening = s.play();
    const logo = s.screen.querySelector('.loader-logo');
    for (const at of [900, 1800]) {
      s.advanceTo(at);
      const scale = Number(/scale\(([^)]+)\)/.exec(logo.style.transform)[1]);
      const radius = globeRadiusPx(s.current().height, {
        fovy,
        viewportHeight: height,
      });
      assert.ok(
        Math.abs(32 * scale - radius) < 1,
        `${width}×${height} at ${at} ms`,
      );
    }
    opening.cancel();
  }
});

test("the logo's grid fades from its own opacity", () => {
  const s = stage();
  const cage = s.doc.getElementById('globe_cage');
  const opening = s.play();
  assert.equal(Number(s.window.getComputedStyle(cage).opacity), 0.63);
  // Halfway through the drawn planet's fade.
  const [from, to] = OPENING.pupilMs;
  s.advance(OPENING.centreMs + (from + to) / 2);
  assert.ok(
    Math.abs(Number(s.window.getComputedStyle(cage).opacity) - 0.315) < 0.01,
  );
  opening.cancel();
});

test('a lone click lands the opening before its handler reads the camera', async () => {
  const s = stage({ target: CLOSE });
  const opening = s.play();
  s.advanceTo(3000);
  const button = s.doc.createElement('button');
  s.doc.body.appendChild(button);
  let seen;
  button.addEventListener('click', () => {
    seen = s.current();
  });
  button.click();
  assert.equal(seen.height, CLOSE.height);
  await opening.done;
});
