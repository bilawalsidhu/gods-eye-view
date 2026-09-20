import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  DEFAULT_FOCUS_DEEMPHASIS_PARAMS,
  advanceFocusEvidenceNowMs,
  advanceProjectedSpriteFocus,
  advanceSpriteFocus,
  clearFocusTarget,
  focusAlphaNeedsWrite,
  focusNowMs,
  focusPassIsNeeded,
  focusTargetEmphasis,
  forgetSpriteFocus,
  getFocusDeemphasisParams,
  getFocusTarget,
  nearFarScalarValueAtDistance,
  onFocusTargetAppear,
  publishFocusTargetFromCachedPosition,
  setFocusDeemphasisParams,
  setFocusEvidenceNowMs,
  smoothFocusEmphasis,
} from './focusDeemphasis.js';

const params = { ...DEFAULT_FOCUS_DEEMPHASIS_PARAMS, paddingPx: 0 };
const target = {
  screenRect: { left: 40, top: 40, right: 60, bottom: 60 },
  paddingPx: 0,
  cameraDistance: 1000,
};

test('focus decision dims a farther sprite inside and preserves one outside', () => {
  assert.equal(focusTargetEmphasis({ x: 50, y: 50 }, 1200, target, params), 0.25);
  assert.equal(focusTargetEmphasis({ x: 61, y: 50 }, 1200, target, params), 1);
});

test('focus decision keeps nearer behavior tunable across allow, dim, and partial', () => {
  assert.equal(focusTargetEmphasis({ x: 50, y: 50 }, 800, target, { ...params, nearerBehavior: 'allow' }), 1);
  assert.equal(focusTargetEmphasis({ x: 50, y: 50 }, 800, target, { ...params, nearerBehavior: 'dim' }), 0.25);
  assert.equal(focusTargetEmphasis({ x: 50, y: 50 }, 800, target, { ...params, nearerBehavior: 'partial' }), 0.625);
});

test('focus decision applies padding and hysteresis at the boundary', () => {
  assert.equal(focusTargetEmphasis({ x: 64, y: 50 }, 1200, target, { ...params, paddingPx: 3 }), 1);
  assert.equal(focusTargetEmphasis({ x: 63, y: 50 }, 1200, target, { ...params, paddingPx: 3 }), 0.25);
  assert.equal(focusTargetEmphasis({ x: 65, y: 50 }, 1200, target, { ...params, hysteresisPx: 6 }, false), 1);
  assert.equal(focusTargetEmphasis({ x: 65, y: 50 }, 1200, target, { ...params, hysteresisPx: 6 }, true), 0.25);
});

test('focus overlap includes the ambient sprite own rendered extent', () => {
  assert.equal(focusTargetEmphasis({ x: 68, y: 50 }, 1200, target, params, false, 8, 8), 0.25);
  assert.equal(focusTargetEmphasis({ x: 68, y: 50 }, 1200, target, params, false, 2, 2), 1);
});

test('focus decision never falls below the configured floor', () => {
  assert.equal(focusTargetEmphasis({ x: 50, y: 50 }, 1200, target, { ...params, dimFloor: 0.41 }), 0.41);
  assert.equal(focusTargetEmphasis({ x: 50, y: 50 }, 1200, target, { ...params, dimFloor: 0 }), 0.01);
});

test('smoothing converges over configured attack and release instead of snapping', () => {
  const attackMid = smoothFocusEmphasis(1, 0.25, 150, params);
  assert.ok(attackMid < 1 && attackMid > 0.25, `attack midpoint=${attackMid}`);
  assert.equal(smoothFocusEmphasis(1, 0.25, 300, params), 0.25);
  const releaseMid = smoothFocusEmphasis(0.25, 1, 300, params);
  assert.ok(releaseMid > 0.25 && releaseMid < 1, `release midpoint=${releaseMid}`);
  assert.equal(smoothFocusEmphasis(0.25, 1, 600, params), 1);
});

test('default attack yields at least four distinct 80 ms sampled values', () => {
  const samples = [0, 80, 160, 240, 320]
    .map((elapsedMs) => smoothFocusEmphasis(1, 0.25, elapsedMs, params));
  assert.ok(new Set(samples.slice(1)).size >= 4, `samples=${samples.join(',')}`);
  assert.equal(samples.at(-1), 0.25);
});

