import { START_VIEW } from '../camera.js';
import { normalizeCameraLongitude } from '../director/camera.js';
import { findCamera } from '../render/rendererOf.js';
import { isEmbedded } from './embed.js';

/**
 * The opening: once the world has loaded, the loading screen's logo turns
 * into the globe, which grows to the whole planet's size, turns there to a
 * stop over the view it ends at and only then closes in on a closer one.
 * Everything is timed from one clock, in ms.
 */
export const OPENING = Object.freeze({
  /** The words under the logo fade. */
  textMs: 105,
  /** The logo moves to the centre. */
  centreMs: 630,
  // The rest is timed from the end of the move.
  /** The eye grows past the screen's edges. */
  eyeMs: 770,
  /** The drawn planet fades into the real one. */
  pupilMs: Object.freeze([420, 840]),
  /** The camera's flight starts. */
  flightStartMs: 210,
  /** The globe grows to the whole planet's size. */
  zoomMs: 1120,
  /** It turns there, slowing to a stop over the view it ends at: the turn
   * starts halfway through the zoom and ends this long after it. */
  spinMs: 600,
  /** Then the camera closes in on a closer view (a shared one), per tenfold
   * change of height, within `approachMs`. */
  approachPerDecadeMs: 770,
  approachMs: Object.freeze([840, 2800]),
  /** How far the globe turns, degrees. */
  spinDeg: 120,
});

const EARTH_RADIUS_M = 6371000;
// public/logo.svg geometry, in its viewBox units.
const EYE_CENTRE = Object.freeze({ x: 568.8, y: 379 });
const EYE_WIDTH = 726.3;
/** The empty circle inside the eye's ring, the app's window. */
const WINDOW = Object.freeze({ x: 567, y: 382, r: 226 });
/** How far past the screen's corners the window opens. */
const WINDOW_COVER_MARGIN = 1.15;
/** Never start further out than this, metres. */
const MAX_FAR_HEIGHT_M = 4e8;
/** The whole planet in view. */
const PLANET_HEIGHT_M = START_VIEW.height;

/** Openings in progress on this page. */
let playing = 0;

/**
 * Whether an opening is playing: the far start shows the globe as a speck,
 * which the globe-in-view recovery would otherwise turn the camera back to.
 */
export function openingPlaying() {
  return playing > 0;
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const easeInCubic = (x) => x ** 3;
const easeOutCubic = (x) => 1 - (1 - x) ** 3;
const easeInOutCubic = (x) =>
  x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2;
const smoothstep = (x) => x * x * (3 - 2 * x);
const span = (t, [from, to]) => clamp01((t - from) / (to - from));
/** An angle, radians, the short way round. */
const shortWay = (angle) =>
  angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));

/** Where each part of the opening stands `t` ms after it starts. */
export function openingStage(t) {
  const move = clamp01(t / OPENING.centreMs);
  const after = t - OPENING.centreMs;
  const eye = clamp01(after / OPENING.eyeMs);
  return {
    /** The words' opacity. */
    text: 1 - clamp01(t / OPENING.textMs),
    /** How far the logo has moved to the centre, 0–1. */
    centre: easeInOutCubic(move),
    /** Whether the screen is shut except inside the eye. */
    shut: move >= 1,
    /** How far the eye has grown towards covering the screen, 0–1. */
    eyeGrowth: easeInCubic(eye),
    /** The eye's own opacity, and that of the shutter around it. */
    eyeOpacity: 1 - span(eye, [0.6, 1]),
    shutterOpacity: 1 - span(eye, [0.85, 1]),
    pupilOpacity: 1 - span(after, OPENING.pupilMs),
  };
}

/**
 * The camera's flight in, from `farHeight` over the equator, looking straight
 * down. The globe first grows to the whole planet's size (or `target`'s
 * height when that is further out), turns `spinDeg` west to east there,
 * slowing to a stop over `target`, and only then closes in on a closer
 * `target`, turning to its heading, pitch and roll (radians) on the way.
 * With nothing to close in on, it grows to `target`'s height.
 * Returns `{ ms, pose(at) }`: its length, and its pose `at` ms into it.
 */
