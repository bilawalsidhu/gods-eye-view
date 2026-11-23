import { cameraOf } from '../render/rendererOf.js';

/**
 * The opening: once the world has loaded, the loading screen's logo turns
 * into the globe. The words fade and the logo glides to the centre; the eye's
 * arcs fly at the viewer; the drawn planet in the pupil gives way to the real
 * one, drawn the same size behind it; the real one spins and grows, slowing
 * until it stops, the whole planet in view, over the start view (the
 * visitor's country). Everything is timed from one clock, in ms.
 */
export const OPENING = Object.freeze({
  /** The words fade and the logo moves to the centre. */
  centreMs: 450,
  // The rest is timed from the end of the move.
  /** The arcs grow and fade. */
  arcsMs: 700,
  /** The background clears to the globe. */
  veilMs: Object.freeze([200, 700]),
  /** The drawn planet fades into the real one. */
  pupilMs: Object.freeze([500, 1100]),
  /** The camera's flight in. */
  flightStartMs: 300,
  flightMs: 4200,
  /** How far the globe turns on the way in, degrees. */
  spinDeg: 360,
});

const EARTH_RADIUS_M = 6371000;
// logo.svg: its viewBox width and the drawn planet's radius, in its units.
const LOGO_WIDTH = 775;
const PUPIL_RADIUS = 120.33;
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
const span = (t, [from, to]) => clamp01((t - from) / (to - from));

/**
 * Where each part of the opening stands `t` ms after it starts.
 * @param {number} t
 */
export function openingStage(t, timing = OPENING) {
  const move = clamp01(t / timing.centreMs);
  const after = t - timing.centreMs;
  const arcs = easeInCubic(clamp01(after / timing.arcsMs));
  const flight = clamp01((after - timing.flightStartMs) / timing.flightMs);
  return {
    /** The words' opacity. */
    text: 1 - move,
    /** How far the logo has moved to the centre, 0–1. */
    centre: easeInOutCubic(move),
    arcsScale: 1 + 5 * arcs,
    arcsOpacity: 1 - arcs,
    /** The loading screen's background opacity. */
    veil: 1 - span(after, timing.veilMs),
    pupilOpacity: 1 - span(after, timing.pupilMs),
    /** The flight's progress, 0–1. */
    flight,
    done: flight >= 1,
  };
}

/**
 * The camera `flight` (0–1) of the way in: from `farHeight` over the
 * equator, a turn of `spinDeg` west to east that slows to a stop over
 * `target`, closing in on `target.height`.
 */
export function openingPose(
  flight,
  { target, farHeight, spinDeg = OPENING.spinDeg },
) {
  const f = clamp01(flight);
  const closing = easeInOutCubic(f);
  const height = Math.exp(
    Math.log(farHeight) +
      (Math.log(target.height) - Math.log(farHeight)) * closing,
  );
  const lon = target.lon + spinDeg * (1 - easeOutCubic(f));
  return {
    lon: ((((lon + 180) % 360) + 360) % 360) - 180,
    lat: target.lat * closing,
    height,
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
 * Play the opening over `loadingScreen`, from where the camera stands (the
 * start view). Returns null when it does not play; else `done`, which
 * settles when the camera has stopped, and `cancel()`. A click, a key or the
 * wheel skips to the start view; any other camera move stops it where it is. The loading
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
    !Number.isFinite(target?.height) ||
    !Number.isFinite(target.lon) ||
    !Number.isFinite(target.lat)
  )
    return null;
  const doc = loadingScreen.ownerDocument;
  const logo = loadingScreen.querySelector('.loader-logo');
  const svg = logo?.querySelector('svg');
  const part = (id) => svg?.querySelector(`#${id}`);
  const arcs = [part('outer_eye'), part('inner_eye')].filter(Boolean);
  // The drawn planet; the whole logo where it is an <img>.
  const pupil = svg
    ? [part('globe'), part('globe_cage')].filter(Boolean)
    : [logo].filter(Boolean);

  loadingScreen.classList.add('opening');
  playing += 1;
  // The planet looks out of the middle of the eye again.
  for (const element of pupil) element.style.transform = 'none';
  const globe = part('globe');
  const pupilRect = (globe ?? logo)?.getBoundingClientRect();
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
    ? globe
      ? pupilRect.width / 2
      : (pupilRect.width * PUPIL_RADIUS) / LOGO_WIDTH
    : 20;
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

  let driving = false;
  const place = (pose, heading = 0, pitch = -Math.PI / 2) => {
    driving = true;
    try {
      camera.setView({
        destination: pose,
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
      place(
        { lon: target.lon, lat: target.lat, height: target.height },
        target.heading ?? 0,
        target.pitch ?? -Math.PI / 2,
      );
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
    loadingScreen.style.setProperty('--opening-veil', stage.veil);
    if (logo)
      logo.style.transform = `translate(${toCentre.x * stage.centre}px, ${
        toCentre.y * stage.centre
      }px) scale(${scale})`;
    for (const element of arcs) {
      element.style.transform = `scale(${stage.arcsScale})`;
      element.style.opacity = stage.arcsOpacity;
    }
    for (const element of pupil) element.style.opacity = stage.pupilOpacity;
    if (stage.pupilOpacity === 0) hide();
    frame = win.requestAnimationFrame(step);
  };
  step();
  return { done, cancel: () => finish() };
}
