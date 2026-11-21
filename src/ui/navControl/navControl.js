/**
 * Owner of the on-screen map navigation control (Google Earth style): a
 * compass ring that shows and drags the heading, a north-up button, a tilt
 * slider with up/down and top-down buttons, zoom in/out with press-and-hold
 * repeat, and a small look-around pad.
 *
 * The control itself is the `NavControl` view (src/ui/views/panels) over the
 * `gev-nav-control` store. This module owns no DOM: it subscribes to the
 * camera, publishes the heading, tilt and follow state to the store, and
 * answers the view's actions through the store.
 *
 * The control orbits the camera around the point under the middle of the
 * screen. It reuses the orbit-frame helpers of the existing tilt/north buttons
 * (`readCameraTargetFrame`/`setCameraTargetFrame`), so the target is the picked
 * tile or terrain point and falls back to the ellipsoid. Every action goes
 * through the shell's navigation policy (`runNavigation`), which refuses while
 * the cockpit owns the camera and releases follow/orbit motion first.
 */
import {
  followedOf,
  followedPosition,
  isFollowing,
  onFollowChanged,
} from '../../data/followed.js';
import {
  clamp,
  distance,
  eastNorthUp,
  framePoint,
  inverseFramePoint,
  magnitude,
  toLonLatH,
  toRadians,
} from '../../geo/index.js';
import { eyeZoomed } from '../../geo/eyeMoves.js';
import { heightsOf } from '../../queries/heights.js';
import {
  canvasOf,
  findCamera,
  findFrame,
  findQuery,
} from '../../render/rendererOf.js';
import {
  readCameraTargetFrame,
  setCameraTargetFrame,
} from '../cameraOrientationControls.js';
import {
  clampPitch,
  easeInOut,
  headingDegrees,
  headingFromDrag,
  liftPitchForClearance,
  normalizeHeading,
  planAction,
  planLook,
  pitchToTiltDeg,
  pointerAngle,
  shortestTurn,
  tiltDegToPitch,
  TOP_DOWN_PITCH,
  ZOOM_FRACTION,
} from './navMath.js';

/**
 * A centre pick can come back wild while tiles are still streaming (a far
 * tile, a depth glitch): seen 13 km below the ellipsoid at a 27 km range from
 * a camera 600 m up. Zooming a fraction of such a range flies the camera under
 * the ground, so a target outside the plausible surface band is not trusted.
 */
export const MIN_TARGET_HEIGHT_M = -1500;
export const MAX_TARGET_HEIGHT_M = 25_000;

const STEP_ANIMATION_MS = 220;
const FIRST_REPEAT_MS = 380;
const REPEAT_MS = 130;
/**
 * How long the camera must stay still after a move before the tilt is read
 * exactly. The exact read picks the globe at the screen centre, which can read
 * the depth buffer and force a frame, so it waits out the arrival work other
 * camera observers do right after `moveEnd`.
 */
export const TILT_IDLE_MS = 1500;
const mounted = new WeakMap();

const REPEATING = new Set([
  'zoom-in',
  'zoom-out',
  'tilt-up',
  'tilt-down',
  'look-left',
  'look-right',
  'look-up',
  'look-down',
]);
const RING_KEYS = {
  ArrowLeft: 'rotate-left',
  ArrowDown: 'rotate-left',
  ArrowRight: 'rotate-right',
  ArrowUp: 'rotate-right',
  Home: 'north',
};
const LOOK_ACTIONS = new Set([
  'look-left',
  'look-right',
  'look-up',
  'look-down',
]);

/** Where the camera sits for an orbit view of `target`. */
export function orbitCameraPosition(target, { heading, pitch, range }) {
  const east = range * -Math.sin(heading) * Math.cos(pitch);
  const north = range * -Math.cos(heading) * Math.cos(pitch);
  const up = range * -Math.sin(pitch);
  return framePoint(eastNorthUp(target), { x: east, y: north, z: up });
}

