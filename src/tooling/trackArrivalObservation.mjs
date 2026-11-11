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

/** A measured rotation error at or above this fails the arrival check. */
export const ARRIVAL_MAX_ERROR_DEG = 10;

/** Attempts allowed when every earlier one timed out without a wrong angle. */
export const ARRIVAL_MAX_ATTEMPTS = 2;

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
    // A timeout keeps every angle it measured: the settle angle before a
    // reveal timeout, and the angle on a late frame itself (a late frame is
    // read first; the idle refresh can only repair an angle, so a wrong one
    // seen late was wrong on time too). `arrivalAngleViolated` then makes the
    // timeout final instead of retryable.
    const expired = (late = null) => ({
      error: `arrival ${moveEnd ? 'reveal' : 'moveEnd'} observation exceeded ${ARRIVAL_OBSERVATION_MS} ms`,
      elapsedMs: now() - startedAt,
      moveEndMs,
      ...(moveEnd
        ? { dMoveEnd: moveEnd.rotationError }
        : late
          ? { dMoveEnd: late.rotationError }
          : {}),
      ...(moveEnd && late?.shown ? { dReveal: late.rotationError } : {}),
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
        const sample = read();
        if (at - phaseStartedAt >= ARRIVAL_OBSERVATION_MS) {
          finish(expired(sample));
          return;
        }
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

/**
 * Whether an observation measured a rotation error over the threshold on any
 * frame it captured, including the settle frame of a reveal that then timed
 * out. Such an observation is a demonstrated failure, never inconclusive.
 */
export function arrivalAngleViolated(observation) {
  const limit = (ARRIVAL_MAX_ERROR_DEG * Math.PI) / 180;
  return [observation?.dMoveEnd, observation?.dReveal].some(
    (error) => Number.isFinite(error) && error >= limit,
  );
}

/**
 * Observe arrival rotation, retrying only an inconclusive timeout. A wall-clock
 * timeout means the frame landed where the idle refresh could already have
 * repaired it, so it earns another attempt; an observation that measured a
 * wrong angle (or succeeded) is final, so a later clean attempt can never
 * replace it. `prepare` runs before every attempt; the result carries
 * `attempts`.
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
    observation.moveEndMs < ARRIVAL_OBSERVATION_MS &&
    observation.revealMs < ARRIVAL_OBSERVATION_MS &&
    Number.isFinite(observation.dMoveEnd) &&
    Number.isFinite(observation.dReveal) &&
    !arrivalAngleViolated(observation)
  );
}
