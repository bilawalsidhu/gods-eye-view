// src/layers/awareness/rangeRing.test.mjs — the 250 km Global Context range
// ring is a haloed line that stays legible on light and dark ground, sits
// where the old ellipse outline did, and follows the subject. Dim sonar
// pulses grow slowly from the subject to the ring, each a haloed line with
// an inward-fading band behind it drawn on one flat canvas-filled ellipse;
// the ring dims and flashes as each one arrives and the overlay's echo field
// follows the subject. All of it goes through the draw port, unpickable. The
// pulses run for a bounded time after a selection or camera move, then rest
// with the ring steady. Under reduced motion the ring simply stays on screen.
import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { AWARENESS_RADIUS_M } from '../../data/militaryAwarenessEngine.js';
import {
  AWARENESS_RANGE_ECHO,
  AWARENESS_RANGE_PULSE,
  AWARENESS_RANGE_RING_STYLE,
  CONTEXT_RIM_HEIGHT_M,
} from './policy.js';
import { CYBER_SONAR_RENDER_INTERVAL_MS } from '../../cyberSonar.js';
import {
  AWARENESS_BAND_PIXELS,
  awarenessPulseLevel,
  awarenessPulseState,
  awarenessRangeRingPositions,
  awarenessRingFlash,
  createRendering,
  paintAwarenessBand,
  wakeAwarenessPulses,
} from './rendering.js';
import { getAwarenessEchoField } from '../../awarenessEcho.js';
import { createLifecycle } from './lifecycle.js';
import { createState } from './state.js';
import { bindFakeCesiumCamera } from '../../testSupport/fakeCameraPort.mjs';
import { fakeScenePorts } from '../../testSupport/fakeCesiumScene.mjs';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

/** WCAG relative luminance of a Cesium colour, ignoring alpha. */
function luminance(color) {
  const channel = (c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return (
    0.2126 * channel(color.red) +
    0.7152 * channel(color.green) +
    0.0722 * channel(color.blue)
  );
}

/** A CSS colour as the ring's draw-port colour: channels 0 to 1. */
function rgba(css) {
  const c = Cesium.Color.fromCssColorString(css);
  return [c.red, c.green, c.blue, c.alpha];
}

const close = (a, b, eps = 1e-9) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);

/**
 * A 2D canvas double: its context makes image data and keeps the last one
 * put, so a test can read what the band painted.
 */
function fakeCanvas() {
  const canvas = { width: 0, height: 0, painted: null };
  const context = {
    createImageData: (width, height) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData(image) {
      canvas.painted = image;
    },
  };
  canvas.getContext = (kind) => (kind === '2d' ? context : null);
  return canvas;
}

/**
 * The first index where two byte arrays differ, -1 when they match: a
 * bounded comparison for whole images.
 */
function firstMismatch(a, b) {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/** A Cesium scene double with the frame events the frame port listens to. */
const sceneDouble = () => ({
  preRender: new Cesium.Event(),
  postRender: new Cesium.Event(),
  screenSpaceCameraController: { enableInputs: true },
  requestRender() {},
});

/** A viewer double bound to fake camera, frame, query and draw ports. */
function viewerDouble(entities) {
  const viewer = {
    entities,
    scene: sceneDouble(),
    canvas: new EventTarget(),
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(3, 20, 800_000),
      positionCartographic: { height: 800_000 },
      heading: 0,
      pitch: -1,
      roll: 0,
    },
  };
  const ports = fakeScenePorts(viewer);
  bindFakeCesiumCamera(viewer, ports);
  return { viewer, draw: ports.draw };
}

/**
 * The rendering part over a viewer double, counting render asks and by
 * reason. `reducedMotion` stubs the media query for the length of the test;
 * `motion.set(on)` flips it later and tells its listeners, as the browser
 * does. Canvases are doubles that keep what is painted on them.
 */
function ringRendering(t, { reducedMotion = false, legacyQuery = false } = {}) {
  const previous = globalThis.matchMedia;
  const listeners = new Set();
  // `legacyQuery` is a MediaQueryList as Safari before 14 shipped it, with
  // only addListener / removeListener.
  const query = legacyQuery
    ? {
        get matches() {
          return reducedMotion;
        },
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener),
      }
    : {
        get matches() {
          return reducedMotion;
        },
        addEventListener(type, listener) {
          if (type === 'change') listeners.add(listener);
        },
        removeEventListener(type, listener) {
          if (type === 'change') listeners.delete(listener);
        },
      };
  globalThis.matchMedia = (media) =>
    media === '(prefers-reduced-motion: reduce)'
      ? query
      : { matches: false, addEventListener() {}, removeEventListener() {} };
  t.after(() => {
    globalThis.matchMedia = previous;
  });
  const createElement = document.createElement.bind(document);
  t.mock.method(document, 'createElement', (tag, ...rest) =>
    tag === 'canvas' ? fakeCanvas() : createElement(tag, ...rest),
  );
  const motion = {
    set(on) {
      reducedMotion = on;
      for (const listener of [...listeners]) listener({ matches: on });
    },
    /** Change the preference without a change event, as old browsers do. */
    setQuietly(on) {
      reducedMotion = on;
    },
    listeners: () => listeners.size,
  };
  const state = createState({ services: {} });
  const entities = new Cesium.EntityCollection();
  const { viewer, draw } = viewerDouble(entities);
  state.viewer = viewer;
  const reasons = [];
  const rendering = createRendering({
    state,
    services: {
      geometry: {},
      render: {
        governorRequestRender(reason) {
          reasons.push(reason);
        },
      },
    },
    parts: {},
  });
  // A shown ring keeps a pulse timer; never leave one running past a test.
  t.after(() => rendering.clearVisual());
  return {
    state,
    entities,
    scene: viewer.scene,
    draw,
    rendering,
    motion,
    reasons,
    renders: () => reasons.filter((r) => r === 'awareness-visual').length,
    pulseFrames: () => reasons.filter((r) => r === 'awareness-pulse').length,
  };
}

/**
 * A request-render scene on a fake clock: `performance.now()` and the
 * timers advance together, and any render ask is drawn (preRender, then
 * postRender) on the next millisecond, as Cesium's request-render mode does.
 * `draw()` draws a frame someone else asked for.
 */
function frameLoop(t, ring, { date = false } = {}) {
  let clock = 1_000_000;
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({
    apis: date
      ? ['setTimeout', 'setInterval', 'Date']
      : ['setTimeout', 'setInterval'],
    now: clock,
  });
  let drawn = 0;
  const draw = () => {
    drawn = ring.reasons.length;
    ring.state.viewer.scene.preRender.raiseEvent(ring.state.viewer.scene);
    ring.state.viewer.scene.postRender.raiseEvent(ring.state.viewer.scene);
  };
  return {
    now: () => clock,
    draw,
    advance(ms) {
      for (let step = 0; step < ms; step++) {
        clock++;
        t.mock.timers.tick(1);
        if (ring.reasons.length > drawn) draw();
      }
    },
  };
}

/** The ring's live draw sets on `draw`: its lines and its band. */
function ringSets(draw) {
  const live = [...draw.sets.values()].filter(
    (record) => !record.disposed && record.spec.id.startsWith('awareness:'),
  );
  return {
    lines: live.find((record) => record.kind === 'lines'),
    band: live.find((record) => record.kind === 'shapes'),
    count: live.length,
  };
}

