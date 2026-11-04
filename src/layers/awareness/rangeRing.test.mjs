// src/layers/awareness/rangeRing.test.mjs — the 250 km Global Context range
// ring is a haloed polyline that stays legible on light and dark ground,
// sits where the old ellipse outline did, and follows the subject.
// Dim sonar pulses grow slowly from the subject to the ring, each with an
// inward-fading gradient behind it, drawn on one unpickable disc; the ring
// dims and flashes as each one arrives and the overlay's echo field follows
// the subject. The pulses run for a bounded time after a selection or camera
// move, then rest with the ring steady. Under reduced motion the ring simply
// stays on screen.
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
  AWARENESS_PULSE_GRADIENT_MAX,
  awarenessPulseLevel,
  awarenessPulseState,
  awarenessRangeRingPositions,
  awarenessRingFlash,
  awarenessRingGeometryOptions,
  createRendering,
  wakeAwarenessPulses,
} from './rendering.js';
import { getAwarenessEchoField } from '../../awarenessEcho.js';
import { createLifecycle } from './lifecycle.js';
import { createState } from './state.js';

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

/**
 * The rendering part over a bare entity collection, counting render asks and
 * by reason. `reducedMotion` stubs the media query for the length of the
 * test; `motion.set(on)` flips it later and tells its listeners, as the
 * browser does.
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
  const scene = {
    primitives: new Cesium.PrimitiveCollection(),
    preRender: new Cesium.Event(),
    postRender: new Cesium.Event(),
  };
  state.viewer = { entities, scene };
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
    scene,
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
    ring.scene.preRender.raiseEvent(ring.scene);
    ring.scene.postRender.raiseEvent(ring.scene);
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

/** The ring and the pulse disc among scene primitives. */
function pulsePrimitives(scene) {
  const all = Array.from({ length: scene.primitives.length }, (_, i) =>
    scene.primitives.get(i),
  );
  const ring = all.find(
    (p) => p.appearance instanceof Cesium.PolylineMaterialAppearance,
  );
  const discs = all.filter((p) => p instanceof Cesium.Primitive && p !== ring);
  return { ring, disc: discs[0], count: discs.length };
}

/** Where a disc built around `built` sits after its model matrix. */
function discCenter(disc, built) {
  return Cesium.Matrix4.multiplyByPoint(
    disc.modelMatrix,
    built,
    new Cesium.Cartesian3(),
  );
}

/** The ring's material uniforms as the next drawn frame sets them. */
function ringColors(scene) {
  scene.preRender.raiseEvent(scene);
  return pulsePrimitives(scene).ring.appearance.material.uniforms;
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
    const to = Cesium.Cartographic.fromCartesian(position);
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
  // A visible halo on each side of a core at least 2 px wide.
  const { width, outlineWidth } = AWARENESS_RANGE_RING_STYLE;
  assert.ok(outlineWidth >= 1);
  assert.ok(width - 2 * outlineWidth >= 2);
});

