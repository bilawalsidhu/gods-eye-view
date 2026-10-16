// Builds a Navara look (viewOptions.js navaraScenePlan) on an initialised
// view and keeps it current while the view renders: the sun follows the wall
// clock as the HUD's SUN elevation does; the cinematic look lights the globe
// from the atmosphere when seen from space, shows its clouds only for low
// views over low ground and while the sun is up, brightens the atmosphere
// (createLuminanceScaler, uniforms from internals.js), compiles both
// night-side shader variants at startup and shows its stars only at night
// or from space. All of it runs only on frames the view draws anyway, so an
// idle view stays idle.

import {
  cloudsSunlitAt,
  cloudsVisibleAt,
  globeLightingAt,
  starsVisibleAt,
  sunDateStale,
} from './viewOptions.js';

/**
 * @param {object} view an initialised ThreeView with the default plugin
 * @param {object} plugin its DefaultPlugin
 * @param {ReturnType<import('./viewOptions.js').navaraScenePlan>} plan
 * @returns {{ handles: object[], frame: (height: number, moving?: boolean, ground?: number, place?: { lat: number, lng: number } | null) => boolean }}
 *   `frame` is called before each frame with the camera height, whether the
 *   camera is moving, the height of the ground in view (metres above the
 *   ellipsoid, NaN when unknown) and the camera's place (degrees, for the
 *   sun's elevation there); it returns true when it changed the scene, so
 *   the caller draws one more frame. It allocates nothing on a frame that
 *   changes nothing.
 * @param {() => number} [now] the wall clock (ms), a test seam
 * @param {{ forEachLuminanceUniform?: (handles: object, visit: (key: string, uniform: { value: object }, scaled: boolean) => void) => void }} [internals]
 *   the takram uniforms behind the atmosphere scale (internals.js); without
 *   it the scale does nothing.
 */
export function buildNavaraLook(
  view,
  plugin,
  plan,
  now = () => Date.now(),
  { forEachLuminanceUniform = null } = {},
) {
  const handles = [];
  if (plan.pluginDefault) {
    const scene = plugin.addDefaultPhotorealScene();
    handles.push(...Object.values(scene).filter(Boolean));
  } else {
    for (const desc of plan.meshes) handles.push(view.addMesh(desc));
    for (const desc of plan.lights) handles.push(view.addLight(desc));
    for (const desc of plan.effects) handles.push(view.addEffect(desc));
  }
  const effect = (name) => {
    const at = plan.effects.findIndex((desc) => Object.hasOwn(desc, name));
    return at < 0
      ? null
      : handles[plan.meshes.length + plan.lights.length + at];
  };
  const mesh = (name) => {
    const at = plan.meshes.findIndex((desc) => Object.hasOwn(desc, name));
    return at < 0 ? null : handles[at];
  };
  const aerial = plan.globeLighting ? effect('aerialPerspective') : null;
  const clouds = effect('clouds');
  const stars = plan.daylightHidesStars ? mesh('stars') : null;
  const brighten = createLuminanceScaler(
    plan.atmosphereLuminance ?? 1,
    forEachLuminanceUniform,
    {
      sky: mesh('sky'),
      stars: mesh('stars'),
      aerialPerspective: effect('aerialPerspective'),
      clouds,
    },
  );
  let globeLit = false;
  // Both aerial-perspective variants (with and without the night side) are
  // compiled on the first two frames, during startup, so a later switch
  // finds its shader compiled (a cold switch stalled a frame for up to
  // 0.8 s, mid-flight on the way down from space).
  let warmUp = aerial ? 2 : 0;
  let cloudsShown = true;
  let cloudsSunlit = true;
  let starsShown = true;

  const frame = (height, moving = false, ground = Number.NaN, place = null) => {
    // Every drawn frame: a material Navara rebuilds comes back unscaled.
    let changed = brighten();
    const atmosphere = view.atmosphere;
    if (atmosphere && sunDateStale(atmosphere.date.getTime(), now())) {
      atmosphere.date = new Date(now());
      changed = true;
    }
    const elevation =
      place && typeof atmosphere?.getSunElevation === 'function'
        ? atmosphere.getSunElevation(place)
        : Number.NaN;
    if (warmUp) {
      warmUp -= 1;
      aerial.update(warmUp ? IRRADIANCE_ON : IRRADIANCE_OFF);
      return true;
    }
    if (aerial) {
      const next = globeLightingAt(height, globeLit);
      // Switching rebuilds the aerial perspective's shader (warmed up
      // above): it switches on only at rest (a flight from city to city
      // through space never switches) and off as soon as the camera comes
      // down, before the tiles would show relit.
      if (next !== globeLit && !(next && moving)) {
        globeLit = next;
        // Only the aerial perspective changes: the tiles already draw plain
        // albedo, so view.lit stays (toggling it recompiles every tile
        // material, a frame of about 0.8 s mid-flight).
        aerial.update(next ? IRRADIANCE_ON : IRRADIANCE_OFF);
        changed = true;
      }
    }
    // Clouds only for a camera below them over low ground, and while the
    // sun is up at the camera (after sunset they read as dark puffs);
    // switching them costs no recompile, so it follows the camera in motion.
    if (clouds) {
      cloudsSunlit = cloudsSunlitAt(elevation, cloudsSunlit);
      const next = cloudsSunlit && cloudsVisibleAt(height, ground, cloudsShown);
      if (next !== cloudsShown) {
        cloudsShown = next;
        clouds.update(next ? VISIBLE : HIDDEN);
        parkCloudLayers(view.atmosphere, next);
        changed = true;
      }
    }
    if (stars) {
      const next = starsVisibleAt(height, elevation, starsShown);
      if (next !== starsShown) {
        starsShown = next;
        stars.update(next ? VISIBLE : HIDDEN);
        changed = true;
      }
    }
    return changed;
  };
  return { handles, frame };
}

