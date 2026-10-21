/**
 * Wall-clock budget for EACH observed frame, regardless of FPS. Both the settle
 * frame (measured from the forced moveEnd) and the reveal frame (measured from
 * the settle frame that hid the contact) must land inside it, so neither can be
 * repaired by the one-second idle rotation refresh before it is read. The
 * refresh clock starts at the fleet tick (preRender) of the frame the budget is
 * measured from, so the budget must leave room for that frame's own render
 * time: half the refresh interval tolerates frames up to ~500 ms, and a ~300 ms
 * software-rendered frame (headless SwiftShader) fits with margin.
 */
export const ARRIVAL_OBSERVATION_MS = 500;

/**
 * Observe the first completed moveEnd frame and the first subsequent reveal.
 * The settle deadline starts when moveEnd is forced, before its rotation
 * baseline; the reveal deadline restarts at the settle frame, which is where
 * the contact is hidden. `read` snapshots visibility and rotation error
 * against the current position.
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
    let phaseStartedAt = startedAt;
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
    const armDeadline = () => {
      clearTimer(timer);
      timer = setTimer(() => finish(expired()), ARRIVAL_OBSERVATION_MS);
    };
    remove = scene.postRender.addEventListener(() => {
      if (done) return;
      try {
        const at = now();
        const elapsedMs = at - startedAt;
        if (at - phaseStartedAt >= ARRIVAL_OBSERVATION_MS) {
          finish(expired());
          return;
        }
        const sample = read();
        if (moveEnd === null) {
          moveEnd = sample;
          moveEndMs = elapsedMs;
          phaseStartedAt = at;
          armDeadline();
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
    armDeadline();
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
    observation.moveEndMs < ARRIVAL_OBSERVATION_MS &&
    observation.revealMs < ARRIVAL_OBSERVATION_MS &&
    (observation.dMoveEnd * 180) / Math.PI < 10 &&
    (observation.dReveal * 180) / Math.PI < 10
  );
}
