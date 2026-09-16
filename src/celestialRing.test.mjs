import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CELESTIAL_PLANE_EPSILON,
  GLOBE_ENTER_CLEARANCE_PX,
  GLOBE_EXIT_CLEARANCE_PX,
  celestialScreenAngle,
  circularAngleDistance,
  earthDiscScreenRadius,
  getKeyholeFadeTuning,
  getKeyholeGeometry,
  isCelestialRingStyleSupported,
  isFullGlobeInsideKeyhole,
  keyholeLabelAlpha,
  normalizeAngle,
  setKeyholeFadeTuning,
} from './celestialRing.js';

function geometry(clearance, offset = 0) {
  const keyholeRadius = 500;
  const earthRadius = keyholeRadius - offset - clearance;
  return {
    earthCenterX: 500 + offset,
    earthCenterY: 500,
    earthRadius,
    keyholeCenterX: 500,
    keyholeCenterY: 500,
    keyholeRadius,
  };
}

test('full globe enters only with the larger clearance', () => {
  assert.equal(isFullGlobeInsideKeyhole(geometry(GLOBE_ENTER_CLEARANCE_PX), false), true);
  assert.equal(isFullGlobeInsideKeyhole(geometry(GLOBE_ENTER_CLEARANCE_PX - 0.1), false), false);
});

test('visible globe uses the smaller exit clearance for hysteresis', () => {
  assert.equal(isFullGlobeInsideKeyhole(geometry(GLOBE_EXIT_CLEARANCE_PX), true), true);
  assert.equal(isFullGlobeInsideKeyhole(geometry(GLOBE_EXIT_CLEARANCE_PX - 0.1), true), false);
});

test('off-center globe containment includes center offset', () => {
  const centered = geometry(30, 0);
  const shifted = { ...centered, earthCenterX: centered.earthCenterX + 20 };
  assert.equal(isFullGlobeInsideKeyhole(centered, false), true);
  assert.equal(isFullGlobeInsideKeyhole(shifted, false), false);
});

test('invalid or clipped Earth discs are rejected', () => {
  assert.equal(isFullGlobeInsideKeyhole(null, false), false);
  assert.equal(isFullGlobeInsideKeyhole({ ...geometry(30), earthRadius: -1 }, false), false);
  assert.equal(isFullGlobeInsideKeyhole(geometry(-2), true), false);
});

test('Earth-disc projection radius rejects local and invalid camera geometry', () => {
  const earthRadius = 6_378_137;
  assert.equal(earthDiscScreenRadius(earthRadius, 800, Math.PI / 3), null);
  assert.equal(earthDiscScreenRadius(earthRadius * 2, 0, Math.PI / 3), null);
  assert.equal(earthDiscScreenRadius(earthRadius * 2, 800, 0), null);
  assert.ok(earthDiscScreenRadius(earthRadius * 2, 800, Math.PI / 3) > 0);
});

test('camera-plane projection maps right, up, left, and down to canvas angles', () => {
  assert.ok(Math.abs(Number(celestialScreenAngle(1, 0).angle)) < 1e-9);
  assert.ok(Math.abs(celestialScreenAngle(0, 1).angle - Math.PI * 1.5) < 1e-9);
  assert.ok(Math.abs(celestialScreenAngle(-1, 0).angle - Math.PI) < 1e-9);
  assert.ok(Math.abs(celestialScreenAngle(0, -1).angle - Math.PI * 0.5) < 1e-9);
});

test('unstable camera-axis projection retains the last bearing and fades', () => {
  const last = 1.25;
  const projected = celestialScreenAngle(CELESTIAL_PLANE_EPSILON * 0.2, 0, last);
  assert.equal(projected.stable, false);
  assert.equal(projected.angle, last);
  assert.ok(projected.opacity > 0 && projected.opacity < 1);
});

test('angle normalization wraps both directions', () => {
  assert.ok(Math.abs(normalizeAngle(-Math.PI / 2) - Math.PI * 1.5) < 1e-9);
  assert.ok(Math.abs(normalizeAngle(Math.PI * 5) - Math.PI) < 1e-9);
});

test('circular angle distance remains small across the wrap point', () => {
  assert.ok(Math.abs(circularAngleDistance(0.04, Math.PI * 2 - 0.03) - 0.07) < 1e-9);
  assert.ok(Math.abs(circularAngleDistance(0, Math.PI) - Math.PI) < 1e-9);
});

test('celestial ring is available only in Normal style', () => {
  assert.equal(isCelestialRingStyleSupported('normal'), true);
  for (const style of ['retro', 'surveillance', 'thermal', 'anime', 'noir', 'snow']) {
    assert.equal(isCelestialRingStyleSupported(style), false);
  }
});

