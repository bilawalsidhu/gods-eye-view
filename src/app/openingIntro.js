import { cameraOf } from '../render/rendererOf.js';

/**
 * The opening: once the world has loaded, the loading screen's logo turns
 * into the globe. The words fade and the logo glides to the centre. The
 * screen is then shut but for the empty circle inside the eye's ring, which
 * flies at the viewer and opens onto the application as it grows past the
 * screen's edges. The drawn
 * planet in the pupil (its blue disc) gives way to the real one, drawn the
 * same size behind it; the real one spins and grows, slowing until it stops,
 * the whole planet in view, over the start view (the visitor's country).
 * Everything is timed from one clock, in ms.
 */
export const OPENING = Object.freeze({
  /** The words under the logo fade. */
  textMs: 150,
  /** The logo moves to the centre. */
  centreMs: 900,
  // The rest is timed from the end of the move.
  /** The eye grows past the screen's edges. */
  eyeMs: 1100,
  /** Without the logo's own parts (an <img>): the background clears. */
  veilMs: Object.freeze([200, 700]),
  /** The drawn planet fades into the real one. */
  pupilMs: Object.freeze([600, 1200]),
  /** The camera's flight in. */
  flightStartMs: 300,
  flightMs: 6000,
  /** How far the globe turns on the way in, degrees. */
  spinDeg: 360,
});

const EARTH_RADIUS_M = 6371000;
// logo.svg: its viewBox width, the drawn planet's radius (the blue disc) and
// the eye's centre, in its units.
const LOGO_WIDTH = 775;
const PUPIL_RADIUS = 195;
const EYE_CENTRE = Object.freeze({ x: 568.8, y: 379 });
const EYE_WIDTH = 726.3;
/** The empty circle inside the eye's ring, the app's window. */
const WINDOW = Object.freeze({ x: 567, y: 382, r: 226 });
/** How far past the screen's corners the window opens. */
const WINDOW_COVER_MARGIN = 1.15;
/** Never start further out than this, metres. */
const MAX_FAR_HEIGHT_M = 4e8;

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

/**
 * Where each part of the opening stands `t` ms after it starts.
 * @param {number} t
 */
export function openingStage(t, timing = OPENING) {
  const move = clamp01(t / timing.centreMs);
  const after = t - timing.centreMs;
  const eye = clamp01(after / timing.eyeMs);
  const flight = clamp01((after - timing.flightStartMs) / timing.flightMs);
  return {
    /** The words' opacity. */
    text: 1 - clamp01(t / timing.textMs),
    /** How far the logo has moved to the centre, 0–1. */
    centre: easeInOutCubic(move),
    /** Whether the screen is shut except inside the eye. */
    shut: move >= 1,
    /** How far the eye has grown towards covering the screen, 0–1. */
    eyeGrowth: easeInCubic(eye),
    /** The eye's own opacity, and that of the shutter around it. */
    eyeOpacity: 1 - span(eye, [0.6, 1]),
    shutterOpacity: 1 - span(eye, [0.85, 1]),
    eyeOpen: eye >= 1,
    /** The background's opacity where the logo is an <img>. */
    veil: 1 - span(after, timing.veilMs),
    pupilOpacity: 1 - span(after, timing.pupilMs),
    /** The flight's progress, 0–1. */
    flight,
    done: flight >= 1,
  };
}

/**
 * The camera `flight` (0–1) of the way in: from `farHeight` over the
 * equator, looking straight down, a turn of `spinDeg` west to east that
 * slows to a stop over `target`, closing in on `target.height`. Over the
 * last part it turns to `target`'s heading and pitch (radians), so a view
 * at an angle (a shared one) is reached without a jump.
 */
