import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESOLUTION_POLICY,
  createResolutionPolicy,
  getResolutionDiagnostics,
  installResolutionGovernor,
  msaaSamplesForRatio,
  pixelRatioCeiling,
  pixelRatioFloor,
  readMaxPixelRatio,
  textureLimitedRatio,
} from './resolutionGovernor.js';

const SLOW = 33.3;
const ON_TIME = 16.7;

/** Feed `ms` worth of frames at `interval`; return the clock and the changes. */
function run(policy, interval, ms, start = 0) {
  let now = start;
  const changes = [];
  while (now - start < ms) {
    now += interval;
    if (policy.frame(interval)) changes.push(policy.ratio);
  }
  return { now, changes };
}

test('readMaxPixelRatio reads, clamps and defaults the URL parameter', () => {
  assert.equal(readMaxPixelRatio(''), RESOLUTION_POLICY.maxPixelRatio);
  assert.equal(readMaxPixelRatio('?maxPixelRatio=1.5'), 1.5);
  assert.equal(readMaxPixelRatio('?maxPixelRatio=1'), 1);
  assert.equal(readMaxPixelRatio('?maxPixelRatio=0.25'), 1);
  assert.equal(readMaxPixelRatio('?maxPixelRatio=9'), 3);
  assert.equal(readMaxPixelRatio('?maxPixelRatio=abc'), 2);
  assert.equal(readMaxPixelRatio('?maxPixelRatio='), 2);
});

test('the ceiling follows the screen, the cap, and never drops below 1', () => {
  assert.equal(pixelRatioCeiling(2, 2), 2);
  assert.equal(pixelRatioCeiling(3, 2), 2);
  assert.equal(pixelRatioCeiling(1.5, 2), 1.5);
  assert.equal(pixelRatioCeiling(1, 2), 1);
  assert.equal(
    pixelRatioCeiling(0.5, 2),
    1,
    'browser zoom-out keeps the old 1x',
  );
  assert.equal(pixelRatioCeiling(undefined, 2), 1);
  assert.equal(pixelRatioCeiling(2, 1), 1);
});

test('the pixel budget caps large canvases on the 0.25 grid', () => {
  // Laptop screens keep their full 2x.
  assert.equal(pixelRatioCeiling(2, 2, { cssWidth: 1512, cssHeight: 982 }), 2);
  assert.equal(pixelRatioCeiling(2, 2, { cssWidth: 1728, cssHeight: 1117 }), 2);
  // A 4K frame exactly fits; a full-screen 5K display draws at 1.5.
  assert.equal(pixelRatioCeiling(2, 2, { cssWidth: 1920, cssHeight: 1080 }), 2);
  assert.equal(
    pixelRatioCeiling(2, 2, { cssWidth: 2560, cssHeight: 1440 }),
    1.5,
  );
  // Never below the old 1x, even past the budget.
  assert.equal(pixelRatioCeiling(2, 2, { cssWidth: 5120, cssHeight: 2880 }), 1);
  assert.equal(pixelRatioCeiling(2, 2, {}), 2, 'no size yet');
});

test('the GPU texture limit caps both sides, below 1x if it must (#905)', () => {
  // 2560 x 1440 on a 2048 GPU: 1x already throws in Cesium, so 0.8.
  assert.equal(textureLimitedRatio(2560, 1440, 2048), 0.8);
  assert.equal(pixelRatioFloor(2560, 1440, 2048), 0.8);
  const fhd = { cssWidth: 2560, cssHeight: 1440, maxTextureSize: 2048 };
  assert.equal(pixelRatioCeiling(2, 2, fhd), 0.8);
  assert.ok(2560 * pixelRatioCeiling(2, 2, fhd) <= 2048);
  // The longer side decides, portrait included.
  assert.equal(
    pixelRatioCeiling(2, 2, {
      cssWidth: 900,
      cssHeight: 1400,
      maxTextureSize: 2048,
    }),
    2048 / 1400,
  );
  // A 1200 px window at 2x needs 2400: a 2048 GPU gets 1.71, a 16k GPU 2.
  const laptop = { cssWidth: 1200, cssHeight: 800 };
  assert.equal(
    pixelRatioCeiling(2, 2, { ...laptop, maxTextureSize: 2048 }),
    2048 / 1200,
  );
  assert.equal(
    pixelRatioCeiling(2, 2, { ...laptop, maxTextureSize: 16384 }),
    2,
  );
  // Unknown limit or size: no texture cap, the floor stays the old 1x.
  assert.equal(pixelRatioFloor(2560, 1440, 0), 1);
  assert.equal(pixelRatioFloor(0, 0, 2048), 1);
});