/** The ring's lines and band items as drawn now. */
function drawn(ring) {
  const { lines, band } = ringSets(ring.draw);
  const item = (id) => lines?.items.get(id);
  // A haloed line is one item; its halo is the style's outline.
  const haloOf = (line) =>
    line && {
      ...line,
      style: { kind: 'solid', color: line.style.outline.color },
    };
  const pulses = [...(lines?.items.keys() ?? [])].filter((id) =>
    id.startsWith('pulse:'),
  );
  return {
    core: item('ring'),
    halo: haloOf(item('ring')),
    pulse: (index, part = 'core') =>
      part === 'halo' ? haloOf(item(`pulse:${index}`)) : item(`pulse:${index}`),
    pulses,
    band: band?.items.get('band'),
    lines,
    bandSet: band,
  };
}

const flight = (lon) => ({
  layerId: 'flights',
  id: 'abc123',
  position: Cesium.Cartesian3.fromDegrees(lon, 27, 9000),
});

/** Surface distance from `center` to each ring position. */
function surfaceDistances(center, positions) {
  const from = Cesium.Cartographic.fromCartesian(center);
  return positions.map((position) => {
    const to = Cesium.Cartographic.fromCartesian(
      Cesium.Cartesian3.clone(position),
    );
    return new Cesium.EllipsoidGeodesic(from, to).surfaceDistance;
  });
}

for (const [place, lat, lon] of [
  ['equator', 0, 0],
  ['Sahara', 27, 3],
  ['Greenland', 72, -40],
  ['antimeridian', 10, 179.9],
]) {
  test(`ring positions stay 250 km from the subject at ${place}`, () => {
    const center = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
    const positions = awarenessRangeRingPositions(
      center,
      AWARENESS_RADIUS_M,
      CONTEXT_RIM_HEIGHT_M,
    );
    assert.equal(positions.length, AWARENESS_RANGE_RING_STYLE.segments + 1);
    assert.ok(
      Cesium.Cartesian3.equalsEpsilon(positions[0], positions.at(-1), 0, 1e-6),
      'the ring closes on itself',
    );
    // Within 100 m of 250 km on the WGS84 ellipsoid.
    for (const distance of surfaceDistances(center, positions))
      assert.ok(Math.abs(distance - AWARENESS_RADIUS_M) < 100, `${distance} m`);
    for (const position of positions)
      assert.ok(
        Math.abs(
          Cesium.Cartographic.fromCartesian(position).height -
            CONTEXT_RIM_HEIGHT_M,
        ) < 1e-3,
      );
  });
}

for (const [place, lat, lon] of [
  ['the North Pole', 90, 0],
  ['the South Pole', -90, 0],
  ['1e-7° from the North Pole', 90 - 1e-7, 45],
  ['1e-8° from the South Pole', -90 + 1e-8, -120],
]) {
  test(`the ring stays a full circle at ${place}`, () => {
    const center = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
    const segments = AWARENESS_RANGE_RING_STYLE.segments;
    const positions = awarenessRangeRingPositions(
      center,
      AWARENESS_RADIUS_M,
      CONTEXT_RIM_HEIGHT_M,
    );
    assert.equal(positions.length, segments + 1);
    assert.ok(
      Cesium.Cartesian3.equalsEpsilon(positions[0], positions.at(-1), 0, 1e-6),
      'the ring closes on itself',
    );
    const distinct = new Set(
      positions
        .slice(0, segments)
        .map(({ x, y, z }) => [x, y, z].map((v) => v.toFixed(1)).join()),
    );
    assert.equal(distinct.size, segments, 'every vertex is its own point');
    // Ordinary chords are 2π × 250 km / 128 ≈ 12.3 km long.
    for (let i = 0; i < segments; i++) {
      const chord = Cesium.Cartesian3.distance(positions[i], positions[i + 1]);
      assert.ok(chord > 11_500 && chord < 13_000, `chord ${i}: ${chord} m`);
    }
    for (const distance of surfaceDistances(center, positions))
      assert.ok(Math.abs(distance - AWARENESS_RADIUS_M) < 100, `${distance} m`);
  });
}

test('the ring core and halo contrast on light and dark ground', () => {
  const core = Cesium.Color.fromCssColorString(
    AWARENESS_RANGE_RING_STYLE.color,
  );
  const halo = Cesium.Color.fromCssColorString(
    AWARENESS_RANGE_RING_STYLE.outlineColor,
  );
  // Core against halo is the edge that survives bright desert and snow, and
  // the monochrome styles that map everything to luminance.
  const ratio = (luminance(core) + 0.05) / (luminance(halo) + 0.05);
  assert.ok(ratio >= 4.5, `core:halo contrast ${ratio.toFixed(2)}`);
  assert.ok(core.alpha >= 0.9 && halo.alpha >= 0.7);
  // A visible halo, half on each side, around a core at least 2 px wide.
  const { width, outlineWidth } = AWARENESS_RANGE_RING_STYLE;
  assert.ok(outlineWidth >= 1);
  assert.ok(width - outlineWidth >= 2);
});

test('renderVisual draws the ring as a haloed line in an unpickable set, never an entity', (t) => {
  const ring = ringRendering(t);
  const { entities, state, rendering } = ring;
  frameLoop(t, ring); // freeze the clock: the pulses have not faded in yet
  rendering.renderVisual(flight(3));
  assert.equal(entities.values.length, 0);
  const { core, halo, lines } = drawn(ring);
  assert.equal(lines.spec.pickable, false);
  // 4 px wide in all, a 1 px halo on each side of a 2 px core, in one
  // line, straight 3D chords between surface-following positions.
  assert.equal(core.widthPx, AWARENESS_RANGE_RING_STYLE.width);
  assert.equal(
    core.style.outline.widthPx,
    AWARENESS_RANGE_RING_STYLE.outlineWidth,
  );
  assert.equal(core.mode, '3d');
  assert.equal(core.positions, state.visual.ringPositions);
  assert.equal(halo.positions, core.positions);
  // At the moment it appears, before the pulses fade in, it is at full.
  assert.equal(core.style.kind, 'solid');
  assert.ok(close(core.style.color, rgba(AWARENESS_RANGE_RING_STYLE.color)));
  assert.ok(
    close(halo.style.color, rgba(AWARENESS_RANGE_RING_STYLE.outlineColor)),
  );
  const ground = Cesium.Cartesian3.fromDegrees(3, 27, 0);
  for (const distance of surfaceDistances(ground, state.visual.ringPositions))
    assert.ok(Math.abs(distance - AWARENESS_RADIUS_M) < 100);
});

test('the ring follows the subject past 250 m and ignores smaller drift', (t) => {
  const ring = ringRendering(t);
  const { state, rendering, renders } = ring;
  rendering.renderVisual(flight(3));
  const sets = ringSets(ring.draw);
  const first = state.visual.ringPositions;
  const rendersAfterAdd = renders();
  // ~100 m east: under the threshold, nothing is redrawn or rendered.
  rendering.renderVisual(flight(3.001));
  assert.equal(state.visual.ringPositions, first);
  assert.equal(drawn(ring).core.positions, first);
  assert.equal(renders(), rendersAfterAdd);
  // ~1 km east: the ring is drawn around the new centre, in the same sets.
  rendering.renderVisual(flight(3.01));
  const moved = state.visual.ringPositions;
  assert.notEqual(moved, first);
  assert.equal(drawn(ring).core.positions, moved);
  assert.equal(ringSets(ring.draw).lines, sets.lines);
  for (const distance of surfaceDistances(
    Cesium.Cartesian3.fromDegrees(3.01, 27, 0),
    moved,
  ))
    assert.ok(Math.abs(distance - AWARENESS_RADIUS_M) < 100);
  assert.equal(renders(), rendersAfterAdd + 1);
  rendering.clearVisual();
  assert.equal(sets.lines.items.size, 0);
  assert.equal(sets.band.items.size, 0);
});