export function openingPose(
  flight,
  { target, farHeight, spinDeg = OPENING.spinDeg },
) {
  const f = clamp01(flight);
  // Half the peak speed of a cubic ease, so the imagery keeps up as the
  // globe grows.
  const closing = smoothstep(f);
  const height = Math.exp(
    Math.log(farHeight) +
      (Math.log(target.height) - Math.log(farHeight)) * closing,
  );
  const lon = target.lon + spinDeg * (1 - easeOutCubic(f));
  const turning = easeInOutCubic(span(f, [0.6, 1]));
  const heading = target.heading ?? 0;
  // The short way round to the target's heading.
  const headingFrom =
    heading - 2 * Math.PI * Math.round(heading / (2 * Math.PI));
  const pitch = target.pitch ?? -Math.PI / 2;
  return {
    lon: ((((lon + 180) % 360) + 360) % 360) - 180,
    lat: target.lat * closing,
    height,
    heading: headingFrom * turning,
    pitch: -Math.PI / 2 + (pitch + Math.PI / 2) * turning,
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
export function eyeCoverScale(windowRadius, view) {
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
function eyeShutter(eye, loadingScreen, win) {
  const colour =
    win.getComputedStyle?.(loadingScreen).backgroundColor || '#000';
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
  shutter.setAttribute('fill', colour);
  shutter.setAttribute('fill-rule', 'evenodd');
  shutter.dataset.openingShutter = '';
  eye.parentNode.insertBefore(shutter, eye.parentNode.firstElementChild);
  return shutter;
}

/**
 * Whether the page opens with the opening: not where motion is reduced, not
 * on a Stories link (Stories opens its own view) and not with `?intro=0`.
 */
export function openingWanted(win = globalThis.window) {
  if (!win) return false;
  if (win.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
    return false;
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
 * play, as for a camera held in a target's frame; else `done`, which settles
 * when the camera has stopped, and `cancel()`. A click, a key or the wheel
 * skips to the end; any other camera move stops it where it is. The loading
 * screen is `hidden` once the real globe shows, or at once on a cancel.
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
  try {
    camera ??= cameraOf(viewer);
  } catch {
    return null;
  }
  const target = camera.pose();
  if (
    target?.frameIsIdentity === false ||
    !Number.isFinite(target?.height) ||
    !Number.isFinite(target.lon) ||
    !Number.isFinite(target.lat)
  )
    return null;
  const doc = loadingScreen.ownerDocument;
  const logo = loadingScreen.querySelector('.loader-logo');
  const svg = logo?.querySelector('svg');
  const part = (id) => svg?.querySelector(`#${id}`);
  const eye = part('outer_eye');
  // The drawn planet: its blue disc, continents and grid; the whole logo
  // where it is an <img>.
  const disc = part('inner_eye');
  const pupil = svg
    ? [disc, part('globe'), part('globe_cage')].filter(Boolean)
    : [logo].filter(Boolean);
  const shutter = eye ? eyeShutter(eye, loadingScreen, win) : null;

  loadingScreen.classList.add('opening');
  playing += 1;
  // The planet looks out of the middle of the eye again.
  for (const element of pupil) element.style.transform = 'none';
  const pupilRect = (disc ?? logo)?.getBoundingClientRect();
  const eyeRect = eye?.getBoundingClientRect();
  const view = (
    doc.getElementById('cesiumContainer') ?? doc.documentElement
  ).getBoundingClientRect();
  const viewportHeight = view.height || win.innerHeight;
  const aspect = (view.width || win.innerWidth) / viewportHeight;
  // Cesium's default lens: 60° across the wider side.
  const fovy = Number.isFinite(target.fovy)
    ? target.fovy
    : aspect > 1
      ? 2 * Math.atan(Math.tan(Math.PI / 6) / aspect)
      : Math.PI / 3;
  const lens = { fovy, viewportHeight };
  const pupilRadius = pupilRect
    ? disc
      ? pupilRect.width / 2
      : (pupilRect.width * PUPIL_RADIUS) / LOGO_WIDTH
    : 32;
  const farHeight = Math.min(
    MAX_FAR_HEIGHT_M,
    Math.max(target.height * 2, heightForGlobeRadius(pupilRadius, lens)),
  );
  const toCentre = pupilRect
    ? {
        x: view.left + view.width / 2 - (pupilRect.left + pupilRect.width / 2),
        y: view.top + view.height / 2 - (pupilRect.top + pupilRect.height / 2),
      }
    : { x: 0, y: 0 };
  const startRadius = globeRadiusPx(farHeight, lens);
  const eyeCover = eyeRect?.width
    ? eyeCoverScale((eyeRect.width * WINDOW.r) / EYE_WIDTH, {
        width: view.width || win.innerWidth,
        height: viewportHeight,
      })
    : 1;

  let driving = false;
  const place = ({ lon, lat, height, heading, pitch }) => {
    driving = true;
    try {
      camera.setView({
        destination: { lon, lat, height },
        orientation: { heading, pitch, roll: 0 },
      });
    } finally {
      driving = false;
    }
  };

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  let frame = 0;
  let finished = false;
  const hide = () => loadingScreen.classList.add('hidden');
  const stopCommands = camera.onCommand?.(() => {
    if (!driving) finish();
  });
  const inputs = ['pointerdown', 'wheel', 'keydown', 'touchstart'];
  // The person's own input skips to the end; another camera move stops it.
  const onInput = () => finish({ land: true });
  for (const type of inputs)
    win.addEventListener(type, onInput, { capture: true, passive: true });

  function finish({ land = false } = {}) {
    if (finished) return;
    finished = true;
    playing -= 1;
    if (frame) win.cancelAnimationFrame(frame);
    stopCommands?.();
    for (const type of inputs)
      win.removeEventListener(type, onInput, { capture: true });
    if (land)
      place({
        lon: target.lon,
        lat: target.lat,
        height: target.height,
        heading: target.heading ?? 0,
        pitch: target.pitch ?? -Math.PI / 2,
      });
    hide();
    resolveDone();
  }

  const start = win.performance.now();
  const step = () => {
    frame = 0;
    if (finished) return;
    const stage = openingStage(win.performance.now() - start);
    if (stage.done) {
      finish({ land: true });
      return;
    }
    const pose = openingPose(stage.flight, { target, farHeight });
    place(pose);
    const scale = globeRadiusPx(pose.height, lens) / startRadius;
    loadingScreen.style.setProperty('--opening-text', stage.text);
    // Once the logo is centred, the shutter around the eye is the cover.
    loadingScreen.style.setProperty(
      '--opening-veil',
      shutter ? (stage.shut ? 0 : 1) : stage.veil,
    );
    if (logo)
      logo.style.transform = `translate(${toCentre.x * stage.centre}px, ${
        toCentre.y * stage.centre
      }px) scale(${scale})`;
    const eyeScale = `scale(${1 + (eyeCover - 1) * stage.eyeGrowth})`;
    if (eye) {
      eye.style.transform = eyeScale;
      eye.style.opacity = stage.eyeOpacity;
    }
    if (shutter) {
      shutter.style.transform = eyeScale;
      shutter.style.opacity = stage.shutterOpacity;
    }
    for (const element of pupil) element.style.opacity = stage.pupilOpacity;
    if (stage.pupilOpacity === 0 && (stage.eyeOpen || !shutter)) hide();
    frame = win.requestAnimationFrame(step);
  };
  step();
  return { done, cancel: () => finish() };
}