test('sun and moon bearings are independent rather than forced opposite', () => {
  const sun = celestialScreenAngle(1, 0).angle;
  const moon = celestialScreenAngle(0.6, -0.8).angle;
  assert.notEqual(normalizeAngle(moon - sun), Math.PI);
});

test('shared keyhole geometry is centered and height-derived', () => {
  const landscape = getKeyholeGeometry(1200, 800);
  const portrait = getKeyholeGeometry(800, 1200);
  assert.equal(landscape.centerX, 600);
  assert.equal(landscape.centerY, 400);
  assert.equal(landscape.radius, 420);
  assert.equal(portrait.centerX, 400);
  assert.equal(portrait.centerY, 600);
  assert.equal(portrait.radius, 630);
  // Degenerate viewports yield a degenerate keyhole, never NaN.
  assert.deepEqual(getKeyholeGeometry(0, 800), { centerX: 0, centerY: 0, radius: 0, featherPx: 0 });
  assert.deepEqual(getKeyholeGeometry(Number.NaN, 800), { centerX: 0, centerY: 0, radius: 0, featherPx: 0 });
});

test('label alpha stays opaque inside and fades monotonically outside', () => {
  setKeyholeFadeTuning({ fadeRatio: 0.16, outsideOpacity: 0 });
  const geometry = getKeyholeGeometry(1200, 800);
  const y = geometry.centerY;
  assert.equal(keyholeLabelAlpha(geometry.centerX, y, 1200, 800), 1);
  assert.equal(keyholeLabelAlpha(geometry.centerX + geometry.radius, y, 1200, 800), 1);
  const quarter = keyholeLabelAlpha(
    geometry.centerX + geometry.radius + geometry.featherPx * 0.25, y, 1200, 800,
  );
  const middle = keyholeLabelAlpha(
    geometry.centerX + geometry.radius + geometry.featherPx * 0.5, y, 1200, 800,
  );
  const threeQuarter = keyholeLabelAlpha(
    geometry.centerX + geometry.radius + geometry.featherPx * 0.75, y, 1200, 800,
  );
  assert.ok(quarter > middle && middle > threeQuarter);
  assert.ok(Math.abs(quarter - 0.75) < 1e-12);
  assert.ok(Math.abs(middle - 0.5) < 1e-12);
  assert.ok(Math.abs(threeQuarter - 0.25) < 1e-12);
  assert.equal(keyholeLabelAlpha(
    geometry.centerX + geometry.radius + geometry.featherPx, y, 1200, 800,
  ), 0);
});

test('fade tuning scales with keyhole radius and supports outside opacity', () => {
  setKeyholeFadeTuning({ fadeRatio: 0.2, outsideOpacity: 0.3 });
  const small = getKeyholeGeometry(800, 600);
  const large = getKeyholeGeometry(1600, 1200);
  assert.equal(large.featherPx, small.featherPx * 2);
  assert.deepEqual(getKeyholeFadeTuning(), { fadeRatio: 0.2, outsideOpacity: 0.3 });
  assert.equal(keyholeLabelAlpha(
    small.centerX + small.radius + small.featherPx,
    small.centerY,
    800,
    600,
  ), 0.3);
  setKeyholeFadeTuning({ fadeRatio: 0.16, outsideOpacity: 0.05 });
});

// ── CelestialRing runtime: fake DOM + deterministic Cesium seams ──────────
import * as Cesium from 'cesium';
import { CelestialRing } from './celestialRing.js';

const EARTH_RADIUS_M = 6_378_137;

/** CanvasRenderingContext2D recorder: every method the ring uses, counted. */
function makeCtx() {
  const gradient = { addColorStop() {} };
  const calls = { clearRect: 0, arc: 0, stroke: 0, fill: 0, fillRect: 0, setTransform: 0 };
  return {
    calls,
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
    arc() { calls.arc += 1; },
    stroke() { calls.stroke += 1; },
    fill() { calls.fill += 1; },
    clip() {},
    fillRect() { calls.fillRect += 1; },
    clearRect() { calls.clearRect += 1; },
    setTransform() { calls.setTransform += 1; },
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
  };
}