test('the policy never steps above the texture limit or below its floor', () => {
  const policy = createResolutionPolicy({
    devicePixelRatio: 2,
    cssWidth: 2560,
    cssHeight: 1440,
    maxTextureSize: 2048,
  });
  assert.equal(policy.ratio, 0.8);
  assert.equal(policy.floor, 0.8);
  assert.deepEqual(
    run(policy, SLOW, 20_000).changes,
    [],
    'nothing to give back',
  );
  // Shrinking the window lifts both: the floor back to 1x, the ceiling with it.
  policy.setViewport({ cssWidth: 1600, cssHeight: 900 });
  assert.equal(policy.floor, 1);
  assert.equal(
    policy.ratio,
    2048 / 1600,
    'follows the ceiling, which the texture limit sets exactly',
  );
  // Growing it again clamps a ratio that would no longer fit.
  policy.setViewport({ cssWidth: 2560, cssHeight: 1440 });
  assert.equal(policy.ratio, 0.8);
});

test('MSAA drops to 2 samples once the ratio supplies the coverage', () => {
  assert.equal(msaaSamplesForRatio(1), 4);
  assert.equal(msaaSamplesForRatio(1.25), 4);
  assert.equal(msaaSamplesForRatio(1.5), 2);
  assert.equal(msaaSamplesForRatio(2), 2);
  // ratio² × samples never falls below the old 1² × 4 coverage samples.
  for (const ratio of [1, 1.25, 1.5, 1.75, 2])
    assert.ok(
      ratio * ratio * msaaSamplesForRatio(ratio) >= 4,
      `ratio ${ratio}`,
    );
});

test('a DPR 1 screen stays at ratio 1 whatever the frame time', () => {
  const policy = createResolutionPolicy({ devicePixelRatio: 1 });
  assert.equal(policy.ratio, 1);
  assert.deepEqual(run(policy, SLOW, 20_000).changes, []);
  assert.deepEqual(run(policy, ON_TIME, 120_000).changes, []);
});

test('starts at the ceiling and steps down 0.25 after ~2 s over budget', () => {
  const policy = createResolutionPolicy({ devicePixelRatio: 2 });
  assert.equal(policy.ratio, 2);
  assert.deepEqual(run(policy, SLOW, 1_900).changes, [], 'not before 2 s');
  const policy2 = createResolutionPolicy({ devicePixelRatio: 2 });
  const { changes } = run(policy2, SLOW, 2_200);
  assert.deepEqual(changes, [1.75]);
});

test('keeps stepping down while slow and never goes below 1', () => {
  const policy = createResolutionPolicy({ devicePixelRatio: 2 });
  const { changes } = run(policy, SLOW, 30_000);
  assert.deepEqual(changes, [1.75, 1.5, 1.25, 1]);
  assert.equal(policy.ratio, 1);
});

test('one slow frame in a smooth run does not step down', () => {
  const policy = createResolutionPolicy({ devicePixelRatio: 2 });
  for (let i = 0; i < 600; i++) {
    const interval = i % 60 === 0 ? 120 : ON_TIME;
    assert.equal(policy.frame(interval), false);
  }
  assert.equal(policy.ratio, 2);
});

test('pauses longer than gapMs are not slow frames', () => {
  const policy = createResolutionPolicy({ devicePixelRatio: 2 });
  for (let i = 0; i < 100; i++) assert.equal(policy.frame(1_000), false);
  assert.equal(policy.ratio, 2);
  assert.equal(policy.diagnostics().smoothedMs, null);
});

test('steps back up after 8 s on time, up to the ceiling', () => {
  const policy = createResolutionPolicy({ devicePixelRatio: 2 });
  let { now } = run(policy, SLOW, 2_200);
  assert.equal(policy.ratio, 1.75);
  ({ now } = run(policy, ON_TIME, 7_800, now));
  assert.equal(policy.ratio, 1.75, 'not before 8 s');
  const { changes } = run(policy, ON_TIME, 60_000, now);
  assert.deepEqual(changes, [2]);
});

