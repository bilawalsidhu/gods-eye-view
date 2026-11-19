// Hand control: poses from synthetic landmarks and the frame-to-frame intents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GestureInterpreter,
  OneEuro,
  calibrateFromSamples,
  classifyHand,
  handFeatures,
  mirrorLandmarks,
  wrapAngle,
} from './gestures.js';

/**
 * A raw (unmirrored) upright hand: wrist below, knuckles at `cy`, palm length
 * `s`. `pose` decides where each fingertip sits.
 */
function hand(
  pose,
  { cx = 0.5, cy = 0.5, s = 0.15, rot = 0, flip = false } = {},
) {
  const raw = new Array(21);
  const put = (i, dx0, dy) => {
    const dx = flip ? -dx0 : dx0;
    const x = dx * Math.cos(rot) - dy * Math.sin(rot);
    const y = dx * Math.sin(rot) + dy * Math.cos(rot);
    raw[i] = { x: cx + x * s, y: cy + y * s, z: 0 };
  };
  put(0, 0, 1); // wrist
  const mcps = { 5: -0.3, 9: 0, 13: 0.2, 17: 0.35 };
  for (const [i, dx] of Object.entries(mcps)) put(Number(i), dx, 0);
  const straight = (mcp, dx) => {
    put(mcp + 1, dx, -0.35);
    put(mcp + 2, dx, -0.65);
    put(mcp + 3, dx, -0.9);
  };
  const curled = (mcp, dx) => {
    put(mcp + 1, dx, -0.25);
    put(mcp + 2, dx, 0);
    put(mcp + 3, dx, 0.15);
  };
  const thumbOut = () => {
    put(1, -0.3, 0.75);
    put(2, -0.55, 0.5);
    put(3, -0.75, 0.35);
    put(4, -0.95, 0.2);
  };
  const thumbIn = () => {
    put(1, -0.3, 0.75);
    put(2, -0.3, 0.5);
    put(3, -0.1, 0.35);
    put(4, 0.05, 0.25);
  };
  if (pose === 'open') {
    thumbOut();
    for (const [i, dx] of Object.entries(mcps)) straight(Number(i), dx);
  } else if (pose === 'fist') {
    thumbIn();
    for (const [i, dx] of Object.entries(mcps)) curled(Number(i), dx);
  } else if (pose === 'phone') {
    thumbOut();
    curled(5, -0.3);
    curled(9, 0);
    curled(13, 0.2);
    straight(17, 0.35);
  } else if (pose === 'bunch') {
    for (const [i, dx] of Object.entries(mcps)) {
      put(Number(i) + 1, dx * 0.7, -0.35);
      put(Number(i) + 2, dx * 0.4, -0.55);
      put(Number(i) + 3, dx * 0.05, -0.7);
    }
    put(1, -0.35, 0.7);
    put(2, -0.35, 0.3);
    put(3, -0.2, -0.3);
    put(4, -0.02, -0.68);
  } else if (pose === 'pilot' || pose === 'point') {
    if (pose === 'pilot') thumbOut();
    else thumbIn();
    straight(5, -0.3);
    curled(9, 0);
    curled(13, 0.2);
    curled(17, 0.35);
  } else if (pose === 'pilot-right') {
    // Index leaning to the raw left = the person's right in the mirror.
    thumbOut();
    put(6, -0.45, -0.3);
    put(7, -0.6, -0.55);
    put(8, -0.75, -0.75);
    curled(9, 0);
    curled(13, 0.2);
    curled(17, 0.35);
  } else if (pose === 'victory') {
    thumbIn();
    straight(5, -0.3);
    straight(9, 0);
    curled(13, 0.2);
    curled(17, 0.35);
  } else if (pose === 'thumb-up' || pose === 'thumb-side') {
    for (const [i, dx] of Object.entries(mcps)) curled(Number(i), dx);
    put(1, -0.3, 0.75);
    if (pose === 'thumb-up') {
      put(2, -0.45, 0.35);
      put(3, -0.5, -0.1);
      put(4, -0.6, -0.65);
    } else {
      put(2, -0.5, 0.45);
      put(3, -0.8, 0.4);
      put(4, -1.1, 0.35);
    }
  } else if (pose === 'pinch' || pose === 'pinch-open') {
    put(1, -0.35, 0.7);
    put(2, -0.45, 0.35);
    put(3, -0.35, -0.2);
    put(4, pose === 'pinch-open' ? -0.55 : -0.25, -0.55);
    put(6, -0.3, -0.35);
    put(7, -0.28, -0.5);
    put(8, -0.25, -0.58);
    curled(9, 0);
    curled(13, 0.2);
    curled(17, 0.35);
  }
  return raw;
}