/** The slice of HTMLElement/CSSStyleDeclaration the overlay touches. */
class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
    this.dataset = {};
    this.classes = new Set();
    this.attributes = new Map();
    this.removed = false;
    this.removerCalls = 0;
  }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get classList() {
    const classes = this.classes;
    return {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  append(...kids) { this.children.push(...kids); }
  appendChild(kid) { this.children.push(kid); return kid; }
  remove() { this.removed = true; }
  getContext() { return this.ctx ??= makeCtx(); }
}

/**
 * Stub viewer with a camera the seams accept. `centerOverride` feeds the
 * patched worldToWindowCoordinates; `distanceM` positions the camera on the
 * -Z axis so magnitude/direction gates are deterministic.
 */
function makeViewer({ distanceM = EARTH_RADIUS_M, centerOverride = { x: 400, y: 300 } } = {}) {
  const container = new FakeEl('div');
  const root = new FakeEl('canvas');
  root.clientWidth = 800;
  root.clientHeight = 600;
  root.width = 800;
  root.height = 600;
  let drawFrame = null;
  let removerCalls = 0;
  return {
    container,
    canvas: root,
    removed: () => removerCalls,
    setDrawFrame: (fn) => { drawFrame = fn; },
    invokeDraw: () => drawFrame?.(),
    scene: {
      canvas: root,
      requestRender() {},
      postRender: {
        addEventListener(fn) {
          drawFrame = fn;
          return () => { removerCalls += 1; };
        },
      },
    },
    camera: {
      positionWC: new Cesium.Cartesian3(0, 0, -distanceM),
      directionWC: new Cesium.Cartesian3(0, 0, 1),
      rightWC: new Cesium.Cartesian3(1, 0, 0),
      upWC: new Cesium.Cartesian3(0, 1, 0),
      positionCartographic: { longitude: 0.5, latitude: 0.2, height: distanceM - EARTH_RADIUS_M },
      heading: 0,
      frustum: { fovy: Math.PI / 3 },
      flyTo() {},
    },
    centerOverride,
  };
}

/**
 * Stub the browser surface plus the Cesium seams a real scene normally
 * serves. Also mocks setInterval: the ring installs a real 60 s timer, and a
 * test that fails before destroy() would otherwise keep the runner alive.
 */
async function withBrowserEnvironment(t, viewer, run) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const savedDocument = globalThis.document;
  const savedWindow = globalThis.window;
  const savedW2W = Cesium.SceneTransforms.worldToWindowCoordinates;
  const savedIcrf = Cesium.Transforms.computeIcrfToFixedMatrix;
  globalThis.document = { createElement: (tag) => new FakeEl(tag), hidden: false };
  globalThis.window = { devicePixelRatio: 1.25 };
  Cesium.SceneTransforms.worldToWindowCoordinates = () => ({ ...viewer.centerOverride });
  // ICRF resolution fetches XYS data packs by URL — impossible headless.
  // Returning null drives the module's TEME-to-pseudo-fixed fallback, which
  // is the branch the runtime rides whenever ICRF data is absent.
  Cesium.Transforms.computeIcrfToFixedMatrix = () => null;
  try {
    await run();
  } finally {
    globalThis.document = savedDocument;
    globalThis.window = savedWindow;
    Cesium.SceneTransforms.worldToWindowCoordinates = savedW2W;
    Cesium.Transforms.computeIcrfToFixedMatrix = savedIcrf;
  }
}

test('the ring builds its overlay DOM, throttles frames, and tears down cleanly', async (t) => {
  const viewer = makeViewer({ distanceM: EARTH_RADIUS_M * 3 });
  await withBrowserEnvironment(t, viewer, () => {
    const ring = new CelestialRing(viewer, {});
    const rootEl = viewer.container.children.at(-1);
    assert.equal(rootEl.id, 'celestial-ring-overlay');
    assert.equal(rootEl.classes.has('celestial-ring-overlay'), true);
    assert.equal(rootEl.attributes.get('aria-hidden'), 'true');
    assert.equal(rootEl.children.length, 5, 'outline, two canvases, two markers');

    // Frame hook registered and usable: a draw on a fresh far camera runs
    // the full gate path without throwing.
    assert.doesNotThrow(() => viewer.invokeDraw());
    ring.destroy();
    assert.equal(viewer.removed(), 1, 'postRender remover called once');
    assert.equal(rootEl.removed, true, 'overlay DOM removed');
  });
});

