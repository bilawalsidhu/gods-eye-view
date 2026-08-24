/**
 * Tests for the render policy, and for the one Cesium default this file corrects.
 *
 * Nothing here builds a `Viewer`: that needs a WebGL context, and what it does is covered by the
 * Playwright suite against the real globe. What is testable without one is the arithmetic and the
 * prototype patch, and the patch is the part that decides whether a scroll can kill the map.
 *
 * `Camera.prototype.rotate` only touches four vectors and one default on its receiver, so a test
 * calls it against a hand-made object rather than a scene. That is what makes the regression
 * deterministic: the crash itself depends on floating-point rounding at the moment a zoom
 * converges and cannot be forced from outside, but the degenerate input it chokes on can be handed
 * over directly.
 */

import { Camera, Cartesian3, Quaternion } from 'cesium';
import { describe, expect, it } from 'vitest';

import {
  MAX_RENDER_RECOVERIES,
  imageryDate,
  isDegenerateAxis,
  isUsablePose,
  shouldRestartLoop,
} from './viewer';

/**
 * Just what `Camera.prototype.rotate` touches on its receiver: four vectors, one default, and one
 * private call it makes on the way out.
 *
 * Hand-made rather than a real `Camera`, which needs a scene, which needs a WebGL context. The
 * point of the exercise is that the guard delegates to Cesium's own rotation for a real axis, so
 * the receiver has to be faithful enough for that rotation to actually run.
 */
function cameraLike() {
  return {
    position: new Cartesian3(7_000_000, 0, 0),
    direction: new Cartesian3(-1, 0, 0),
    up: new Cartesian3(0, 0, 1),
    right: new Cartesian3(0, 1, 0),
    defaultRotateAmount: 0.1,
    // Called at the end of the real `rotate`; it only matters for an orthographic frustum, and
    // this project's camera is perspective.
    _adjustOrthographicFrustum: (): undefined => undefined,
  };
}

function rotate(receiver: ReturnType<typeof cameraLike>, axis: Cartesian3, angle: number): void {
  Camera.prototype.rotate.call(receiver, axis, angle);
}

describe('isDegenerateAxis', () => {
  it('rejects an axis with no length, which is the one that kills the render loop', () => {
    expect(isDegenerateAxis(new Cartesian3(0, 0, 0))).toBe(true);
  });

  it('rejects a non-finite axis, which cannot describe a rotation at all', () => {
    expect(isDegenerateAxis(new Cartesian3(NaN, 0, 0))).toBe(true);
    expect(isDegenerateAxis(new Cartesian3(0, Infinity, 0))).toBe(true);
    expect(isDegenerateAxis(new Cartesian3(0, 0, -Infinity))).toBe(true);
  });

  it('rejects nothing at all rather than throwing on it', () => {
    expect(isDegenerateAxis(undefined)).toBe(true);
  });

  it('accepts a real axis, including a very small one', () => {
    expect(isDegenerateAxis(new Cartesian3(0, 0, 1))).toBe(false);
    // The zoom's axis shrinks towards zero as it converges: measured down to 0.0117 in the live
    // app before the arrival that would have thrown. Small is not degenerate and must still turn
    // the camera, or a zoom would stop tracking the point under the cursor.
    expect(isDegenerateAxis(new Cartesian3(1e-12, 0, 0))).toBe(false);
  });
});