test('a pulse grows slowly from the subject and arrives dim at the ring', () => {
  const {
    periodMs,
    count,
    startFraction,
    fadeInFraction,
    peakOpacity,
    endOpacityFraction,
  } = AWARENESS_RANGE_PULSE;
  const at = (phase) => awarenessPulseState(phase * periodMs, 0);
  // Starts small and invisible, so nothing pops in at the centre.
  assert.equal(at(0).radiusM, AWARENESS_RADIUS_M * startFraction);
  assert.equal(at(0).alpha, 0);
  // Dim: never brighter than `peakOpacity`, which sits well under the ring.
  let brightest = 0;
  for (let phase = 0; phase < 1; phase += 0.005) {
    const { alpha } = at(phase);
    assert.ok(alpha >= 0 && alpha <= peakOpacity, `alpha ${alpha} at ${phase}`);
    brightest = Math.max(brightest, alpha);
  }
  assert.ok(Math.abs(brightest - at(fadeInFraction).alpha) < 0.01);
  assert.ok(peakOpacity <= 0.6);
  // Fading as it travels, but still visible when it reaches the ring, where
  // the ring takes over with its flash.
  assert.ok(at(0.5).alpha < at(0.25).alpha);
  assert.ok(at(0.9).alpha < at(0.5).alpha);
  assert.ok(
    Math.abs(at(0.999).alpha - peakOpacity * endOpacityFraction) < 0.01,
  );
  assert.ok(at(0.999).alpha >= 0.15, 'the arriving pulse is still visible');
  assert.ok(Math.abs(at(0.999).radiusM - AWARENESS_RADIUS_M) < 300);
  // Constant speed: equal time steps add equal radius.
  const step = at(0.4).radiusM - at(0.3).radiusM;
  assert.ok(Math.abs(at(0.7).radiusM - at(0.6).radiusM - step) < 1e-6);
  // Calm: a new pulse at most every 2.5 s, crossing 250 km in 8 s or more.
  assert.ok(periodMs / count >= 2500);
  assert.ok(periodMs >= 8000);
  // Pulses are evenly staggered across one period, and the cycle repeats.
  const near = (a, b) =>
    Math.abs(a.radiusM - b.radiusM) < 1e-6 &&
    Math.abs(a.alpha - b.alpha) < 1e-9;
  for (let index = 1; index < count; index++)
    assert.ok(
      near(
        awarenessPulseState(0, index),
        awarenessPulseState((index / count) * periodMs, 0),
      ),
    );
  assert.ok(
    near(
      awarenessPulseState(periodMs * 7 + 123, 1),
      awarenessPulseState(123, 1),
    ),
  );
});

test('pulses ask for a frame 80 ms after each drawn frame instead of holding continuous rendering', (t) => {
  const ring = ringRendering(t);
  const { rendering, pulseFrames } = ring;
  const loop = frameLoop(t, ring);
  rendering.renderVisual(flight(3));
  // A Contacts view repaints at the Cyber sonar cadence, ~12.5 fps, while
  // the pulses run, never every display frame.
  assert.equal(pulseFrames(), 0);
  loop.advance(1); // the frame the new ring asked for arms the first request
  loop.advance(CYBER_SONAR_RENDER_INTERVAL_MS * 10);
  assert.ok(Math.abs(pulseFrames() - 10) <= 1, `${pulseFrames()} frames`);
  const frames = pulseFrames();
  rendering.clearVisual();
  assert.equal(ringSets(ring.draw).lines.items.size, 0);
  assert.equal(ring.scene.postRender.numberOfListeners, 0);
  loop.advance(CYBER_SONAR_RENDER_INTERVAL_MS * 10);
  assert.equal(pulseFrames(), frames, 'no frames once the ring is gone');
});

test('a pulse frame draws the step made before it was asked for; a moving camera steps nothing sooner', (t) => {
  const ring = ringRendering(t);
  const { rendering, state } = ring;
  const loop = frameLoop(t, ring);
  rendering.renderVisual(flight(3));
  loop.advance(1);
  // Each pulse request comes with its step already made, so the frame it
  // asks for steps nothing more and asks for no other.
  const asked = [];
  const push = ring.reasons.push;
  ring.reasons.push = function (reason) {
    asked.push([reason, state.visual.lastStepMs, performance.now()]);
    return push.call(this, reason);
  };
  let steps = 0;
  const step = state.visual.step;
  state.visual.step = (nowMs) => {
    steps += 1;
    step(nowMs);
  };
  loop.advance(CYBER_SONAR_RENDER_INTERVAL_MS * 10);
  const pulses = asked.filter(([reason]) => reason === 'awareness-pulse');
  assert.ok(pulses.length >= 9, `${pulses.length} pulse frames`);
  for (const [, stepMs, nowMs] of pulses) assert.equal(stepMs, nowMs);
  assert.equal(steps, pulses.length, 'one step a pulse frame');
  // The fronts and band are fixed in the world: frames the camera moves
  // in within the interval step nothing, as a parked view's would not.
  steps = 0;
  const bandKey = drawn(ring).band.fill.image.key;
  for (let i = 0; i < 5; i++) {
    state.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
      3,
      20 + (i + 1) * 0.01,
      800_000,
    );
    loop.draw();
  }
  assert.equal(steps, 0);
  assert.equal(drawn(ring).band.fill.image.key, bandKey);
  // Nor do frames a user's drag draws, each waking the running pulses.
  for (let i = 0; i < 3; i++) {
    rendering.wakePulses();
    loop.draw();
  }
  assert.equal(steps, 0, 'a drag keeps the interval');
  // Crossing below the rim height hides them at once, interval or not.
  state.viewer.camera.positionCartographic = { height: 1_000 };
  loop.draw();
  assert.equal(steps, 1);
  assert.equal(drawn(ring).pulse(0).show, false);
  assert.equal(drawn(ring).band.show, false);
});

test('a parked view stops asking for frames once the pulses rest', (t) => {
  const ring = ringRendering(t);
  const { rendering, pulseFrames } = ring;
  const loop = frameLoop(t, ring);
  const { activeMs, count, periodMs } = AWARENESS_RANGE_PULSE;
  // Long enough for three ring flashes, then quiet, and short: a burst is
  // seconds, not minutes.
  assert.ok(activeMs >= 3 * (periodMs / count));
  assert.ok(activeMs <= 15_000, `${activeMs} ms burst`);
  rendering.renderVisual(flight(3));
  loop.advance(activeMs + 500);
  const frames = pulseFrames();
  assert.ok(frames >= activeMs / CYBER_SONAR_RENDER_INTERVAL_MS - 2);
  assert.ok(
    frames <= activeMs / CYBER_SONAR_RENDER_INTERVAL_MS + 2,
    `${frames} frames in one burst`,
  );
  // Parked: a minute later not one more request.
  loop.advance(60_000);
  assert.equal(pulseFrames(), frames, 'render requests stop after the bound');
  // At rest the ring stands on screen at full, as without pulses, and the
  // pulses, gradient and echoes are hidden.
  const now = drawn(ring);
  assert.ok(
    close(now.core.style.color, rgba(AWARENESS_RANGE_RING_STYLE.color)),
  );
  for (let index = 0; index < AWARENESS_RANGE_PULSE.count; index++)
    assert.equal(now.pulse(index).show, false);
  assert.equal(now.band.show, false);
  assert.equal(getAwarenessEchoField().level(loop.now()), 0);
});