test('a near-ground camera never shows the ring and auto-disables the effect', async (t) => {
  const viewer = makeViewer({ distanceM: EARTH_RADIUS_M });
  await withBrowserEnvironment(t, viewer, () => {
    let autoDisabled = 0;
    const ring = new CelestialRing(viewer, { onAutoDisable: () => { autoDisabled += 1; } });
    const rootEl = viewer.container.children.at(-1);

    viewer.invokeDraw();
    assert.equal(ring.visible, false, 'disc does not project at/below the surface');
    assert.equal(rootEl.classes.has('visible'), false);
    assert.equal(rootEl.dataset.globeVisible, 'false');
    assert.equal(autoDisabled, 1, 'non-full-globe view auto-disables');
    assert.equal(ring.enabled, false);
    assert.equal(rootEl.classes.has('disabled'), true);

    const debug = ring.getDebugState();
    assert.equal(debug.visible, false);
    assert.equal(debug.disc, null);

    // A draw with the effect disabled is a silent no-op.
    viewer.invokeDraw();
    assert.equal(autoDisabled, 1);

    ring.destroy();
  });
});

test('a full-globe camera paints effect layers, markers, and reports state', async (t) => {
  const viewer = makeViewer({ distanceM: EARTH_RADIUS_M * 3 });
  await withBrowserEnvironment(t, viewer, () => {
    const ring = new CelestialRing(viewer, {});
    const rootEl = viewer.container.children.at(-1);
    const [outline, sunCanvas, moonCanvas, sunMarker, moonMarker] = rootEl.children;

    viewer.invokeDraw();
    assert.equal(ring.visible, true, 'globe fits the keyhole with clearance');
    assert.equal(rootEl.classes.has('visible'), true);
    assert.equal(rootEl.dataset.globeVisible, 'true');
    assert.equal(rootEl.dataset.ephemerisUpdates, '1', 'real ephemeris sampled once');

    // Backing store: dpr clamped to 1.25, and the pixel budget respected.
    assert.equal(sunCanvas.width, 1000);
    assert.equal(sunCanvas.height, 750);
    assert.equal(sunCanvas.style.width, '800px');

    // Cached effect layers painted once (sun rays + two tapered arcs + haze).
    assert.equal(outline.style.display, '');
    assert.equal(outline.style.width, '608px', 'radius 304px = keyhole 315 − 11 inset');
    assert.ok(sunCanvas.ctx.calls.clearRect >= 1, 'sun layer cleared before painting');
    assert.ok(sunCanvas.ctx.calls.stroke > 0, 'tapered arc segments stroked');
    assert.ok(moonCanvas.ctx.calls.fill > 0, 'moon haze filled');
    assert.ok(sunCanvas.style.transform.startsWith('rotate('), 'sun canvas rotated to bearing');
    assert.ok(Number(sunCanvas.style.opacity) >= 0 && Number(sunCanvas.style.opacity) <= 1);
    assert.ok(sunMarker.style.left.endsWith('px'), 'sun marker positioned');
    assert.ok(moonMarker.style.top.endsWith('px'), 'moon marker positioned');

    const debug = ring.getDebugState();
    assert.equal(debug.visible, true);
    assert.equal(debug.renderScale, 1.25);
    assert.ok(Number.isFinite(debug.sunAngle));
    assert.ok(Number.isFinite(debug.moonAngle));
    assert.equal(debug.markersCollide, false);
    assert.ok(debug.disc.earthRadius > 0);

    // Disabling clears the canvases and parks the outline.
    ring.setEnabled(false);
    assert.equal(rootEl.classes.has('disabled'), true);
    assert.equal(outline.style.display, 'none');
    assert.equal(sunCanvas.ctx.calls.clearRect >= 2, true, 'canvases cleared on disable');

    ring.destroy();
  });
});

test('the frame throttle holds the stale composition until the next slot', async (t) => {
  const viewer = makeViewer({ distanceM: EARTH_RADIUS_M * 3 });
  await withBrowserEnvironment(t, viewer, () => {
    const ring = new CelestialRing(viewer, {});
    viewer.invokeDraw();
    assert.equal(ring.visible, true);

    // Camera "moves" so the globe no longer fits, but inside the 33 ms slot:
    // the throttled draw must keep the previous visible state.
    viewer.centerOverride = { x: 4000, y: 300 };
    viewer.invokeDraw();
    assert.equal(ring.visible, true, 'throttled frame keeps the stale state');

    // After the slot opens, the same camera state flips the ring off.
    const realNow = performance.now.bind(performance);
    performance.now = () => realNow() + 40;
    try {
      viewer.invokeDraw();
    } finally {
      performance.now = realNow;
    }
    assert.equal(ring.visible, false, 'unthrottled frame applies the new camera');
    assert.equal(ring.enabled, false, 'auto-disable fires once the slot opens');

    ring.destroy();
  });
});