const classify = (pose) =>
  classifyHand(handFeatures(mirrorLandmarks(hand(pose)), 1));

test('classifies the four poses', () => {
  assert.equal(classify('open'), 'open');
  assert.equal(classify('fist'), 'fist');
  assert.equal(classify('phone'), 'phone');
  assert.equal(classify('pinch'), 'pinch');
  assert.equal(classify('bunch'), 'bunch');
});

test('a pinch only moves the map after it settles, then drags with the hand', () => {
  const g = new GestureInterpreter();
  let out;
  for (let i = 0; i < 4; i++)
    out = g.update([{ key: 'Right', landmarks: hand('pinch') }], i * 33, 1);
  assert.equal(out.grabbing, true);
  assert.equal(out.pan.dx, 0);
  // Raw x goes left = the person's right in the mirror → positive dx.
  for (let i = 4; i < 12; i++)
    out = g.update(
      [
        {
          key: 'Right',
          landmarks: hand('pinch', { cx: 0.5 - (i - 3) * 0.02 }),
        },
      ],
      i * 33,
      1,
    );
  assert.ok(out.pan.dx > 0, `dx ${out.pan.dx}`);
  assert.equal(out.twoHands, false);
});

test('an open hand never moves the map', () => {
  const g = new GestureInterpreter();
  let out;
  for (let i = 0; i < 10; i++)
    out = g.update(
      [{ key: 'Right', landmarks: hand('open', { cx: 0.3 + i * 0.03 }) }],
      i * 33,
      1,
    );
  assert.equal(out.grabbing, false);
  assert.deepEqual(out.pan, { dx: 0, dy: 0 });
  assert.equal(out.zoom, 0);
});

test('bringing the pinching hand nearer zooms in', () => {
  const g = new GestureInterpreter();
  let out;
  for (let i = 0; i < 4; i++)
    out = g.update([{ key: 'Right', landmarks: hand('pinch') }], i * 33, 1);
  for (let i = 4; i < 14; i++)
    out = g.update(
      [
        {
          key: 'Right',
          landmarks: hand('pinch', { s: 0.15 * (1 + (i - 3) * 0.06) }),
        },
      ],
      i * 33,
      1,
    );
  assert.ok(out.zoom > 0, `zoom ${out.zoom}`);
});

test('two pinching hands spreading apart zoom in', () => {
  const g = new GestureInterpreter();
  let out;
  const pair = (gap) => [
    { key: 'Left', landmarks: hand('pinch', { cx: 0.5 - gap }) },
    { key: 'Right', landmarks: hand('pinch', { cx: 0.5 + gap }) },
  ];
  for (let i = 0; i < 4; i++) out = g.update(pair(0.15), i * 33, 1);
  for (let i = 4; i < 12; i++)
    out = g.update(pair(0.15 + (i - 3) * 0.02), i * 33, 1);
  assert.equal(out.twoHands, true);
  assert.ok(out.zoom > 0, `zoom ${out.zoom}`);
});

test('a fist stops after a few frames and blocks any grab', () => {
  const g = new GestureInterpreter();
  let out;
  for (let i = 0; i < 4; i++)
    out = g.update([{ key: 'Right', landmarks: hand('fist') }], i * 33, 1);
  assert.equal(out.stop, true);
  assert.equal(out.grabbing, false);
});

test('🤙 toggles once after 0.5 s and re-arms only after the hand changes', () => {
  const g = new GestureInterpreter();
  const phone = [{ key: 'Right', landmarks: hand('phone') }];
  let fired = 0;
  let t = 0;
  for (; t <= 2000; t += 33) if (g.update(phone, t, 1).micToggle) fired++;
  assert.equal(fired, 1, 'held phone fires exactly once');
  // Hand gone for a moment, then phone again → second toggle.
  for (let i = 0; i < 10; i++, t += 33) g.update([], t, 1);
  let second = 0;
  for (let i = 0; i < 30; i++, t += 33)
    if (g.update(phone, t, 1).micToggle) second++;
  assert.equal(second, 1);
});