test('a camera move wakes resting pulses for another bounded run', (t) => {
  const ring = ringRendering(t);
  const { rendering, pulseFrames } = ring;
  const loop = frameLoop(t, ring);
  const { activeMs } = AWARENESS_RANGE_PULSE;
  rendering.renderVisual(flight(3));
  loop.advance(activeMs + 500);
  const rested = pulseFrames();
  // The camera moves: lifecycle wakes the pulses inside the frame it draws,
  // and that frame arms the next request. Waking asks for none of its own.
  rendering.wakePulses();
  assert.equal(pulseFrames(), rested);
  loop.draw();
  loop.advance(activeMs + 500);
  const woke = pulseFrames() - rested;
  assert.ok(woke >= activeMs / CYBER_SONAR_RENDER_INTERVAL_MS - 2, `${woke}`);
  loop.advance(60_000);
  assert.equal(pulseFrames(), rested + woke, 'and rest again');
  // The subject moving does not wake them: a flying subject moves on every
  // refresh, which would bring the endless repaint back.
  rendering.renderVisual(flight(3.01));
  loop.advance(10_000);
  assert.equal(pulseFrames(), rested + woke);
});

test('a camera move seen by the lifecycle wakes resting pulses; a parked camera does not', (t) => {
  const ring = ringRendering(t);
  const { state, rendering, pulseFrames } = ring;
  const loop = frameLoop(t, ring, { date: true });
  const { activeMs, inputWakeMs } = AWARENESS_RANGE_PULSE;
  state.enabled = true;
  const touch = () =>
    state.viewer.canvas.dispatchEvent(new Event('pointerdown'));
  const lifecycle = createLifecycle({
    state,
    services: {
      render: { holdContinuousRender() {}, releaseContinuousRender() {} },
    },
    parts: {
      rendering,
      model: {
        awarenessRefreshDecision: () => ({ moving: false, refresh: false }),
        awarenessNeedsContinuousRender: () => false,
      },
    },
  });
  lifecycle.attachRuntimeListeners();
  t.after(() => lifecycle.detachRuntimeListeners());
  rendering.renderVisual(flight(3));
  loop.advance(activeMs + 500);
  const rested = pulseFrames();
  // Parked: frames other owners draw do not wake the pulses.
  loop.draw();
  loop.advance(activeMs);
  assert.equal(pulseFrames(), rested);
  // The user drags the camera 50 km: the next frame wakes them for another
  // run.
  touch();
  state.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
    3.5,
    20,
    800_000,
  );
  loop.draw();
  loop.advance(activeMs + 500);
  assert.ok(
    pulseFrames() - rested >= activeMs / CYBER_SONAR_RENDER_INTERVAL_MS - 2,
  );
  const woke = pulseFrames();
  loop.advance(60_000);
  assert.equal(pulseFrames(), woke, 'and rest again once it parks');
  // The app moving the camera, with no hand on it, does not wake them: a
  // tracking follow, the cockpit view, an orbit or a fly-to all move it on
  // every frame.
  const follow = (lon) => {
    state.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
      lon,
      20,
      800_000,
    );
    loop.draw();
    loop.advance(500);
  };
  for (let lon = 3.6; lon < 5.6; lon += 0.1) follow(lon);
  assert.equal(pulseFrames(), woke, 'app camera moves do not wake them');
  // Input long past (beyond `inputWakeMs`) does not count either; a hover
  // without a button pressed is not handling the camera.
  touch();
  loop.advance(inputWakeMs + 100);
  state.viewer.canvas.dispatchEvent(
    Object.assign(new Event('pointermove'), { buttons: 0 }),
  );
  follow(5.7);
  assert.equal(pulseFrames(), woke, 'stale input does not wake them');
  // Each way of handling the map counts: a wheel, a touch, a drag; keys
  // typed anywhere in the window do not.
  const panWith = (handle, lon) => {
    loop.advance(activeMs + 500);
    const before = pulseFrames();
    handle();
    follow(lon);
    loop.advance(activeMs);
    return pulseFrames() > before;
  };
  const onCanvas = (event) => () => state.viewer.canvas.dispatchEvent(event);
  assert.equal(panWith(onCanvas(new Event('wheel')), 5.8), true, 'wheel');
  assert.equal(panWith(onCanvas(new Event('touchstart')), 5.9), true, 'touch');
  assert.equal(
    panWith(
      onCanvas(Object.assign(new Event('pointermove'), { buttons: 1 })),
      6.0,
    ),
    true,
    'drag',
  );
  assert.equal(
    panWith(() => window.dispatchEvent(new Event('keydown')), 6.1),
    false,
    'keys do not count',
  );
  // Detached, the canvas listeners are gone.
  lifecycle.detachRuntimeListeners();
  touch();
  assert.equal(state.lastCameraInputMs < Date.now() - inputWakeMs, true);
});

/**
 * The lifecycle's camera-input listeners over `ring`, with a camera the test
 * moves by longitude (`pan`) and a camera controller whose inputs it can
 * switch off, as the cockpit view does. Pulses start resting.
 */
function inputLifecycle(t, ring) {
  const { state, rendering } = ring;
  const loop = frameLoop(t, ring, { date: true });
  state.enabled = true;
  const lifecycle = createLifecycle({
    state,
    services: {
      render: { holdContinuousRender() {}, releaseContinuousRender() {} },
    },
    parts: {
      rendering,
      model: {
        awarenessRefreshDecision: () => ({ moving: false, refresh: false }),
        awarenessNeedsContinuousRender: () => false,
      },
    },
  });
  lifecycle.attachRuntimeListeners();
  t.after(() => lifecycle.detachRuntimeListeners());
  rendering.renderVisual(flight(3));
  loop.advance(AWARENESS_RANGE_PULSE.activeMs + 500);
  let lon = 3;
  return {
    loop,
    lifecycle,
    controller: state.viewer.scene.screenSpaceCameraController,
    dispatch: (type, init = {}) =>
      state.viewer.canvas.dispatchEvent(Object.assign(new Event(type), init)),
    pan(stepDeg = 0.1) {
      lon += stepDeg;
      state.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
        lon,
        20,
        800_000,
      );
      loop.draw();
    },
    /** Whether the pulses drew frames during the next `ms`. */
    pulsing(ms = AWARENESS_RANGE_PULSE.activeMs) {
      const before = ring.pulseFrames();
      loop.advance(ms);
      return ring.pulseFrames() > before;
    },
  };
}

test('input the camera controller ignores, as in the cockpit, does not wake the pulses', (t) => {
  const ring = ringRendering(t);
  const { activeMs } = AWARENESS_RANGE_PULSE;
  const { controller, dispatch, pan, pulsing, loop } = inputLifecycle(t, ring);
  // The cockpit takes the camera: clicks, drags and wheels on the canvas
  // move nothing, while the cockpit itself moves the camera every frame.
  controller.enableInputs = false;
  for (const [type, init] of [
    ['pointerdown', {}],
    ['pointermove', { buttons: 1 }],
    ['wheel', {}],
    ['touchstart', {}],
  ]) {
    dispatch(type, init);
    pan();
    assert.equal(pulsing(), false, `${type} in the cockpit`);
  }
  // A gesture that began just before the cockpit took the camera is
  // dropped too, rather than waking the pulses on the cockpit's first move.
  controller.enableInputs = true;
  loop.advance(activeMs);
  dispatch('pointerdown');
  controller.enableInputs = false;
  pan();
  assert.equal(pulsing(), false, 'a gesture cut off by the cockpit');
  controller.enableInputs = true;
  pan();
  assert.equal(pulsing(), false, 'and stays dropped once it hands back');
  // Back in the user's hands, a drag wakes them again.
  dispatch('pointerdown');
  pan();
  assert.equal(pulsing(), true, 'a drag after the cockpit');
});