test('focusFullGlobe flies to the keyhole-framing altitude and cancels disable safely', async (t) => {
  const viewer = makeViewer({ distanceM: EARTH_RADIUS_M * 1.2, centerOverride: { x: 4000, y: 300 } });
  await withBrowserEnvironment(t, viewer, () => {
    let autoDisabled = 0;
    let flight = null;
    viewer.camera.flyTo = (options) => { flight = options; };
    const ring = new CelestialRing(viewer, { onAutoDisable: () => { autoDisabled += 1; } });
    ring.setEnabled(false); // focusFullGlobe must re-enable nothing by itself
    ring.enabled = true;

    const started = ring.focusFullGlobe({});
    assert.equal(started, true, 'valid camera geometry starts the flight');
    assert.ok(flight, 'flyTo was called');

    // Degenerate frusta refuse to fly rather than dividing by zero.
    viewer.camera.frustum.fovy = 0;
    assert.equal(ring.focusFullGlobe({}), false, 'zero fovy refuses');
    viewer.camera.frustum.fovy = Math.PI;
    assert.equal(ring.focusFullGlobe({}), false, 'π fovy refuses');
    viewer.camera.frustum.fovy = Math.PI / 3;
    assert.ok(Cesium.Cartesian3.magnitude(flight.destination) > EARTH_RADIUS_M * 1.55,
      'destination clears the minimum full-globe altitude');
    assert.equal(flight.orientation.pitch, -Cesium.Math.PI_OVER_TWO);
    assert.equal(typeof flight.complete, 'function');
    assert.equal(typeof flight.cancel, 'function');

    // Cancellation over a NON-full-globe view must auto-disable (user walked
    // away mid-flight), and completion must just release the focus latch.
    flight.cancel();
    assert.equal(autoDisabled, 1);
    assert.equal(ring.enabled, false);

    ring.setEnabled(true);
    ring.focusFullGlobe({});
    flight.complete();
    assert.equal(ring.enabled, true, 'completion does not disable');

    ring.destroy();
  });
});

test('isGlobeFullyVisible answers from the projected geometry alone', async (t) => {
  const viewer = makeViewer({ distanceM: EARTH_RADIUS_M * 3 });
  await withBrowserEnvironment(t, viewer, () => {
    const ring = new CelestialRing(viewer, { enabled: false });
    // The gate is geometric: it works regardless of the enabled preference,
    // which is what lets the focus flight verify its own composition.
    assert.equal(ring.isGlobeFullyVisible(), true, 'centered disc clears the entry margin');

    viewer.centerOverride = { x: 4000, y: 300 };
    assert.equal(ring.isGlobeFullyVisible(), false, 'offscreen disc fails containment');

    ring.destroy();
  });
});

test('the ephemeris interval marks data dirty and survives document visibility', (t) => {
  const viewer = makeViewer({ distanceM: EARTH_RADIUS_M * 3 });
  return withBrowserEnvironment(t, viewer, async () => {
    const realNow = performance.now.bind(performance);
    // Draws are throttled to 30 fps against the clock _draw reads — and that
    // read also SETS the next slot, so each call must land strictly past the
    // previous one's slot (+40, +80, …), not merely past real time.
    let drawStep = 0;
    const drawUnthrottled = () => {
      drawStep += 1;
      performance.now = () => realNow() + 40 * drawStep;
      try {
        viewer.invokeDraw();
      } finally {
        performance.now = realNow;
      }
    };

    const ring = new CelestialRing(viewer, {});
    // Consume the initial dirty flag.
    drawUnthrottled();
    const updates = Number(rootEl(viewer).dataset.ephemerisUpdates);
    assert.equal(updates, 1);

    // 61 s later the timer re-dirties; a hidden document must NOT request a
    // render, but the dirty flag still forces a resample on the next frame.
    globalThis.document.hidden = true;
    t.mock.timers.tick(61_000);
    globalThis.document.hidden = false;
    drawUnthrottled();
    assert.equal(
      Number(rootEl(viewer).dataset.ephemerisUpdates),
      updates + 1,
      'hidden interval still ages the ephemeris',
    );

    // A visible tick also requests the repaint frame (governor path).
    t.mock.timers.tick(61_000);
    drawUnthrottled();
    assert.equal(
      Number(rootEl(viewer).dataset.ephemerisUpdates),
      updates + 2,
      'visible tick resamples too',
    );

    ring.destroy();
    // After destroy the interval is gone — more elapsed time is a no-op.
    t.mock.timers.tick(61_000);
    drawUnthrottled();
    assert.equal(
      Number(rootEl(viewer).dataset.ephemerisUpdates),
      updates + 2,
      'destroyed timer no longer refreshes',
    );
  });
});

function rootEl(viewer) {
  return viewer.container.children.at(-1);
}