test('a failed step up doubles the wait, capped at 64 s; success resets it', () => {
  const policy = createResolutionPolicy({ devicePixelRatio: 2 });
  let now = run(policy, SLOW, 2_200).now;
  assert.equal(policy.ratio, 1.75);
  const waits = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    // On time until the probe steps up, then slow until it steps back down.
    const before = now;
    while (policy.ratio === 1.75) {
      now += ON_TIME;
      policy.frame(ON_TIME);
    }
    waits.push(Math.round((now - before) / 1000));
    while (policy.ratio === 2) {
      now += SLOW;
      policy.frame(SLOW);
    }
  }
  assert.deepEqual(waits, [8, 16, 32, 64, 64, 64]);
  assert.equal(policy.diagnostics().recoverMs, 64_000);
  // The probe holds this time: a full on-time wait resets the backoff.
  while (policy.ratio === 1.75) {
    now += ON_TIME;
    policy.frame(ON_TIME);
  }
  run(policy, ON_TIME, 70_000, now);
  assert.equal(policy.ratio, 2);
  assert.equal(policy.diagnostics().recoverMs, 8_000);
});

test('on-time frames from short pans add up to a step up', () => {
  const policy = createResolutionPolicy({ devicePixelRatio: 2 });
  run(policy, SLOW, 2_200);
  assert.equal(policy.ratio, 1.75);
  const changes = [];
  // Ten 1-second pans with idle pauses between them.
  for (let pan = 0; pan < 10; pan++) {
    policy.pause();
    changes.push(...run(policy, ON_TIME, 1_000).changes);
  }
  assert.deepEqual(changes, [2]);
});

test('slow frames from short pans add up to a step down', () => {
  const policy = createResolutionPolicy({ devicePixelRatio: 2 });
  const changes = [];
  for (let pan = 0; pan < 4; pan++) {
    policy.pause();
    changes.push(...run(policy, SLOW, 700).changes);
  }
  assert.deepEqual(changes, [1.75]);
});

test('a frame time hovering at the budget still steps down', () => {
  const policy = createResolutionPolicy({ devicePixelRatio: 2 });
  let i = 0;
  const changes = [];
  // Alternating 19 / 23 ms: the smoothed value crosses 20 ms all the time
  // but never gets back under the 18 ms on-time threshold.
  while (i++ < 600)
    if (policy.frame(i % 2 ? 19 : 23)) changes.push(policy.ratio);
  assert.deepEqual(changes.slice(0, 1), [1.75]);
});

test('between the thresholds the ratio holds', () => {
  const policy = createResolutionPolicy({ devicePixelRatio: 2 });
  run(policy, SLOW, 2_200);
  assert.equal(policy.ratio, 1.75);
  assert.deepEqual(run(policy, 19, 60_000).changes, [], 'no step either way');
});

test('a devicePixelRatio change restarts at the new ceiling', () => {
  const policy = createResolutionPolicy({ devicePixelRatio: 2 });
  run(policy, SLOW, 5_000);
  assert.equal(policy.ratio, 1.5);
  assert.equal(policy.setViewport({ devicePixelRatio: 1 }), true);
  assert.equal(policy.ratio, 1);
  assert.equal(policy.setViewport({ devicePixelRatio: 1 }), false);
  assert.equal(policy.setViewport({ devicePixelRatio: 3 }), true);
  assert.equal(policy.ratio, 2, 'capped');
  assert.equal(policy.ceiling, 2);
});

test('a resize keeps a stepped-down ratio and follows an unthrottled one', () => {
  const policy = createResolutionPolicy({
    devicePixelRatio: 2,
    cssWidth: 1440,
    cssHeight: 900,
  });
  assert.equal(policy.ratio, 2);
  policy.setViewport({ cssWidth: 2560, cssHeight: 1440 });
  assert.equal(policy.ratio, 1.5, 'follows the budget down');
  policy.setViewport({ cssWidth: 1440, cssHeight: 900 });
  assert.equal(policy.ratio, 2, 'and back up while not throttled');
  run(policy, SLOW, 5_000);
  assert.equal(policy.ratio, 1.5);
  policy.setViewport({ cssWidth: 1400, cssHeight: 900 });
  assert.equal(policy.ratio, 1.5, 'a throttled ratio stays put');
  policy.setViewport({ cssWidth: 3000, cssHeight: 1600 });
  assert.equal(policy.ratio, 1.25, 'but never above the new ceiling');
});

