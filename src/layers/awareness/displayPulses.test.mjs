// The Global Context range pulses on a globe without a Cesium viewer
// (Navara): the same clock, ring flash, frame requests and echo field as on
// Cesium, drawn through the display's ring and pulse disc.
import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { CYBER_SONAR_RENDER_INTERVAL_MS } from '../../cyberSonar.js';
import { getAwarenessEchoField } from '../../awarenessEcho.js';
import { createRendering } from './rendering.js';
import { createState } from './state.js';
import { AWARENESS_RANGE_PULSE, CONTEXT_RIM_HEIGHT_M } from './policy.js';

function event() {
  const listeners = new Set();
  return {
    add(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    raise() {
      for (const listener of [...listeners]) listener();
    },
    get size() {
      return listeners.size;
    },
  };
}

function displayRendering(t, { pulses = true, reducedMotion = false } = {}) {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({
    matches: reducedMotion,
    addEventListener() {},
    removeEventListener() {},
  });
  t.after(() => {
    globalThis.matchMedia = previous;
  });
  const frame = event();
  const frameEnd = event();
  const rims = [];
  const discs = [];
  let height = 800_000;
  const display = {
    container: {},
    canvas: { clientWidth: 800, clientHeight: 600 },
    camera: {},
    cameraHeight: () => height,
    onFrame: (run) => frame.add(run),
    onFrameEnd: (run) => frameEnd.add(run),
    createRim(center) {
      const rim = {
        center,
        alphas: [],
        destroyed: false,
        move(next) {
          rim.center = next;
        },
        setAlpha(alpha) {
          rim.alphas.push(alpha);
        },
        destroy() {
          rim.destroyed = true;
        },
      };
      rims.push(rim);
      return rim;
    },
    ...(pulses
      ? {
          createPulses(center) {
            const disc = {
              center,
              draws: [],
              destroyed: false,
              move(next) {
                disc.center = next;
              },
              draw(state) {
                disc.draws.push({
                  level: state.level,
                  radii: [...state.radii],
                  alphas: [...state.alphas],
                });
              },
              destroy() {
                disc.destroyed = true;
              },
            };
            discs.push(disc);
            return disc;
          },
        }
      : {}),
  };
  const state = createState({ services: {} });
  state.display = display;
  const reasons = [];
  const rendering = createRendering({
    state,
    services: {
      geometry: {},
      render: { governorRequestRender: (reason) => reasons.push(reason) },
    },
    parts: {},
  });
  t.after(() => rendering.clearVisual());
  let clock = 1_000_000;
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'], now: clock });
  const draw = () => {
    frame.raise();
    frameEnd.raise();
  };
  return {
    state,
    rendering,
    rims,
    discs,
    frame,
    frameEnd,
    reasons,
    draw,
    setHeight(next) {
      height = next;
    },
    advance(ms) {
      clock += ms;
      t.mock.timers.tick(ms);
    },
  };
}

const subject = (lon) => ({
  layerId: 'flights',
  id: 'abc123',
  position: geo.cartesian3.fromDegrees(lon, 27, 9000),
});

test('a Navara display draws the pulses, flashes its ring and publishes the echo field', (t) => {
  const h = displayRendering(t);
  h.rendering.renderVisual(subject(3));
  assert.equal(h.rims.length, 1);
  assert.equal(h.discs.length, 1);
  assert.ok(getAwarenessEchoField(), 'the overlay echoes the fronts');
  // A second in: the pulses are rising, the fronts are inside the range.
  h.advance(1000);
  h.draw();
  const last = h.discs[0].draws.at(-1);
  assert.ok(last.level > 0);
  assert.ok(last.radii.slice(0, 3).every((r) => r > 0 && r <= 1));
  assert.ok(last.alphas.some((a) => a > 0));
  assert.ok(h.rims[0].alphas.at(-1) < 1, 'the ring dims while they run');
  // Each drawn frame asks for the next one a sonar interval later.
  const before = h.reasons.filter((r) => r === 'awareness-pulse').length;
  h.advance(CYBER_SONAR_RENDER_INTERVAL_MS);
  assert.equal(
    h.reasons.filter((r) => r === 'awareness-pulse').length,
    before + 1,
  );
  // After the active window they rest: no level, no more frame requests.
  h.advance(AWARENESS_RANGE_PULSE.activeMs + AWARENESS_RANGE_PULSE.settleMs);
  h.draw();
  assert.equal(h.discs[0].draws.at(-1).level, 0);
  assert.equal(h.rims[0].alphas.at(-1), 1, 'the ring is steady at rest');
  const rested = h.reasons.length;
  h.advance(CYBER_SONAR_RENDER_INTERVAL_MS * 3);
  assert.equal(h.reasons.length, rested);
  // A camera move the user made wakes them again.
  h.rendering.wakePulses();
  h.advance(1000);
  h.draw();
  assert.ok(h.discs[0].draws.at(-1).level > 0);
});

test('the Navara disc follows the subject and goes with the ring', (t) => {
  const h = displayRendering(t);
  h.rendering.renderVisual(subject(3));
  h.rendering.renderVisual(subject(3.5));
  assert.equal(h.discs.length, 1, 'a move is not a rebuild');
  assert.ok(
    geo.cartesian3.distance(h.discs[0].center, h.rims[0].center) < 1,
    'disc and ring share the centre',
  );
  h.rendering.clearVisual();
  assert.equal(h.discs[0].destroyed, true);
  assert.equal(h.rims[0].destroyed, true);
  assert.equal(h.frame.size, 0, 'no frame listener left');
  assert.equal(h.frameEnd.size, 0);
  assert.equal(getAwarenessEchoField(), null);
});

test('below the rim height the pulses rest, so no disc sweeps across the sky', (t) => {
  const h = displayRendering(t);
  h.setHeight(CONTEXT_RIM_HEIGHT_M - 1);
  h.rendering.renderVisual(subject(3));
  h.advance(1000);
  h.draw();
  assert.equal(h.discs[0].draws.at(-1).level, 0);
  const rested = h.reasons.length;
  h.advance(CYBER_SONAR_RENDER_INTERVAL_MS * 3);
  assert.equal(h.reasons.length, rested, 'and ask for no frames');
});

for (const [name, options] of [
  ['reduced motion', { reducedMotion: true }],
  ['a display without a disc', { pulses: false }],
])
  test(`under ${name} the ring stands alone`, (t) => {
    const h = displayRendering(t, options);
    h.rendering.renderVisual(subject(3));
    assert.equal(h.rims.length, 1);
    assert.equal(h.discs.length, 0);
    assert.equal(h.frame.size, 0);
    assert.equal(getAwarenessEchoField(), null);
  });