export function openingFlight({ target, farHeight }) {
  const headingTo = shortWay(target.heading ?? 0);
  const rollTo = shortWay(target.roll ?? 0);
  const pitchTo = target.pitch ?? -Math.PI / 2;
  const turns =
    Math.abs(headingTo) > 1e-3 ||
    Math.abs(rollTo) > 1e-3 ||
    Math.abs(pitchTo + Math.PI / 2) > 1e-3;
  const above = Math.max(PLANET_HEIGHT_M, target.height);
  const decades = Math.log10(above / target.height);
  const [shortest, longest] = OPENING.approachMs;
  const approachMs =
    decades > 0.05 || turns
      ? Math.min(
          longest,
          Math.max(shortest, decades * OPENING.approachPerDecadeMs),
        )
      : 0;
  const planet = approachMs ? above : target.height;
  const ms = OPENING.zoomMs + OPENING.spinMs + approachMs;
  const logLerp = (from, to, k) =>
    Math.exp(Math.log(from) + (Math.log(to) - Math.log(from)) * k);
  // The turn starts halfway through the zoom, as the drawn planet fades out.
  const spinFrom = OPENING.zoomMs / 2;
  const spinLength = OPENING.zoomMs + OPENING.spinMs - spinFrom;
  return {
    ms,
    pose(at) {
      const t = Math.min(Math.max(at, 0), ms);
      const zoom = smoothstep(clamp01(t / OPENING.zoomMs));
      const spin = easeOutCubic(clamp01((t - spinFrom) / spinLength));
      const approach = approachMs
        ? clamp01((t - OPENING.zoomMs - OPENING.spinMs) / approachMs)
        : 0;
      const turning = easeInOutCubic(approach);
      return {
        lon: normalizeCameraLongitude(
          target.lon + OPENING.spinDeg * (1 - spin),
        ),
        lat: target.lat * spin,
        height:
          approach > 0
            ? logLerp(planet, target.height, smoothstep(approach))
            : logLerp(farHeight, planet, zoom),
        heading: headingTo * turning,
        pitch: -Math.PI / 2 + (pitchTo + Math.PI / 2) * turning,
        roll: rollTo * turning,
      };
    },
  };
}

/**
 * The globe's radius on screen, pixels, from `height` metres straight above
 * it, through a lens of vertical angle `fovy` on a view `viewportHeight`
 * pixels tall.
 */
export function globeRadiusPx(height, { fovy, viewportHeight }) {
  const angle = Math.asin(EARTH_RADIUS_M / (EARTH_RADIUS_M + height));
  return (Math.tan(angle) / Math.tan(fovy / 2)) * (viewportHeight / 2);
}

/** The height at which the globe's radius on screen is `radiusPx`. */
export function heightForGlobeRadius(radiusPx, { fovy, viewportHeight }) {
  const tangent = (radiusPx * Math.tan(fovy / 2)) / (viewportHeight / 2);
  return EARTH_RADIUS_M / Math.sin(Math.atan(tangent)) - EARTH_RADIUS_M;
}

/**
 * How much the eye must grow, about its centre at the centre of `view`, for
 * its window (the empty circle inside its ring, `windowRadius` pixels) to
 * reach past the view's corners.
 */
function eyeCoverScale(windowRadius, view) {
  return (
    (WINDOW_COVER_MARGIN * Math.hypot(view.width, view.height)) /
    2 /
    windowRadius
  );
}

/**
 * The cover around the eye's window: a shape the loading screen's colour, as
 * large as any screen, with the empty circle inside the eye's ring cut out of
 * it. It sits under the logo's parts and grows with the eye, so the screen is
 * shut but for that circle.
 */
