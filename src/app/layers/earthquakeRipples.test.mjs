import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISC_FADE,
  cssWithAlpha,
  RIPPLE_ACTIVE_CYCLES,
  RIPPLE_PAINT_LANE,
  RIPPLE_RING_SEGMENTS,
  createEarthquakeRipples,
} from './earthquakeRipples.js';
import {
  EARTHQUAKE_RIPPLE_PERIOD_MS,
  EARTHQUAKE_RIPPLE_RINGS,
} from '../../layers/earthquakes/model.js';
import { fromDegrees } from '../../geo/ellipsoid.js';

/** A paint lane, frame clock and canvas the test steps by hand. */
function harness({ reducedMotion = false } = {}) {
  let motionReduced = reducedMotion;
  const lanes = [];
  const frames = new Map();
  let nextFrame = 1;
  let clock = 0;
  const ripples = createEarthquakeRipples({
    registerLane(laneId, painter, options) {
      const lane = {
        laneId,
        painter,
        options,
        active: false,
        paints: 0,
        unregistered: false,
        setActive(next) {
          lane.active = next;
        },
        requestPaint() {
          lane.paints++;
        },
        unregister() {
          lane.unregistered = true;
        },
      };
      lanes.push(lane);
      return lane;
    },
    now: () => clock,
    requestFrame(cb) {
      const handle = nextFrame++;
      frames.set(handle, cb);
      return handle;
    },
    cancelFrame: (handle) => frames.delete(handle),
    prefersReducedMotion: () => motionReduced,
  });
  const strokes = [];
  const fills = [];
  let path = null;
  const ctx = {
    globalAlpha: 1,
    beginPath() {
      path = { moves: 0, lines: 0 };
    },
    moveTo() {
      path.moves++;
    },
    lineTo() {
      path.lines++;
    },
    stroke() {
      strokes.push({
        ...path,
        alpha: ctx.globalAlpha,
        color: ctx.strokeStyle,
        width: ctx.lineWidth,
      });
    },
    // Fills record their path, gradient and the transform they fill under.
    saved: 0,
    transformed: null,
    save() {
      ctx.saved++;
    },
    restore() {
      ctx.saved--;
      ctx.transformed = null;
    },
    transform(...args) {
      ctx.transformed = args;
    },
    createRadialGradient(...circles) {
      const gradient = { circles, stops: [] };
      gradient.addColorStop = (offset, color) =>
        gradient.stops.push([offset, color]);
      return gradient;
    },
    fill() {
      fills.push({
        ...path,
        gradient: ctx.fillStyle,
        transform: ctx.transformed,
      });
    },
  };
  // w = 1 everywhere: every point is in front of the eye.
  const matrix = new Float64Array(16);
  matrix[0] = 1e-7;
  matrix[5] = 1e-7;
  matrix[15] = 1;
  const frame = (visible = true) => ({
    ctx,
    width: 800,
    height: 600,
    viewProjectionMatrix: matrix,
    occluder: { isPointVisible: () => visible },
  });
  return {
    ripples,
    lanes,
    frames,
    strokes,
    fills,
    frame,
    matrix,
    setReducedMotion(next) {
      motionReduced = next;
    },
    advance(ms) {
      clock += ms;
    },
    /** Run the pending animation frames once. */
    step() {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, cb] of pending) cb();
    },
  };
}

const target = {
  id: 'ak1',
  lon: -153.3,
  lat: 60,
  radiusM: 32000,
  color: 'rgb(255,0,0)',
};

test('nothing is registered or animated until a quake is selected', () => {
  const h = harness();
  assert.equal(h.lanes.length, 0);
  assert.equal(h.frames.size, 0);
  h.ripples.hide();
  assert.equal(h.frames.size, 0);
});