const IRRADIANCE_ON = Object.freeze({
  aerialPerspective: Object.freeze({ irradiance: true }),
});
const IRRADIANCE_OFF = Object.freeze({
  aerialPerspective: Object.freeze({ irradiance: false }),
});
const VISIBLE = Object.freeze({ visible: true });
const HIDDEN = Object.freeze({ visible: false });

/**
 * The atmosphere scale (viewOptions.js ATMOSPHERE_LUMINANCE_SCALE): each
 * luminance factor is set to `scale` times the base value recorded the
 * first time it is seen, never multiplied in place, so a vector Navara
 * shares between materials, or copies into a rebuilt one, is never scaled
 * twice. The stars keep the base value: when they share the sky's vector,
 * they get their own. Returns `apply()`, true when it changed a uniform.
 */
export function createLuminanceScaler(scale, forEachUniform, handles) {
  if (scale === 1 || !forEachUniform) return () => false;
  const bases = new Map(); // key -> { base, target }
  const scaledVectors = new WeakSet();
  let changed = false;
  const entry = (key, value) => {
    let found = bases.get(key);
    if (!found) {
      found = {
        base: value.clone(),
        target: value.clone().multiplyScalar(scale),
      };
      bases.set(key, found);
    }
    return found;
  };
  const record = (key, uniform) => entry(key, uniform.value);
  const scaleOne = (key, uniform, scaled) => {
    if (!scaled) return;
    const { target } = entry(key, uniform.value);
    scaledVectors.add(uniform.value);
    if (uniform.value.equals(target)) return;
    uniform.value.copy(target);
    changed = true;
  };
  const keepBase = (key, uniform, scaled) => {
    if (scaled) return;
    const { base } = entry(key, uniform.value);
    if (scaledVectors.has(uniform.value)) {
      uniform.value = base.clone();
      changed = true;
    } else if (!uniform.value.equals(base)) {
      uniform.value.copy(base);
      changed = true;
    }
  };
  return () => {
    changed = false;
    // Bases first, from the values as Navara built them.
    forEachUniform(handles, record);
    forEachUniform(handles, scaleOne);
    forEachUniform(handles, keepBase);
    return changed;
  };
}

// The clouds hand the aerial perspective their last output through the
// atmosphere (overlay, shadow, shadow length) once, when they first draw.
// A hidden clouds pass leaves those in place, and the aerial perspective
// keeps compositing the last clouds as grey ghosts. Hiding parks them;
// showing puts them back.
const CLOUD_OUTPUTS = ['overlay', 'shadow', 'shadowLength'];
const parked = new WeakMap();

function parkCloudLayers(atmosphere, shown) {
  if (!atmosphere) return;
  if (!shown) {
    const outputs = {};
    for (const name of CLOUD_OUTPUTS) {
      if (!atmosphere[name]) continue;
      outputs[name] = atmosphere[name].value;
      atmosphere[name].value = null;
    }
    parked.set(atmosphere, outputs);
    return;
  }
  const outputs = parked.get(atmosphere);
  if (!outputs) return;
  parked.delete(atmosphere);
  for (const [name, value] of Object.entries(outputs))
    atmosphere[name].value = value;
}
