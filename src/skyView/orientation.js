/**
 * "Point at the sky" controller: reads the
 * phone's orientation and drives the sky view's az/el/roll.
 *
 * Sources, in order (feature detected, never assumed):
 *  0. Wherever DeviceOrientationEvent.requestPermission() exists (iOS 13+,
 *     and recent Chrome too) it is called INSIDE the tap handler (start() is
 *     synchronous up to that call); the source is chosen after it.
 *  1. iOS Safari: `deviceorientation` (alpha in an arbitrary yaw frame)
 *     corrected by webkitCompassHeading (magnetic) / webkitCompassAccuracy;
 *     recognised by the webkitCompassHeading field, not by sniffing.
 *  2. Generic Sensor AbsoluteOrientationSensor (Chromium): a quaternion
 *     against magnetic north, 30 Hz; an error (at start or after readings)
 *     or no reading within NO_SAMPLE_TIMEOUT_MS falls back to 3/4.
 *  3. `deviceorientationabsolute` (Chrome Android), or `deviceorientation`
 *     with absolute === true.
 *  4. `deviceorientation` with absolute false (e.g. Firefox Android): a
 *     relative heading, usable after one Align on the Sun/Moon.
 * Magnetic sources get the WMM declination; every source gets the user's
 * Align offset. Samples are limited to 30 Hz, smoothed (slerp) per frame and
 * applied at <= 30 fps while moving, <= 5 fps when still (orientationMath).
 * Nothing here stops dragging: the sky view stops this controller on a drag.
 *
 * Each source is one "attempt" with its own listeners and its own
 * no-sample watchdog (NO_SAMPLE_TIMEOUT_MS). Only a reading from the CURRENT
 * attempt counts: when a source fails, its last reading is dropped, so a
 * silent fallback ends as denied/unsupported (everything torn down) instead
 * of staying "on" with a stale view. Callbacks from a superseded attempt
 * (late sensor readings/errors, old timers, a stop/start in between) are
 * ignored.
 */
import {
  addHeading,
  alignDelta,
  compassAccuracyPoor,
  compassYawCorrection,
  createRateLimiter,
  normalizeScreenAngle,
  orientationMessage,
  quatAngleDeg,
  quatFromEuler,
  quatNormalize,
  SENSOR_HZ,
  shouldApplyFrame,
  smoothAngleDeg,
  smoothStep,
  viewFromQuaternion,
  wrap180,
} from './orientationMath.js';

export const OFFSET_STORAGE_KEY = 'gev.sky.headingOffsetDeg';
/** No usable sample this long after a source starts = that source is dead. */
export const NO_SAMPLE_TIMEOUT_MS = 3000;
/** iOS accuracy hysteresis: poor above 25 deg, good again at <= 20 deg. */
const ACCURACY_RECOVER_DEG = 20;
/** Weight of each new iOS compass reading in the yaw correction. */
const COMPASS_SMOOTHING = 0.2;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function readOffset(storage) {
  try {
    const v = Number(storage?.getItem?.(OFFSET_STORAGE_KEY));
    return Number.isFinite(v) ? wrap180(v) : 0;
  } catch {
    return 0;
  }
}

/**
 * @param {object} options
 *   win: the window (DeviceOrientationEvent, AbsoluteOrientationSensor,
 *     addEventListener, isSecureContext, screen.orientation.angle)
 *   onView({azDeg, elDeg, rollDeg}), onState(state, info)
 *   storage (localStorage) for the persistent Align offset
 */