test('a selected quake animates one ring set, one frame request at a time', () => {
  const h = harness();
  h.ripples.show(target);
  const [lane] = h.lanes;
  assert.equal(lane.laneId, RIPPLE_PAINT_LANE);
  assert.equal(RIPPLE_PAINT_LANE, 'ambient-label', 'under the labels');
  assert.equal(lane.active, true);
  assert.equal(h.frames.size, 1);
  h.ripples.show({ ...target, id: 'ak2' });
  assert.equal(h.lanes.length, 1, 'the lane is reused');
  assert.equal(h.frames.size, 1, 'still one frame loop');
  const before = lane.paints;
  h.step();
  h.step();
  assert.equal(lane.paints, before + 2, 'one repaint per frame');
  assert.equal(h.frames.size, 1);

  h.advance(600);
  lane.painter(h.frame());
  // At 600 ms every line is between the marker and the edge, so all draw.
  assert.equal(h.strokes.length, EARTHQUAKE_RIPPLE_RINGS);
  assert.deepEqual(
    h.strokes.map((stroke) => stroke.width),
    [2, 1.1, 1.1, 2, 1.1, 1.1],
    'every third line is an index contour',
  );
  for (const stroke of h.strokes) {
    assert.equal(stroke.moves, 1, 'one unbroken ring');
    assert.equal(stroke.lines, RIPPLE_RING_SEGMENTS);
    assert.equal(stroke.color, 'rgb(255,0,0)');
    assert.ok(stroke.alpha > 0 && stroke.alpha <= 1);
  }

  h.ripples.hide();
  assert.equal(lane.active, false);
  assert.equal(h.frames.size, 0, 'no frames asked for once hidden');
  h.strokes.length = 0;
  lane.painter(h.frame());
  assert.equal(h.strokes.length, 0);
});

test('rings are skipped behind the globe and broken behind the eye', () => {
  const h = harness();
  h.ripples.show(target);
  h.advance(600);
  const [lane] = h.lanes;
  lane.painter(h.frame(false));
  assert.equal(h.strokes.length, 0, 'epicentre over the horizon');

  // Points with negative x fall behind the eye: each ring breaks there.
  const frame = h.frame();
  frame.viewProjectionMatrix[3] = 1e-6;
  const center = fromDegrees(target.lon, target.lat);
  frame.viewProjectionMatrix[15] = -1e-6 * center.x;
  lane.painter(frame);
  assert.equal(h.strokes.length, EARTHQUAKE_RIPPLE_RINGS);
  for (const stroke of h.strokes)
    assert.ok(stroke.lines < RIPPLE_RING_SEGMENTS, 'part of each ring hidden');
});

test('reduced motion draws still contour rings and asks for no frames', () => {
  const h = harness({ reducedMotion: true });
  h.ripples.show(target);
  assert.equal(h.frames.size, 0);
  assert.equal(h.lanes[0].paints, 1, 'painted once');
  h.lanes[0].painter(h.frame());
  assert.equal(h.strokes.length, EARTHQUAKE_RIPPLE_RINGS);
  assert.ok(h.strokes.every((stroke) => stroke.alpha === 0.7));
});

test('an unusable target hides the rings; dispose releases the lane', () => {
  const h = harness();
  h.ripples.show(target);
  h.ripples.show({ ...target, radiusM: 0 });
  assert.equal(h.lanes[0].active, false);
  assert.equal(h.frames.size, 0);
  h.ripples.dispose();
  assert.equal(h.lanes[0].unregistered, true);
  // Shown again after dispose, it registers a fresh lane.
  h.ripples.show(target);
  assert.equal(h.lanes.length, 2);
  h.ripples.dispose();
});

