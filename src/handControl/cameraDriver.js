/**
 * Hand control: applies gesture intents (handControl/gestures.js) to the
 * camera port and the app.
 *
 * - Pan drags the map like a hand on a table: the eye slides over the ground
 *   at its own height, scaled by altitude. Letting go while the hand still
 *   moves throws the map, which coasts to a stop.
 * - Zoom, rotate and tilt turn about the ground point under the screen centre
 *   (`lookAt` with heading/pitch/range, then `release`, so the mouse keeps
 *   working normally).
 * - Pilot 👉 flies straight ahead at a steady height; the pilot hand steers
 *   and sets the speed. Any other camera input ends the flight.
 * - Thumb 👍 sideways starts the same slow orbit the voice uses; an open-hand
 *   swipe walks the view history (or spins the globe from far away).
 * - A grab or a fist interrupts voice/route camera motions and flights, the
 *   same reflex as touching the map with the mouse.
 *
 * @module handControl/cameraDriver
 */
import { interruptCameraMotion, moveCamera } from '../cameraVerbs.js';
import { START_VIEW } from '../camera.js';
import { isFollowing } from '../data/followed.js';
import { distance, toLonLatH, toDegrees, toRadians } from '../geo/index.js';
import { eyeMoved } from '../geo/eyeMoves.js';
import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';
import {
  cameraOf,
  canvasOf,
  findFrame,
  findQuery,
} from '../render/rendererOf.js';

const PITCH_MIN = toRadians(-89);
const PITCH_MAX = toRadians(-5);
const RANGE_MIN = 60;
const RANGE_MAX = 40_000_000;
/** Mean Earth radius for the small per-frame slides, metres. */
const EARTH_RADIUS_M = 6_371_000;
/** Above this height a sideways swipe spins the globe instead of going back. */
const GLOBE_SWIPE_HEIGHT_M = 2_500_000;
const HISTORY_MAX = 30;
const RENDER_OWNER = 'hand-control-motion';

/** Gains at sensitivity 1. */
export const GAINS = Object.freeze({
  /** Fraction of the camera height moved per full-frame hand travel. */
  pan: 2.2,
  /** Exponent on the hand-scale ratio (one hand nearer → closer). */
  zoom: 3,
  /** Exponent on the two-hand spread ratio. */
  zoom2: 2.2,
  rotate: 1.2,
  /** Radians of pitch per full-frame vertical travel of both hands. */
  tilt: 2.5,
});

/** Pilot flight tuning. */
export const CRUISE = Object.freeze({
  /** Ground speed at factor 1, as a fraction of the camera height per second. */
  heightPerS: 0.04,
  minMps: 12,
  /** Speed factor range and how strongly hand distance changes it. */
  minFactor: 0.25,
  maxFactor: 8,
  throttleGain: 3,
  /** Index lean (rad) ignored around straight up, and turn rate per rad. */
  steerDead: 0.12,
  steerRate: 0.6,
});

/** Throw: hand speed (frame/s) needed, and the coast's decay time. */
export const GLIDE = Object.freeze({
  minSpeed: 0.25,
  decayS: 0.45,
  stopSpeed: 0.02,
});

