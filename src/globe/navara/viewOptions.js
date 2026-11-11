// How the product builds its Navara view: render on demand (the engine's
// render.setContinuous turns animation on), at CSS pixels without MSAA as
// Cesium draws, or in HD at the device pixel ratio with MSAA 4 as Cesium's
// msaaSamples, a canvas whose WebGL2 context keeps its drawing
// buffer (Cesium's contextOptions.webgl.preserveDrawingBuffer, for captures),
// and a look: `cinematic` by default (navaraScenePlan below), Navara's own
// `photoreal` scene (aerial perspective, tone mapping and SMAA, about 5 ms a
// frame) with `?look=photoreal`, and `minimal` (sky, stars, sky light and sun
// without post effects) for benches.

import { Vector2 } from 'three';

/**
 * WebGL2 attributes Navara 0.2.1 asks for, plus preserveDrawingBuffer, but
 * without antialias: Navara draws into its own (MSAA) targets and only copies
 * the result to the canvas, so a multisampled canvas costs about 36 MiB for
 * nothing (pixel-identical frames).
 */
export const NAVARA_CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: true,
  antialias: false,
  depth: true,
  stencil: true,
  premultipliedAlpha: true,
  preserveDrawingBuffer: true,
  powerPreference: 'default',
});

const HD_MSAA_SAMPLES = 4;

/**
 * ThreeView options. Without `hd` the view draws at CSS pixels without MSAA
 * (on a 2x screen about 1 GiB less than HD; SMAA still smooths edges).
 */
export function navaraViewOptions({ container, canvas, hd = false } = {}) {
  return {
    container,
    ...(canvas ? { canvas } : {}),
    animation: false,
    ...(hd ? {} : { pixelRatio: 1 }),
    multisampling: hd ? HD_MSAA_SAMPLES : 0,
  };
}

/** The looks the view can build; the app takes `?look=` (cinematic by default). */
export const NAVARA_LOOKS = Object.freeze([
  'minimal',
  'photoreal',
  'cinematic',
]);
export const DEFAULT_NAVARA_LOOK = 'cinematic';

/** The look named by `?look=` in `search`, else the default (cinematic). */
export function resolveNavaraLook(search = '') {
  const value = String(new URLSearchParams(search).get('look') ?? '')
    .trim()
    .toLowerCase();
  return NAVARA_LOOKS.includes(value) ? value : DEFAULT_NAVARA_LOOK;
}

// postprocessing's ToneMappingMode.ACES_FILMIC (Navara's default is AGX, 7).
export const ACES_FILMIC = 6;
export const AGX = 7;
export const LINEAR = 0;

// Map textures already encode their lighting. Atmosphere belongs in the sky
// and clouds, not in a second lighting or haze pass over those colours.
export const MAP_AERIAL_PERSPECTIVE = Object.freeze({
  irradiance: false,
  transmittance: false,
  inscatter: false,
});

// Pick early afternoon at the starting landscape longitude. The look keeps
// this timestamp while the user explores; telemetry uses its own clock.
export function landscapeSunTime(now, longitude) {
  const hour = 3_600_000;
  const day = 24 * hour;
  const offset = (longitude / 15) * hour;
  return Math.floor((now + offset) / day) * day + 13 * hour - offset;
}

// Navara cloud layers use ellipsoid heights. Over uplands raise the two
// cumulus layers together; at world scale a single ground sample no longer
// represents the whole view. Quantize the offset to avoid tiny layer updates.
export const LOCAL_CLOUD_COVERAGE = 0.36;
export const CUMULUS_BASES = Object.freeze([1500, 1800]);
export function cloudTerrainOffset(height, ground) {
  if (!Number.isFinite(ground) || height >= STARS_SPACE_ENTER_M) return 0;
  return Math.ceil(Math.max(0, ground - 500) / 500) * 750;
}

// Navara's sky and clouds come from the atmosphere model in physical
// radiance, scaled for a tone-mapping exposure near 10, while the Google
// tiles carry baked colours that need exposure 1. At exposure 1 the noon sky
// came out dark navy (sRGB about 39, 58, 90 at Manhattan facing the
// horizon), and the stars showed through it. The cinematic look multiplies
// the atmosphere's radiance-to-luminance factors (not the stars) by this
// scale instead of raising the exposure, so the sky turns daylight blue
// and the tiles keep their colours.
export const ATMOSPHERE_LUMINANCE_SCALE = 3;

// Stars show from space or once the sun is well below the horizon at the
// camera (civil twilight), and hide in a daylit sky. Gaps keep a camera
// near a limit from flickering them.
export const STARS_SHOW_SUN_BELOW_DEG = -6;
export const STARS_HIDE_SUN_ABOVE_DEG = -4;
export const STARS_SPACE_ENTER_M = 100_000;
export const STARS_SPACE_EXIT_M = 80_000;

// Keep the sunlit cloud tops through twilight. Hide them locally at night.
export const CLOUDS_HIDE_SUN_BELOW_DEG = -6;
export const CLOUDS_SHOW_SUN_ABOVE_DEG = -4;

