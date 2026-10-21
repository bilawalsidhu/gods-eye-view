/**
 * On-screen map navigation control (Google Earth style): a compass ring that
 * shows and drags the heading, a north-up button, a tilt slider with up/down
 * and top-down buttons, zoom in/out with press-and-hold repeat, and a small
 * look-around pad.
 *
 * The control orbits the camera around the point under the middle of the
 * screen. It reuses the orbit-frame helpers of the existing tilt/north buttons
 * (`readCameraTargetFrame`/`setCameraTargetFrame`), so the target is the picked
 * tile or terrain point and falls back to the ellipsoid. Every action goes
 * through the shell's navigation policy (`runNavigation`), which refuses while
 * the cockpit owns the camera and releases follow/orbit motion first.
 */
import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import {
  readCameraTargetFrame,
  setCameraTargetFrame,
} from '../cameraOrientationControls.js';
import {
  TILT_SPAN_DEG,
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

const ROOT_ATTRIBUTE = 'data-gev-nav-control';
const STEP_ANIMATION_MS = 220;
const FIRST_REPEAT_MS = 380;
const REPEAT_MS = 130;
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
const LOOK_ACTIONS = new Set([
  'look-left',
  'look-right',
  'look-up',
  'look-down',
]);

const LABELS = {
  'zoom-in': msg('Zoom in'),
  'zoom-out': msg('Zoom out'),
  'tilt-up': msg('Tilt up toward the horizon'),
  'tilt-down': msg('Tilt down toward top-down view'),
  'top-down': msg('Top-down view'),
  'look-left': msg('Look left'),
  'look-right': msg('Look right'),
  'look-up': msg('Look up'),
  'look-down': msg('Look down'),
};
const GLYPHS = {
  'zoom-in': '+',
  'zoom-out': '\u2212',
  'tilt-up': '\u25B2',
  'tilt-down': '\u25BC',
  'top-down': 'TOP',
  'look-left': '\u25C0',
  'look-right': '\u25B6',
  'look-up': '\u25B2',
  'look-down': '\u25BC',
};

/** Where the camera sits for an orbit view of `target`. */
export function orbitCameraPosition(target, { heading, pitch, range }) {
  const east = range * -Math.sin(heading) * Math.cos(pitch);
  const north = range * -Math.cos(heading) * Math.cos(pitch);
  const up = range * -Math.sin(pitch);
  return Cesium.Matrix4.multiplyByPoint(
    Cesium.Transforms.eastNorthUpToFixedFrame(target),
    new Cesium.Cartesian3(east, north, up),
    new Cesium.Cartesian3(),
  );
}

/** Whether a picked world position sits in the band the surface can occupy. */
export function plausibleTarget(target) {
  const carto = target && Cesium.Cartographic.fromCartesian(target);
  return Boolean(
    carto &&
    carto.height >= MIN_TARGET_HEIGHT_M &&
    carto.height <= MAX_TARGET_HEIGHT_M,
  );
}

/** The orbit frame of a camera around `target`, in the same terms as upstream. */
export function frameForTarget(camera, target) {
  const inverse = Cesium.Matrix4.inverseTransformation(
    Cesium.Transforms.eastNorthUpToFixedFrame(target),
    new Cesium.Matrix4(),
  );
  const local = Cesium.Matrix4.multiplyByPoint(
    inverse,
    camera.positionWC,
    new Cesium.Cartesian3(),
  );
  const range = Cesium.Cartesian3.magnitude(local);
  if (!Number.isFinite(range) || range < 1) return null;
  const pitch = -Math.asin(Cesium.Math.clamp(local.z / range, -1, 1));
  const heading =
    pitch < Cesium.Math.toRadians(-88.5)
      ? camera.heading
      : Math.atan2(-local.x, -local.y);
  return { target, range, heading: normalizeHeading(heading), pitch };
}

function tracked(viewer) {
  const entity = viewer.trackedEntity;
  if (!entity) return null;
  return (
    entity.gevDisplayPosition?.() ||
    entity.position?.getValue(viewer.clock?.currentTime) ||
    null
  );
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
    const entity = viewer.trackedEntity;
    const apply = (view, aim) =>
      setCameraTargetFrame(viewer, { ...target, target: aim, ...view });
    if (duration <= 0 || !viewer.scene?.preUpdate?.addEventListener) {
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
    remove = viewer.scene.preUpdate.addEventListener(() => {
      if (viewer.isDestroyed?.() || viewer.trackedEntity !== entity) {
        cancel();
        return;
      }
      // Someone else (a flight, a search, a drag) moved the camera since the
      // last step: they own it now, so stop instead of pulling it back.
      if (state?.lastPosition && !entity) {
        const moved = Cesium.Cartesian3.distance(
          viewer.camera.positionWC,
          state.lastPosition,
        );
        if (moved > Math.max(1, state.shown.range * 1e-3)) {
          cancel();
          return;
        }
      }
      const progress = Math.min(1, Math.max(0, (now() - start) / duration));
      const eased = easeInOut(progress);
      const aim = entity ? tracked(viewer) : target.target;
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
      state.lastPosition = Cesium.Cartesian3.clone(viewer.camera.positionWC);
      if (progress === 1) {
        const settled = state.to;
        cancel();
        onSettled?.(settled);
      }
    });
    viewer.scene.requestRender?.();
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

function build(doc) {
  const make = (tag, className, attributes = {}, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    for (const [name, value] of Object.entries(attributes))
      node.setAttribute(name, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (action, className) =>
    make(
      'button',
      `gev-nav-btn ${className}`,
      {
        type: 'button',
        'data-nav': action,
        'aria-label': t(LABELS[action]),
        title: t(LABELS[action]),
      },
      GLYPHS[action],
    );

  const root = make('section', 'gev-nav', {
    [ROOT_ATTRIBUTE]: '',
    id: 'gev-nav-control',
    role: 'group',
    'aria-label': t('Map navigation'),
  });

  const tilt = make('div', 'gev-nav-tilt');
  const tiltUp = button('tilt-up', 'gev-nav-tilt-up');
  const slider = make('input', 'gev-nav-slider', {
    type: 'range',
    min: 0,
    max: TILT_SPAN_DEG,
    step: 1,
    value: 0,
    'data-nav': 'tilt-slider',
    'aria-label': t('Tilt'),
    'aria-orientation': 'vertical',
    title: t('Tilt: top-down (bottom) to near horizon (top)'),
  });
  const tiltDown = button('tilt-down', 'gev-nav-tilt-down');
  tilt.append(tiltUp, slider, tiltDown);

  const compass = make('div', 'gev-nav-compass');
  const dial = make('div', 'gev-nav-dial', {
    'data-nav': 'ring',
    role: 'slider',
    tabindex: 0,
    'aria-label': t(
      'Map heading. Drag to rotate, arrow keys turn, Home for north',
    ),
    'aria-valuemin': 0,
    'aria-valuemax': 359,
    'aria-valuenow': 0,
    'aria-valuetext': t('North, 0 degrees'),
  });
  const mark = make('span', 'gev-nav-dial-mark', { 'aria-hidden': 'true' });
  dial.append(mark);
  const north = make(
    'button',
    'gev-nav-btn gev-nav-north',
    {
      type: 'button',
      'data-nav': 'north',
      'aria-label': t(
        'Reset map to north up. Current heading {heading} degrees',
        {
          heading: 0,
        },
      ),
      title: t('North up'),
    },
    'N',
  );
  const look = make('div', 'gev-nav-look', {
    role: 'group',
    'aria-label': t('Look around'),
  });
  look.append(
    button('look-up', 'gev-nav-look-up'),
    button('look-left', 'gev-nav-look-left'),
    button('look-right', 'gev-nav-look-right'),
    button('look-down', 'gev-nav-look-down'),
  );
  compass.append(dial, look, north);

  const zoom = make('div', 'gev-nav-zoom');
  zoom.append(
    button('zoom-in', 'gev-nav-zoom-in'),
    button('zoom-out', 'gev-nav-zoom-out'),
    button('top-down', 'gev-nav-top-down'),
  );

  root.append(tilt, compass, zoom);
  return { root, dial, north, slider, look };
}

/**
 * Mount the control once per viewer.
 * @param {Object} options
 * @param {Cesium.Viewer} options.viewer Live viewer.
 * @param {HTMLElement} [options.parent] Mount point (default `document.body`).
 * @param {Document} [options.document] Document used to build the DOM.
 * @param {Function} [options.runNavigation] `(noun, navigate) => result`; the
 *   shell's explicit-navigation policy. Defaults to calling `navigate()`.
 * @param {Function} [options.showToast] Operator-visible message.
 * @param {Function} [options.now] Millisecond clock (tests inject one).
 * @param {Object} [options.timers] `{setTimeout, clearTimeout}` (tests inject).
 */
export function mountNavControl({
  viewer,
  parent,
  document: doc = globalThis.document,
  runNavigation = (_noun, navigate) => navigate(),
  showToast,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  timers = globalThis,
} = {}) {
  if (!viewer?.camera || !viewer?.scene)
    throw new TypeError('A viewer with a camera and scene is required');
  const existing = mounted.get(viewer);
  if (existing && !existing.destroyed) return existing;

  const host = parent || doc?.body;
  if (!host || !doc) throw new TypeError('A document and parent are required');
  const { root, dial, north, slider } = build(doc);
  host.append(root);

  const removers = [];
  let destroyed = false;
  let applied = null;
  let sliderDragging = false;
  let hold = null;
  let drag = null;

  const camera = viewer.camera;
  const animator = createOrbitAnimator(viewer, {
    now,
    onSettled: () => refreshTilt(),
  });

  const listen = (target, type, handler, options) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    removers.push(() => target.removeEventListener(type, handler, options));
  };
  const subscribe = (event, handler) => {
    const remove = event?.addEventListener?.(handler);
    if (typeof remove === 'function') removers.push(remove);
  };

  /** Height of the camera over the surface for an orbit pitch, or NaN. */
  const clearanceProbe = (frame, view) => (pitch) => {
    try {
      const position = orbitCameraPosition(frame.target, { ...view, pitch });
      const carto = Cesium.Cartographic.fromCartesian(position);
      if (!carto) return Number.NaN;
      let ground = viewer.scene.sampleHeight?.(carto);
      if (!Number.isFinite(ground))
        ground = viewer.scene.globe?.getHeight?.(carto);
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
    if (frame && (viewer.trackedEntity || plausibleTarget(frame.target)))
      return frame;
    try {
      const canvas = viewer.scene.canvas;
      const centre = new Cesium.Cartesian2(
        (canvas.clientWidth || canvas.width) / 2,
        (canvas.clientHeight || canvas.height) / 2,
      );
      const ground = camera.pickEllipsoid(centre, Cesium.Ellipsoid.WGS84);
      return ground ? frameForTarget(camera, ground) : null;
    } catch {
      return null;
    }
  };

  /** Keep the camera in place and change where it looks (also the no-target fallback). */
  const lookInPlace = (heading, pitch) => {
    try {
      camera.setView({
        destination: Cesium.Cartesian3.clone(camera.positionWC),
        orientation: { heading, pitch, roll: 0 },
      });
      viewer.scene.requestRender?.();
      return true;
    } catch {
      return false;
    }
  };

  /** One discrete action; returns whether the camera accepted it. */
  function perform(action) {
    const result = runNavigation('camera', () => {
      if (LOOK_ACTIONS.has(action)) {
        if (viewer.trackedEntity) return false;
        animator.cancel();
        const next = planLook(
          { heading: camera.heading, pitch: camera.pitch },
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
    const heading = camera.heading;
    const pitch = Number.isFinite(camera.pitch) ? camera.pitch : TOP_DOWN_PITCH;
    switch (action) {
      case 'zoom-in':
      case 'zoom-out': {
        const height = Math.max(
          1,
          Number(camera.positionCartographic?.height) || 1_000,
        );
        const amount = height * ZOOM_FRACTION;
        if (action === 'zoom-in') camera.zoomIn?.(amount);
        else camera.zoomOut?.(amount);
        viewer.scene.requestRender?.();
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

  for (const node of root.querySelectorAll?.('[data-nav]') || []) {
    const action = node.getAttribute('data-nav');
    if (action === 'ring' || action === 'tilt-slider') continue;
    const act = action === 'north' ? 'north' : action;
    listen(node, 'pointerdown', (event) => {
      if (event.button > 0) return;
      startHold(act);
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave'])
      listen(node, type, stopHold);
    // Keyboard activation arrives as a click with no pointer (detail 0).
    // Pointer clicks were already handled on pointerdown.
    listen(node, 'click', (event) => {
      if (event.detail) return;
      perform(act);
    });
  }
  listen(globalThis, 'blur', stopHold);

  // ── compass ring: drag to rotate, arrows turn, Home is north ───────────
  listen(dial, 'pointerdown', (event) => {
    if (event.button > 0) return;
    const rect = dial.getBoundingClientRect?.();
    if (!rect || !rect.width) return;
    const result = runNavigation('camera', () => {
      animator.cancel();
      return readFrame() || { fallback: true, heading: camera.heading };
    });
    if (!result) return;
    drag = {
      frame: result.fallback ? null : result,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      startHeading: result.heading,
      pitch: result.fallback ? camera.pitch : result.pitch,
      startAngle: pointerAngle(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        event.clientX,
        event.clientY,
      ),
    };
    try {
      dial.setPointerCapture?.(event.pointerId);
    } catch {
      /* synthetic pointer */
    }
    root.setAttribute('data-dragging', 'ring');
  });
  listen(dial, 'pointermove', (event) => {
    if (!drag) return;
    const heading = headingFromDrag({
      startHeading: drag.startHeading,
      startAngle: drag.startAngle,
      angle: pointerAngle(
        drag.centerX,
        drag.centerY,
        event.clientX,
        event.clientY,
      ),
    });
    if (drag.frame) setCameraTargetFrame(viewer, { ...drag.frame, heading });
    else lookInPlace(heading, drag.pitch);
    refreshHeading();
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    root.removeAttribute('data-dragging');
    refreshTilt();
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
    listen(dial, type, endDrag);
  listen(dial, 'keydown', (event) => {
    const map = {
      ArrowLeft: 'rotate-left',
      ArrowDown: 'rotate-left',
      ArrowRight: 'rotate-right',
      ArrowUp: 'rotate-right',
      Home: 'north',
    };
    const action = map[event.key];
    if (!action) return;
    event.preventDefault?.();
    perform(action);
  });

  // ── tilt slider ──────────────────────────────────────────────────────
  listen(slider, 'pointerdown', () => {
    sliderDragging = true;
  });
  for (const type of ['pointerup', 'pointercancel', 'blur'])
    listen(slider, type, () => {
      sliderDragging = false;
      refreshTilt();
    });
  listen(slider, 'input', () => {
    const pitchWanted = tiltDegToPitch(Number(slider.value));
    runNavigation('camera', () => {
      const frame = animator.active ? animator.frame : readFrame();
      if (!frame) return lookInPlace(camera.heading, pitchWanted);
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
    refreshHeading();
  });

  // ── state shown on the control ───────────────────────────────────────
  function refreshHeading() {
    if (destroyed) return;
    const heading = headingDegrees(camera.heading);
    if (applied?.heading === heading) return;
    applied = { ...applied, heading };
    root.style.setProperty('--gev-nav-heading', `${heading}deg`);
    root.setAttribute('data-north-up', String(heading === 0));
    dial.setAttribute('aria-valuenow', String(heading));
    dial.setAttribute(
      'aria-valuetext',
      heading === 0
        ? t('North, 0 degrees')
        : t('{heading} degrees from north', { heading }),
    );
    north.setAttribute(
      'aria-label',
      t('Reset map to north up. Current heading {heading} degrees', {
        heading,
      }),
    );
  }
  /** Exact tilt costs one depth read, so it refreshes once per gesture. */
  function refreshTilt() {
    if (destroyed || sliderDragging) return;
    const frame = animator.active ? null : readFrame();
    const pitch = frame ? frame.pitch : camera.pitch;
    const tilt = pitchToTiltDeg(pitch);
    if (applied?.tilt !== tilt) {
      applied = { ...applied, tilt };
      slider.value = String(tilt);
      slider.setAttribute(
        'aria-valuetext',
        t('{tilt} degrees from top-down', { tilt }),
      );
    }
    const following = Boolean(viewer.trackedEntity);
    if (applied.following !== following) {
      applied = { ...applied, following };
      root.setAttribute('data-following', String(following));
      for (const node of root.querySelectorAll?.('[data-nav^="look-"]') || []) {
        if (following) node.setAttribute('disabled', '');
        else node.removeAttribute('disabled');
      }
    }
  }
  subscribe(viewer.scene.preRender, refreshHeading);
  subscribe(camera.moveEnd, refreshTilt);
  subscribe(viewer.trackedEntityChanged, () => {
    animator.cancel();
    refreshTilt();
  });
  // A physical gesture on the globe supersedes any step still easing.
  for (const type of ['pointerdown', 'wheel'])
    listen(viewer.scene.canvas, type, animator.cancel, { passive: true });
  refreshHeading();
  refreshTilt();

  const handle = {
    root,
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
      stopHold();
      animator.cancel();
      for (const remove of removers.splice(0)) remove();
      root.remove?.();
      mounted.delete(viewer);
    },
  };
  mounted.set(viewer, handle);
  return handle;
}
