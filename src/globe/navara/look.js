// Builds a Navara look (viewOptions.js navaraScenePlan) on an initialised
// view and keeps it current while the view renders: the sun follows `now`
// (the engine clock's frame time in the app: the app clock, which is the wall
// clock the HUD's SUN elevation reads unless QA moves it); the cinematic look
// lights the globe
// from the atmosphere when seen from space, shows its clouds only for low
// views over low ground, brightens the atmosphere (atmosphereLuminance.js)
// and shows its stars only at night or from space. All of it runs only on frames the view draws
// anyway, so an idle view stays idle.

import { createAtmosphereLuminance } from './atmosphereLuminance.js';
import {
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
 *   the caller draws one more frame.
 */
export function buildNavaraLook(view, plugin, plan, now = () => Date.now()) {
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
  const atmosphereHandles = {
    sky: mesh('sky'),
    aerialPerspective: effect('aerialPerspective'),
    clouds,
  };
  const brighten = createAtmosphereLuminance(plan.atmosphereLuminance ?? 1);
  let globeLit = false;
  let cloudsShown = true;
  let starsShown = true;

  const frame = (height, moving = false, ground = Number.NaN, place = null) => {
    // Every drawn frame: a material Navara rebuilds comes back unscaled.
    let changed = brighten(atmosphereHandles);
    const atmosphere = view.atmosphere;
    if (atmosphere && sunDateStale(atmosphere.date.getTime(), now())) {
      atmosphere.date = new Date(now());
      changed = true;
    }
    if (aerial) {
      const next = globeLightingAt(height, globeLit);
      // Switching recompiles the aerial perspective, a frame of about 0.8 s
      // headless: it switches on only at rest (a flight from city to city
      // through space never switches) and off as soon as the camera comes
      // down, before the tiles would show relit.
      if (next !== globeLit && !(next && moving)) {
        globeLit = next;
        // Only the aerial perspective changes: the tiles already draw plain
        // albedo, so view.lit stays (toggling it recompiles every tile
        // material, a frame of about 0.8 s mid-flight).
        aerial.update({ aerialPerspective: { irradiance: next } });
        changed = true;
      }
    }
    // Clouds only for a camera below them over low ground; switching them
    // costs no recompile, so it follows the camera in motion too.
    if (clouds) {
      const next = cloudsVisibleAt(height, ground, cloudsShown);
      if (next !== cloudsShown) {
        cloudsShown = next;
        clouds.update({ visible: next });
        parkCloudLayers(view.atmosphere, next);
        changed = true;
      }
    }
    if (stars) {
      const elevation =
        place && typeof atmosphere?.getSunElevation === 'function'
          ? atmosphere.getSunElevation(place)
          : Number.NaN;
      const next = starsVisibleAt(height, elevation, starsShown);
      if (next !== starsShown) {
        starsShown = next;
        stars.update({ visible: next });
        changed = true;
      }
    }
    return changed;
  };
  return { handles, frame };
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
