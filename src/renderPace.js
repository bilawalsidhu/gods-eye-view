/**
 * Draws a moving layer as often as its marks move on screen, in place of a
 * hold on the render loop for as long as the layer is on.
 *
 * A mark should move at most PACE_STEP_PX between two draws, so a layer
 * needs `fastest on-screen speed / PACE_STEP_PX` draws a second. The pace
 * keeps that between PACE_MIN_HZ (animated marks never stall) and
 * PACE_MAX_HZ (room in the frame for everything else the scene draws).
 * Below PACE_HOLD_HZ it asks for one frame at a time on a timer, so the
 * loop stays on demand; from there it holds the loop at a rate the display
 * divides evenly (the render governor's rate per hold).
 *
 * The person steering the camera still draws at the display's rate: that is
 * the camera's hold, not a layer's (see renderGovernor.js).
 */

/** The most a mark may move on screen between two draws, in pixels. */
export const PACE_STEP_PX = 0.5;
/** Draws a second however slowly the marks move. */
export const PACE_MIN_HZ = 3;
/** Draws a second however fast the marks move. */
export const PACE_MAX_HZ = 30;
/** From this many draws a second the pace holds the loop instead. */
export const PACE_HOLD_HZ = 12;
/** Below this the hold is let go again (a gap, so it does not flap; above
 * ROTOR_FPS, so a turning rotor alone draws on the timer at its own rate). */
export const PACE_RELEASE_HZ = 11;
/** Held rates, each dividing 60 and 120 evenly so draws come at even gaps. */
const HELD_RATES = [15, 20, 30];

/** Draws a second for marks crossing the screen at `pxPerSec`. */
export function paceHzForSpeed(pxPerSec) {
  return pxPerSec / PACE_STEP_PX;
}

/** The held rate for a need of `hz` draws a second. */
function heldRateFor(hz) {
  for (const rate of HELD_RATES) if (hz <= rate) return rate;
  return PACE_MAX_HZ;
}

/**
 * @param {object} options
 * @param {string} options.owner The hold's owner id ('flights', 'satellites').
 * @param {object} [options.render] The render governor's calls
 *   (holdContinuousRender, releaseContinuousRender, governorRequestRender).
 * @param {Function} [options.setTimeout] Injectable timers for tests.
 * @param {Function} [options.clearTimeout]
 * @param {() => number} [options.now] Injectable wall clock (ms) for tests.
 */
export function createRenderPace({
  owner,
  render,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: unschedule = globalThis.clearTimeout,
  now = () => globalThis.performance?.now() ?? Date.now(),
}) {
  const hold = render?.holdContinuousRender ?? (() => {});
  const release = render?.releaseContinuousRender ?? (() => {});
  const request = render?.governorRequestRender ?? (() => {});
  let running = false;
  let hz = PACE_MIN_HZ;
  let held = false;
  /** The rate the hold asked for, or -1 while not held. */
  let heldFps = -1;
  let timer = null;
  let timerHz = 0;
  /** Whether the timer's wait ended: the marks move on the next frame. */
  let due = false;
  /** Wall ms the marks last moved. */
  let movedMs = -Infinity;

  function arm() {
    if (!running || held) return;
    if (timer !== null) {
      // A pending wait at a much slower rate is cut short.
      if (hz <= timerHz * 1.5) return;
      unschedule(timer);
    }
    timerHz = hz;
    timer = schedule(() => {
      timer = null;
      due = true;
      request(owner);
      arm();
    }, 1000 / hz);
  }

  /**
   * Set the draws a second needed now (any number: it is clamped to the
   * pace's range; Infinity asks for the most). Called once a drawn frame.
   */
  function set(needHz) {
    if (!running) return;
    const clamped = Math.min(
      PACE_MAX_HZ,
      needHz >= PACE_MIN_HZ ? needHz : PACE_MIN_HZ,
    );
    // Up at once, down gently: the fastest mark leaving the view is no
    // reason to step the next one.
    hz = clamped >= hz ? clamped : Math.max(clamped, hz * 0.9);
    const wantHold = held ? hz >= PACE_RELEASE_HZ : hz >= PACE_HOLD_HZ;
    if (wantHold) {
      const maxFps = heldRateFor(hz);
      if (!held || maxFps !== heldFps) hold(owner, { maxFps });
      heldFps = maxFps;
      if (timer !== null) unschedule(timer);
      timer = null;
    } else if (held) {
      release(owner);
      heldFps = -1;
    }
    held = wantHold;
    arm();
  }

  /**
   * Whether the layer's marks should move in this frame, for a layer that
   * moves them itself (moving them asks for a frame, so a layer moving them
   * on every drawn frame keeps the loop drawing). Marks the move when true.
   */
  function take() {
    const at = now();
    if (!running || held || due || at - movedMs >= 1000 / hz) {
      due = false;
      movedMs = at;
      return true;
    }
    return false;
  }

  function start() {
    if (running) return;
    running = true;
    // Until the first frame says what is needed.
    hz = PACE_RELEASE_HZ;
    due = true;
    movedMs = -Infinity;
    request(owner);
    arm();
  }

  function stop() {
    running = false;
    if (timer !== null) unschedule(timer);
    timer = null;
    held = false;
    heldFps = -1;
    due = false;
    release(owner);
  }

  return {
    set,
    take,
    start,
    stop,
    state: () => ({ running, hz, held, heldFps }),
  };
}