/** Name for a pilot speed factor. */
export function cruiseSpeedName(factor) {
  if (factor < 0.6) return 'very slow';
  if (factor < 1.6) return 'slow';
  if (factor < 3.5) return 'normal';
  return 'fast';
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * The geodetic point `eastM`/`northM` metres from `lon`/`lat` (degrees): a
 * local step, accurate for the short slides one frame makes.
 */
export function stepLonLat(lon, lat, eastM, northM) {
  const latR = toRadians(lat);
  const nextLat = clamp(lat + toDegrees(northM / EARTH_RADIUS_M), -89.9, 89.9);
  const cosLat = Math.max(1e-6, Math.cos(latR));
  let nextLon = lon + toDegrees(eastM / (EARTH_RADIUS_M * cosLat));
  if (nextLon > 180) nextLon -= 360;
  if (nextLon < -180) nextLon += 360;
  return { lon: nextLon, lat: nextLat };
}

/**
 * @param {object} viewer The scene the camera port is found from.
 * @param {{
 *   sensitivity?: () => number,
 *   annotations?: {annotate: Function}|null,
 *   sceneDirector?: object|null,
 * }} [options]
 */
export function createCameraDriver(
  viewer,
  { sensitivity = () => 1, annotations = null, sceneDirector = null } = {},
) {
  const camera = () => cameraOf(viewer);
  const past = [];
  const future = [];
  let cruise = null; // { factor, refFactor, steer, startedAt }
  let glide = null; // { vx, vy } frame widths per second
  let splitHandle = null; // grabbed imagery split line
  let loop = 0;
  let lastLoopT = 0;
  let expectedPos = null;

  function centerTarget() {
    const query = findQuery(viewer);
    const canvas = canvasOf(viewer);
    if (!query || !canvas) return null;
    try {
      return (
        query.pickEllipsoid(canvas.clientWidth / 2, canvas.clientHeight / 2) ||
        null
      );
    } catch {
      return null;
    }
  }

  const busy = () => isFollowing(viewer);
  const requestRender = () => governorRequestRender('hand-control');

  // ---- view history ------------------------------------------------------
  function snapshot() {
    const pose = camera().pose();
    return {
      position: { ...pose.position },
      heading: pose.heading,
      pitch: pose.pitch,
      roll: pose.roll,
    };
  }
  const sameView = (a, b) =>
    a &&
    b &&
    distance(a.position, b.position) < 1 &&
    Math.abs(a.heading - b.heading) < 1e-3 &&
    Math.abs(a.pitch - b.pitch) < 1e-3;

  /** Remember the view before a change, so a swipe can bring it back. */
  function record() {
    const view = snapshot();
    if (sameView(view, past[past.length - 1])) return;
    past.push(view);
    if (past.length > HISTORY_MAX) past.shift();
    future.length = 0;
  }

  function historyStep(dir) {
    const from = dir === 'back' ? past : future;
    const to = dir === 'back' ? future : past;
    let view = from.pop();
    const now = snapshot();
    while (view && sameView(view, now)) view = from.pop();
    if (!view) return 'no-history';
    to.push(now);
    takeOver('hand-history');
    camera().flyTo(view.position, {
      orientation: {
        heading: view.heading,
        pitch: view.pitch,
        roll: view.roll,
      },
      durationS: 0.9,
    });
    return dir;
  }

  // ---- local motions (pilot flight, throw) -------------------------------
  function stopLocal() {
    cruise = null;
    glide = null;
    expectedPos = null;
    if (loop) {
      cancelAnimationFrame(loop);
      loop = 0;
      releaseContinuousRender(RENDER_OWNER);
    }
  }

  /** Stop flights and voice/route motions; the hand now owns the camera. */
  function takeOver(reason = 'hand-control') {
    stopLocal();
    try {
      camera().cancelFlight();
    } catch {
      /* no flight */
    }
    interruptCameraMotion(reason);
  }

  // The mouse, a touch or the wheel on the map ends a hand flight or throw.
  const onManualInput = (event) => {
    if (event.isTrusted && (cruise || glide)) stopLocal();
  };
  const canvas = canvasOf(viewer);
  for (const type of ['pointerdown', 'wheel', 'touchstart'])
    canvas?.addEventListener(type, onManualInput, { passive: true });

  /** Slide the eye over the ground at its height (metres right/forward). */
  function slide(rightM, forwardM, heading = camera().pose().heading) {
    const pose = camera().pose();
    const east = rightM * Math.cos(heading) + forwardM * Math.sin(heading);
    const north = -rightM * Math.sin(heading) + forwardM * Math.cos(heading);
    const next = stepLonLat(pose.lon, pose.lat, east, north);
    camera().setView({
      destination: { lon: next.lon, lat: next.lat, height: pose.height },
      orientation: { heading, pitch: pose.pitch, roll: pose.roll },
    });
  }

  function pan(dx, dy, k) {
    const height = Math.max(20, camera().pose().height);
    // Grab semantics: the map follows the hand, so the eye moves opposite.
    slide(-dx * GAINS.pan * height * k, dy * GAINS.pan * height * k);
  }

  function tick(now) {
    loop = 0;
    if (!cruise && !glide) return;
    // Capped so a stalled tab does not jump, loose enough for a slow GPU.
    const dt = Math.min(0.25, Math.max(0, (now - lastLoopT) / 1000));
    lastLoopT = now;
    // Someone else moved the camera (voice, a flight, a layer): yield to it.
    if (expectedPos && distance(camera().pose().position, expectedPos) > 2) {
      stopLocal();
      return;
    }
    try {
      if (cruise && !busy()) {
        const pose = camera().pose();
        const height = Math.max(20, pose.height);
        const speed = Math.max(
          CRUISE.minMps,
          height * CRUISE.heightPerS * cruise.factor,
        );
        slide(
          0,
          speed * dt,
          pose.heading + cruise.steer * CRUISE.steerRate * dt,
        );
      } else if (cruise) {
        stopLocal();
        return;
      }
      if (glide) {
        const k = clamp(sensitivity(), 0.2, 3);
        pan(glide.vx * dt, glide.vy * dt, k);
        const decay = Math.exp(-dt / GLIDE.decayS);
        glide.vx *= decay;
        glide.vy *= decay;
        if (Math.hypot(glide.vx, glide.vy) < GLIDE.stopSpeed) glide = null;
      }
    } catch {
      stopLocal();
      return;
    }
    expectedPos = { ...camera().pose().position };
    requestRender();
    if (cruise || glide) loop = requestAnimationFrame(tick);
    else stopLocal();
  }

  function ensureLoop() {
    if (loop) return;
    lastLoopT = performance.now();
    expectedPos = { ...camera().pose().position };
    holdContinuousRender(RENDER_OWNER);
    loop = requestAnimationFrame(tick);
  }

  function startCruise() {
    record();
    takeOver('hand-pilot');
    cruise = {
      factor: 1,
      refFactor: 1,
      steer: 0,
      startedAt: performance.now(),
    };
    ensureLoop();
  }

  function steerCruise(pilot) {
    if (!cruise) return;
    if (!pilot) {
      cruise.steer = 0;
      return;
    }
    if (pilot.fresh) cruise.refFactor = cruise.factor;
    cruise.factor = clamp(
      cruise.refFactor * Math.exp(CRUISE.throttleGain * pilot.throttle),
      CRUISE.minFactor,
      CRUISE.maxFactor,
    );
    const lean = pilot.steer;
    cruise.steer =
      Math.abs(lean) < CRUISE.steerDead ? 0 : clamp(lean, -0.9, 0.9);
  }

  // ---- one-shot actions ---------------------------------------------------
  /** Back to the view the app starts from. */
  function flyHome() {
    record();
    takeOver('hand-home');
    camera().flyTo(
      { lon: START_VIEW.lon, lat: START_VIEW.lat, height: START_VIEW.height },
      {
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        durationS: 2,
      },
    );
  }

  function northUp() {
    const target = centerTarget();
    record();
    takeOver('hand-north');
    const pose = camera().pose();
    if (!target) {
      camera().flyTo(pose.position, {
        orientation: { heading: 0, pitch: pose.pitch, roll: 0 },
        durationS: 0.8,
      });
      return;
    }
    camera().flyToBounds(
      { center: target, radius: 0 },
      {
        offset: {
          heading: 0,
          pitch: pose.pitch,
          range: distance(pose.position, target),
        },
        durationS: 0.8,
      },
    );
  }

  function startOrbit(direction) {
    record();
    takeOver('hand-orbit');
    const result = moveCamera({
      motion: 'orbit',
      direction,
      mode: 'continuous',
      speed: 'slow',
    });
    return result?.ok === false ? 'no-target' : 'orbit';
  }

  function spinGlobe(direction) {
    takeOver('hand-globe');
    const result = moveCamera({
      motion: 'rotate_globe',
      direction,
      mode: 'continuous',
    });
    return result?.ok === false ? 'idle' : 'globe';
  }

  function dropPin() {
    const target = centerTarget();
    if (!target || typeof annotations?.annotate !== 'function')
      return 'no-target';
    const ground = toLonLatH(target);
    if (!ground) return 'no-target';
    void Promise.resolve(
      annotations.annotate(
        [
          {
            type: 'pin',
            manual: true,
            latitude: ground.lat,
            longitude: ground.lon,
            label: null,
            color: 'amber',
          },
        ],
        { persist: true, flyTo: false },
      ),
    ).catch(() => null);
    return 'pin';
  }

  /** Save the next drawn frame as a PNG download. */
  function screenshot() {
    const frame = findFrame(viewer);
    const target = canvasOf(viewer);
    if (!frame || !target) return 'idle';
    const off = frame.on('postRender', () => {
      off();
      target.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const stamp = new Date()
          .toISOString()
          .replace(/[:T]/g, '-')
          .slice(0, 19);
        link.href = url;
        link.download = `gev-${stamp}.png`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }, 'image/png');
    });
    frame.requestRender('hand-screenshot');
    return 'shot';
  }

  function sceneStep(dir) {
    const director = sceneDirector;
    const scene = director?._getSelectedScene?.();
    const shots = scene?.shots || [];
    if (!shots.length || typeof director.loadShot !== 'function')
      return 'no-scenes';
    const at = shots.findIndex((s) => s.id === director._selectedShotId);
    const next =
      (Math.max(0, at) + (dir === 'right' ? 1 : -1) + shots.length) %
      shots.length;
    stopLocal();
    void Promise.resolve(director.loadShot(scene.id, shots[next].id)).catch(
      () => null,
    );
    return 'scene';
  }

  /** A synthetic mouse click on the map at a screen spot (0..1). */
  function click(pos) {
    if (!canvas) return 'idle';
    const rect = canvas.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + pos.x * rect.width,
      clientY: rect.top + pos.y * rect.height,
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    };
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', { ...init, buttons: 1 }),
    );
    setTimeout(
      () =>
        canvas.dispatchEvent(
          new PointerEvent('pointerup', { ...init, buttons: 0 }),
        ),
      60,
    );
    return 'click';
  }

  // ---- imagery split line --------------------------------------------------
  function visibleSplitHandle() {
    for (const handle of document.querySelectorAll(
      '[id$="-split-line"] [role="slider"]',
    ))
      if (!handle.closest('[hidden]') && handle.offsetParent) return handle;
    return null;
  }
  const splitValue = (handle) =>
    Number(handle.getAttribute('aria-valuenow')) / 100;

  function moveSplit(handle, x) {
    let delta = x - splitValue(handle);
    for (let i = 0; i < 20 && Math.abs(delta) >= 0.01; i++) {
      const big = Math.abs(delta) >= 0.05;
      handle.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: delta > 0 ? 'ArrowRight' : 'ArrowLeft',
          shiftKey: big,
          bubbles: true,
          cancelable: true,
        }),
      );
      delta -= Math.sign(delta) * (big ? 0.05 : 0.01);
    }
  }

  /** Zoom (log factor), rotate (rad) and tilt (rad) about the centre target. */
  function orbit(zoomLog, dHeading, dPitch) {
    const cam = camera();
    const pose = cam.pose();
    const target = centerTarget();
    if (!target) {
      // Looking past the globe: plain dolly along the view.
      if (zoomLog) {
        const h = Math.max(20, pose.height);
        const step = h * (1 - Math.exp(-zoomLog));
        if (step > 0 && h < RANGE_MIN * 2) return;
        cam.setView(eyeMoved(pose, 'forward', step));
      }
      return;
    }
    const range = distance(pose.position, target);
    const nextRange = clamp(range * Math.exp(-zoomLog), RANGE_MIN, RANGE_MAX);
    // Only a tilt gesture clamps the pitch; zoom and rotate keep the view's own.
    let nextPitch = dPitch
      ? clamp(pose.pitch + dPitch, PITCH_MIN, PITCH_MAX)
      : pose.pitch;
    // Straight down, heading is undefined and a rotation would be lost.
    if (dHeading && nextPitch < PITCH_MIN) nextPitch = PITCH_MIN;
    cam.lookAt(target, {
      heading: pose.heading + dHeading,
      pitch: nextPitch,
      range: nextRange,
    });
    cam.release();
  }

  /**
   * Apply one interpreted frame.
   * @param {ReturnType<import('./gestures.js').GestureInterpreter['update']>} intent
   * @returns {string} What happened: 'moved' | 'idle' | 'busy' | 'stopped' |
   *   'home' | 'cruise' | 'orbit' | 'globe' | 'back' | 'forward' |
   *   'no-history' | 'pin' | 'north' | 'shot' | 'scene' | 'no-scenes' |
   *   'no-target' | 'click' | 'glide' | 'split'.
   */
  function apply(intent) {
    if (intent.stop) {
      splitHandle = null;
      takeOver('hand-stop');
      return 'stopped';
    }
    if (intent.click) return click(intent.click);
    if (intent.shot) {
      // The second hand of the frame may have started a flight a moment ago.
      if (cruise && performance.now() - cruise.startedAt < 2500) stopLocal();
      return screenshot();
    }
    if (intent.home) {
      if (busy()) return 'busy';
      flyHome();
      return 'home';
    }
    if (intent.pin) return dropPin();
    if (intent.cruiseStart) {
      if (busy()) return 'busy';
      startCruise();
      steerCruise(intent.pilot);
      return 'cruise';
    }
    if (intent.orbit) {
      if (busy()) return 'busy';
      return startOrbit(intent.orbit);
    }
    if (intent.northUp) {
      if (busy()) return 'busy';
      northUp();
      return 'north';
    }
    if (intent.swipe) {
      if (intent.swipe.pose === 'victory') return sceneStep(intent.swipe.dir);
      if (busy()) return 'busy';
      if (camera().pose().height > GLOBE_SWIPE_HEIGHT_M)
        return spinGlobe(intent.swipe.dir);
      return historyStep(intent.swipe.dir === 'left' ? 'back' : 'forward');
    }
    steerCruise(intent.pilot);
    if (intent.release && !splitHandle) {
      const { dx, dy, dt } = intent.release;
      const seconds = Math.max(0.016, dt / 1000);
      const vx = dx / seconds;
      const vy = dy / seconds;
      if (Math.hypot(vx, vy) > GLIDE.minSpeed && !busy()) {
        glide = { vx, vy };
        ensureLoop();
        return 'glide';
      }
    }
    if (!intent.grabbing && !intent.grabStart) {
      splitHandle = null;
      if (cruise) return 'cruise';
      if (glide) return 'glide';
      return 'idle';
    }
    if (busy()) return 'busy';
    if (intent.grabStart) {
      record();
      takeOver();
      const handle = intent.twoHands ? null : visibleSplitHandle();
      splitHandle =
        handle &&
        intent.grip &&
        Math.abs(intent.grip.x - splitValue(handle)) < 0.07
          ? handle
          : null;
    }
    if (splitHandle) {
      if (intent.grip) moveSplit(splitHandle, intent.grip.x);
      return 'split';
    }
    const k = clamp(sensitivity(), 0.2, 3);
    const { dx, dy } = intent.pan;
    const zoomGain = intent.twoHands ? GAINS.zoom2 : GAINS.zoom;
    const zoomLog = intent.zoom * zoomGain * k;
    // Mirror view: clockwise hand → clockwise map → camera heading decreases.
    const dHeading = -intent.rotate * GAINS.rotate * k;
    // Both hands up → look toward the horizon.
    const dPitch = -intent.tilt * GAINS.tilt * k;
    let moved = false;
    try {
      if (dx || dy) {
        pan(dx, dy, k);
        moved = true;
      }
      if (zoomLog || dHeading || dPitch) {
        orbit(zoomLog, dHeading, dPitch);
        moved = true;
      }
    } catch {
      return 'idle'; // teardown race or degenerate pose
    }
    if (moved) requestRender();
    return moved ? 'moved' : 'idle';
  }

  /** What the hand-driven motions are doing now, for the status line. */
  function state() {
    return {
      cruising: Boolean(cruise),
      speed: cruise ? cruiseSpeedName(cruise.factor) : null,
      turning: cruise ? Math.sign(cruise.steer) : 0,
      gliding: Boolean(glide),
    };
  }

  function destroy() {
    stopLocal();
    for (const type of ['pointerdown', 'wheel', 'touchstart'])
      canvas?.removeEventListener(type, onManualInput);
  }

  return { apply, takeOver, flyHome, state, destroy, stopLocal };
}