function makeEvent() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    raise() {
      for (const fn of [...listeners]) fn();
    },
  };
}

function makeViewer() {
  const scene = {
    requestRenderMode: false,
    msaaSamples: 4,
    postRender: makeEvent(),
    camera: { moveStart: makeEvent(), moveEnd: makeEvent() },
  };
  return {
    scene,
    resolutionScale: 1,
    canvas: {
      clientWidth: 1200,
      clientHeight: 800,
      style: { imageRendering: 'pixelated' },
    },
  };
}

/** Frames that land inside the start-up warm-up; they never count. */
function warmUp(viewer, clock) {
  frames(viewer, clock, SLOW, RESOLUTION_POLICY.warmupMs);
}

function frames(viewer, clock, interval, ms) {
  const end = clock.t + ms;
  while (clock.t < end) {
    clock.t += interval;
    viewer.scene.postRender.raise();
  }
}

test('install applies the ceiling, MSAA and diagnostics at DPR 2', () => {
  const viewer = makeViewer();
  const windowRef = { devicePixelRatio: 2 };
  const clock = { t: 0 };
  const dispose = installResolutionGovernor(viewer, {
    windowRef,
    now: () => clock.t,
  });
  assert.equal(viewer.resolutionScale, 1, 'ratio 2 on a DPR 2 screen');
  assert.equal(viewer.scene.msaaSamples, 2);
  assert.equal(getResolutionDiagnostics(viewer).ratio, 2);
  dispose();
  assert.equal(getResolutionDiagnostics(viewer), null);
  assert.equal(viewer.scene.postRender.listeners.size, 0);
  assert.equal(viewer.scene.camera.moveStart.listeners.size, 0);
});

test('install at DPR 1 leaves the old 1x drawing and 4x MSAA', () => {
  const viewer = makeViewer();
  const clock = { t: 0 };
  installResolutionGovernor(viewer, {
    windowRef: { devicePixelRatio: 1 },
    now: () => clock.t,
  });
  assert.equal(viewer.resolutionScale, 1);
  assert.equal(viewer.scene.msaaSamples, 4);
  frames(viewer, clock, SLOW, 20_000);
  assert.equal(viewer.resolutionScale, 1);
});

test('a cap below the screen ratio scales the drawing buffer down', () => {
  const viewer = makeViewer();
  installResolutionGovernor(viewer, {
    windowRef: { devicePixelRatio: 2 },
    maxPixelRatio: 1,
    now: () => 0,
  });
  assert.equal(viewer.resolutionScale, 0.5);
  assert.equal(viewer.scene.msaaSamples, 4);
});

test('slow continuous frames step the viewer down', () => {
  const viewer = makeViewer();
  const clock = { t: 0 };
  installResolutionGovernor(viewer, {
    windowRef: { devicePixelRatio: 2 },
    now: () => clock.t,
  });
  warmUp(viewer, clock);
  assert.equal(viewer.resolutionScale, 1, 'start-up frames do not count');
  frames(viewer, clock, SLOW, 2_300);
  assert.equal(viewer.resolutionScale, 0.875);
  frames(viewer, clock, SLOW, 30_000);
  assert.equal(viewer.resolutionScale, 0.5);
  assert.equal(viewer.scene.msaaSamples, 4);
});

test('idle request-mode frames never change the ratio; camera motion does', () => {
  const viewer = makeViewer();
  viewer.scene.requestRenderMode = true;
  const clock = { t: 0 };
  installResolutionGovernor(viewer, {
    windowRef: { devicePixelRatio: 2 },
    now: () => clock.t,
  });
  warmUp(viewer, clock);
  frames(viewer, clock, SLOW, 30_000);
  assert.equal(viewer.resolutionScale, 1, 'request-mode spacing is not cost');
  viewer.scene.camera.moveStart.raise();
  frames(viewer, clock, SLOW, 2_300);
  assert.equal(
    viewer.resolutionScale,
    0.875,
    'a moving camera renders back-to-back',
  );
  viewer.scene.camera.moveEnd.raise();
  frames(viewer, clock, SLOW, 30_000);
  assert.equal(viewer.resolutionScale, 0.875);
});