test('per-sprite state attacks, restores after focus clears, and settles at one', () => {
  const sprite = {};
  const input = { screenPosition: { x: 50, y: 50 }, cameraDistance: 1200, target, params };
  assert.equal(advanceSpriteFocus(sprite, { ...input, nowMs: 0 }).factor, 1);
  const attack = advanceSpriteFocus(sprite, { ...input, nowMs: 150 });
  assert.ok(attack.factor < 1 && attack.factor > 0.25);
  assert.equal(advanceSpriteFocus(sprite, { ...input, nowMs: 300 }).factor, 0.25);
  assert.equal(advanceSpriteFocus(sprite, { ...input, target: null, nowMs: 300 }).factor, 0.25);
  const release = advanceSpriteFocus(sprite, { ...input, target: null, nowMs: 600 });
  assert.ok(release.factor > 0.25 && release.factor < 1);
  assert.equal(advanceSpriteFocus(sprite, { ...input, target: null, nowMs: 900 }).factor, 1);
});

test('distance chatter reanchors from current progress and converges toward the majority state', () => {
  const sprite = {};
  const chatterParams = { ...params, nearerBehavior: 'allow', distanceHysteresisRatio: 0.08 };
  const distances = [1200, 990, 1010, 995, 1005, 990, 1200, 990, 1010];
  const factors = distances.map((cameraDistance, index) => advanceSpriteFocus(sprite, {
    screenPosition: { x: 50, y: 50 },
    cameraDistance,
    target,
    params: chatterParams,
    nowMs: index * 80,
  }).factor);
  for (let index = 1; index < factors.length; index += 1) {
    assert.ok(factors[index] <= factors[index - 1] + 1e-12, `factors=${factors.join(',')}`);
  }
  assert.ok(factors.at(-1) < 0.5, `factors=${factors.join(',')}`);

  const dimSprite = {};
  const dimFactors = [0, 80, 160, 240].map((nowMs, index) => advanceSpriteFocus(dimSprite, {
    screenPosition: { x: 50, y: 50 },
    cameraDistance: index % 2 ? 990 : 1010,
    target,
    params: { ...params, nearerBehavior: 'dim' },
    nowMs,
  }).factor);
  assert.ok(dimFactors.at(-1) < 1, `dimFactors=${dimFactors.join(',')}`);
});

test('alternating desired state reanchors from sampled progress and converges to a stable cycle', () => {
  const sprite = {};
  const chatterParams = { ...params, nearerBehavior: 'allow', distanceHysteresisRatio: 0.08 };
  const factors = Array.from({ length: 20 }, (_, index) => advanceSpriteFocus(sprite, {
    screenPosition: { x: 50, y: 50 },
    // Cross both sides of the range hysteresis band every tick so `desired`
    // truly alternates instead of latching in the prior state.
    cameraDistance: index % 2 === 0 ? 1200 : 800,
    target,
    params: chatterParams,
    nowMs: index * 80,
  }).factor);

  assert.ok(new Set(factors).size >= 16, `factors=${factors.join(',')}`);
  const earlyEvenDelta = Math.abs(factors[4] - factors[2]);
  const lateEvenDelta = Math.abs(factors[18] - factors[16]);
  const earlyOddDelta = Math.abs(factors[5] - factors[3]);
  const lateOddDelta = Math.abs(factors[19] - factors[17]);
  assert.ok(lateEvenDelta < earlyEvenDelta, `even factors=${factors.join(',')}`);
  assert.ok(lateOddDelta < earlyOddDelta, `odd factors=${factors.join(',')}`);
});

test('advanceSpriteFocus returns its documented module singleton', () => {
  const sprite = {};
  const input = { screenPosition: { x: 50, y: 50 }, cameraDistance: 1200, target, params };
  const first = advanceSpriteFocus(sprite, { ...input, nowMs: 0 });
  const second = advanceSpriteFocus(sprite, { ...input, nowMs: params.attackMs });
  assert.strictEqual(first, second);
  assert.equal(first.factor, params.dimFloor, 'the prior reference reflects the next call');
});