test('contour lines are wavy, the same for a quake every time, and inside the disc', () => {
  const h = harness();
  h.ripples.show(target);
  h.advance(600);
  // An identity-like projection: screen x, y follow ECEF y, z, so the
  // distance from the projected epicentre measures each point's radius.
  const frame = h.frame();
  const m = frame.viewProjectionMatrix;
  m[0] = 0;
  m[5] = 0;
  m[4] = 1e-6;
  m[9] = 1e-6;
  const points = [];
  const ctx = frame.ctx;
  const record = (x, y) => points.at(-1).push([x, y]);
  ctx.beginPath = () => points.push([]);
  ctx.moveTo = record;
  ctx.lineTo = record;
  ctx.stroke = () => {};
  h.lanes[0].painter(frame);
  const center = fromDegrees(target.lon, target.lat);
  const cx = (center.y * 1e-6 * 0.5 + 0.5) * 800;
  const cy = (0.5 - center.z * 1e-6 * 0.5) * 600;
  const spread = (line) => {
    const radii = line.map(([x, y]) => Math.hypot(x - cx, y - cy));
    return Math.max(...radii) / Math.min(...radii);
  };
  // The disc's outer circle first (filled, not stroked), then each line.
  assert.equal(points.length, EARTHQUAKE_RIPPLE_RINGS + 1);
  points.shift();
  assert.ok(
    points.every((line) => spread(line) > 1.05),
    'not circles: each line dents in and out',
  );
  for (const line of points) {
    const [first, last] = [line[0], line.at(-1)];
    assert.ok(
      Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6,
      'closed',
    );
  }
});

test('the disc fades out to its outer circle; each wave fills with a fade', () => {
  const h = harness();
  h.ripples.show(target);
  h.advance(600);
  // A projection where east and north span the screen: the disc is seen
  // from above, so its ground frame can be filled.
  const frame = h.frame();
  const m = frame.viewProjectionMatrix;
  m[0] = 0;
  m[5] = 0;
  m[4] = 1e-6;
  m[9] = 1e-6;
  h.lanes[0].painter(frame);
  assert.equal(h.fills.length, 1 + EARTHQUAKE_RIPPLE_RINGS);
  const [disc, ...waves] = h.fills;
  assert.equal(disc.lines, RIPPLE_RING_SEGMENTS, 'the whole outer circle');
  assert.deepEqual(disc.gradient.circles, [0, 0, 0, 0, 0, 1]);
  assert.deepEqual(
    disc.gradient.stops,
    DISC_FADE.map(([offset, alpha]) => [offset, `rgba(255,0,0,${alpha})`]),
  );
  assert.equal(disc.gradient.stops.at(-1)[1], 'rgba(255,0,0,0)', 'fades out');
  assert.ok(disc.transform, 'filled under the ground-to-screen transform');
  assert.equal(h.fills.length, waves.length + 1);
  for (const wave of waves) {
    const reach = wave.gradient.circles[5];
    assert.ok(reach > 0 && reach < 1, 'out to its own line');
    assert.equal(wave.gradient.stops[0][1], 'rgba(255,0,0,0)', 'clear inside');
  }
  // The transforms were undone: nothing leaks into the labels' painting.
  assert.equal(frame.ctx.saved, 0);
  // Seen edge-on, the ground frame has no area: lines only, no fills.
  h.fills.length = 0;
  m[9] = 0;
  m[5] = 0;
  h.lanes[0].painter(frame);
  assert.equal(h.fills.length, 0);
});

test('cssWithAlpha turns rgb into rgba stops', () => {
  assert.equal(cssWithAlpha('rgb(255,165,0)')(0.25), 'rgba(255,165,0,0.25)');
  assert.equal(cssWithAlpha('rgba(1, 2, 3, 0.5)')(2), 'rgba(1,2,3,1)');
  assert.equal(cssWithAlpha('red')(0.3), 'red');
});

test('the lines run a bounded time after a selection, then rest without frames', () => {
  const h = harness();
  h.ripples.show(target);
  const [lane] = h.lanes;
  const window = RIPPLE_ACTIVE_CYCLES * EARTHQUAKE_RIPPLE_PERIOD_MS;
  assert.ok(window <= 15_000, 'about a quarter of a minute at most');
  let frames = 0;
  for (let t = 0; t < window * 3; t += 16) {
    if (!h.frames.size) break;
    lane.painter(h.frame());
    h.advance(16);
    h.step();
    frames++;
  }
  assert.equal(h.frames.size, 0, 'no frame asked for once settled');
  assert.ok(frames <= Math.ceil(window / 16) + 2, `bounded: ${frames} frames`);
  // At rest the lines hold still as readable contours.
  h.strokes.length = 0;
  lane.painter(h.frame());
  assert.equal(h.strokes.length, EARTHQUAKE_RIPPLE_RINGS);
  assert.ok(h.strokes.every((stroke) => stroke.alpha === 0.7));
  // A parked camera repainting the overlay does not start them again.
  lane.painter(h.frame());
  assert.equal(h.frames.size, 0);
  // A new selection runs again.
  h.ripples.show({ ...target, id: 'ak2' });
  assert.equal(h.frames.size, 1);
  h.ripples.dispose();
});