test('renderVisual draws one haloed polyline ring, not an ellipse outline', (t) => {
  const ring = ringRendering(t);
  const { entities, scene, state, rendering } = ring;
  frameLoop(t, ring); // freeze the clock: the pulses have not faded in yet
  rendering.renderVisual(flight(3));
  // A polyline primitive, never an entity or an ellipse outline.
  assert.equal(entities.values.length, 0);
  const ringPrimitive = pulsePrimitives(scene).ring;
  assert.ok(ringPrimitive);
  const geometry = ringPrimitive.geometryInstances.geometry;
  assert.ok(geometry instanceof Cesium.PolylineGeometry);
  // 4 px wide, straight chords between surface-following positions, as the
  // entity ring was drawn.
  const options = awarenessRingGeometryOptions(state.visual.ringPositions);
  assert.equal(options.width, 4);
  assert.equal(options.width, AWARENESS_RANGE_RING_STYLE.width);
  assert.equal(options.arcType, Cesium.ArcType.NONE);
  assert.equal(options.positions, state.visual.ringPositions);
  assert.equal(
    options.vertexFormat,
    Cesium.PolylineMaterialAppearance.VERTEX_FORMAT,
  );
  const { material } = ringPrimitive.appearance;
  assert.equal(material.type, 'PolylineOutline');
  // The ring's hue is fixed; its opacity flashes with arriving pulses, and
  // at the moment it appears, before the pulses fade in, it is at full.
  const core = Cesium.Color.fromCssColorString(
    AWARENESS_RANGE_RING_STYLE.color,
  );
  const { color, outlineWidth } = ringColors(scene);
  assert.equal(color.red, core.red);
  assert.equal(color.blue, core.blue);
  assert.ok(Math.abs(color.alpha - core.alpha) < 1e-9, `${color.alpha}`);
  assert.equal(outlineWidth, AWARENESS_RANGE_RING_STYLE.outlineWidth);
  const ground = Cesium.Cartesian3.fromDegrees(3, 27, 0);
  for (const distance of surfaceDistances(ground, state.visual.ringPositions))
    assert.ok(Math.abs(distance - AWARENESS_RADIUS_M) < 100);
});

test('the ring and pulses follow the subject past 250 m and ignore smaller drift', (t) => {
  const { scene, state, rendering, renders } = ringRendering(t);
  const subject = flight;
  rendering.renderVisual(subject(3));
  const ringBefore = pulsePrimitives(scene).ring;
  const first = state.visual.ringPositions;
  const discBefore = pulsePrimitives(scene).disc;
  const rendersAfterAdd = renders();

  // ~100 m east: under the threshold, nothing is rebuilt or rendered.
  rendering.renderVisual(subject(3.001));
  assert.equal(pulsePrimitives(scene).ring, ringBefore);
  assert.equal(state.visual.ringPositions, first);
  assert.equal(renders(), rendersAfterAdd);

  // ~1 km east: the ring is rebuilt around the new centre, keeping its
  // material, so a flash carries on.
  rendering.renderVisual(subject(3.01));
  const ringAfter = pulsePrimitives(scene).ring;
  assert.notEqual(ringAfter, ringBefore);
  assert.ok(ringBefore.isDestroyed());
  assert.equal(ringAfter.appearance.material, ringBefore.appearance.material);
  assert.equal(ringAfter.allowPicking, false);
  const moved = state.visual.ringPositions;
  assert.notEqual(moved, first);
  for (const distance of surfaceDistances(
    Cesium.Cartesian3.fromDegrees(3.01, 27, 0),
    moved,
  ))
    assert.ok(Math.abs(distance - AWARENESS_RADIUS_M) < 100);
  assert.equal(renders(), rendersAfterAdd + 1);
  // The pulses are drawn on a disc that follows to the NEW centre by its
  // model matrix, so they stay concentric with the ring without a rebuild.
  assert.equal(pulsePrimitives(scene).disc, discBefore);
  assert.ok(
    Cesium.Cartesian3.distance(
      discCenter(discBefore, Cesium.Cartesian3.fromDegrees(3, 27, 0)),
      Cesium.Cartesian3.fromDegrees(3.01, 27, 0),
    ) < 1,
  );

  rendering.clearVisual();
  assert.equal(scene.primitives.length, 0);
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
  assert.equal(ring.scene.primitives.length, 0);
  assert.equal(ring.scene.postRender.numberOfListeners, 0);
  loop.advance(CYBER_SONAR_RENDER_INTERVAL_MS * 10);
  assert.equal(pulseFrames(), frames, 'no frames once the ring is gone');
});