test('evidence clock produces identical alpha sequences across repeated captures', () => {
  const sequenceOffsets = [0, 80, 160, 240, 320, 400, 560, 720, 880, 1040];
  const capture = (productionClockBase, productionClockStep) => {
    setFocusEvidenceNowMs(10_000);
    const sprite = {};
    const sequence = sequenceOffsets.map((offset, index) => {
      if (index > 0) advanceFocusEvidenceNowMs(offset - sequenceOffsets[index - 1]);
      const nowMs = focusNowMs(productionClockBase + index * productionClockStep);
      return advanceSpriteFocus(sprite, {
        screenPosition: { x: 50, y: 50 },
        cameraDistance: 1200,
        target: offset <= 320 ? target : null,
        params,
        nowMs,
      }).factor;
    });
    setFocusEvidenceNowMs(null);
    return sequence;
  };
  assert.deepEqual(capture(1_000, 1), capture(1_000_000, 9_999));
});

test('NearFarScalar rendered-size interpolation matches Cesium clamp endpoints', () => {
  const scalar = { near: 1000, nearValue: 3, far: 8_000_000, farValue: 0.5 };
  assert.equal(nearFarScalarValueAtDistance(scalar, 500), 3);
  assert.equal(nearFarScalarValueAtDistance(scalar, 9_000_000), 0.5);
  const middle = nearFarScalarValueAtDistance(scalar, 1_000_000);
  assert.ok(middle > 0.5 && middle < 3);
});

// ─── Runtime tuning ───────────────────────────────────────────────────────────
//
// The evidence harness and the A/B seams drive these values at runtime, so the
// setter is part of the rendering contract: out-of-range values must clamp,
// unrecognized keys must be dropped (an override can never invent a new
// rendering behavior), and a change must be visible in the very next decision.

test('runtime tuning clamps, drops unknown keys, and takes effect on the next decision', () => {
  const defaults = { ...DEFAULT_FOCUS_DEEMPHASIS_PARAMS };
  try {
    setFocusDeemphasisParams({
      dimFloor: 0.9,
      paddingPx: -5,
      nearerBehavior: 'sideways',
      hysteresisPx: -1,
      distanceHysteresisRatio: 2,
      attackMs: -10,
      releaseMs: -1,
      writeEpsilon: -0.5,
      notARenderingContract: Symbol('ignored'),
    });

    const live = getFocusDeemphasisParams();
    assert.equal(live.dimFloor, 0.9);
    assert.equal(live.paddingPx, 0, 'a negative pad is clamped to zero');
    assert.equal(live.nearerBehavior, 'allow', 'an unknown behavior is dropped, not applied');
    assert.equal(live.hysteresisPx, 0);
    assert.equal(live.distanceHysteresisRatio, 0.5, 'the ratio tops out at its documented max');
    assert.equal(live.attackMs, 0);
    assert.equal(live.releaseMs, 0);
    assert.equal(live.writeEpsilon, 0);
    assert.equal('notARenderingContract' in live, false, 'no key is ever added');

    // The tuning is live, not cosmetic: this sprite sits inside the rect and
    // beyond the (now much wider) depth hysteresis band, so it dims to the
    // raised floor.
    assert.equal(focusTargetEmphasis({ x: 50, y: 50 }, 2_000, target), 0.9);
  } finally {
    setFocusDeemphasisParams(defaults);
  }
  assert.deepEqual(getFocusDeemphasisParams(), defaults, 'the caller restores what it found');
});

// ─── Shared focus target lifecycle ────────────────────────────────────────────
//
// publish/clear is a cross-layer contract: whichever layer publishes owns the
// slot, appear listeners re-arm consumers that self-suspended, and a target
// that can no longer be projected must not survive as a stale rectangle.

/**
 * Replace Cesium's world→window projection with a deterministic stub.
 * @param {object} t node:test context owning the restore.
 * @param {{x:number,y:number}|null} screen Screen point every position projects
 *   to, or null to model a position with no window coordinate.
 * @returns {{count:number}} Number of projection calls attempted.
 */
function installProjectionStub(t, screen) {
  const original = Cesium.SceneTransforms.worldToWindowCoordinates;
  const calls = { count: 0 };
  Cesium.SceneTransforms.worldToWindowCoordinates = (_scene, _position, result) => {
    calls.count += 1;
    if (!screen) return null;
    result.x = screen.x;
    result.y = screen.y;
    return result;
  };
  t.after(() => { Cesium.SceneTransforms.worldToWindowCoordinates = original; });
  return calls;
}

