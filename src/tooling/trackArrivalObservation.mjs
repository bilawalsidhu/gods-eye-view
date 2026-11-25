/**
 * Frames the reveal may take after the last frame that drew the contact
 * hidden (or the settle frame): the next frame, or the one after it when the
 * next was already in flight. The count is not timed: the angle a frame draws
 * does not depend on how long the frame took.
 */
export const ARRIVAL_REVEAL_MAX_FRAMES = 2;

/**
 * Maximum wall-clock wait for the next frame before the observation ends.
 */
export const ARRIVAL_STALL_MS = 10_000;

/** A measured rotation error at or above this fails the arrival check. */
export const ARRIVAL_MAX_ERROR_DEG = 10;

/** Attempts allowed when every earlier one was inconclusive. */
export const ARRIVAL_MAX_ATTEMPTS = 2;

/**
 * Observe the first frame after a forced moveEnd (the settle frame) and the
 * first frame that draws the contact again (the reveal). `startReveal` hides
 * the contact right after the settle frame; `read` snapshots visibility and
 * rotation error against the current position. A hidden sample carrying
 * `revealStartsNow` marks a frame that drew the contact hidden: the reveal is
 * counted from the last such frame, or from the settle frame when no frame is
 * marked. The frames spent drawing it hidden are the probe's setup, reported
 * as `hiddenMs`, not part of the reveal.
 */
export function observeArrivalRotation({
  scene,
  startMoveEnd,
  startReveal,
  read,
  now = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  return new Promise((resolve, reject) => {
    const startedAt = now();
    let moveEnd = null;
    let moveEndMs = null;
    let revealFromMs = null;
    let revealFromFrame = 0;
    let revealFrames = 0;
    let done = false;
    let remove;
    let timer;
    const cleanup = () => {
      done = true;
      remove?.();
      clearTimer(timer);
    };
    const finish = (result) => {
      if (done) return;
      cleanup();
      resolve(result);
    };
    // An unfinished observation keeps the settle angle it measured, so
    // `arrivalAngleViolated` can make it final instead of retryable.
    const unfinished = (reason) => ({
      error: `arrival ${moveEnd ? 'reveal' : 'moveEnd'} ${reason}`,
      elapsedMs: now() - startedAt,
      moveEndMs,
      ...(moveEnd ? { dMoveEnd: moveEnd.rotationError } : {}),
    });
    const armStall = () => {
      clearTimer(timer);
      timer = setTimer(
        () => finish(unfinished(`saw no frame for ${ARRIVAL_STALL_MS} ms`)),
        ARRIVAL_STALL_MS,
      );
    };
    remove = scene.postRender.addEventListener(() => {
      if (done) return;
      try {
        const elapsedMs = now() - startedAt;
        const sample = read();
        armStall();
        if (moveEnd === null) {
          moveEnd = sample;
          moveEndMs = elapsedMs;
          revealFromMs = elapsedMs;
          startReveal();
        } else {
          revealFrames++;
          const revealFrame = revealFrames - revealFromFrame;
          if (sample.shown) {
            // Keep the FIRST visible result, including a wrong angle. Never
            // wait for a subsequent frame to repair a failed reveal.
            finish({
              dMoveEnd: moveEnd.rotationError,
              dReveal: sample.rotationError,
              shown: sample.shown,
              flipFrame: revealFrames,
              revealFrame,
              moveEndMs,
              revealMs: elapsedMs - revealFromMs,
              hiddenMs: revealFromMs - moveEndMs,
              elapsedMs,
            });
            return;
          }
          if (sample.revealStartsNow) {
            revealFromMs = elapsedMs;
            revealFromFrame = revealFrames;
          } else if (revealFrame >= ARRIVAL_REVEAL_MAX_FRAMES) {
            finish(
              unfinished(
                `not drawn within ${ARRIVAL_REVEAL_MAX_FRAMES} frames`,
              ),
            );
            return;
          }
        }
        scene.requestRender();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
    armStall();
    try {
      startMoveEnd();
      scene.requestRender();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/**
 * Whether an observation measured a rotation error over the threshold on any
 * frame it captured, including the settle frame of a reveal that never came.
 * Such an observation is a demonstrated failure, never inconclusive.
 */
export function arrivalAngleViolated(observation) {
  const limit = (ARRIVAL_MAX_ERROR_DEG * Math.PI) / 180;
  return [observation?.dMoveEnd, observation?.dReveal].some(
    (error) => Number.isFinite(error) && error >= limit,
  );
}

/**
 * Observe arrival rotation, retrying only an inconclusive observation: a
 * stalled renderer, or a reveal that missed its frames after a correct settle
 * frame. An observation that measured a wrong angle (or succeeded) is final,
 * so a later clean attempt can never replace it. `prepare` runs before every
 * attempt; the result carries `attempts`.
 */
export async function observeArrivalRotationWithRetry({
  prepare = async () => {},
  observe = observeArrivalRotation,
  maxAttempts = ARRIVAL_MAX_ATTEMPTS,
  ...options
}) {
  let observed;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await prepare();
    observed = { ...(await observe(options)), attempts: attempt };
    if (!observed.error || arrivalAngleViolated(observed)) break;
  }
  return observed;
}

/** Test the captured frames without retrying a bad first observation. */
export function arrivalRotationPassed(observation) {
  return (
    !!observation &&
    !observation.error &&
    observation.shown === true &&
    observation.revealFrame >= 1 &&
    observation.revealFrame <= ARRIVAL_REVEAL_MAX_FRAMES &&
    Number.isFinite(observation.dMoveEnd) &&
    Number.isFinite(observation.dReveal) &&
    !arrivalAngleViolated(observation)
  );
}