test('a devicePixelRatio change is followed on the next frame', () => {
  const viewer = makeViewer();
  const windowRef = { devicePixelRatio: 2 };
  const clock = { t: 0 };
  installResolutionGovernor(viewer, { windowRef, now: () => clock.t });
  windowRef.devicePixelRatio = 1;
  frames(viewer, clock, ON_TIME, ON_TIME);
  assert.equal(viewer.resolutionScale, 1);
  assert.equal(viewer.scene.msaaSamples, 4);
  windowRef.devicePixelRatio = 3;
  frames(viewer, clock, ON_TIME, ON_TIME);
  assert.equal(viewer.resolutionScale, 2 / 3);
  assert.equal(viewer.scene.msaaSamples, 2);
});

test('nearest-neighbour upscaling only at whole-number factors', () => {
  const viewer = makeViewer();
  const clock = { t: 0 };
  installResolutionGovernor(viewer, {
    windowRef: { devicePixelRatio: 2 },
    now: () => clock.t,
  });
  const { style } = viewer.canvas;
  assert.equal(style.imageRendering, 'pixelated', '2x on a 2x screen');
  warmUp(viewer, clock);
  frames(viewer, clock, SLOW, 4_500);
  assert.equal(viewer.resolutionScale, 0.75);
  assert.equal(style.imageRendering, 'auto', '1.5x on a 2x screen');
  frames(viewer, clock, SLOW, 30_000);
  assert.equal(viewer.resolutionScale, 0.5);
  assert.equal(style.imageRendering, 'pixelated', 'the old 1x drawing');
  const phone = makeViewer();
  installResolutionGovernor(phone, { windowRef: { devicePixelRatio: 3 } });
  assert.equal(phone.canvas.style.imageRendering, 'auto', 'capped 2x on 3x');
});

test('a canvas resize past the pixel budget lowers the ratio', () => {
  const viewer = makeViewer();
  const clock = { t: 0 };
  installResolutionGovernor(viewer, {
    windowRef: { devicePixelRatio: 2 },
    now: () => clock.t,
  });
  assert.equal(viewer.resolutionScale, 1);
  viewer.canvas.clientWidth = 2560;
  viewer.canvas.clientHeight = 1440;
  frames(viewer, clock, ON_TIME, ON_TIME);
  assert.equal(viewer.resolutionScale, 0.75);
  assert.equal(viewer.canvas.style.imageRendering, 'auto');
  assert.equal(getResolutionDiagnostics(viewer).ceiling, 1.5);
});

test('install keeps the drawing buffer inside the texture limit', () => {
  const viewer = makeViewer();
  viewer.canvas.clientWidth = 2560;
  viewer.canvas.clientHeight = 1440;
  const clock = { t: 0 };
  installResolutionGovernor(viewer, {
    windowRef: { devicePixelRatio: 1 },
    maxTextureSize: 2048,
    now: () => clock.t,
  });
  assert.equal(viewer.resolutionScale, 0.8);
  assert.ok(2560 * viewer.resolutionScale <= 2048);
  assert.equal(getResolutionDiagnostics(viewer).floor, 0.8);
  // A narrower window gets the old 1x back.
  viewer.canvas.clientWidth = 1920;
  viewer.canvas.clientHeight = 1080;
  frames(viewer, clock, ON_TIME, ON_TIME);
  assert.equal(viewer.resolutionScale, 1);
});

test('install rejects a non-viewer and replaces an earlier governor', () => {
  assert.throws(() => installResolutionGovernor({}), /Cesium viewer/);
  const viewer = makeViewer();
  installResolutionGovernor(viewer, { windowRef: { devicePixelRatio: 2 } });
  installResolutionGovernor(viewer, { windowRef: { devicePixelRatio: 2 } });
  assert.equal(viewer.scene.postRender.listeners.size, 1);
});