const FAKE_SCENE = { frameState: { frameNumber: 42 } };
const DISPLAY_POSITION = Cesium.Cartesian3.fromDegrees(-97.695, 30.205, 2000);
const FAKE_CAMERA = { positionWC: Cesium.Cartesian3.fromDegrees(-97.695, 30.205, 20_000) };
/** A sprite well beyond the target's depth hysteresis band, so it competes. */
const FARTHER_SPRITE_POSITION = Cesium.Cartesian3.fromDegrees(-97.695, 30.205, 60_000);

function publishFlightsTarget() {
  return publishFocusTargetFromCachedPosition({
    ownerLayer: 'flights',
    id: 'abc123',
    scene: FAKE_SCENE,
    camera: FAKE_CAMERA,
    displayPosition: DISPLAY_POSITION,
    widthPx: 24,
    heightPx: 24,
  });
}

test('publishing a target notifies appear listeners once and clears only for its owner', (t) => {
  installProjectionStub(t, { x: 50, y: 50 });
  const appearances = [];
  const unsubscribeAppear = onFocusTargetAppear(() => appearances.push(getFocusTarget()));
  const unsubscribeExploding = onFocusTargetAppear(() => {
    throw new Error('listener exploded');
  });
  t.after(() => {
    unsubscribeAppear();
    unsubscribeExploding();
    clearFocusTarget('flights', 'abc123');
  });

  const published = publishFlightsTarget();
  assert.ok(published, 'the target is published');
  assert.equal(published.ownerLayer, 'flights');
  assert.equal(published.frameNumber, 42);
  assert.ok(published.screenRect.left < 50 && published.screenRect.right > 50);
  assert.equal(appearances.length, 1, 'a throwing listener must not starve the others');
  assert.equal(appearances[0], published, 'listeners see the target that just appeared');

  // Republishing the same slot is not a second appear, and it replaces the
  // published rect rather than layering a second one.
  const republished = publishFlightsTarget();
  assert.equal(appearances.length, 1);
  assert.notEqual(republished, published, 'each publication is a fresh rect');

  // Another layer's idle tick must not erase a target it does not own, and
  // neither must the same layer asking about a different contact.
  clearFocusTarget('satellites');
  assert.equal(getFocusTarget(), republished);
  clearFocusTarget('flights', 'other-id');
  assert.equal(getFocusTarget(), republished);
  clearFocusTarget('flights', 'abc123');
  assert.equal(getFocusTarget(), null);
});

test('a subject that loses its cached position releases the focus slot it held', (t) => {
  installProjectionStub(t, { x: 50, y: 50 });
  t.after(() => { clearFocusTarget(); });
  assert.ok(publishFlightsTarget(), 'precondition: the slot is held');

  // The tracked contact's next tick has no cached world position (it left the
  // occluded side of the globe, or its feed row vanished). The caller must not
  // be able to leave the old rectangle armed, and nothing partial publishes.
  assert.equal(publishFocusTargetFromCachedPosition({
    ownerLayer: 'flights',
    id: 'abc123',
    scene: FAKE_SCENE,
    camera: FAKE_CAMERA,
    displayPosition: null,
  }), null);
  assert.equal(getFocusTarget(), null);

  // A caller with no owner identity at all releases whatever slot is held —
  // it cannot be trusted to match one.
  assert.ok(publishFlightsTarget());
  assert.equal(publishFocusTargetFromCachedPosition({
    ownerLayer: '',
    id: 'abc123',
    scene: FAKE_SCENE,
    camera: FAKE_CAMERA,
    displayPosition: DISPLAY_POSITION,
  }), null);
  assert.equal(getFocusTarget(), null);
});

test('a target that can no longer be projected is cleared instead of left stale', (t) => {
  const calls = installProjectionStub(t, null);

  assert.equal(publishFlightsTarget(), null, 'an unprojectable subject publishes nothing');
  assert.equal(getFocusTarget(), null, 'and any earlier target for it is dropped');
  assert.ok(calls.count > 0, 'the projection was actually attempted');

  // Non-finite coordinates are the same failure in a different costume.
  installProjectionStub(t, { x: Number.NaN, y: 50 });
  assert.equal(publishFlightsTarget(), null);
  assert.equal(getFocusTarget(), null);
});