test('a long drag or touch keeps the pulses awake after it leaves the canvas', (t) => {
  const ring = ringRendering(t);
  const { inputWakeMs } = AWARENESS_RANGE_PULSE;
  const { dispatch, pan, pulsing, loop, lifecycle } = inputLifecycle(t, ring);
  const onDocument = (type, init = {}) =>
    document.dispatchEvent(Object.assign(new Event(type), init));
  // The gesture starts on the canvas and carries on past `inputWakeMs`
  // outside it, where Cesium still follows it at document level.
  const longGesture = (start, move, init) => {
    dispatch(start, init);
    for (let ms = 0; ms < inputWakeMs + 1000; ms += 250) {
      loop.advance(250);
      onDocument(move, init);
    }
  };
  for (const [start, move, end, init] of [
    ['pointerdown', 'pointermove', 'pointerup', { buttons: 1 }],
    ['touchstart', 'touchmove', 'touchend', {}],
    ['touchstart', 'touchmove', 'touchcancel', {}],
  ]) {
    longGesture(start, move, init);
    pan();
    assert.equal(pulsing(), true, `${move} outside the canvas`);
    // Once it ends, moves elsewhere are not handling the map.
    onDocument(end);
    loop.advance(inputWakeMs + 100);
    onDocument(move, init);
    pan();
    assert.equal(pulsing(), false, `${move} after ${end}`);
  }
  // Detaching mid-gesture drops the document listeners too.
  dispatch('pointerdown');
  lifecycle.detachRuntimeListeners();
  loop.advance(inputWakeMs + 100);
  const noted = ring.state.lastCameraInputMs;
  onDocument('pointermove', { buttons: 1 });
  assert.equal(ring.state.lastCameraInputMs, noted);
});

test('lifting one finger of a pinch leaves the other finger counting', (t) => {
  const ring = ringRendering(t);
  const { inputWakeMs } = AWARENESS_RANGE_PULSE;
  const { dispatch, pan, pulsing, loop } = inputLifecycle(t, ring);
  const onDocument = (type, init = {}) =>
    document.dispatchEvent(Object.assign(new Event(type), init));
  // Cesium carries on with a one-finger drag after the other lifts.
  const dragOn = (move, init) => {
    for (let ms = 0; ms < inputWakeMs + 1000; ms += 250) {
      loop.advance(250);
      onDocument(move, init);
    }
    pan();
    return pulsing();
  };
  // Without pointer events: the touch list says who is still down.
  dispatch('touchstart');
  onDocument('touchend', { touches: [{}] });
  assert.equal(dragOn('touchmove', {}), true, 'touch: one finger left');
  onDocument('touchend', { touches: [] });
  assert.equal(dragOn('touchmove', {}), false, 'touch: all lifted');
  // With pointer events: each contact has its own pointer id.
  dispatch('pointerdown', { pointerId: 1 });
  dispatch('pointerdown', { pointerId: 2 });
  onDocument('pointerup', { pointerId: 1 });
  const drag = { pointerId: 2, buttons: 1 };
  assert.equal(dragOn('pointermove', drag), true, 'pointer: one left');
  onDocument('pointercancel', { pointerId: 2 });
  assert.equal(dragOn('pointermove', drag), false, 'pointer: all lifted');
});

test('a gesture lost to a window blur or a hidden page stops counting', (t) => {
  const ring = ringRendering(t);
  const { inputWakeMs } = AWARENESS_RANGE_PULSE;
  const { dispatch, pan, pulsing, loop } = inputLifecycle(t, ring);
  const visibility = Object.getOwnPropertyDescriptor(
    document,
    'visibilityState',
  );
  t.after(() => {
    if (visibility)
      Object.defineProperty(document, 'visibilityState', visibility);
    else delete document.visibilityState;
  });
  const setVisibility = (value) =>
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => value,
    });
  for (const [name, lose] of [
    ['blur', () => window.dispatchEvent(new Event('blur'))],
    [
      'hidden',
      () => {
        setVisibility('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        setVisibility('visible');
      },
    ],
  ]) {
    // The release happens outside the window, so no end ever arrives.
    dispatch('pointerdown', { pointerId: 1 });
    lose();
    pan();
    assert.equal(pulsing(), false, `${name}: pending input dropped`);
    loop.advance(inputWakeMs + 100);
    const noted = ring.state.lastCameraInputMs;
    document.dispatchEvent(
      Object.assign(new Event('pointermove'), { pointerId: 1, buttons: 1 }),
    );
    assert.equal(ring.state.lastCameraInputMs, noted, `${name}: no follow`);
  }
  // A page coming back into view is no reason to drop a gesture.
  dispatch('pointerdown', { pointerId: 1 });
  document.dispatchEvent(new Event('visibilitychange'));
  loop.advance(inputWakeMs + 100);
  document.dispatchEvent(
    Object.assign(new Event('pointermove'), { pointerId: 1, buttons: 1 }),
  );
  pan();
  assert.equal(pulsing(), true, 'visible: still following');
});

test('disabling the layer tears the pulses down completely', (t) => {
  const ring = ringRendering(t);
  const { state, scene, rendering, motion, pulseFrames } = ring;
  const loop = frameLoop(t, ring);
  const lifecycle = createLifecycle({
    state,
    services: {
      render: { holdContinuousRender() {}, releaseContinuousRender() {} },
    },
    parts: {
      rendering,
      model: {
        awarenessRefreshDecision: () => ({ moving: false, refresh: false }),
        awarenessNeedsContinuousRender: () => false,
      },
      panel: {
        startAwarenessPageRotation() {},
        stopAwarenessPageRotation() {},
        ensurePanel() {},
        hidePanel() {},
      },
      dependencies: {
        activateOperationalContext: () => true,
        releaseOwnedDependencies: () => true,
      },
    },
  });
  state.passive = true;
  lifecycle.methods.enable();
  state.subject = flight(3);
  rendering.renderVisual(state.subject);
  loop.advance(1000);
  assert.ok(pulseFrames() > 0);
  const sets = ringSets(ring.draw);
  assert.ok(sets.lines.items.size > 0 && sets.band.items.size === 1);
  lifecycle.methods.disable();
  assert.equal(sets.lines.items.size, 0, 'ring and pulses removed');
  assert.equal(sets.band.items.size, 0, 'band removed');
  assert.equal(scene.preRender.numberOfListeners, 0);
  assert.equal(scene.postRender.numberOfListeners, 0);
  assert.equal(motion.listeners(), 0, 'no media-query listener');
  assert.equal(getAwarenessEchoField(), null);
  assert.equal(state.visual, null);
  const frames = pulseFrames();
  loop.advance(60_000);
  assert.equal(
    pulseFrames(),
    frames,
    'no awareness-pulse requests after disable',
  );
});

test('pulse requests wait 80 ms after any frame, so they cannot beat the Cyber sonar', (t) => {
  const ring = ringRendering(t);
  const { rendering, pulseFrames } = ring;
  const loop = frameLoop(t, ring);
  rendering.renderVisual(flight(3));
  loop.advance(1);
  const frames = pulseFrames();
  // Another owner (the Cyber sonar, a data update) draws 67 ms after ours.
  loop.advance(67);
  loop.draw();
  loop.advance(CYBER_SONAR_RENDER_INTERVAL_MS - 1);
  assert.equal(pulseFrames(), frames, 'no request 13 ms after that frame');
  loop.advance(1);
  assert.equal(pulseFrames(), frames + 1, 'one request 80 ms after it');
});