test('a parked view stops asking for frames once the pulses rest', (t) => {
  const ring = ringRendering(t);
  const { scene, rendering, pulseFrames } = ring;
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
  const core = Cesium.Color.fromCssColorString(
    AWARENESS_RANGE_RING_STYLE.color,
  );
  assert.ok(Math.abs(ringColors(scene).color.alpha - core.alpha) < 1e-9);
  assert.equal(pulsePrimitives(scene).disc.show, false);
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
  state.viewer.canvas = new EventTarget();
  const touch = () =>
    state.viewer.canvas.dispatchEvent(new Event('pointerdown'));
  state.viewer.camera = {
    positionWC: Cesium.Cartesian3.fromDegrees(3, 20, 800_000),
    heading: 0,
    pitch: -1,
    roll: 0,
  };
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
  state.viewer.canvas = new EventTarget();
  state.viewer.scene.screenSpaceCameraController = { enableInputs: true };
  state.viewer.camera = {
    positionWC: Cesium.Cartesian3.fromDegrees(3, 20, 800_000),
    heading: 0,
    pitch: -1,
    roll: 0,
  };
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
  state.viewer.camera = {
    positionWC: Cesium.Cartesian3.fromDegrees(3, 20, 800_000),
    heading: 0,
    pitch: -1,
    roll: 0,
  };
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
  assert.equal(scene.primitives.length, 2);
  lifecycle.methods.disable();
  assert.equal(scene.primitives.length, 0, 'ring and disc removed');
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

test('a scene without primitives or preRender gets the static ring only', (t) => {
  const { state, entities, rendering, pulseFrames } = ringRendering(t);
  for (const scene of [
    {},
    { primitives: { add() {} } },
    { primitives: { add() {} }, preRender: new Cesium.Event() },
    undefined,
  ]) {
    state.viewer = { entities, scene };
    rendering.clearVisual();
    rendering.renderVisual(flight(3));
    // No usable primitive collection: the ring falls back to an entity.
    assert.equal(entities.values.length, 1);
    assert.equal(entities.values[0].polyline.positions.isConstant, true);
    assert.equal(entities.values[0].polyline.material.color.isConstant, true);
  }
  rendering.clearVisual();
  assert.equal(pulseFrames(), 0);
});

test('a gradient disc behind the pulses fades inward and follows the subject', (t) => {
  const ring = ringRendering(t);
  const { scene, rendering } = ring;
  const loop = frameLoop(t, ring);
  rendering.renderVisual(flight(3));
  assert.ok(AWARENESS_RANGE_PULSE.count <= AWARENESS_PULSE_GRADIENT_MAX);
  assert.equal(scene.primitives.length, 2, 'the ring and the pulse disc');
  const { disc, count } = pulsePrimitives(scene);
  assert.equal(count, 1, 'the gradient disc');
  assert.ok(disc);
  // Never a click or tap target, and see-through.
  assert.equal(disc.allowPicking, false);
  assert.equal(disc.appearance.translucent, true);
  const { material } = disc.appearance;
  assert.ok(
    Math.abs(
      material.uniforms.depth - AWARENESS_RANGE_PULSE.gradientDepthFraction,
    ) < 1e-9,
  );
  assert.ok(
    Math.abs(
      material.uniforms.color.alpha - AWARENESS_RANGE_PULSE.gradientOpacity,
    ) < 1e-6,
  );
  // The pulse lines are drawn in the ring's colours and widths.
  const core = Cesium.Color.fromCssColorString(
    AWARENESS_RANGE_RING_STYLE.color,
  );
  const halo = Cesium.Color.fromCssColorString(
    AWARENESS_RANGE_RING_STYLE.outlineColor,
  );
  assert.ok(material.uniforms.lineColor.equalsEpsilon(core, 1e-6));
  assert.ok(material.uniforms.haloColor.equalsEpsilon(halo, 1e-6));
  assert.equal(material.uniforms.lineWidth, AWARENESS_RANGE_PULSE.width);
  assert.equal(material.uniforms.haloWidth, AWARENESS_RANGE_PULSE.outlineWidth);
  // Each frame writes the pulses' radius (as a fraction of the range) and
  // opacity into the shader, from the same curve the lines use, once the
  // pulses have faded in.
  assert.equal(scene.preRender.numberOfListeners, 1);
  loop.advance(AWARENESS_RANGE_PULSE.settleMs + 500);
  scene.preRender.raiseEvent(scene);
  assert.equal(disc.show, true);
  const { radii, alphas } = material.uniforms;
  for (let index = 0; index < AWARENESS_RANGE_PULSE.count; index++) {
    const radius = Cesium.Cartesian4.pack(radii, [])[index];
    const alpha = Cesium.Cartesian4.pack(alphas, [])[index];
    const expected = awarenessPulseState(loop.now(), index);
    assert.ok(Math.abs(radius - expected.radiusM / AWARENESS_RADIUS_M) < 1e-6);
    assert.ok(alpha >= 0 && alpha <= AWARENESS_RANGE_PULSE.peakOpacity);
    assert.ok(Math.abs(alpha - expected.alpha) < 1e-6);
  }
  // Unused shader slots stay empty.
  assert.equal(
    Cesium.Cartesian4.pack(alphas, [])[AWARENESS_PULSE_GRADIENT_MAX - 1],
    0,
  );

  // The disc follows by its model matrix and is rebuilt only past
  // `gradientRebuildM` (20 km), keeping its material.
  const built = Cesium.Cartesian3.fromDegrees(3, 27, 0);
  for (const lon of [3.001, 3.01, 3.1, 3.19]) {
    rendering.renderVisual(flight(lon));
    assert.equal(pulsePrimitives(scene).disc, disc, `${lon}`);
    assert.ok(!disc.isDestroyed());
    // Concentric with the ring wherever the subject went, within a metre
    // across the ground; the ellipsoid curves away from the rotation's
    // sphere by tens of metres in height at most.
    const at = Cesium.Cartographic.fromCartesian(discCenter(disc, built));
    const want = Cesium.Cartographic.fromCartesian(ring.state.visual.center);
    const across = new Cesium.EllipsoidGeodesic(at, want).surfaceDistance;
    assert.ok(across < 1, `${across} m off at ${lon}`);
    assert.ok(Math.abs(at.height) < 50, `${at.height} m off the ground`);
  }
  rendering.renderVisual(flight(3.25)); // ~25 km from where it was built
  assert.equal(pulsePrimitives(scene).count, 1);
  const moved = pulsePrimitives(scene).disc;
  assert.notEqual(moved, disc);
  assert.ok(disc.isDestroyed());
  assert.equal(moved.appearance.material, material);
  assert.equal(moved.allowPicking, false);

  rendering.clearVisual();
  assert.equal(scene.primitives.length, 0);
  assert.equal(scene.preRender.numberOfListeners, 0);
});

test("switching subjects keeps one pulse material in Cesium's global cache", (t) => {
  const ring = ringRendering(t);
  const { scene, rendering } = ring;
  frameLoop(t, ring);
  // Cesium keeps every new material type for the page's lifetime, so an
  // unnamed fabric (a fresh GUID type each time) would grow it per subject.
  const cached = () =>
    Object.keys(Cesium.Material._materialCache._materials).length;
  rendering.renderVisual({ ...flight(3), id: 'subject-0' });
  const first = pulsePrimitives(scene).disc.appearance.material;
  const size = cached();
  let last = first;
  for (let index = 1; index <= 6; index++) {
    rendering.renderVisual({ ...flight(3 + index), id: `subject-${index}` });
    last = pulsePrimitives(scene).disc.appearance.material;
  }
  assert.equal(cached(), size, 'subject switches add no cache entries');
  rendering.clearVisual();
  rendering.renderVisual(flight(3));
  assert.equal(cached(), size, 'nor does a reselect');
  // A material built from the cached template still owns its uniform values.
  const again = pulsePrimitives(scene).disc.appearance.material;
  assert.notEqual(again, last);
  assert.notEqual(again.uniforms.radii, last.uniforms.radii);
  assert.notEqual(again.uniforms.alphas, first.uniforms.alphas);
  assert.ok(again.uniforms.radii instanceof Cesium.Cartesian4);
  assert.ok(again.uniforms.lineColor instanceof Cesium.Color);
  assert.equal(again.uniforms.lineWidth, AWARENESS_RANGE_PULSE.width);
});

test('a resting pulse disc is not rebuilt as the subject moves, and catches up on wake', (t) => {
  const ring = ringRendering(t);
  const { scene, rendering } = ring;
  const loop = frameLoop(t, ring);
  rendering.renderVisual(flight(3));
  loop.advance(AWARENESS_RANGE_PULSE.activeMs + 500);
  const resting = pulsePrimitives(scene).disc;
  const restingMatrix = Cesium.Matrix4.clone(resting.modelMatrix);
  // A flying subject keeps moving while the pulses rest: the hidden disc is
  // neither moved nor rebuilt, even well past the rebuild distance.
  for (let lon = 3.01; lon < 3.4; lon += 0.01)
    rendering.renderVisual(flight(lon));
  assert.equal(pulsePrimitives(scene).disc, resting);
  assert.ok(!resting.isDestroyed());
  assert.ok(Cesium.Matrix4.equals(resting.modelMatrix, restingMatrix));
  // Woken, the disc catches up at once: rebuilt around the subject.
  rendering.wakePulses();
  const woken = pulsePrimitives(scene).disc;
  assert.notEqual(woken, resting);
  assert.ok(resting.isDestroyed());
  assert.equal(pulsePrimitives(scene).count, 1);
  // Woken again without moving: the disc stays.
  rendering.wakePulses();
  assert.equal(pulsePrimitives(scene).disc, woken);
});

test('the ring and pulses never catch a click: no entities, every primitive unpickable', (t) => {
  for (const reducedMotion of [false, true]) {
    const { entities, scene, rendering } = ringRendering(t, { reducedMotion });
    rendering.renderVisual(flight(3));
    // Cesium always picks entities, so the awareness visual adds none.
    assert.equal(entities.values.length, 0);
    assert.ok(scene.primitives.length >= 1);
    for (let i = 0; i < scene.primitives.length; i++)
      assert.equal(scene.primitives.get(i).allowPicking, false);
    rendering.clearVisual();
  }
});

test('a camera below the rim height hides the pulse disc instead of sweeping the sky', (t) => {
  const ring = ringRendering(t);
  const { scene, rendering } = ring;
  const loop = frameLoop(t, ring);
  rendering.renderVisual(flight(3));
  loop.advance(AWARENESS_RANGE_PULSE.settleMs + 500);
  const cameraAt = (height) => {
    scene.camera = {
      positionCartographic: new Cesium.Cartographic(0, 0, height),
    };
    scene.preRender.raiseEvent(scene);
    return pulsePrimitives(scene).disc.show;
  };
  assert.equal(cameraAt(CONTEXT_RIM_HEIGHT_M + 500), true);
  assert.equal(cameraAt(CONTEXT_RIM_HEIGHT_M - 500), false, 'cockpit view');
  // Below the disc the pulses rest with it: the ring is steady at full, no
  // echo lights and no frame is asked for.
  const core = Cesium.Color.fromCssColorString(
    AWARENESS_RANGE_RING_STYLE.color,
  );
  assert.ok(Math.abs(ringColors(scene).color.alpha - core.alpha) < 1e-9);
  assert.equal(getAwarenessEchoField().level(loop.now()), 0);
  const frames = ring.pulseFrames();
  loop.draw();
  loop.advance(2000);
  assert.equal(ring.pulseFrames(), frames, 'no requests below the rim');
  assert.equal(cameraAt(800_000), true);
});

test('reduced motion keeps the static ring and drops the pulses', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { scene, rendering, pulseFrames } = ringRendering(t, {
    reducedMotion: true,
  });
  rendering.renderVisual(flight(3));
  assert.ok(pulsePrimitives(scene).ring);
  t.mock.timers.tick(1000);
  assert.equal(pulseFrames(), 0);
  assert.equal(pulsePrimitives(scene).count, 0, 'no pulse disc');
  assert.equal(scene.preRender.numberOfListeners, 0);
  assert.equal(scene.postRender.numberOfListeners, 0);
});

test('turning reduced motion on mid-session stops the pulses, and off restarts them', (t) => {
  const ring = ringRendering(t);
  const { scene, rendering, motion, state } = ring;
  const loop = frameLoop(t, ring);
  state.subject = flight(3);
  rendering.renderVisual(state.subject);
  assert.equal(pulsePrimitives(scene).count, 1);
  loop.advance(1000);
  // The OS setting changes while the same aircraft stays tracked.
  motion.set(true);
  assert.ok(pulsePrimitives(scene).ring);
  assert.equal(pulsePrimitives(scene).count, 0);
  assert.equal(scene.preRender.numberOfListeners, 0);
  assert.equal(scene.postRender.numberOfListeners, 0);
  assert.equal(getAwarenessEchoField(), null);
  const frames = ring.pulseFrames();
  loop.advance(5000);
  assert.equal(ring.pulseFrames(), frames);
  motion.set(false);
  assert.equal(pulsePrimitives(scene).count, 1);
  assert.ok(getAwarenessEchoField());
  // One media-query listener per visual; none once the ring is gone.
  assert.equal(motion.listeners(), 1);
  rendering.clearVisual();
  assert.equal(motion.listeners(), 0);
});

test('a reduced-motion change reaches older Safari through addListener', (t) => {
  const { scene, rendering, motion, state } = ringRendering(t, {
    legacyQuery: true,
  });
  state.subject = flight(3);
  rendering.renderVisual(state.subject);
  assert.equal(pulsePrimitives(scene).count, 1);
  assert.equal(motion.listeners(), 1);
  motion.set(true);
  assert.equal(pulsePrimitives(scene).count, 0);
  assert.equal(scene.preRender.numberOfListeners, 0);
  rendering.clearVisual();
  assert.equal(motion.listeners(), 0);
});

test('a refresh after reduced motion changed rebuilds the visual too', (t) => {
  const { scene, rendering, motion } = ringRendering(t);
  rendering.renderVisual(flight(3));
  assert.equal(pulsePrimitives(scene).count, 1);
  // No change event: the next same-subject refresh notices on its own.
  motion.setQuietly(true);
  rendering.renderVisual(flight(3));
  assert.ok(pulsePrimitives(scene).ring);
  assert.equal(pulsePrimitives(scene).count, 0);
  assert.equal(scene.preRender.numberOfListeners, 0);
});

test('while pulses run the ring flashes as each one arrives, then rests', (t) => {
  const ring = ringRendering(t);
  const { scene, rendering } = ring;
  const loop = frameLoop(t, ring);
  rendering.renderVisual(flight(3));
  const core = Cesium.Color.fromCssColorString(
    AWARENESS_RANGE_RING_STYLE.color,
  );
  const halo = Cesium.Color.fromCssColorString(
    AWARENESS_RANGE_RING_STYLE.outlineColor,
  );
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
  // Once the pulses have faded in, the live colour tracks the flash, and
  // never drops below `restOpacity`.
  loop.advance(AWARENESS_RANGE_PULSE.settleMs);
  for (let step = 0; step < 40; step++) {
    loop.advance(100);
    const { color, outlineColor } = ringColors(scene);
    const flash = Math.max(restOpacity, awarenessRingFlash(loop.now()));
    const expected = core.alpha * flash;
    assert.ok(
      Math.abs(color.alpha - expected) < 1e-9,
      `${color.alpha} vs ${expected}`,
    );
    assert.ok(Math.abs(outlineColor.alpha - halo.alpha * flash) < 1e-9);
  }
});

test('without pulses the ring stays on screen at full strength', (t) => {
  const { scene, rendering } = ringRendering(t, { reducedMotion: true });
  rendering.renderVisual(flight(3));
  assert.equal(scene.preRender.numberOfListeners, 0);
  assert.equal(
    ringColors(scene).color.toCssColorString(),
    Cesium.Color.fromCssColorString(
      AWARENESS_RANGE_RING_STYLE.color,
    ).toCssColorString(),
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