export function createPhoneOrientation({
  win = globalThis,
  isSecureContext = win?.isSecureContext,
  onView = () => {},
  onState = () => {},
  storage = (() => {
    try {
      return globalThis.localStorage;
    } catch {
      return null;
    }
  })(),
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  requestFrame = (fn) => globalThis.requestAnimationFrame?.(fn) ?? null,
  cancelFrame = (id) => globalThis.cancelAnimationFrame?.(id),
  timers = globalThis,
  noSampleTimeoutMs = NO_SAMPLE_TIMEOUT_MS,
} = {}) {
  let state = 'off';
  let reason = null;
  let source = null;
  let declination = 0;
  let declinationKnown = false;
  // persistent for compass sources; session-only for a relative heading
  let offset = readOffset(storage);
  let relativeOffset = null;
  let compassCorrection = null;
  let accuracyDeg = null;
  let accuracyPoor = false;
  let lastRaw = null; // { q, magnetic }
  let target = null;
  let shown = null;
  let applied = null;
  let appliedAt = -Infinity;
  let appliedAngle = null;
  let lastFrameAt = null;
  let frame = null;
  let timeout = null;
  let sensor = null;
  let sensorDenied = false;
  let eventsAvailable = false;
  let token = 0; // one per start()/stop(): guards the permission answer
  let attempt = 0; // one per source attempt: guards its callbacks + watchdog
  let attemptSampled = false;
  const removers = []; // the current attempt's listeners
  const limiter = createRateLimiter(SENSOR_HZ);

  /**
   * Can an Align offset be applied now? Only when the current attempt has a
   * reading in a known heading frame: magnetic north (sensor, absolute
   * event, iOS once webkitCompassHeading has given the yaw correction) or a
   * relative source (whose session-only offset IS its reference). iOS before
   * its first usable compass reading draws alpha in an arbitrary frame
   * (reason "heading", or "accuracy" for a negative accuracy): an offset
   * taken there would be stored and then counted twice once the correction
   * arrives, so Align waits for the reference (R2).
   */
  function alignReady() {
    if (!running() || !lastRaw || !source) return false;
    if (source === 'ios') return compassCorrection != null;
    return true;
  }

  const info = () => ({
    reason,
    source,
    alignReady: alignReady(),
    accuracyDeg,
    offsetDeg: source === 'relative' ? relativeOffset : offset,
    declinationDeg: declinationKnown ? declination : null,
    message: orientationMessage(state, reason),
  });
  let readyNotified = false; // alignReady() as last reported via onState
  function setState(next, nextReason = null) {
    if (state === next && reason === nextReason) {
      // e.g. iOS still poor ("accuracy") when its first compass reference
      // arrives: same state, but Align just became possible
      if (alignReady() === readyNotified) return;
    }
    state = next;
    reason = nextReason;
    readyNotified = alignReady();
    onState(state, info());
  }
  const running = () =>
    state === 'on' || state === 'calibrating' || state === 'asking';

  function screenAngle() {
    const angle =
      win?.screen?.orientation?.angle ??
      (isNum(win?.orientation) ? win.orientation : 0);
    return normalizeScreenAngle(angle);
  }

  // ── samples ──────────────────────────────────────────────────────────────
  function headingTotal(magnetic) {
    if (!magnetic) return relativeOffset ?? 0;
    return declination + offset;
  }
  function retarget() {
    if (!lastRaw) return;
    target = addHeading(lastRaw.q, headingTotal(lastRaw.magnetic));
  }
  function sample(q, { magnetic }) {
    attemptSampled = true;
    lastRaw = { q: quatNormalize(q), magnetic };
    retarget();
    timers.clearTimeout?.(timeout);
    timeout = null;
    // state: calibrating while the heading is unknown or poor, else on
    if (!magnetic && relativeOffset == null)
      setState('calibrating', 'relative');
    else if (accuracyPoor) setState('calibrating', 'accuracy');
    else if (source === 'ios' && compassCorrection == null)
      setState('calibrating', 'heading');
    else setState('on');
    ensureFrame();
  }

  function onEvent(event) {
    if (!running()) return;
    if (!isNum(event?.alpha) || !isNum(event?.beta) || !isNum(event?.gamma))
      return; // desktop browsers fire one all-null event
    if (!limiter.accept(now())) return;
    const q = quatFromEuler(event.alpha, event.beta, event.gamma);
    if (isNum(event.webkitCompassHeading) || source === 'ios') {
      source = 'ios';
      accuracyDeg = isNum(event.webkitCompassAccuracy)
        ? event.webkitCompassAccuracy
        : null;
      if (accuracyPoor)
        accuracyPoor = !(
          accuracyDeg >= 0 && accuracyDeg <= ACCURACY_RECOVER_DEG
        );
      else accuracyPoor = compassAccuracyPoor(accuracyDeg);
      if (isNum(event.webkitCompassHeading) && !(accuracyDeg < 0)) {
        const c = compassYawCorrection(q, event.webkitCompassHeading);
        if (c != null)
          compassCorrection =
            compassCorrection == null
              ? c
              : smoothAngleDeg(compassCorrection, c, COMPASS_SMOOTHING);
      }
      if (compassCorrection == null) {
        // no heading yet: keep the view moving, flagged as calibrating
        sample(q, { magnetic: true });
        return;
      }
      sample(addHeading(q, compassCorrection), { magnetic: true });
      return;
    }
    const absolute =
      event.type === 'deviceorientationabsolute' || event.absolute === true;
    if (!absolute) source = 'relative';
    else if (!source || source === 'relative') source = 'absolute-event';
    sample(q, { magnetic: absolute });
  }

  /** End the current source attempt (listeners, watchdog); start a new one. */
  function newAttempt() {
    for (const remove of removers.splice(0)) remove();
    sensor = null;
    timers.clearTimeout?.(timeout);
    timeout = null;
    attempt += 1;
    attemptSampled = false;
    return attempt;
  }

  /** Watchdog for the current attempt: no reading of ITS OWN in time. */
  function armTimeout(onSilent) {
    timers.clearTimeout?.(timeout);
    const mine = attempt;
    timeout = timers.setTimeout?.(() => {
      if (mine !== attempt) return; // superseded: not our timer any more
      timeout = null;
      if (attemptSampled || !running()) return;
      onSilent();
    }, noSampleTimeoutMs);
  }

  function giveUp() {
    teardown();
    setState(sensorDenied ? 'denied' : 'unsupported');
  }

  function listenEvents() {
    const mine = newAttempt();
    const type =
      win && 'ondeviceorientationabsolute' in win
        ? 'deviceorientationabsolute'
        : 'deviceorientation';
    const handler = (event) => {
      if (mine === attempt) onEvent(event);
    };
    win.addEventListener?.(type, handler);
    removers.push(() => win.removeEventListener?.(type, handler));
    armTimeout(giveUp);
  }

  /**
   * The sensor failed or stayed silent: drop its reading (it is no longer
   * live), stop drawing it, and try the events, which must deliver a reading
   * of their own within the timeout.
   */
  function fallBackFromSensor() {
    newAttempt();
    source = null; // the events name their own source on their first reading
    lastRaw = null;
    target = null;
    if (frame != null) cancelFrame(frame);
    frame = null;
    lastFrameAt = null;
    limiter.reset();
    if (eventsAvailable) listenEvents();
    else giveUp();
  }

  function startSensor(Sensor) {
    let s;
    try {
      s = new Sensor({ frequency: SENSOR_HZ, referenceFrame: 'device' });
    } catch {
      return false; // SecurityError / ReferenceError: use the events
    }
    const mine = newAttempt();
    const onReading = () => {
      if (mine !== attempt || !running()) return;
      const q = s.quaternion;
      if (!q || q.length !== 4 || !q.every(isNum)) return;
      if (!limiter.accept(now())) return;
      source = 'sensor';
      sample([q[0], q[1], q[2], q[3]], { magnetic: true });
    };
    const onError = (event) => {
      if (mine !== attempt || !running()) return;
      const name = event?.error?.name;
      if (name === 'NotAllowedError') sensorDenied = true;
      fallBackFromSensor(); // also when it fails after readings
    };
    s.addEventListener?.('reading', onReading);
    s.addEventListener?.('error', onError);
    removers.push(() => {
      s.removeEventListener?.('reading', onReading);
      s.removeEventListener?.('error', onError);
      try {
        s.stop?.();
      } catch {
        /* already stopped */
      }
    });
    try {
      s.start();
    } catch {
      newAttempt(); // remove what was attached; the caller uses the events
      return false;
    }
    if (mine !== attempt) return true; // an error fired inside start()
    sensor = s;
    armTimeout(fallBackFromSensor); // started but silent: try the events
    return true;
  }

  // ── frames ───────────────────────────────────────────────────────────────
  function ensureFrame() {
    if (frame != null || !running()) return;
    frame = requestFrame(step);
    if (frame == null) {
      // no animation frames (tests without a frame source): apply directly
      shown = target;
      apply(now(), true);
    }
  }
  function apply(t, force = false) {
    if (!shown) return;
    const angle = screenAngle();
    const delta = applied ? quatAngleDeg(applied, shown) : Infinity;
    if (
      !force &&
      angle === appliedAngle &&
      !shouldApplyFrame(delta, t - appliedAt)
    )
      return;
    applied = shown;
    appliedAt = t;
    appliedAngle = angle;
    onView(viewFromQuaternion(shown, angle));
  }
  function step() {
    frame = null;
    if (!running() || !target) return;
    const t = now();
    const dt = lastFrameAt == null ? 0 : t - lastFrameAt;
    lastFrameAt = t;
    shown = shown ? smoothStep(shown, target, dt) : target;
    apply(t);
    frame = requestFrame(step);
  }

  function teardown() {
    token += 1;
    newAttempt(); // invalidates every callback and timer of the old attempt
    if (frame != null) cancelFrame(frame);
    frame = null;
    lastFrameAt = null;
    lastRaw = null;
    target = null;
    shown = null;
    applied = null;
    appliedAt = -Infinity;
    appliedAngle = null;
    compassCorrection = null;
    accuracyDeg = null;
    accuracyPoor = false;
    limiter.reset();
  }

  // ── public ───────────────────────────────────────────────────────────────
  /**
   * Turn pointing on. Call it directly from the tap handler: on iOS the
   * permission request must run inside the user gesture.
   */
  function start() {
    if (running()) return Promise.resolve(state);
    teardown();
    source = null;
    sensorDenied = false;
    relativeOffset = null;
    eventsAvailable = false;
    if (!isSecureContext) {
      setState('insecure');
      return Promise.resolve(state);
    }
    const DOE = win?.DeviceOrientationEvent;
    const AOS = win?.AbsoluteOrientationSensor;
    if (typeof DOE !== 'function' && typeof AOS !== 'function') {
      setState('unsupported');
      return Promise.resolve(state);
    }
    eventsAvailable = typeof DOE === 'function';
    setState('asking');
    // Pick the best source once access is settled (feature detection, not
    // browser sniffing: Chrome now has requestPermission() too).
    const begin = () => {
      if (typeof AOS === 'function' && startSensor(AOS)) return;
      if (typeof DOE !== 'function') {
        setState('unsupported');
        return;
      }
      listenEvents();
    };
    if (typeof DOE?.requestPermission === 'function') {
      // iOS 13+ (and recent Chrome): must run inside the tap
      let request;
      try {
        request = DOE.requestPermission(); // synchronous inside the tap
      } catch {
        setState('denied');
        return Promise.resolve(state);
      }
      const mine = token;
      return Promise.resolve(request).then(
        (answer) => {
          if (mine !== token || state !== 'asking') return state;
          if (answer === 'granted') begin();
          else setState('denied');
          return state;
        },
        () => {
          if (mine === token && state === 'asking') setState('denied');
          return state;
        },
      );
    }
    begin();
    return Promise.resolve(state);
  }

  /** Turn pointing off (Off button, drag, leaving the sky). */
  function stop() {
    teardown();
    setState('off');
  }

  /**
   * Align: the user has the view centre on a known object (Sun, Moon, the
   * selected object) whose true azimuth is targetAzDeg. Returns the change
   * in degrees, or null (nothing stored) when pointing is not running or
   * has no heading reference yet (alignReady).
   */
  function alignTo(targetAzDeg, viewAzDeg) {
    if (!alignReady() || !isNum(targetAzDeg) || !isNum(viewAzDeg)) return null;
    const delta = alignDelta(targetAzDeg, viewAzDeg);
    if (source === 'relative') {
      relativeOffset = wrap180((relativeOffset ?? 0) + delta);
    } else {
      offset = wrap180(offset + delta);
      try {
        storage?.setItem?.(OFFSET_STORAGE_KEY, String(offset));
      } catch {
        /* private mode */
      }
    }
    retarget();
    shown = target; // snap: the user is looking at the result
    if (lastRaw) sample(lastRaw.q, { magnetic: lastRaw.magnetic });
    apply(now(), true);
    onState(state, info());
    return delta;
  }

  function resetOffset() {
    offset = 0;
    relativeOffset = source === 'relative' ? null : relativeOffset;
    try {
      storage?.removeItem?.(OFFSET_STORAGE_KEY);
    } catch {
      /* private mode */
    }
    retarget();
    shown = target;
    if (lastRaw) sample(lastRaw.q, { magnetic: lastRaw.magnetic });
    apply(now(), true);
    onState(state, info());
  }

  /** WMM declination for the observer (null = unknown, 0 used). */
  function setDeclination(deg) {
    declinationKnown = isNum(deg);
    declination = declinationKnown ? deg : 0;
    retarget();
  }

  return {
    get state() {
      return state;
    },
    get reason() {
      return reason;
    },
    get source() {
      return source;
    },
    get running() {
      return running();
    },
    /** A heading reference exists, so alignTo() applies (see alignReady). */
    get alignReady() {
      return alignReady();
    },
    get info() {
      return info();
    },
    get sensor() {
      return sensor;
    },
    start,
    stop,
    alignTo,
    resetOffset,
    setDeclination,
    destroy() {
      teardown();
      state = 'off';
    },
  };
}

/**
 * Should the "Point at the sky" button be offered? Phones and tablets
 * (coarse pointer) and any browser exposing the orientation APIs on a touch
 * screen; on an insecure page it is still shown so the tap can explain why
 * it cannot work.
 */
export function pointingOffered(win = globalThis) {
  const coarse = Boolean(win?.matchMedia?.('(any-pointer: coarse)')?.matches);
  return coarse;
}