test('the pulse level fades in, holds, fades out and keeps its level when woken', () => {
  const { activeMs, settleMs } = AWARENESS_RANGE_PULSE;
  const wake = wakeAwarenessPulses(
    { startMs: -Infinity, untilMs: -Infinity },
    0,
  );
  assert.equal(awarenessPulseLevel(0, wake), 0);
  assert.ok(Math.abs(awarenessPulseLevel(settleMs / 2, wake) - 0.5) < 1e-9);
  assert.equal(awarenessPulseLevel(activeMs / 2, wake), 1);
  assert.ok(
    Math.abs(awarenessPulseLevel(activeMs - settleMs / 4, wake) - 0.25) < 1e-9,
  );
  assert.equal(awarenessPulseLevel(activeMs, wake), 0);
  assert.equal(awarenessPulseLevel(activeMs * 10, wake), 0);
  // Woken mid-fade-out: no jump back to full, then a fresh run.
  const at = activeMs - settleMs / 4;
  wakeAwarenessPulses(wake, at);
  assert.ok(Math.abs(awarenessPulseLevel(at, wake) - 0.25) < 1e-9);
  assert.equal(awarenessPulseLevel(at + settleMs, wake), 1);
  assert.equal(awarenessPulseLevel(at + activeMs, wake), 0);
});

test('a renderer without frame hooks gets the static ring only', (t) => {
  const ring = ringRendering(t);
  const { state, entities, rendering, pulseFrames } = ring;
  for (const scene of [{}, undefined]) {
    state.viewer = { entities, scene };
    const { draw } = bindFakeDraw(state.viewer);
    rendering.clearVisual();
    rendering.renderVisual(flight(3));
    // The ring is one line in an unpickable draw set, a bright core inside
    // a dark halo, and nothing animates.
    assert.equal(entities.values.length, 0);
    const { lines, band } = ringSets(draw);
    assert.equal(lines.spec.pickable, false);
    assert.deepEqual([...lines.items.keys()], ['ring']);
    assert.equal(band.items.size, 0, 'no band');
    const core = lines.items.get('ring');
    assert.ok(close(core.style.color, rgba(AWARENESS_RANGE_RING_STYLE.color)));
    rendering.clearVisual();
    assert.equal(lines.items.size, 0, 'clearing takes the ring away');
    assert.equal(state.visual, null);
  }
  assert.equal(pulseFrames(), 0);
});

test('the band fades inward from each front, in the ring blue, about the subject', () => {
  const size = 64;
  const image = { width: size, data: new Uint8ClampedArray(size * size * 4) };
  const { gradientDepthFraction: depth, gradientOpacity } =
    AWARENESS_RANGE_PULSE;
  const rangeM = 100;
  const spanM = 100;
  const band = (offset = { east: 0, north: 0 }) =>
    paintAwarenessBand(image, {
      radii: [0.8, 0],
      alphas: [0.5, 0],
      rgb: [0.25, 0.5, 1],
      spanM,
      rangeM,
      offset,
    });
  // Alpha at a pixel `fraction` of the range east of the canvas centre.
  const alphaEast = (fraction) => {
    const x = Math.floor(size / 2 + (fraction * size) / 2);
    const k = ((size / 2) * size + x) * 4;
    return image.data[k + 3] / 255;
  };
  band();
  const k = ((size / 2) * size + size / 2) * 4;
  assert.deepEqual([...image.data.slice(k, k + 3)], [64, 128, 255]);
  // Strongest just inside the front, nothing beyond it or `depth` inside.
  const peak = 0.5 * gradientOpacity;
  assert.ok(Math.abs(alphaEast(0.79) - peak) < 0.02, `${alphaEast(0.79)}`);
  assert.equal(alphaEast(0.85), 0);
  assert.equal(alphaEast(0.8 - depth - 0.1), 0);
  // Quadratic: half way in, a quarter as strong.
  assert.ok(
    Math.abs(alphaEast(0.8 - depth / 2) - peak / 4) < 0.02,
    `${alphaEast(0.8 - depth / 2)}`,
  );
  // The subject 20 m east of the canvas centre: the band moves with it.
  band({ east: 20, north: 0 });
  assert.ok(Math.abs(alphaEast(0.79 + 0.2) - peak) < 0.02);
  // 0.3 of the range from the subject: deeper than the band reaches.
  assert.equal(alphaEast(0.5), 0);
});

test('a band painted with a kept memo is the band painted afresh, step after step', () => {
  const size = 48;
  const fresh = () => ({
    width: size,
    data: new Uint8ClampedArray(size * size * 4),
  });
  const kept = [fresh(), fresh()];
  const memo = {};
  const steps = [
    { radii: [0.2, 0.5, 0.9], offset: { east: 0, north: 0 } },
    { radii: [0.25, 0.55, 0.95], offset: { east: 0, north: 0 } },
    { radii: [0.3, 0.6, 1], offset: { east: 7, north: -3 } },
    { radii: [0.05, 0.65, 0.4], offset: { east: 7, north: -3 } },
    { radii: [1.2, 0.1, 0], offset: { east: 7, north: -3 } },
  ];
  steps.forEach(({ radii, offset }, k) => {
    const band = {
      radii,
      alphas: radii.map((r, i) => 0.2 + 0.1 * i),
      rgb: k < 3 ? [0.25, 0.5, 1] : [1, 0.5, 0],
      spanM: 120,
      rangeM: 100,
      offset,
    };
    const image = kept[k % 2];
    paintAwarenessBand(image, band, memo);
    const expected = fresh();
    paintAwarenessBand(expected, band);
    assert.equal(firstMismatch(image.data, expected.data), -1, `step ${k}`);
  });
  // An image painted over by someone else is painted whole again.
  const image = kept[0];
  const band = {
    ...steps[0],
    alphas: [0.3, 0.3, 0.3],
    spanM: 120,
    rangeM: 100,
  };
  paintAwarenessBand(image, { ...band, rgb: [1, 0, 0] }, memo);
  paintAwarenessBand(image, { ...band, rgb: [0, 0, 1] });
  paintAwarenessBand(image, { ...band, rgb: [1, 0, 0] }, memo);
  const expected = fresh();
  paintAwarenessBand(expected, { ...band, rgb: [1, 0, 0] });
  assert.equal(firstMismatch(image.data, expected.data), -1, 'repainted');
  // Bytes that do not line up with whole words are painted a byte at a
  // time, the same.
  const odd = {
    width: size,
    data: new Uint8ClampedArray(new ArrayBuffer(size * size * 4 + 1), 1),
  };
  paintAwarenessBand(odd, { ...band, rgb: [1, 0, 0] }, memo);
  assert.equal(firstMismatch(odd.data, expected.data), -1, 'unaligned');
});