/** Whether the sun is up enough for the cinematic clouds; NaN keeps `current`. */
export function cloudsSunlitAt(sunElevation, current = true) {
  if (!Number.isFinite(sunElevation)) return current;
  return current
    ? sunElevation >= CLOUDS_HIDE_SUN_BELOW_DEG
    : sunElevation > CLOUDS_SHOW_SUN_ABOVE_DEG;
}

/**
 * Whether the cinematic stars show for a camera at `height` (metres above
 * the ellipsoid) with the sun `sunElevation` degrees above its horizon; an
 * unknown height or sun elevation keeps `current`.
 */
export function starsVisibleAt(height, sunElevation, current = true) {
  if (!Number.isFinite(height)) return current;
  if (current ? height > STARS_SPACE_EXIT_M : height >= STARS_SPACE_ENTER_M)
    return true;
  if (!Number.isFinite(sunElevation)) return current;
  return current
    ? sunElevation <= STARS_HIDE_SUN_ABOVE_DEG
    : sunElevation < STARS_SHOW_SUN_BELOW_DEG;
}

/**
 * Whether the atmosphere's sun date has drifted from the wall clock (the
 * HUD's SUN elevation uses `new Date()`) by more than a minute.
 */
export function sunDateStale(atmosphereMs, nowMs, toleranceMs = 60_000) {
  return !(Math.abs(nowMs - atmosphereMs) <= toleranceMs);
}

const cinematic = (mobile) => ({
  pluginDefault: false,
  // Brighter, larger stars (defaults 10 and 1 px) so the night sky and the
  // globe from space keep a visible starfield next to a sunlit Earth. The
  // atmosphere scale leaves the stars at their base factor (look.js).
  meshes: [
    { sky: {} },
    {
      stars: {
        intensity: 120,
        pointSize: 2,
      },
    },
  ],
  // The tiles carry baked sunlight, so the sun casts no shadow maps (CSM
  // would cost every frame and darken nothing the tiles show).
  lights: [{ skyLightProbe: {} }, { sun: { castShadow: false } }],
  effects: [
    { aerialPerspective: { ...MAP_AERIAL_PERSPECTIVE } },
    ...(mobile
      ? []
      : [
          {
            clouds: {
              qualityPreset: 'low',
              coverage: LOCAL_CLOUD_COVERAGE,
              // No cloud shadows on the ground: dark patches over the map
              // read as features (and cost nothing measurable either way).
              shadows: false,
              // The clouds still shade themselves from these maps. The low
              // preset's 256² and 2 cascades, which Navara 0.2.1 overwrites
              // with its 512² and 3 (4 MiB instead of 24).
              shadowMapSize: new Vector2(256, 256),
              shadowCascadeCount: 2,
              // The two cumulus layers start at 1,500 m instead of 750 and
              // 1,000 m, above the city views (Austin's 600 m, Manhattan's
              // 900 m): clouds fill the sky without hiding the streets.
              cloudLayers: CUMULUS_BASES.map((altitude) => ({ altitude })),
            },
          },
          { lensFlare: {} },
        ]),
    { toneMapping: { mode: ACES_FILMIC } },
    mobile ? { fxaa: {} } : { smaa: {} },
  ],
  inspectionDaylight: true,
  atmosphereLuminance: ATMOSPHERE_LUMINANCE_SCALE,
  daylightHidesStars: true,
});

const PLANS = {
  minimal: () => ({
    pluginDefault: false,
    meshes: [{ sky: {} }, { stars: {} }],
    // Match cinematic: Google tiles already carry baked sunlight.
    lights: [{ skyLightProbe: {} }, { sun: { castShadow: false } }],
    effects: [],
    inspectionDaylight: false,
    atmosphereLuminance: 1,
    daylightHidesStars: false,
  }),
  photoreal: () => ({
    pluginDefault: true,
    meshes: [],
    lights: [],
    effects: [],
    inspectionDaylight: false,
    atmosphereLuminance: 1,
    daylightHidesStars: false,
  }),
  cinematic,
};

/**
 * What the view adds for a look, as Navara descriptors ({ name: config }):
 * - `minimal`: sky, stars, sky light and sun, no post effects (benches);
 * - `photoreal`: the default plugin's addDefaultPhotorealScene (sky, sun,
 *   aerial perspective, lens flare, AgX tone mapping, SMAA);
 * - `cinematic` (the app's default): photoreal plus volumetric clouds for
 *   mountain and coastal views, ACES tone mapping, brighter stars, no sun shadow
 *   maps, a brighter atmosphere (ATMOSPHERE_LUMINANCE_SCALE)
 *   and stars only at night or from space (starsVisibleAt). On a mobile-optimized
 *   view it drops the clouds and the lens flare and uses FXAA.
 */
export function navaraScenePlan(
  look = DEFAULT_NAVARA_LOOK,
  { mobile = false } = {},
) {
  if (!Object.hasOwn(PLANS, look))
    throw new RangeError(`Unknown Navara look: ${look}`);
  return PLANS[look](mobile);
}