test('🤙 respects the cooldown between toggles', () => {
  const g = new GestureInterpreter();
  const phone = [{ key: 'Right', landmarks: hand('phone') }];
  let t = 0;
  let fires = [];
  for (; t <= 600; t += 33) if (g.update(phone, t, 1).micToggle) fires.push(t);
  for (let i = 0; i < 6; i++, t += 33) g.update([], t, 1); // ~200 ms away
  for (let i = 0; i < 40; i++, t += 33)
    if (g.update(phone, t, 1).micToggle) fires.push(t);
  assert.equal(fires.length, 2);
  assert.ok(fires[1] - fires[0] >= 1000, `gap ${fires[1] - fires[0]}`);
});

test('wrapAngle and OneEuro basics', () => {
  assert.ok(Math.abs(wrapAngle(3 * Math.PI) - Math.PI) < 1e-9);
  assert.ok(Math.abs(wrapAngle((-3 * Math.PI) / 2) - Math.PI / 2) < 1e-9);
  const f = new OneEuro();
  assert.equal(f.filter(1, 0), 1);
  const v = f.filter(2, 33);
  assert.ok(v > 1 && v < 2);
});

const run = (g, frames, t0 = 0) => {
  let out;
  frames.forEach((hands, i) => (out = g.update(hands, t0 + i * 33, 1)));
  return out;
};

test('a slight gap between thumb and index lets go at once', () => {
  const g = new GestureInterpreter();
  const grab = Array.from({ length: 5 }, () => [
    { key: 'Right', landmarks: hand('pinch') },
  ]);
  assert.equal(run(g, grab).grabbing, true);
  const out = g.update(
    [{ key: 'Right', landmarks: hand('pinch-open') }],
    5 * 33,
    1,
  );
  assert.equal(out.grabbing, false);
});

test('the left hand alone tilts like the middle mouse button', () => {
  const g = new GestureInterpreter();
  const frames = Array.from({ length: 12 }, (_, i) => [
    {
      key: 'Left',
      landmarks: hand('pinch', { cy: 0.6 - Math.max(0, i - 3) * 0.02 }),
    },
  ]);
  const out = run(g, frames);
  assert.equal(out.tiltHand, true);
  assert.ok(out.tilt < 0, `hand up → toward the horizon (${out.tilt})`);
  assert.deepEqual(out.pan, { dx: 0, dy: 0 });
  assert.equal(out.zoom, 0);
});

test('when one hand of a two-hand grab lets go, nothing moves until both do', () => {
  const g = new GestureInterpreter();
  const both = (gap) => [
    { key: 'Left', landmarks: hand('pinch', { cx: 0.5 - gap }) },
    { key: 'Right', landmarks: hand('pinch', { cx: 0.5 + gap }) },
  ];
  let t = 0;
  for (let i = 0; i < 5; i++, t += 33) g.update(both(0.15), t, 1);
  // Left lets go; the right hand keeps pinching and moves.
  let out;
  for (let i = 0; i < 8; i++, t += 33)
    out = g.update(
      [
        { key: 'Left', landmarks: hand('open', { cx: 0.35 }) },
        { key: 'Right', landmarks: hand('pinch', { cx: 0.65 - i * 0.03 }) },
      ],
      t,
      1,
    );
  assert.equal(out.locked, true);
  assert.equal(out.grabbing, false);
  assert.deepEqual(out.pan, { dx: 0, dy: 0 });
  // Both open → unlocked; a new pinch grabs again.
  for (let i = 0; i < 3; i++, t += 33)
    g.update([{ key: 'Right', landmarks: hand('open') }], t, 1);
  for (let i = 0; i < 5; i++, t += 33)
    out = g.update([{ key: 'Right', landmarks: hand('pinch') }], t, 1);
  assert.equal(out.locked, false);
  assert.equal(out.grabbing, true);
});

test('fingertips together for 0.6 s fly home once', () => {
  const g = new GestureInterpreter();
  const bunch = [{ key: 'Right', landmarks: hand('bunch') }];
  let fired = 0;
  for (let t = 0; t <= 2000; t += 33) if (g.update(bunch, t, 1).home) fired++;
  assert.equal(fired, 1);
});