/** Whether a picked world position sits in the band the surface can occupy. */
export function plausibleTarget(target) {
  const height = target ? toLonLatH(target)?.height : null;
  return Boolean(
    Number.isFinite(height) &&
    height >= MIN_TARGET_HEIGHT_M &&
    height <= MAX_TARGET_HEIGHT_M,
  );
}

/**
 * The orbit frame of a camera pose (`{position, heading}`) around `target`, in
 * the same terms as upstream.
 */
export function frameForTarget(pose, target) {
  const local = inverseFramePoint(eastNorthUp(target), pose.position);
  const range = magnitude(local);
  if (!Number.isFinite(range) || range < 1) return null;
  const pitch = -Math.asin(clamp(local.z / range, -1, 1));
  const heading =
    pitch < toRadians(-88.5) ? pose.heading : Math.atan2(-local.x, -local.y);
  return { target, range, heading: normalizeHeading(heading), pitch };
}

function tracked(viewer) {
  return followedPosition(viewer, followedOf(viewer));
}

/**
 * Ease an orbit view toward a destination, re-aiming from wherever the last
 * step has got to so chained presses accumulate instead of restarting.
 */
function createOrbitAnimator(viewer, { now, onSettled }) {
  let remove = null;
  let state = null;

  const cancel = () => {
    remove?.();
    remove = null;
    state = null;
  };

  function current() {
    if (!state) return null;
    return state.shown;
  }

  function animate(frame, to, duration = STEP_ANIMATION_MS) {
    const from = state?.shown || {
      heading: frame.heading,
      pitch: frame.pitch,
      range: frame.range,
    };
    const target = state?.frame || frame;
    cancel();
    const followed = followedOf(viewer);
    const apply = (view, aim) =>
      setCameraTargetFrame(viewer, { ...target, target: aim, ...view });
    const frames = findFrame(viewer);
    if (duration <= 0 || !frames) {
      const done = apply(to, target.target);
      if (done) onSettled?.(to);
      return done;
    }
    state = {
      frame: target,
      to,
      shown: from,
      lastPosition: null,
    };
    const start = now();
    const turn = shortestTurn(from.heading, to.heading);
    remove = frames.on('preUpdate', () => {
      const camera = findCamera(viewer);
      if (
        !camera ||
        viewer.isDestroyed?.() ||
        followedOf(viewer) !== followed
      ) {
        cancel();
        return;
      }
      // Someone else (a flight, a search, a drag) moved the camera since the
      // last step: they own it now, so stop instead of pulling it back.
      if (state?.lastPosition && !followed) {
        const moved = distance(camera.pose().position, state.lastPosition);
        if (moved > Math.max(1, state.shown.range * 1e-3)) {
          cancel();
          return;
        }
      }
      const progress = Math.min(1, Math.max(0, (now() - start) / duration));
      const eased = easeInOut(progress);
      const aim = followed ? tracked(viewer) : target.target;
      const view = {
        heading: normalizeHeading(from.heading + turn * eased),
        pitch: from.pitch + (to.pitch - from.pitch) * eased,
        range: from.range * Math.pow(to.range / from.range, eased),
      };
      if (!aim || !apply(view, aim)) {
        cancel();
        return;
      }
      state.shown = view;
      state.lastPosition = camera.pose().position;
      if (progress === 1) {
        const settled = state.to;
        cancel();
        onSettled?.(settled);
      }
    });
    frames.requestRender('nav-control');
    return true;
  }

  return {
    animate,
    cancel,
    get active() {
      return Boolean(state);
    },
    get destination() {
      return state?.to || null;
    },
    get frame() {
      return state?.frame || null;
    },
    current,
  };
}

