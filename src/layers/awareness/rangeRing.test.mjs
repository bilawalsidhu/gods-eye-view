// src/layers/awareness/rangeRing.test.mjs — the 250 km Global Context range
// ring is a haloed polyline that stays legible on light and dark ground,
// sits where the old ellipse outline did, and follows the subject.
// Dim sonar pulses grow slowly from the subject to the ring, each with an
// inward-fading gradient behind it; the ring flashes as each one arrives and
// the overlay's echo field follows the subject. Under reduced motion the ring
// simply stays on screen.
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
import {
  AWARENESS_PULSE_GRADIENT_MAX,
  awarenessPulseState,
  awarenessRangeRingPositions,
  awarenessRingFlash,
  createRendering,
} from './rendering.js';
import { getAwarenessEchoField } from '../../awarenessEcho.js';
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
 * by reason. `reducedMotion` stubs the media query for
 * the length of the test.
 */
function ringRendering(t, { reducedMotion = false } = {}) {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = (query) => ({
    matches: query === '(prefers-reduced-motion: reduce)' && reducedMotion,
  });
  t.after(() => {
    globalThis.matchMedia = previous;
  });
  const state = createState({ services: {} });
  const entities = new Cesium.EntityCollection();
  const scene = {
    primitives: new Cesium.PrimitiveCollection(),
    preRender: new Cesium.Event(),
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
    renders: () => reasons.filter((r) => r === 'awareness-visual').length,
    pulseFrames: () => reasons.filter((r) => r === 'awareness-pulse').length,
  };
}

/** The pulse gradient disc and the echo collection among scene primitives. */
function pulsePrimitives(scene) {
  const all = Array.from({ length: scene.primitives.length }, (_, i) =>
    scene.primitives.get(i),
  );
  return {
    disc: all.find((p) => p instanceof Cesium.Primitive),
    count: all.length,
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
  const { entities, rendering } = ringRendering(t);
  rendering.renderVisual(flight(3));
  assert.equal(entities.values.length, 1 + AWARENESS_RANGE_PULSE.count);
  assert.ok(entities.values.every((entity) => entity.ellipse === undefined));
  const [entity] = entities.values;
  assert.equal(entity.ellipse, undefined);
  const now = Cesium.JulianDate.now();
  assert.equal(entity.polyline.width.getValue(now), 4);
  assert.equal(entity.polyline.arcType.getValue(now), Cesium.ArcType.NONE);
  const material = entity.polyline.material;
  assert.ok(material instanceof Cesium.PolylineOutlineMaterialProperty);
  // The ring's hue is fixed; its opacity flashes with arriving pulses.
  const core = Cesium.Color.fromCssColorString(
    AWARENESS_RANGE_RING_STYLE.color,
  );
  const color = material.color.getValue(now);
  assert.equal(color.red, core.red);
  assert.equal(color.blue, core.blue);
  assert.ok(color.alpha >= 0 && color.alpha <= core.alpha + 1e-9);
  assert.equal(
    material.outlineWidth.getValue(now),
    AWARENESS_RANGE_RING_STYLE.outlineWidth,
  );
  const ground = Cesium.Cartesian3.fromDegrees(3, 27, 0);
  for (const distance of surfaceDistances(
    ground,
    entity.polyline.positions.getValue(now),
  ))
    assert.ok(Math.abs(distance - AWARENESS_RADIUS_M) < 100);
});