function eyeShutter(eye) {
  const far = 1e5;
  // Centred where the eye grows from, so the two grow as one.
  const { x, y } = EYE_CENTRE;
  const { x: cx, y: cy, r } = WINDOW;
  const shutter = eye.ownerDocument.createElementNS(
    'http://www.w3.org/2000/svg',
    'path',
  );
  shutter.setAttribute(
    'd',
    `M${x - far},${y - far}H${x + far}V${y + far}H${x - far}Z` +
      `M${cx - r},${cy}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0Z`,
  );
  shutter.style.fill = 'var(--bg-dark)';
  shutter.setAttribute('fill-rule', 'evenodd');
  shutter.dataset.openingShutter = '';
  eye.parentNode.insertBefore(shutter, eye.parentNode.firstElementChild);
  return shutter;
}

/**
 * Whether the page opens with the opening: not where motion is reduced, not
 * in an embedded view (its host drives the camera, and an inline panel's host
 * may stop animation frames), not on a Stories link (Stories opens its own
 * view) and not with `?intro=0`.
 */
export function openingWanted(win = globalThis.window) {
  if (!win) return false;
  if (win.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
    return false;
  if (isEmbedded(win.location)) return false;
  const params = new URLSearchParams(win.location?.search ?? '');
  return !(
    params.get('intro') === '0' ||
    params.has('story') ||
    params.has('stories')
  );
}

/**
 * Play the opening over `loadingScreen`, ending where the camera stands (the
 * start view, or the view a link opened). Returns null when it does not
 * play: without the logo's own parts (an <img> logo opens as with reduced
 * motion), or for a camera at or below the ellipsoid. Else `done`, which
 * settles when the camera has stopped, and `cancel()`. A press, a click, a
 * key, a touch or the wheel skips to the end; any other camera move stops it
 * where it is. The loading screen is `hidden` once the real globe shows, or
 * at once on a cancel.
 * @param {{viewer: object, loadingScreen: HTMLElement, win?: Window,
 *   camera?: object}} options `camera` is the viewer's camera port unless given.
 */
export function playOpeningIntro({
  viewer,
  loadingScreen,
  win = globalThis.window,
  camera = null,
}) {
  if (!openingWanted(win)) return null;
  camera ??= findCamera(viewer);
  if (!camera) return null;
  const target = camera.pose();
  if (
    !Number.isFinite(target.height) ||
    target.height <= 0 ||
    !Number.isFinite(target.lon) ||
    !Number.isFinite(target.lat)
  )
    return null;
  const doc = loadingScreen.ownerDocument;
  const logo = loadingScreen.querySelector('.loader-logo');
  const svg = logo?.querySelector('svg');
  const eye = svg?.querySelector('#outer_eye');
  // The drawn planet: its blue disc, continents and grid.
  const disc = svg?.querySelector('#inner_eye');
  if (!eye || !disc) return null;
  const pupil = [
    disc,
    svg.querySelector('#globe'),
    svg.querySelector('#globe_cage'),
  ].filter(Boolean);
  // Each part fades from its own opacity: the grid is translucent.
  const ownOpacity = pupil.map((element) => {
    const opacity = Number.parseFloat(win.getComputedStyle(element).opacity);
    return Number.isFinite(opacity) ? opacity : 1;
  });
  const shutter = eyeShutter(eye);

  loadingScreen.classList.add('opening');
  playing += 1;
  // Cancel the logo gaze's offset (src/logoGaze.js): the pupil starts centred.
  for (const element of pupil) element.style.transform = 'none';
  // The globe takes over from the drawn planet inside the blue disc, at its size.
  const planet = svg.querySelector('#globe') ?? disc;
  const pupilRect = planet.getBoundingClientRect();
  const eyeRect = eye.getBoundingClientRect();
  const view = (
    doc.getElementById('cesiumContainer') ?? doc.documentElement
  ).getBoundingClientRect();
  const viewportHeight = view.height || win.innerHeight;
  const lens = { fovy: target.fovy, viewportHeight };
  const pupilRadius = pupilRect.width / 2;
  const farHeight = Math.min(
    MAX_FAR_HEIGHT_M,
    Math.max(target.height * 2, heightForGlobeRadius(pupilRadius, lens)),
  );
  const toCentre = {
    x: view.left + view.width / 2 - (pupilRect.left + pupilRect.width / 2),
    y: view.top + view.height / 2 - (pupilRect.top + pupilRect.height / 2),
  };
  const startRadius = globeRadiusPx(farHeight, lens);
  // Where the far start is capped (a wide screen), the globe there is larger
  // than the drawn planet: the logo grows to it on its way to the centre,
  // under the cover, and matches it from then on.
  const discScale = pupilRadius > 0 ? startRadius / pupilRadius : 1;
  const eyeCover = eyeRect.width
    ? eyeCoverScale((eyeRect.width * WINDOW.r) / EYE_WIDTH, {
        width: view.width || win.innerWidth,
        height: viewportHeight,
      })
    : 1;

  let driving = false;
  /** The camera as the opening last left it. */
  let placed = null;
  const place = ({ lon, lat, height, heading, pitch, roll = 0 }) => {
    driving = true;
    try {
      camera.setView({
        destination: { lon, lat, height },
        orientation: { heading, pitch, roll },
      });
    } finally {
      driving = false;
    }
    placed = camera.pose();
  };
  // A move made on the renderer's own camera sends no command.
  const movedElsewhere = () => {
    const now = camera.pose();
    return (
      Math.abs(now.lat - placed.lat) > 1e-6 ||
      Math.abs(normalizeCameraLongitude(now.lon - placed.lon)) > 1e-6 ||
      Math.abs(now.height - placed.height) > 1
    );
  };

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  let frame = 0;
  let finished = false;
  const hide = () => loadingScreen.classList.add('hidden');
  const stopCommands = camera.onCommand(() => {
    if (!driving) finish();
  });
  const inputs = ['pointerdown', 'click', 'wheel', 'keydown', 'touchstart'];
  const onInput = () => finish({ land: true });
  for (const type of inputs)
    win.addEventListener(type, onInput, { capture: true, passive: true });

  function finish({ land = false } = {}) {
    if (finished) return;
    finished = true;
    playing -= 1;
    try {
      if (frame) win.cancelAnimationFrame(frame);
      stopCommands();
      for (const type of inputs)
        win.removeEventListener(type, onInput, { capture: true });
      if (land) place(target);
    } finally {
      hide();
      resolveDone();
    }
  }

  const flight = openingFlight({ target, farHeight });
  const start = win.performance.now();
  const step = () => {
    frame = 0;
    if (finished) return;
    try {
      if (placed && movedElsewhere()) {
        finish();
        return;
      }
      const t = win.performance.now() - start;
      const flown = t - OPENING.centreMs - OPENING.flightStartMs;
      if (flown >= flight.ms) {
        finish({ land: true });
        return;
      }
      const stage = openingStage(t);
      const pose = flight.pose(flown);
      place(pose);
      const scale =
        (globeRadiusPx(pose.height, lens) / startRadius) *
        (1 + (discScale - 1) * stage.centre);
      loadingScreen.style.setProperty('--opening-text', stage.text);
      // Once the logo is centred, the shutter around the eye is the cover.
      loadingScreen.style.setProperty('--opening-veil', stage.shut ? 0 : 1);
      logo.style.transform = `translate(${toCentre.x * stage.centre}px, ${
        toCentre.y * stage.centre
      }px) scale(${scale})`;
      const eyeScale = `scale(${1 + (eyeCover - 1) * stage.eyeGrowth})`;
      eye.style.transform = eyeScale;
      eye.style.opacity = stage.eyeOpacity;
      shutter.style.transform = eyeScale;
      shutter.style.opacity = stage.shutterOpacity;
      pupil.forEach((element, i) => {
        element.style.opacity = ownOpacity[i] * stage.pupilOpacity;
      });
      if (stage.pupilOpacity === 0) hide();
      frame = win.requestAnimationFrame(step);
    } catch (error) {
      finish();
      throw error;
    }
  };
  step();
  return { done, cancel: () => finish() };
}