test('the band is one flat unpickable ellipse at the rim, drawn anew each step about the subject', (t) => {
  const ring = ringRendering(t);
  const { state, rendering } = ring;
  const loop = frameLoop(t, ring);
  rendering.renderVisual(flight(3));
  loop.advance(AWARENESS_RANGE_PULSE.settleMs + 500);
  const { band, bandSet } = drawn(ring);
  assert.equal(bandSet.spec.pickable, false);
  assert.equal(band.show, true);
  assert.equal(band.height, 'absolute');
  const { geometry } = band;
  assert.equal(geometry.kind, 'ellipse');
  assert.ok(Math.abs(geometry.center.lon - 3) < 1e-9);
  assert.ok(Math.abs(geometry.center.lat - 27) < 1e-9);
  assert.equal(geometry.center.height, CONTEXT_RIM_HEIGHT_M);
  // Wide enough for the band to follow the subject `gradientRebuildM` off.
  const spanM = AWARENESS_RADIUS_M + AWARENESS_RANGE_PULSE.gradientRebuildM;
  assert.equal(geometry.semiMajor, spanM);
  assert.equal(geometry.semiMinor, spanM);
  const { canvas, key } = band.fill.image;
  assert.equal(canvas.width, AWARENESS_BAND_PIXELS);
  // Each step paints the other canvas under a new key.
  loop.advance(CYBER_SONAR_RENDER_INTERVAL_MS + 2);
  const next = drawn(ring).band.fill.image;
  assert.notEqual(next.key, key);
  assert.notEqual(next.canvas, canvas);
  // What it painted is the band of the pulses as they were at that step.
  const at = state.visual.lastStepMs;
  const level = awarenessPulseLevel(at, state.visual.wake);
  const expected = { width: AWARENESS_BAND_PIXELS };
  expected.data = new Uint8ClampedArray(AWARENESS_BAND_PIXELS ** 2 * 4);
  const radii = [];
  const alphas = [];
  for (let index = 0; index < AWARENESS_RANGE_PULSE.count; index++) {
    const pulse = awarenessPulseState(at, index);
    radii.push(pulse.radiusM / AWARENESS_RADIUS_M);
    alphas.push(pulse.alpha * level);
  }
  paintAwarenessBand(expected, {
    radii,
    alphas,
    rgb: rgba(AWARENESS_RANGE_RING_STYLE.color),
    spanM,
    rangeM: AWARENESS_RADIUS_M,
    offset: { east: 0, north: 0 },
  });
  // Compared byte by byte: a failing deepEqual on a 256×256 image builds a
  // diff of every byte, which ran a test process out of memory.
  assert.equal(firstMismatch(next.canvas.painted.data, expected.data), -1);
  // Each front is a haloed line at its radius, faded with its pulse.
  for (let index = 0; index < AWARENESS_RANGE_PULSE.count; index++) {
    const core = drawn(ring).pulse(index);
    const halo = drawn(ring).pulse(index, 'halo');
    assert.equal(core.show, true);
    assert.equal(core.widthPx, AWARENESS_RANGE_PULSE.width);
    assert.equal(halo.style.color.length, 4);
    // The outline is the halo's width in all, half on each side.
    assert.equal(
      core.style.outline.widthPx,
      AWARENESS_RANGE_PULSE.outlineWidth,
    );
    const pulse = awarenessPulseState(at, index);
    const ground = Cesium.Cartesian3.fromDegrees(3, 27, 0);
    for (const d of surfaceDistances(ground, core.positions))
      assert.ok(Math.abs(d - pulse.radiusM) < 100, `${d} vs ${pulse.radiusM}`);
    const want = rgba(AWARENESS_RANGE_RING_STYLE.color);
    want[3] *= pulse.alpha * level;
    assert.ok(close(core.style.color, want));
  }
  // The ellipse stands while the subject moves under `gradientRebuildM`,
  // the canvas drawing the band about the subject; past it, it moves.
  rendering.renderVisual(flight(3.15)); // ~15 km
  assert.ok(Math.abs(drawn(ring).band.geometry.center.lon - 3) < 1e-9);
  rendering.renderVisual(flight(3.25)); // ~25 km
  assert.ok(Math.abs(drawn(ring).band.geometry.center.lon - 3.25) < 1e-6);
});

test('switching subjects draws into the same sets', (t) => {
  const ring = ringRendering(t);
  const { rendering } = ring;
  frameLoop(t, ring);
  rendering.renderVisual({ ...flight(3), id: 'subject-0' });
  const sets = ringSets(ring.draw);
  for (let index = 1; index <= 6; index++)
    rendering.renderVisual({ ...flight(3 + index), id: `subject-${index}` });
  const after = ringSets(ring.draw);
  assert.equal(after.lines, sets.lines);
  assert.equal(after.band, sets.band);
  assert.equal(ring.draw.sets.size, 2, 'no set per subject');
});

test('a resting band is not moved as the subject moves, and catches up on wake', (t) => {
  const ring = ringRendering(t);
  const { rendering } = ring;
  const loop = frameLoop(t, ring);
  rendering.renderVisual(flight(3));
  loop.advance(AWARENESS_RANGE_PULSE.activeMs + 500);
  const resting = drawn(ring).band;
  assert.equal(resting.show, false);
  const writes = drawn(ring).bandSet.writes;
  // A flying subject keeps moving while the pulses rest: the hidden band is
  // neither moved nor redrawn, even well past the rebuild distance.
  for (let lon = 3.01; lon < 3.4; lon += 0.01)
    rendering.renderVisual(flight(lon));
  assert.equal(drawn(ring).band, resting);
  assert.equal(drawn(ring).bandSet.writes, writes);
  // Woken, the band catches up at once, around the subject.
  rendering.wakePulses();
  loop.advance(AWARENESS_RANGE_PULSE.settleMs);
  const woken = drawn(ring).band;
  assert.equal(woken.show, true);
  assert.ok(Math.abs(woken.geometry.center.lon - 3.39) < 0.011);
});

test('the ring and pulses never catch a click: no entities, every set unpickable', (t) => {
  for (const reducedMotion of [false, true]) {
    const ring = ringRendering(t, { reducedMotion });
    ring.rendering.renderVisual(flight(3));
    // Cesium always picks entities, so the awareness visual adds none.
    assert.equal(ring.entities.values.length, 0);
    for (const record of ring.draw.sets.values())
      assert.equal(record.spec.pickable, false, record.spec.id);
    ring.rendering.clearVisual();
  }
});

test('a camera below the rim height hides the pulses instead of sweeping the sky', (t) => {
  const ring = ringRendering(t);
  const { state, rendering } = ring;
  const loop = frameLoop(t, ring);
  rendering.renderVisual(flight(3));
  loop.advance(AWARENESS_RANGE_PULSE.settleMs + 500);
  const cameraAt = (height) => {
    state.viewer.camera.positionCartographic = { height };
    loop.advance(CYBER_SONAR_RENDER_INTERVAL_MS + 1);
    loop.draw();
    return drawn(ring).band.show && drawn(ring).pulse(0).show;
  };
  assert.equal(cameraAt(CONTEXT_RIM_HEIGHT_M + 500), true);
  assert.equal(cameraAt(CONTEXT_RIM_HEIGHT_M - 500), false, 'cockpit view');
  // Below the band the pulses rest with it: the ring is steady at full, no
  // echo lights and no frame is asked for.
  assert.ok(
    close(drawn(ring).core.style.color, rgba(AWARENESS_RANGE_RING_STYLE.color)),
  );
  assert.equal(getAwarenessEchoField().level(loop.now()), 0);
  const frames = ring.pulseFrames();
  loop.draw();
  loop.advance(2000);
  assert.equal(ring.pulseFrames(), frames, 'no requests below the rim');
  state.viewer.camera.positionCartographic = { height: 800_000 };
  loop.draw();
  loop.advance(CYBER_SONAR_RENDER_INTERVAL_MS + 2);
  assert.equal(drawn(ring).band.show, true);
});

test('reduced motion keeps the static ring and drops the pulses', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const ring = ringRendering(t, { reducedMotion: true });
  const { scene, rendering, pulseFrames } = ring;
  rendering.renderVisual(flight(3));
  assert.ok(drawn(ring).core);
  t.mock.timers.tick(1000);
  assert.equal(pulseFrames(), 0);
  assert.deepEqual(drawn(ring).pulses, [], 'no pulse fronts');
  assert.equal(drawn(ring).band, undefined, 'no band');
  assert.equal(scene.preRender.numberOfListeners, 0);
  assert.equal(scene.postRender.numberOfListeners, 0);
});