test('hands labelled the other way round are learned from their sides', () => {
  const g = new GestureInterpreter();
  // MediaPipe calls the hand on the person's left "Right": swapped labels.
  for (let i = 0; i < 10; i++)
    g.update(
      [
        { key: 'Right', landmarks: hand('open', { cx: 0.75 }) },
        { key: 'Left', landmarks: hand('open', { cx: 0.25 }) },
      ],
      i * 33,
      1,
    );
  assert.equal(g.leftLabel(), 'Right');
});

test('a thumb hidden behind the index is not a pinch', () => {
  const raw = hand('pinch');
  // Same spot in the picture, but the thumb tip is well behind the index tip.
  raw[4] = { ...raw[4], z: raw[8].z + 0.06 };
  const f = handFeatures(mirrorLandmarks(raw), 1);
  assert.notEqual(classifyHand(f), 'pinch');
  // Level with it (touching, seen): still a pinch.
  raw[4] = { ...raw[4], z: raw[8].z + 0.005 };
  assert.equal(classifyHand(handFeatures(mirrorLandmarks(raw), 1)), 'pinch');
});

const feed = (g, frames, start = 0, step = 33) => {
  const outs = [];
  frames.forEach((hands, i) => outs.push(g.update(hands, start + i * step, 1)));
  return outs;
};
const R = (pose, opts) => ({ key: 'Right', landmarks: hand(pose, opts) });
const L = (pose, opts) => ({
  key: 'Left',
  landmarks: hand(pose, { cx: 0.8, ...opts }),
});
const repeat = (n, make) => Array.from({ length: n }, (_, i) => make(i));

test('classifies pilot, pointer, thumb and victory', () => {
  assert.equal(classify('pilot'), 'pilot');
  assert.equal(classify('point'), 'point');
  assert.equal(classify('thumb-up'), 'thumb');
  assert.equal(classify('thumb-side'), 'thumb');
  assert.equal(classify('victory'), 'victory');
  const f = (pose, opts) => handFeatures(mirrorLandmarks(hand(pose, opts)), 1);
  assert.equal(f('thumb-up').thumbDir, 'up');
  assert.equal(f('thumb-side').thumbDir, 'right');
  assert.equal(f('thumb-side', { flip: true }).thumbDir, 'left');
  assert.ok(f('pilot-right').indexLean > 0.3);
  assert.ok(Math.abs(f('pilot').indexLean) < 0.05);
});

test('a held pilot hand starts one flight and steers it', () => {
  const g = new GestureInterpreter();
  const outs = feed(
    g,
    repeat(30, () => [R('pilot')]),
  );
  assert.equal(outs.filter((o) => o.cruiseStart).length, 1);
  assert.ok(outs[3].hold?.name === 'pilot');
  const right = feed(g, [[R('pilot-right')]], 2000).at(-1);
  assert.ok(right.pilot.steer > 0.3, 'leaning right turns right');
  // Hand nearer the camera (bigger) → throttle up.
  const near = feed(
    g,
    repeat(20, (i) => [R('pilot', { s: 0.15 + i * 0.004 })]),
    3000,
  ).at(-1);
  assert.ok(near.pilot.throttle > 0.1, `throttle ${near.pilot.throttle}`);
});

test('two pilot hands make a frame: screenshot, no flight', () => {
  const g = new GestureInterpreter();
  const outs = feed(
    g,
    repeat(30, () => [R('pilot', { cx: 0.3 }), L('pilot')]),
  );
  assert.equal(outs.filter((o) => o.shot).length, 1);
  assert.equal(outs.filter((o) => o.cruiseStart).length, 0);
});

test('pointer then a quick pinch clicks without moving the map', () => {
  const g = new GestureInterpreter();
  const outs = feed(g, [
    ...repeat(5, () => [R('point')]),
    ...repeat(3, () => [R('pinch')]),
    [R('open')],
  ]);
  assert.ok(outs[2].pointer, 'reticle while pointing');
  assert.ok(outs.at(-1).click, 'click on release');
  assert.ok(outs.every((o) => !o.grabbing && !o.grabStart));
});

test('pointer then a held pinch becomes a grab, not a click', () => {
  const g = new GestureInterpreter();
  const outs = feed(g, [
    ...repeat(5, () => [R('point')]),
    ...repeat(20, () => [R('pinch')]),
    [R('open')],
  ]);
  assert.ok(outs.some((o) => o.grabStart));
  assert.ok(outs.some((o) => o.grabbing));
  assert.ok(outs.every((o) => !o.click));
});