/** cos 60°: marks further than this from the view's axis are not read. */
const VIEW_COS = 0.5;

/**
 * Reads how fast the fastest mark crosses the screen, from each mark's move
 * as an angle at the eye. Use: `begin` with the camera, `add` each mark's
 * two positions (ECEF), then `pxPerSec` with the time between them.
 * The flat screen stretches an angle away from its centre by 1 / cos², so
 * that is applied too.
 */
export function createScreenSpeed() {
  let eye = null;
  let dir = null;
  let ex = 0;
  let ey = 0;
  let ez = 0;
  let focal = 0;
  let fastest2 = 0;

  return {
    /**
     * @param {{position: {x,y,z}, direction: {x,y,z}, fovy: number}|null} pose
     * @param {number} heightPx The canvas's height in CSS pixels.
     * @param {{x,y,z}} [eyeMove] How far the eye itself moved between the
     *   two positions: a camera riding one mark sees its neighbours nearly
     *   still.
     * @returns {boolean} Whether there is a camera to read with.
     */
    begin(pose, heightPx, eyeMove = null) {
      fastest2 = 0;
      eye = pose?.position ?? null;
      dir = pose?.direction ?? null;
      if (!eye || !dir || !(pose.fovy > 0)) {
        eye = null;
        return false;
      }
      ex = eyeMove?.x ?? 0;
      ey = eyeMove?.y ?? 0;
      ez = eyeMove?.z ?? 0;
      focal = (heightPx || 900) / 2 / Math.tan(pose.fovy / 2);
      return true;
    },
    /**
     * One mark's move from `from` to `to` (ECEF metres), made over `scale`
     * times less time than the moves `pxPerSec` is asked for: a mark whose
     * drawn path ends sooner is read over what is left of it.
     */
    add(from, to, scale = 1) {
      if (!eye || !from || !to) return;
      const dx = to.x - eye.x;
      const dy = to.y - eye.y;
      const dz = to.z - eye.z;
      const range2 = dx * dx + dy * dy + dz * dz;
      const along = dx * dir.x + dy * dir.y + dz * dir.z;
      if (!(along > 0) || along * along < VIEW_COS * VIEW_COS * range2) return;
      const mx = (to.x - from.x) * scale - ex;
      const my = (to.y - from.y) * scale - ey;
      const mz = (to.z - from.z) * scale - ez;
      // The angle the move subtends, stretched by 1 / cos² off the centre.
      const turn2 =
        ((mx * mx + my * my + mz * mz) * range2) /
        (along * along * along * along);
      if (turn2 > fastest2) fastest2 = turn2;
    },
    /** The fastest mark's on-screen speed, for moves `seconds` apart. */
    pxPerSec(seconds) {
      if (!eye || !(seconds > 0)) return 0;
      return (Math.sqrt(fastest2) * focal) / seconds;
    },
  };
}