describe('the guard on Camera.rotate', () => {
  it('leaves the camera exactly where it was when the axis has no length', () => {
    const camera = cameraLike();

    rotate(camera, new Cartesian3(0, 0, 0), 0.2);

    // A rotation about an axis of no length is the identity, so this is the correct answer rather
    // than a swallowed error.
    expect(camera.position).toEqual(new Cartesian3(7_000_000, 0, 0));
    expect(camera.direction).toEqual(new Cartesian3(-1, 0, 0));
  });

  it('still rotates about a real axis, so the guard has not disabled zooming', () => {
    const camera = cameraLike();

    rotate(camera, new Cartesian3(0, 0, 1), Math.PI / 2);

    expect(camera.position.x).toBeCloseTo(0, 6);
    expect(Math.abs(camera.position.y)).toBeCloseTo(7_000_000, 6);
  });

  it('survives a non-finite axis instead of stopping the map', () => {
    const camera = cameraLike();

    expect(() => {
      rotate(camera, new Cartesian3(NaN, 0, 0), 0.2);
    }).not.toThrow();
  });

  /**
   * The upstream bug this patch exists for, asserted directly.
   *
   * If this ever starts passing without throwing, Cesium has guarded the axis itself and the patch
   * in `viewer.ts` should be deleted. A test that fails when the reason for a workaround goes away
   * is the only kind worth writing around a workaround.
   */
  it('is still needed, because Cesium itself throws on a zero axis', () => {
    expect(() => Quaternion.fromAxisAngle(new Cartesian3(0, 0, 0), 0.2)).toThrow(
      /normalized result is not a number/,
    );
  });
});

/** A camera pose with a chosen x, for the pose checks. */
function pose(x: number) {
  return {
    position: new Cartesian3(x, 0, 0),
    direction: new Cartesian3(-1, 0, 0),
    up: new Cartesian3(0, 0, 1),
  };
}

describe('isUsablePose', () => {
  it('accepts a real pose', () => {
    expect(isUsablePose(pose(7_000_000))).toBe(true);
  });

  it('refuses a pose with a non-finite component, which is what a thrown frame leaves behind', () => {
    // Restoring one of these would throw again on the very next frame, so recovery would spin
    // rather than recover.
    expect(isUsablePose(pose(NaN))).toBe(false);
    expect(isUsablePose(pose(Infinity))).toBe(false);
    expect(
      isUsablePose({
        position: new Cartesian3(7_000_000, 0, 0),
        direction: new Cartesian3(NaN, 0, 0),
        up: new Cartesian3(0, 0, 1),
      }),
    ).toBe(false);
  });
});

describe('shouldRestartLoop', () => {
  const stopped = { destroyed: false, loopRunning: false, hidden: false, recoveries: 0 };

  it('restarts a loop that has stopped while the tab is visible', () => {
    expect(shouldRestartLoop(stopped)).toBe(true);
  });

  it('leaves a running loop alone', () => {
    expect(shouldRestartLoop({ ...stopped, loopRunning: true })).toBe(false);
  });

  it('leaves a hidden tab stopped, because this file stopped it on purpose', () => {
    // Otherwise recovery fights the power saving and turns the GPU back on every frame the tab
    // spends in the background.
    expect(shouldRestartLoop({ ...stopped, hidden: true })).toBe(false);
  });

  it('never touches a destroyed viewer', () => {
    expect(shouldRestartLoop({ ...stopped, destroyed: true })).toBe(false);
  });

  it('gives up once the budget is spent, so a wedged camera cannot spin the loop', () => {
    expect(shouldRestartLoop({ ...stopped, recoveries: MAX_RENDER_RECOVERIES - 1 })).toBe(true);
    expect(shouldRestartLoop({ ...stopped, recoveries: MAX_RENDER_RECOVERIES })).toBe(false);
  });
});

describe('the recovery budget', () => {
  it('is bounded, because recovery replays the frame that threw', () => {
    // A wedged camera would otherwise spin the loop throwing and restarting for ever, and a hung
    // tab is worse than a stopped one.
    expect(MAX_RENDER_RECOVERIES).toBeGreaterThan(0);
    expect(MAX_RENDER_RECOVERIES).toBeLessThanOrEqual(5);
  });
});

describe('imageryDate', () => {
  it('asks for yesterday, because today has black gaps where the satellite has not passed', () => {
    expect(imageryDate(new Date('2026-08-23T09:00:00Z'))).toBe('2026-08-22');
  });

  it('crosses a month boundary backwards', () => {
    expect(imageryDate(new Date('2026-03-01T00:30:00Z'))).toBe('2026-02-28');
  });
});