test('a fast open-hand swipe is a swipe; a slow drift is not', () => {
  const g = new GestureInterpreter();
  const fast = feed(
    g,
    repeat(9, (i) => [R('open', { cx: 0.7 - i * 0.035 })]),
  );
  const swipes = fast.filter((o) => o.swipe);
  assert.equal(swipes.length, 1);
  assert.deepEqual(swipes[0].swipe, { dir: 'right', pose: 'open' });
  const g2 = new GestureInterpreter();
  const slow = feed(
    g2,
    repeat(40, (i) => [R('open', { cx: 0.7 - i * 0.008 })]),
  );
  assert.ok(slow.every((o) => !o.swipe));
});

test('✌️ held still drops one pin; swiped it steps shots', () => {
  const g = new GestureInterpreter();
  const outs = feed(
    g,
    repeat(40, () => [R('victory')]),
  );
  assert.equal(outs.filter((o) => o.pin).length, 1);
  const g2 = new GestureInterpreter();
  const swipe = feed(
    g2,
    repeat(9, (i) => [R('victory', { cx: 0.3 + i * 0.035 })]),
  ).find((o) => o.swipe);
  assert.deepEqual(swipe.swipe, { dir: 'left', pose: 'victory' });
  assert.equal(swipe.pin, false);
});

test('both hands open and still: north up once', () => {
  const g = new GestureInterpreter();
  const outs = feed(
    g,
    repeat(45, () => [R('open', { cx: 0.3 }), L('open')]),
  );
  assert.equal(outs.filter((o) => o.northUp).length, 1);
});

test('thumb sideways orbits toward it; thumb up follows', () => {
  const g = new GestureInterpreter();
  const side = feed(
    g,
    repeat(25, () => [R('thumb-side')]),
  );
  assert.deepEqual(
    side.filter((o) => o.orbit).map((o) => o.orbit),
    ['right'],
  );
  assert.ok(
    side.every((o) => !o.stop),
    'a thumb out is not a fist',
  );
  const g2 = new GestureInterpreter();
  const up = feed(
    g2,
    repeat(30, () => [R('thumb-up')]),
  );
  assert.equal(up.filter((o) => o.follow).length, 1);
});

test('letting go of a moving drag hands over its velocity; a fist does not', () => {
  const drag = (end) => {
    const g = new GestureInterpreter();
    return feed(g, [
      ...repeat(4, () => [R('pinch')]),
      ...repeat(6, (i) => [R('pinch', { cx: 0.5 - (i + 1) * 0.03 })]),
      ...repeat(4, () => [R(end, { cx: 0.32 })]),
    ]);
  };
  const released = drag('open').find((o) => o.release);
  assert.ok(released && released.release.dx > 0, 'throw toward the right');
  assert.ok(drag('fist').every((o) => !o.release));
});

test('left-handed: the right hand tilts', () => {
  const g = new GestureInterpreter();
  g.leftHanded = true;
  const outs = feed(
    g,
    repeat(8, (i) => [R('pinch', { cy: 0.5 - i * 0.02 })]),
  );
  assert.ok(outs.at(-1).tiltHand);
});

test("calibration derives thresholds from the person's own hand", () => {
  const f = (pose) => handFeatures(mirrorLandmarks(hand(pose)), 1);
  const samples = {
    pinch: repeat(12, () => f('pinch')),
    open: repeat(12, () => f('open')),
    fist: repeat(12, () => f('fist')),
  };
  const result = calibrateFromSamples(samples);
  assert.equal(result.ok, true);
  const t = result.tuning;
  assert.ok(t.pinchOff > t.pinchOn);
  assert.ok(t.extended > t.curled);
  assert.ok(t.pinchOn > f('pinch').pinch, 'the measured pinch still closes');
  const g = new GestureInterpreter();
  g.setTuning(t);
  assert.equal(classifyHand(f('pinch'), false, g.tuning), 'pinch');
  assert.equal(classifyHand(f('fist'), false, g.tuning), 'fist');
  assert.equal(classifyHand(f('open'), false, g.tuning), 'open');
  assert.deepEqual(calibrateFromSamples({ ...samples, fist: [] }), {
    ok: false,
    missing: 'fist',
  });
});