/**
 * Answer the navigation control's actions for one viewer.
 * @param {Object} options
 * @param {Object} options.viewer The scene object the shell holds (the camera,
 *   frame and query ports are reached through it).
 * @param {{connect: Function, detach: Function, publish: Function}} options.store
 *   The `gev-nav-control` store the view renders and calls.
 * @param {Function} [options.runNavigation] `(noun, navigate) => result`; the
 *   shell's explicit-navigation policy. Defaults to calling `navigate()`.
 * @param {Function} [options.now] Millisecond clock (tests inject one).
 * @param {Object} [options.timers] `{setTimeout, clearTimeout}` (tests inject).
 * @returns {{perform: Function, refresh: Function, destroy: Function, destroyed: boolean}}
 */
export function mountNavControl({
  viewer,
  store,
  runNavigation = (_noun, navigate) => navigate(),
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  timers = globalThis,
} = {}) {
  const camera = findCamera(viewer);
  const frames = findFrame(viewer);
  if (!camera || !frames)
    throw new TypeError('A viewer with a camera and scene is required');
  if (!store?.connect || !store?.publish)
    throw new TypeError('The navigation control store is required');
  const existing = mounted.get(viewer);
  if (existing && !existing.destroyed) return existing;

  const removers = [];
  let destroyed = false;
  // What the view shows; `sent` is false until the first publish.
  let published = {
    heading: 0,
    tilt: 0,
    following: false,
    dragging: false,
    sent: false,
  };
  let sliderDragging = false;
  let deferredTilt = null;
  let hold = null;
  let drag = null;
  let token = null;

  const animator = createOrbitAnimator(viewer, {
    now,
    onSettled: () => refreshTilt(),
  });

  /** Height of the camera over the surface for an orbit pitch, or NaN. */
  const clearanceProbe = (frame, view) => (pitch) => {
    try {
      const position = orbitCameraPosition(frame.target, { ...view, pitch });
      const carto = toLonLatH(position);
      if (!carto) return Number.NaN;
      const heights = heightsOf(viewer);
      const at = { lon: carto.lon, lat: carto.lat };
      const ground = heights.now(at) ?? heights.now(at, { against: 'terrain' });
      return Number.isFinite(ground) ? carto.height - ground : Number.NaN;
    } catch {
      return Number.NaN;
    }
  };

  /**
   * Orbit frame around the screen centre. A followed entity is trusted as is;
   * otherwise a wild pick falls back to the ellipsoid under the centre, and
   * a view with no ground in it (the sky) has no frame.
   */
  const readFrame = () => {
    const frame = readCameraTargetFrame(viewer);
    if (frame && (isFollowing(viewer) || plausibleTarget(frame.target)))
      return frame;
    try {
      const canvas = canvasOf(viewer);
      const ground = findQuery(viewer)?.pickEllipsoid(
        (canvas.clientWidth || canvas.width) / 2,
        (canvas.clientHeight || canvas.height) / 2,
      );
      return ground ? frameForTarget(camera.pose(), ground) : null;
    } catch {
      return null;
    }
  };

  /** Keep the camera in place and change where it looks (also the no-target fallback). */
  const lookInPlace = (heading, pitch) => {
    try {
      camera.setView({
        destination: camera.pose().position,
        orientation: { heading, pitch, roll: 0 },
      });
      frames.requestRender('nav-control');
      return true;
    } catch {
      return false;
    }
  };

  /** One discrete action; returns whether the camera accepted it. */
  function perform(action) {
    const result = runNavigation('camera', () => {
      if (LOOK_ACTIONS.has(action)) {
        if (isFollowing(viewer)) return false;
        animator.cancel();
        const pose = camera.pose();
        const next = planLook(
          { heading: pose.heading, pitch: pose.pitch },
          action,
        );
        return lookInPlace(next.heading, next.pitch);
      }
      const pending = animator.active ? animator.destination : null;
      const frame = animator.active ? animator.frame : readFrame();
      if (!frame) return performWithoutTarget(action);
      const base = pending || frame;
      const plan = planAction(base, action);
      if (plan.pitch > TOP_DOWN_PITCH) {
        plan.pitch = liftPitchForClearance(
          plan.pitch,
          clearanceProbe(frame, plan),
        );
      }
      return animator.animate(
        frame,
        { heading: plan.heading, pitch: plan.pitch, range: plan.range },
        action === 'top-down' || action === 'north' ? 650 : STEP_ANIMATION_MS,
      );
    });
    refreshHeading();
    return Boolean(result);
  }

  /** No pick, no ellipsoid hit (looking at the sky): turn or move in place. */
  function performWithoutTarget(action) {
    const pose = camera.pose();
    const heading = pose.heading;
    const pitch = Number.isFinite(pose.pitch) ? pose.pitch : TOP_DOWN_PITCH;
    switch (action) {
      case 'zoom-in':
      case 'zoom-out': {
        const height = Math.max(1, Number(pose.height) || 1_000);
        const amount = height * ZOOM_FRACTION;
        camera.setView(
          eyeZoomed(pose, action === 'zoom-in' ? amount : -amount),
        );
        frames.requestRender('nav-control');
        return true;
      }
      case 'north':
        return lookInPlace(0, pitch);
      case 'top-down':
        return lookInPlace(heading, -Math.PI / 2);
      case 'tilt-up':
      case 'tilt-down':
      case 'rotate-left':
      case 'rotate-right': {
        const next = planAction({ heading, pitch, range: 1_000 }, action);
        return lookInPlace(next.heading, next.pitch);
      }
      default:
        return false;
    }
  }

  // ── press-and-hold ───────────────────────────────────────────────────
  function stopHold() {
    if (!hold) return;
    timers.clearTimeout(hold.timeout);
    timers.clearInterval?.(hold.interval);
    hold = null;
  }
  function startHold(action) {
    stopHold();
    perform(action);
    if (!REPEATING.has(action)) return;
    const token = {};
    hold = token;
    token.timeout = timers.setTimeout(() => {
      if (hold !== token) return;
      token.interval = timers.setInterval(() => {
        if (hold !== token || destroyed) return;
        perform(action);
      }, REPEAT_MS);
    }, FIRST_REPEAT_MS);
  }

  /** Show the view the control renders; an unchanged view sends nothing. */
  function present(change) {
    if (destroyed) return;
    const next = { ...published, ...change, sent: true };
    if (
      published.sent &&
      next.heading === published.heading &&
      next.tilt === published.tilt &&
      next.following === published.following &&
      next.dragging === published.dragging
    )
      return;
    published = next;
    store.publish(token, {
      heading: next.heading,
      tilt: next.tilt,
      following: next.following,
      dragging: next.dragging,
    });
  }

  // ── actions the view calls through the store ──────────────────────────
  /** A pointer press on a button: act now, and repeat while it is held. */
  const press = (action) => startHold(action);
  /** Keyboard activation (a click with no pointer); pointer clicks acted on press. */
  const activate = (action) => perform(action);

  /** Begin dragging the compass ring; false when the camera refuses. */
  function ringStart({ centerX, centerY, clientX, clientY }) {
    const result = runNavigation('camera', () => {
      animator.cancel();
      return readFrame() || { fallback: true, heading: camera.pose().heading };
    });
    if (!result) return false;
    drag = {
      frame: result.fallback ? null : result,
      centerX,
      centerY,
      startHeading: result.heading,
      pitch: result.fallback ? camera.pose().pitch : result.pitch,
      startAngle: pointerAngle(centerX, centerY, clientX, clientY),
    };
    present({ dragging: true });
    return true;
  }
  function ringMove({ clientX, clientY }) {
    if (!drag) return;
    const heading = headingFromDrag({
      startHeading: drag.startHeading,
      startAngle: drag.startAngle,
      angle: pointerAngle(drag.centerX, drag.centerY, clientX, clientY),
    });
    // Pointer capture can outlive the camera's owner (the Cockpit opening
    // mid-drag), so every move asks the navigation policy again, as the tilt
    // slider does. A refusal ends the drag; only a new press can start one.
    const accepted = runNavigation('camera', () =>
      drag.frame
        ? setCameraTargetFrame(viewer, { ...drag.frame, heading })
        : lookInPlace(heading, drag.pitch),
    );
    if (!accepted) {
      ringEnd();
      return;
    }
    refreshHeading();
  }
  function ringEnd() {
    if (!drag) return;
    drag = null;
    present({ dragging: false });
    refreshTilt();
  }
  /** @returns {boolean} Whether the key was one the ring answers. */
  function ringKey(key) {
    const action = RING_KEYS[key];
    if (!action) return false;
    perform(action);
    return true;
  }

  function sliderStart() {
    sliderDragging = true;
  }
  function sliderEnd() {
    sliderDragging = false;
    refreshTilt();
  }
  function sliderInput(value) {
    const pitchWanted = tiltDegToPitch(Number(value));
    runNavigation('camera', () => {
      const frame = animator.active ? animator.frame : readFrame();
      if (!frame) return lookInPlace(camera.pose().heading, pitchWanted);
      const heading = animator.destination?.heading ?? frame.heading;
      const range = animator.destination?.range ?? frame.range;
      animator.cancel();
      let pitch = clampPitch(pitchWanted, range);
      if (pitch > TOP_DOWN_PITCH)
        pitch = liftPitchForClearance(
          pitch,
          clearanceProbe(frame, { heading, range, pitch }),
        );
      return setCameraTargetFrame(viewer, { ...frame, heading, range, pitch });
    });
    // The handle shows what the person asked for until the gesture ends.
    present({ tilt: Math.round(Number(value)) });
    refreshHeading();
  }

  // ── state shown on the control ───────────────────────────────────────
  function refreshHeading() {
    present({ heading: headingDegrees(camera.pose().heading) });
  }
  /** Exact tilt costs one depth read, so it refreshes once per gesture. */
  function refreshTilt() {
    if (destroyed || sliderDragging) return;
    const frame = animator.active ? null : readFrame();
    const pitch = frame ? frame.pitch : camera.pose().pitch;
    present({
      tilt: pitchToTiltDeg(pitch),
      following: isFollowing(viewer),
    });
  }

  token = store.connect({
    press,
    release: stopHold,
    activate,
    ringStart,
    ringMove,
    ringEnd,
    ringKey,
    sliderStart,
    sliderInput,
    sliderEnd,
  });
  const subscribe = (remove) => {
    if (typeof remove === 'function') removers.push(remove);
  };
  subscribe(frames.on('preRender', refreshHeading));
  // The exact tilt costs a target pick, which may read the depth buffer. Do not
  // spend it inside `moveEnd`, nor in the frames that follow while other
  // observers re-aim: wait until the camera has been still for TILT_IDLE_MS,
  // and restart the wait on every further camera move.
  subscribe(
    camera.on('moveEnd', () => {
      if (deferredTilt !== null) timers.clearTimeout(deferredTilt);
      deferredTilt = timers.setTimeout(() => {
        deferredTilt = null;
        refreshTilt();
      }, TILT_IDLE_MS);
    }),
  );
  subscribe(
    onFollowChanged(viewer, () => {
      animator.cancel();
      refreshTilt();
    }),
  );
  // A gesture on the globe supersedes a step still easing: the animator
  // stops as soon as the camera has been moved by anything but itself.
  published.heading = headingDegrees(camera.pose().heading);
  refreshTilt(); // the first publish

  const handle = {
    perform,
    refresh() {
      refreshHeading();
      refreshTilt();
    },
    get destroyed() {
      return destroyed;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (deferredTilt !== null) timers.clearTimeout(deferredTilt);
      deferredTilt = null;
      stopHold();
      animator.cancel();
      for (const remove of removers.splice(0)) remove();
      store.detach(token);
      mounted.delete(viewer);
    },
  };
  mounted.set(viewer, handle);
  return handle;
}
