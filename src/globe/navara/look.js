// Builds a Navara look (viewOptions.js navaraScenePlan) on an initialised
// view and keeps it current while the view renders: the sun follows `now`
// (the world time in the app, shared with the HUD's SUN elevation). The sky
// and clouds keep the cinematic lighting; map colours stay readable at any
// time and height. All of it runs only on frames the view draws anyway, so
// an idle view stays idle.

import {
  cloudsSunlitAt,
  AGX,
  LINEAR,
  MAP_AERIAL_PERSPECTIVE,
  cloudTerrainOffset,
  landscapeSunTime,
  CUMULUS_BASES,
  LOCAL_CLOUD_COVERAGE,
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
 * @param {() => number} [now] the sun's time (ms); the app passes the world
 *   time (index.js), the wall clock by default and in tests
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
  let scene = null;
  if (plan.pluginDefault) {
    scene = plugin.addDefaultPhotorealScene();
    handles.push(...Object.values(scene).filter(Boolean));
  } else {
    for (const desc of plan.meshes) handles.push(view.addMesh(desc));
    for (const desc of plan.lights) handles.push(view.addLight(desc));
    for (const desc of plan.effects) handles.push(view.addEffect(desc));
  }
  // Set before tiles compile: neither forward nor deferred sunlight should
  // relight imagery that already contains its own shadows.
  view.lit = false;
  view.toneMappingExposure = 1;
  const effect = (name) => {
    if (scene) return scene[name] ?? null;
    const at = plan.effects.findIndex((desc) => Object.hasOwn(desc, name));
    return at < 0
      ? null
      : handles[plan.meshes.length + plan.lights.length + at];
  };
  const mesh = (name) => {
    const at = plan.meshes.findIndex((desc) => Object.hasOwn(desc, name));
    return at < 0 ? null : handles[at];
  };
  if (scene)
    effect('aerialPerspective')?.update({
      aerialPerspective: { ...MAP_AERIAL_PERSPECTIVE },
    });
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
  let cloudsShown = true;
  let cloudsSunlit = true;
  let landscape = false;
  let daylightTime = null;
  const tone = effect('toneMapping');
  const toneMode =
    plan.effects.find((desc) => desc.toneMapping)?.toneMapping.mode ?? AGX;
  let styled = false;
  let starsShown = true;

  const frame = (
    height,
    moving = false,
    ground = Number.NaN,
    place = null,
    landscapeRequested = false,
  ) => {
    // Every drawn frame: a material Navara rebuilds comes back unscaled.
    let changed = brighten();
    if (landscapeRequested !== landscape) {
      landscape = landscapeRequested;
      daylightTime = null;
    }
    const atmosphere = view.atmosphere;
    // Choose inspection daylight once so rotating the camera leaves the
    // sky's sun direction fixed.
    if (landscape && place && daylightTime === null)
      daylightTime = landscapeSunTime(now(), place.lng);
    const time = daylightTime ?? now();
    if (atmosphere && sunDateStale(atmosphere.date.getTime(), time)) {
      atmosphere.date = new Date(time);
      changed = true;
    }
    const elevation =
      place && typeof atmosphere?.getSunElevation === 'function'
        ? atmosphere.getSunElevation(place)
        : Number.NaN;
    // Terrain-relative layers keep distant cumulus above mountain ridges.
    // Keep the deck visible from aircraft altitude, then clear it for regional views.
    if (clouds) {
      const offset = cloudTerrainOffset(height, ground);
      const pass = clouds.ref?.raw;
      const layers = pass?.cloudLayers;
      if (layers) {
        for (let i = 0; i < CUMULUS_BASES.length; i++) {
          const altitude = CUMULUS_BASES[i] + offset;
          if (layers[i].altitude !== altitude) {
            layers[i].altitude = altitude;
            changed = true;
          }
        }
      }
      cloudsSunlit = cloudsSunlitAt(elevation, cloudsSunlit);
      const ceiling = offset + (cloudsShown ? 12_000 : 11_000);
      const next = cloudsSunlit && height <= ceiling;
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
  // Anime's bands turn the starfield into blotches: the stars fade with the
  // style (Cesium fades its Milky Way), from the look's own brightness.
  const starsMesh = mesh('stars');
  const starsIntensity =
    plan.meshes.find((desc) => Object.hasOwn(desc, 'stars'))?.stars
      ?.intensity ?? NAVARA_STARS_INTENSITY;
  let starsDimmed = 0;
  let cloudCoverage = LOCAL_CLOUD_COVERAGE;
  return {
    handles,
    frame,
    // Sensor shaders expect display colours, as on Cesium. A filmic curve
    // before their gain/thresholds changes both contrast and clipping.
    setStyled(active) {
      if (!tone || active === styled) return false;
      styled = active;
      tone.update({ toneMapping: { mode: styled ? LINEAR : toneMode } });
      return true;
    },
    resetDaylight() {
      daylightTime = null;
    },
    /** Whether the look draws volumetric clouds (cinematic, not on mobile). */
    hasClouds: Boolean(clouds),
    /**
     * The clouds' cover (0..1), or null for the look's own
     * (LOCAL_CLOUD_COVERAGE); true when it changed. Where and when they
     * show stays the look's rule (height, sunlight).
     */
    setCloudCoverage(coverage) {
      if (!clouds) return false;
      const next = coverage ?? LOCAL_CLOUD_COVERAGE;
      if (next === cloudCoverage) return false;
      cloudCoverage = next;
      clouds.update({ clouds: { coverage: next } });
      return true;
    },
    /** Dims the stars by `amount` (0 none, 1 hidden); true when it changed. */
    setStarsDimmed(amount) {
      const next = Math.min(1, Math.max(0, Number(amount) || 0));
      if (!starsMesh || next === starsDimmed) return false;
      starsDimmed = next;
      starsMesh.update({
        stars: { intensity: starsIntensity * (1 - next) },
      });
      return true;
    },
  };
}

/** Navara's own stars intensity, for a look that does not set one. */
const NAVARA_STARS_INTENSITY = 10;

const VISIBLE = Object.freeze({ visible: true });
const HIDDEN = Object.freeze({ visible: false });

// Every luminance vector a scaler has written, with the value it had
// before: one map for the page, as the vectors are.
const unscaled = new WeakMap();

/**
 * The atmosphere scale (viewOptions.js ATMOSPHERE_LUMINANCE_SCALE): each
 * luminance factor is set to `scale` times the base value recorded the
 * first time it is seen, never multiplied in place, so a vector Navara
 * shares between materials, or copies into a rebuilt one, is never scaled
 * twice. The stars keep the base value: when they share the sky's vector,
 * they get their own. Returns `apply()`, true when it changed a uniform.
 *
 * The vectors are takram's AtmosphereParameters.DEFAULT ones, one per page
 * and read by every globe's materials, so the base of a vector an earlier
 * globe already scaled is the value it had before that (`unscaled`): a
 * globe rebuilt on the page after a lost context took the scaled value as
 * its base and drew the atmosphere scale² bright.
 */
export function createLuminanceScaler(scale, forEachUniform, handles) {
  if (scale === 1 || !forEachUniform) return () => false;
  const bases = new Map(); // key -> { base, target }
  const scaledVectors = new WeakSet();
  let changed = false;
  const entry = (key, value) => {
    let found = bases.get(key);
    if (!found) {
      const base = unscaled.get(value) ?? value;
      found = {
        base: base.clone(),
        target: base.clone().multiplyScalar(scale),
      };
      bases.set(key, found);
    }
    return found;
  };
  let applyScale = true;
  const record = (key, uniform) => entry(key, uniform.value);
  const scaleOne = (key, uniform, scaled) => {
    if (!scaled) return;
    const { base, target } = entry(key, uniform.value);
    const desired = applyScale ? target : base;
    scaledVectors.add(uniform.value);
    if (uniform.value.equals(desired)) return;
    if (!unscaled.has(uniform.value))
      unscaled.set(uniform.value, uniform.value.clone());
    uniform.value.copy(desired);
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
  return (enabled = true) => {
    applyScale = enabled;
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
