// Where weather imagery and shells go: the globe's own imagery host, the
// shells' heights and how they rise with the camera. Light on purpose (the
// renderer ports only), so a layer that drapes a field can share them
// without the weather layer's image pipeline.
import { findCamera, findFrame, findGlobe } from '../../render/rendererOf.js';

/**
 * The viewer's own globe imagery, as a weather imagery host: where a layer
 * drapes when the application shell names no host of its own. Its globe
 * port's imagery stands for it, one object per port.
 * @param {object|null|undefined} viewer The scene object the layer holds.
 * @returns {{collection: object|null, kind: 'globe'}}
 */
export function globeImageryHost(viewer) {
  return { collection: findGlobe(viewer)?.imagery ?? null, kind: 'globe' };
}

/**
 * Metres above the ellipsoid. Lower shells draw first, so lightning draws
 * last; an air-quality model field (its Europe inset over it) draws under
 * wind.
 */
export const WEATHER_SHELL_HEIGHTS = Object.freeze({
  'air-quality': 4_700,
  'air-quality-inset': 4_850,
  wind: 5_000,
  clouds: 5_500,
  'clouds-regional': 5_800,
  radar: 6_200,
  lightning: 6_600,
});
// From far away Google's coarse 3D tiles rise tens of kilometres above the
// ground and hide the shells, so the shells rise with the camera: 4 m per
// kilometre of camera height, at most 60 km, in 500 m steps.
const LIFT_PER_METRE = 0.004;
const MAX_LIFT = 60_000;
const LIFT_STEP = 500;

/** Metres every shell rises for a camera this high above the ellipsoid. */
export function shellLift(cameraHeight) {
  if (!(cameraHeight > 0)) return 0;
  const lift = Math.min(MAX_LIFT, cameraHeight * LIFT_PER_METRE);
  return Math.round(lift / LIFT_STEP) * LIFT_STEP;
}

/**
 * Tell `apply` the shell lift for the camera's height now and, each frame
 * before it draws, whenever it changes.
 * @param {object} viewer
 * @param {(liftM: number) => void} apply
 * @param {{cameraOf?: Function, frameOf?: Function}} [ports]
 * @returns {() => void} Stops.
 */
export function followShellLift(
  viewer,
  apply,
  { cameraOf = findCamera, frameOf = findFrame } = {},
) {
  let lift = null;
  const read = () => {
    const next = shellLift(cameraOf(viewer)?.pose?.().height);
    if (next === lift) return;
    lift = next;
    apply(next);
  };
  read();
  return frameOf(viewer)?.on('preRender', read) ?? (() => {});
}
