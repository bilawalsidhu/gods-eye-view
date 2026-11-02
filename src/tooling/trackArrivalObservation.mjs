/** A reveal must beat the one-second idle rotation refresh, regardless of FPS. */
export const ARRIVAL_OBSERVATION_MS = 500;

/**
 * Observe the first completed moveEnd frame and the first subsequent reveal.
 * The deadline starts when moveEnd is forced, before its rotation baseline, so
 * waiting for either frame cannot let the one-second idle refresh mask a bug.
 * `read` snapshots visibility and rotation error against the current position.
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
    const expired = () => ({
      error: `arrival ${moveEnd ? 'reveal' : 'moveEnd'} observation exceeded ${ARRIVAL_OBSERVATION_MS} ms`,
      elapsedMs: now() - startedAt,
      moveEndMs,
      flipFrame: -1,
    });
    remove = scene.postRender.addEventListener(() => {
      if (done) return;
      try {
        const elapsedMs = now() - startedAt;
        if (elapsedMs >= ARRIVAL_OBSERVATION_MS) {
          finish(expired());
          return;
        }
        const sample = read();
        if (moveEnd === null) {
          moveEnd = sample;
          moveEndMs = elapsedMs;
          startReveal();
        } else {
          revealFrames++;
          if (sample.shown) {
            // Keep the FIRST visible result, including a wrong angle. Never
            // wait for a subsequent tick to repair a failed reveal.
            finish({
              dMoveEnd: moveEnd.rotationError,
              dReveal: sample.rotationError,
              shown: sample.shown,
              flipFrame: revealFrames,
              moveEndMs,
              revealMs: elapsedMs - moveEndMs,
              elapsedMs,
            });
            return;
          }
        }
        scene.requestRender();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
    timer = setTimer(() => finish(expired()), ARRIVAL_OBSERVATION_MS);
    try {
      startMoveEnd();
      scene.requestRender();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/** Test the captured frames without retrying a bad first observation. */
export function arrivalRotationPassed(observation) {
  return (
    !!observation &&
    !observation.error &&
    observation.shown === true &&
    observation.elapsedMs < ARRIVAL_OBSERVATION_MS &&
    (observation.dMoveEnd * 180) / Math.PI < 10 &&
    (observation.dReveal * 180) / Math.PI < 10
  );
}