test('the projected advance skips projection when nothing is tracked and nothing is dimmed', (t) => {
  const calls = installProjectionStub(t, { x: 50, y: 50 });
  const sprite = {};

  const identity = advanceProjectedSpriteFocus(sprite, DISPLAY_POSITION, FAKE_SCENE, FAKE_CAMERA, 0, null);
  assert.equal(identity.factor, 1);
  assert.equal(identity.changed, false);
  assert.equal(identity.active, false);
  assert.equal(calls.count, 0, 'a fleet-wide tick with nothing tracked projects nothing');

  // The same sprite WITH a target projects and dims.
  const published = publishFlightsTarget();
  t.after(() => { clearFocusTarget('flights', 'abc123'); });
  const projectedBeforePublish = calls.count;
  const attackStart = advanceProjectedSpriteFocus(
    sprite,
    FARTHER_SPRITE_POSITION,
    FAKE_SCENE,
    FAKE_CAMERA,
    0,
    published,
  );
  assert.equal(attackStart.factor, 1, 'the attack starts from full emphasis');
  assert.equal(
    calls.count - projectedBeforePublish,
    1,
    'exactly one projection for the sprite that needs one',
  );

  const settled = advanceProjectedSpriteFocus(
    sprite,
    FARTHER_SPRITE_POSITION,
    FAKE_SCENE,
    FAKE_CAMERA,
    300,
    published,
  );
  assert.equal(settled.factor, 0.25, 'a farther sprite reaches the floor at the attack duration');
  assert.equal(settled.changed, true);
  assert.equal(settled.active, true);
  assert.equal(settled.transitioning, false);
  forgetSpriteFocus(sprite);
});

test('forgetting a sprite drops its dimming state so the next attack starts from identity', (t) => {
  installProjectionStub(t, { x: 50, y: 50 });
  const published = publishFlightsTarget();
  t.after(() => { clearFocusTarget('flights', 'abc123'); });
  const sprite = {};

  assert.equal(advanceProjectedSpriteFocus(sprite, FARTHER_SPRITE_POSITION, FAKE_SCENE, FAKE_CAMERA, 0, published).factor, 1);
  assert.equal(
    advanceProjectedSpriteFocus(sprite, FARTHER_SPRITE_POSITION, FAKE_SCENE, FAKE_CAMERA, 300, published).factor,
    0.25,
    'precondition: the sprite is fully dimmed',
  );

  forgetSpriteFocus(sprite);
  forgetSpriteFocus(undefined, 'a null sprite is a no-op');

  assert.equal(
    advanceProjectedSpriteFocus(sprite, FARTHER_SPRITE_POSITION, FAKE_SCENE, FAKE_CAMERA, 300, published).factor,
    1,
    'with no remembered state the sprite is back at full emphasis',
  );
  forgetSpriteFocus(sprite);
});

test('an untouched sprite with no target is pure identity and costs no state', () => {
  const sprite = {};
  const result = advanceSpriteFocus(sprite, {
    screenPosition: null,
    cameraDistance: Number.NaN,
    nowMs: 0,
    target: null,
  });

  assert.equal(result.factor, 1);
  assert.equal(result.changed, false);
  assert.equal(result.transitioning, false);
  assert.equal(result.active, false);
  assert.equal(result.desired, 1);
  forgetSpriteFocus(sprite);
});

// ─── Consumer-side helpers ────────────────────────────────────────────────────
//
// Gated consumers (CCTV's projection loop) and final alpha write sites share
// these two predicates, so their edge cases are the difference between an idle
// governor that sleeps and one that never does.

test('a gated consumer keeps ticking until no target and no active sprite remain', () => {
  assert.equal(focusPassIsNeeded(null, 0), false, 'nothing tracked, nothing dimmed: rest');
  assert.equal(focusPassIsNeeded(target, 0), true, 'a published target always owes a pass');
  assert.equal(focusPassIsNeeded(null, 3), true, 'sprites still returning to identity owe a pass');
  assert.equal(focusPassIsNeeded(null, Number.NaN), false, 'a non-count is not a pass owed');
});

test('the shared deadband decides which alpha writes are actually owed', () => {
  assert.equal(focusAlphaNeedsWrite(Number.NaN, 1), true, 'an unreadable current alpha always writes');
  assert.equal(focusAlphaNeedsWrite(1, 1), false, 'no change, no write');
  assert.equal(focusAlphaNeedsWrite(0.998, 1), false, 'sub-epsilon drift is not worth a write');
  assert.equal(focusAlphaNeedsWrite(0.9, 1), true, 'a real change is');
  assert.equal(
    focusAlphaNeedsWrite(1, 0.5, { writeEpsilon: 0.6 }),
    false,
    'the caller tuning, not the module default, sets the deadband',
  );
});