test('turning reduced motion on mid-session stops the pulses, and off restarts them', (t) => {
  const ring = ringRendering(t);
  const { scene, rendering, motion, state } = ring;
  const loop = frameLoop(t, ring);
  state.subject = flight(3);
  rendering.renderVisual(state.subject);
  assert.equal(drawn(ring).pulses.length, AWARENESS_RANGE_PULSE.count);
  loop.advance(1000);
  // The OS setting changes while the same aircraft stays tracked.
  motion.set(true);
  assert.ok(drawn(ring).core);
  assert.deepEqual(drawn(ring).pulses, []);
  assert.equal(drawn(ring).band, undefined);
  assert.equal(scene.preRender.numberOfListeners, 0);
  assert.equal(scene.postRender.numberOfListeners, 0);
  assert.equal(getAwarenessEchoField(), null);
  const frames = ring.pulseFrames();
  loop.advance(5000);
  assert.equal(ring.pulseFrames(), frames);
  motion.set(false);
  assert.equal(drawn(ring).pulses.length, AWARENESS_RANGE_PULSE.count);
  assert.ok(getAwarenessEchoField());
  // One media-query listener per visual; none once the ring is gone.
  assert.equal(motion.listeners(), 1);
  rendering.clearVisual();
  assert.equal(motion.listeners(), 0);
});

test('a reduced-motion change reaches older Safari through addListener', (t) => {
  const ring = ringRendering(t, { legacyQuery: true });
  const { scene, rendering, motion, state } = ring;
  state.subject = flight(3);
  rendering.renderVisual(state.subject);
  assert.equal(drawn(ring).pulses.length, AWARENESS_RANGE_PULSE.count);
  assert.equal(motion.listeners(), 1);
  motion.set(true);
  assert.deepEqual(drawn(ring).pulses, []);
  assert.equal(scene.preRender.numberOfListeners, 0);
  rendering.clearVisual();
  assert.equal(motion.listeners(), 0);
});

test('a refresh after reduced motion changed rebuilds the visual too', (t) => {
  const ring = ringRendering(t);
  const { scene, rendering, motion } = ring;
  rendering.renderVisual(flight(3));
  assert.equal(drawn(ring).pulses.length, AWARENESS_RANGE_PULSE.count);
  // No change event: the next same-subject refresh notices on its own.
  motion.setQuietly(true);
  rendering.renderVisual(flight(3));
  assert.ok(drawn(ring).core);
  assert.deepEqual(drawn(ring).pulses, []);
  assert.equal(scene.preRender.numberOfListeners, 0);
});

test('while pulses run the ring flashes as each one arrives, then rests', (t) => {
  const ring = ringRendering(t);
  const { state, rendering } = ring;
  const loop = frameLoop(t, ring);
  rendering.renderVisual(flight(3));
  const core = rgba(AWARENESS_RANGE_RING_STYLE.color);
  const halo = rgba(AWARENESS_RANGE_RING_STYLE.outlineColor);
  const { periodMs, count } = AWARENESS_RANGE_PULSE;
  const { flashMs, restOpacity } = AWARENESS_RANGE_RING_STYLE;
  // Full the moment a front reaches 250 km, gone `flashMs` later.
  const arrival = periodMs * 6; // pulse 0 wraps here
  assert.ok(Math.abs(awarenessRingFlash(arrival) - 1) < 1e-6);
  assert.ok(awarenessRingFlash(arrival + flashMs / 2) > 0.2);
  assert.equal(awarenessRingFlash(arrival + flashMs + 1), 0);
  // Between flashes the 250 km edge stays readable, dimmed, not gone.
  assert.ok(restOpacity >= 0.35 && restOpacity <= 0.5, `${restOpacity}`);
  // Once per arriving pulse: `count` flashes in any one-period window that
  // starts after a flash has faded.
  let flashes = 0;
  let wasLit = false;
  const from = arrival + flashMs + 1;
  for (let ms = 0; ms < periodMs; ms += 10) {
    const lit = awarenessRingFlash(from + ms) > 0.5;
    if (lit && !wasLit) flashes++;
    wasLit = lit;
  }
  assert.equal(flashes, count);
  // Once the pulses have faded in, the drawn colour tracks the flash as it
  // was at each step, and never drops below `restOpacity`.
  loop.advance(AWARENESS_RANGE_PULSE.settleMs);
  for (let step = 0; step < 40; step++) {
    loop.advance(100);
    const flash = Math.max(
      restOpacity,
      awarenessRingFlash(state.visual.lastStepMs),
    );
    const { core: drawnCore, halo: drawnHalo } = drawn(ring);
    assert.ok(
      Math.abs(drawnCore.style.color[3] - core[3] * flash) < 1e-9,
      `${drawnCore.style.color[3]} vs ${core[3] * flash}`,
    );
    assert.ok(Math.abs(drawnHalo.style.color[3] - halo[3] * flash) < 1e-9);
  }
});

test('without pulses the ring stays on screen at full strength', (t) => {
  const ring = ringRendering(t, { reducedMotion: true });
  ring.rendering.renderVisual(flight(3));
  assert.equal(ring.scene.preRender.numberOfListeners, 0);
  assert.ok(
    close(drawn(ring).core.style.color, rgba(AWARENESS_RANGE_RING_STYLE.color)),
  );
  assert.equal(getAwarenessEchoField(), null);
});

test('the echo field follows the subject while pulses run and clears with the ring', (t) => {
  const { rendering } = ringRendering(t);
  rendering.renderVisual(flight(3));
  const field = getAwarenessEchoField();
  assert.ok(field);
  assert.equal(field.radiusM, AWARENESS_RADIUS_M);
  assert.equal(field.pulse, AWARENESS_RANGE_PULSE);
  assert.equal(field.echo, AWARENESS_RANGE_ECHO);
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(
      field.center,
      Cesium.Cartesian3.fromDegrees(3, 27, 0),
      0,
      1e-3,
    ),
  );
  // ~1 km later the same field has moved with the subject.
  rendering.renderVisual(flight(3.01));
  assert.equal(getAwarenessEchoField(), field);
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(
      field.center,
      Cesium.Cartesian3.fromDegrees(3.01, 27, 0),
      0,
      1e-3,
    ),
  );
  rendering.clearVisual();
  assert.equal(getAwarenessEchoField(), null);
});

test('a ring drawn on one viewer leaves it when the layer moves to another', (t) => {
  const ring = ringRendering(t);
  const { state, scene, rendering } = ring;
  const loop = frameLoop(t, ring);
  rendering.renderVisual(flight(3));
  loop.advance(AWARENESS_RANGE_PULSE.settleMs + 200);
  const first = ringSets(ring.draw);
  assert.ok(first.lines.items.size > 0 && first.band.items.size === 1);
  // Re-initialized on a viewer without frame hooks.
  const plain = { entities: ring.entities, scene: {} };
  const { draw } = bindFakeDraw(plain);
  state.viewer = plain;
  rendering.renderVisual(flight(3));
  assert.equal(first.lines.disposed, true, 'gone from the first viewer');
  assert.equal(first.band.disposed, true);
  assert.equal(scene.preRender.numberOfListeners, 0);
  assert.equal(scene.postRender.numberOfListeners, 0);
  assert.equal(getAwarenessEchoField(), null);
  const second = ringSets(draw);
  assert.equal(second.lines.items.size, 1, 'the static ring on the second');
  // And onto a viewer with frame hooks: drawn there with its pulses.
  const third = viewerDouble(ring.entities);
  state.viewer = third.viewer;
  rendering.renderVisual(flight(3));
  loop.advance(AWARENESS_RANGE_PULSE.settleMs + 200);
  assert.equal(second.lines.disposed, true);
  const drawnThird = ringSets(third.draw);
  assert.equal(drawnThird.band.items.size, 1);
  rendering.disposeVisual();
  assert.equal(drawnThird.lines.disposed, true);
  assert.equal(drawnThird.band.disposed, true);
});