test('the ring and pulses follow the subject past 250 m and ignore smaller drift', (t) => {
  const { entities, rendering, renders } = ringRendering(t);
  const subject = flight;
  rendering.renderVisual(subject(3));
  const [entity] = entities.values;
  const now = Cesium.JulianDate.now();
  const first = entity.polyline.positions.getValue(now);
  const rendersAfterAdd = renders();

  // ~100 m east: under the threshold, nothing is rebuilt or rendered.
  rendering.renderVisual(subject(3.001));
  assert.equal(entity.polyline.positions.getValue(now), first);
  assert.equal(renders(), rendersAfterAdd);

  // ~1 km east: the same entity moves to the new centre.
  rendering.renderVisual(subject(3.01));
  assert.equal(entities.values.length, 1 + AWARENESS_RANGE_PULSE.count);
  assert.equal(entities.values[0], entity);
  const moved = entity.polyline.positions.getValue(now);
  assert.notEqual(moved, first);
  for (const distance of surfaceDistances(
    Cesium.Cartesian3.fromDegrees(3.01, 27, 0),
    moved,
  ))
    assert.ok(Math.abs(distance - AWARENESS_RADIUS_M) < 100);
  assert.equal(renders(), rendersAfterAdd + 1);
  // Each pulse is a circle around the NEW centre: one radius all the way round.
  for (const pulse of entities.values.slice(1)) {
    const radii = surfaceDistances(
      Cesium.Cartesian3.fromDegrees(3.01, 27, 0),
      pulse.polyline.positions.getValue(now),
    );
    assert.ok(Math.max(...radii) - Math.min(...radii) < 100);
  }

  rendering.clearVisual();
  assert.equal(entities.values.length, 0);
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

test('pulses ask for a frame every 80 ms instead of holding continuous rendering', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { entities, rendering, pulseFrames } = ringRendering(t);
  rendering.renderVisual(flight(3));
  // A parked Contacts view repaints at the Cyber sonar cadence, ~12.5 fps,
  // never every display frame.
  assert.equal(pulseFrames(), 0);
  t.mock.timers.tick(AWARENESS_RANGE_PULSE.frameIntervalMs * 10);
  assert.equal(pulseFrames(), 10);
  const now = Cesium.JulianDate.now();
  const core = Cesium.Color.fromCssColorString(
    AWARENESS_RANGE_RING_STYLE.color,
  );
  for (const pulse of entities.values.slice(1)) {
    assert.equal(pulse.polyline.positions.isConstant, false);
    assert.equal(
      pulse.polyline.width.getValue(now),
      AWARENESS_RANGE_PULSE.width,
    );
    const color = pulse.polyline.material.color.getValue(now);
    assert.ok(color.alpha >= 0 && color.alpha <= core.alpha);
    assert.equal(color.red, core.red);
    const radii = surfaceDistances(
      Cesium.Cartesian3.fromDegrees(3, 27, 0),
      pulse.polyline.positions.getValue(now),
    );
    assert.ok(
      Math.min(...radii) >=
        AWARENESS_RADIUS_M * AWARENESS_RANGE_PULSE.startFraction - 100,
    );
    assert.ok(Math.max(...radii) <= AWARENESS_RADIUS_M + 100);
  }
  rendering.clearVisual();
  assert.equal(entities.values.length, 0);
  t.mock.timers.tick(AWARENESS_RANGE_PULSE.frameIntervalMs * 10);
  assert.equal(pulseFrames(), 10, 'no frames once the ring is gone');
});

test('a scene without primitives or preRender gets the static ring only', (t) => {
  const { state, entities, rendering, pulseFrames } = ringRendering(t);
  for (const scene of [{}, { primitives: { add() {} } }, undefined]) {
    state.viewer = { entities, scene };
    rendering.clearVisual();
    rendering.renderVisual(flight(3));
    assert.equal(entities.values.length, 1);
    assert.equal(entities.values[0].polyline.positions.isConstant, true);
  }
  rendering.clearVisual();
  assert.equal(pulseFrames(), 0);
});

test('a gradient disc behind the pulses fades inward and follows the subject', (t) => {
  const { scene, rendering } = ringRendering(t);
  rendering.renderVisual(flight(3));
  assert.ok(AWARENESS_RANGE_PULSE.count <= AWARENESS_PULSE_GRADIENT_MAX);
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
  // Each frame writes the pulses' radius (as a fraction of the range) and
  // opacity into the shader, from the same curve the lines use.
  assert.equal(scene.preRender.numberOfListeners, 1);
  const before = performance.now();
  scene.preRender.raiseEvent(scene);
  const after = performance.now();
  const { radii, alphas } = material.uniforms;
  for (let index = 0; index < AWARENESS_RANGE_PULSE.count; index++) {
    const radius = Cesium.Cartesian4.pack(radii, [])[index];
    const alpha = Cesium.Cartesian4.pack(alphas, [])[index];
    const low = awarenessPulseState(before, index);
    const high = awarenessPulseState(after, index);
    // A few milliseconds pass during the raise; allow for that drift.
    assert.ok(
      Math.abs(radius - low.radiusM / AWARENESS_RADIUS_M) < 0.01 ||
        Math.abs(radius - high.radiusM / AWARENESS_RADIUS_M) < 0.01,
    );
    assert.ok(alpha >= 0 && alpha <= AWARENESS_RANGE_PULSE.peakOpacity);
    assert.ok(
      Math.abs(alpha - low.alpha) < 0.02 || Math.abs(alpha - high.alpha) < 0.02,
    );
  }
  // Unused shader slots stay empty.
  assert.equal(
    Cesium.Cartesian4.pack(alphas, [])[AWARENESS_PULSE_GRADIENT_MAX - 1],
    0,
  );

  // The disc is rebuilt only past `gradientRebuildM` (2 km), not on every
  // 250 m step the lines take, and keeps its material.
  rendering.renderVisual(flight(3.001));
  assert.equal(pulsePrimitives(scene).disc, disc);
  rendering.renderVisual(flight(3.01)); // ~1 km: the lines move, the disc stays
  assert.equal(pulsePrimitives(scene).disc, disc);
  assert.ok(!disc.isDestroyed());
  rendering.renderVisual(flight(3.03)); // ~3 km from the disc's centre
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

test('pulses evaluate every frame without breaking, reusing their positions', (t) => {
  const { entities, rendering } = ringRendering(t);
  rendering.renderVisual(flight(3));
  const center = Cesium.Cartesian3.fromDegrees(3, 27, 0);
  for (const pulse of entities.values.slice(1)) {
    const property = pulse.polyline.positions;
    const first = property.getValue(Cesium.JulianDate.now());
    // Cesium calls this on every rendered frame; the second call is where a
    // reused Cartesian once landed in the ellipsoid argument and threw.
    for (let frame = 0; frame < 5; frame++) {
      const positions = property.getValue(Cesium.JulianDate.now());
      assert.equal(positions, first, 'the same array is reused');
      assert.equal(positions.length, AWARENESS_RANGE_PULSE.segments + 1);
      const radii = surfaceDistances(center, positions);
      assert.ok(radii.every(Number.isFinite));
      assert.ok(Math.max(...radii) - Math.min(...radii) < 100);
    }
  }
});

test('reduced motion keeps the static ring and drops the pulses', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { entities, scene, rendering, pulseFrames } = ringRendering(t, {
    reducedMotion: true,
  });
  rendering.renderVisual(flight(3));
  assert.equal(entities.values.length, 1);
  assert.equal(entities.values[0].polyline.positions.isConstant, true);
  t.mock.timers.tick(1000);
  assert.equal(pulseFrames(), 0);
  assert.equal(scene.primitives.length, 0);
  assert.equal(scene.preRender.numberOfListeners, 0);
});

test('while pulses run the ring flashes as each one arrives, then rests', (t) => {
  const { entities, rendering } = ringRendering(t);
  rendering.renderVisual(flight(3));
  const ring = entities.values[0];
  const core = Cesium.Color.fromCssColorString(
    AWARENESS_RANGE_RING_STYLE.color,
  );
  assert.equal(ring.polyline.material.color.isConstant, false);
  const { periodMs, count } = AWARENESS_RANGE_PULSE;
  const { flashMs, restOpacity } = AWARENESS_RANGE_RING_STYLE;
  // Full the moment a front reaches 250 km, gone `flashMs` later.
  const arrival = periodMs * 6; // pulse 0 wraps here
  assert.ok(Math.abs(awarenessRingFlash(arrival) - 1) < 1e-6);
  assert.ok(awarenessRingFlash(arrival + flashMs / 2) > 0.2);
  assert.equal(awarenessRingFlash(arrival + flashMs + 1), 0);
  assert.equal(restOpacity, 0);
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
  // The live colour tracks the flash at this instant.
  const before = awarenessRingFlash(performance.now());
  const alpha = ring.polyline.material.color.getValue(
    Cesium.JulianDate.now(),
  ).alpha;
  const after = awarenessRingFlash(performance.now());
  assert.ok(
    alpha >= core.alpha * Math.min(before, after) - 0.02 &&
      alpha <= core.alpha * Math.max(before, after) + 0.02,
  );
});

test('without pulses the ring stays on screen at full strength', (t) => {
  const { entities, rendering } = ringRendering(t, { reducedMotion: true });
  rendering.renderVisual(flight(3));
  const color = entities.values[0].polyline.material.color;
  assert.equal(color.isConstant, true);
  assert.equal(
    color.getValue(Cesium.JulianDate.now()).toCssColorString(),
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