test('off screen the frames stop; back in view inside the window they resume', () => {
  const h = harness();
  h.ripples.show(target);
  const [lane] = h.lanes;
  // Behind the globe.
  lane.painter(h.frame(false));
  const paints = lane.paints;
  h.step();
  assert.equal(h.frames.size, 0, 'stopped while out of sight');
  assert.equal(lane.paints, paints + 1, 'one last paint, then none');
  h.step();
  assert.equal(lane.paints, paints + 1);
  // Panned away: the disc is far off the viewport.
  h.ripples.show(target);
  const away = h.frame();
  away.viewProjectionMatrix[12] = 50;
  lane.painter(away);
  h.step();
  assert.equal(h.frames.size, 0);
  // The camera brings it back while the window lasts.
  away.viewProjectionMatrix[12] = 0;
  lane.painter(h.frame());
  assert.equal(h.frames.size, 1, 'resumed');
  h.ripples.dispose();
});

test('turning reduced motion on mid-run stills the lines and stops the frames', () => {
  const h = harness();
  h.ripples.show(target);
  const [lane] = h.lanes;
  lane.painter(h.frame());
  h.setReducedMotion(true);
  h.step();
  assert.equal(h.frames.size, 0);
  h.strokes.length = 0;
  lane.painter(h.frame());
  assert.ok(
    h.strokes.every((stroke) => stroke.alpha === 0.7),
    'still',
  );
  // Turned off again within the window: the next paint runs them again.
  h.setReducedMotion(false);
  lane.painter(h.frame());
  assert.equal(h.frames.size, 1);
  h.ripples.dispose();
});

test('a refresh of the same quake does not run a settled selection again', () => {
  const h = harness();
  h.ripples.show(target);
  const [lane] = h.lanes;
  h.advance(RIPPLE_ACTIVE_CYCLES * EARTHQUAKE_RIPPLE_PERIOD_MS + 1);
  lane.painter(h.frame());
  h.step();
  assert.equal(h.frames.size, 0, 'settled');
  h.ripples.show({ ...target, radiusM: 40000 }, { restart: false });
  assert.equal(h.frames.size, 0, 'a refresh keeps it at rest');
  lane.painter(h.frame());
  assert.equal(h.frames.size, 0);
  // A different quake, or a user's restart, runs again.
  h.ripples.show({ ...target, id: 'other' }, { restart: false });
  assert.equal(h.frames.size, 1);
  h.ripples.dispose();
});

// The rings sit on the ground the disc is draped on. A label's fly-to starts
// far away, before that ground loads, so the painter reads the height again
// while it paints and moves the rings onto it.
test('the rings move onto the ground height once it loads', () => {
  const h = harness();
  let ground = null;
  h.ripples.show({ ...target, heightM: 0, heightAt: () => ground });
  h.advance(600);
  const [lane] = h.lanes;
  lane.painter(h.frame());
  const atSea = h.fills.at(-1).transform;
  h.fills.length = 0;
  ground = 4000;
  h.advance(600);
  lane.painter(h.frame());
  const onGround = h.fills.at(-1).transform;
  assert.notDeepEqual(onGround, atSea, 'the centre moved up onto the ground');
  // A change of a metre or less, or an impossible height, leaves them put.
  for (const next of [4000.5, 25000, -2000]) {
    ground = next;
    h.advance(600);
    lane.painter(h.frame());
    assert.deepEqual(h.fills.at(-1).transform, onGround, String(next));
  }
  // Reads are bounded: a second paint within the interval does not ask again.
  let reads = 0;
  h.ripples.show({ ...target, id: 'ak2', heightAt: () => (reads++, 4000) });
  lane.painter(h.frame());
  lane.painter(h.frame());
  assert.equal(reads, 1);
});
