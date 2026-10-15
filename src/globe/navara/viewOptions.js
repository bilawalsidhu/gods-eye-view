// How the product builds its Navara view (S4, S5): render on demand (the
// engine's render.setContinuous turns animation on), MSAA 4 as Cesium's
// msaaSamples, the device pixel ratio unless a measurement pins one, a canvas
// whose WebGL2 context keeps its drawing buffer (Cesium's
// contextOptions.webgl.preserveDrawingBuffer, for captures), and a look:
// `cinematic` by default (navaraScenePlan below), Navara's own `photoreal`
// scene (aerial perspective, tone mapping and SMAA, about 5 ms a frame, S5)
// with `?look=photoreal`, and `minimal` (sky, stars, sky light and sun
// without post effects) for benches.

/** WebGL2 attributes Navara 0.2.1 asks for, plus preserveDrawingBuffer. */
export const NAVARA_CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: true,
  antialias: true,
  depth: true,
  stencil: true,
  premultipliedAlpha: true,
  preserveDrawingBuffer: true,
  powerPreference: 'default',
});

const MSAA_SAMPLES = 4;

/** ThreeView options; `pixelRatio` only when a measurement pins it. */
export function navaraViewOptions({ container, canvas, pixelRatio } = {}) {
  return {
    container,
    ...(canvas ? { canvas } : {}),
    animation: false,
    multisampling: MSAA_SAMPLES,
    ...(pixelRatio !== undefined ? { pixelRatio } : {}),
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
const ACES_FILMIC = 6;

// Camera heights (m) where the cinematic look switches the globe to
// atmosphere lighting (night side and terminator) and back. The gap keeps a
// camera hovering near one height from toggling.
export const GLOBE_LIGHTING_ENTER_M = 1_500_000;
export const GLOBE_LIGHTING_EXIT_M = 1_000_000;

/**
 * Whether the cinematic look lights the globe from the atmosphere (deferred
 * irradiance: a real night side) at this camera height. Up close the Google
 * tiles keep their baked lighting: relit, they turn grey and dark (their
 * shadows and shading would count twice). Hysteresis between the two heights.
 */
export function globeLightingAt(height, current = false) {
  if (!Number.isFinite(height)) return current;
  return current
    ? height > GLOBE_LIGHTING_EXIT_M
    : height >= GLOBE_LIGHTING_ENTER_M;
}

// Where the cinematic clouds show. Their layers span 1,500 to 3,000 m above
// the ellipsoid. Above 4 km the camera would look down on them, and they
// would hide the map under clouds that are a backdrop, not weather; over
// ground above 1,000 m (canyons, the Alps) they would cut into the terrain
// as dark puffs.
// Each limit has a gap so a camera near it does not flicker them.
export const CLOUDS_HIDE_ABOVE_M = 4_000;
export const CLOUDS_SHOW_BELOW_M = 3_500;
export const CLOUDS_HIDE_OVER_GROUND_M = 1_000;
export const CLOUDS_SHOW_OVER_GROUND_M = 800;

/**
 * Whether the cinematic clouds show for a camera at `height` looking at
 * ground at `ground` (both metres above the ellipsoid; an unknown ground
 * counts as low).
 */
export function cloudsVisibleAt(height, ground, current = true) {
  if (!Number.isFinite(height)) return current;
  const low = Number.isFinite(ground) ? ground : 0;
  return current
    ? height <= CLOUDS_HIDE_ABOVE_M && low <= CLOUDS_HIDE_OVER_GROUND_M
    : height < CLOUDS_SHOW_BELOW_M && low < CLOUDS_SHOW_OVER_GROUND_M;
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
  // globe from space keep a visible starfield next to a sunlit Earth.
  meshes: [{ sky: {} }, { stars: { intensity: 40, pointSize: 2 } }],
  // The tiles carry baked sunlight, so the sun casts no shadow maps (CSM
  // would cost every frame and darken nothing the tiles show).
  lights: [{ skyLightProbe: {} }, { sun: { castShadow: false } }],
  effects: [
    // Depth-reconstructed normals: Navara 0.2.1's G-buffer normals are zero
    // for Google tiles and the globe, which turns atmosphere lighting black.
    // albedoScale brightens that lighting's day side to the photoreal
    // look's (it scales the albedo only where the atmosphere lights it).
    { aerialPerspective: { useNormalBuffer: false, albedoScale: 2 } },
    ...(mobile
      ? []
      : [
          {
            clouds: {
              // 'low' looks the same here and costs about 1 ms less than
              // 'medium' (clouds cost about 3 ms a frame at 1280×800).
              qualityPreset: 'low',
              coverage: 0.2,
              // No cloud shadows on the ground: dark patches over the map
              // read as features (and cost nothing measurable either way).
              shadows: false,
              // The two cumulus layers start at 1,500 m instead of 750 and
              // 1,000 m, above the city views (Austin's 600 m, Manhattan's
              // 900 m): clouds fill the sky without hiding the streets.
              cloudLayers: [{ altitude: 1500 }, { altitude: 1800 }],
            },
          },
          { lensFlare: {} },
        ]),
    { toneMapping: { mode: ACES_FILMIC } },
    mobile ? { fxaa: {} } : { smaa: {} },
  ],
  globeLighting: true,
});

const PLANS = {
  minimal: () => ({
    pluginDefault: false,
    meshes: [{ sky: {} }, { stars: {} }],
    lights: [{ skyLightProbe: {} }, { sun: {} }],
    effects: [],
    globeLighting: false,
  }),
  photoreal: () => ({
    pluginDefault: true,
    meshes: [],
    lights: [],
    effects: [],
    globeLighting: false,
  }),
  cinematic,
};

/**
 * What the view adds for a look, as Navara descriptors ({ name: config }):
 * - `minimal`: sky, stars, sky light and sun, no post effects (benches);
 * - `photoreal`: the default plugin's addDefaultPhotorealScene (sky, sun,
 *   aerial perspective, lens flare, AgX tone mapping, SMAA);
 * - `cinematic` (the app's default): photoreal plus volumetric clouds for
 *   low views over low ground (cloudsVisibleAt), ACES tone mapping, brighter stars, no sun shadow
 *   maps, and atmosphere lighting of the globe from space (`globeLighting`,
 *   see globeLightingAt). On a mobile-optimized
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
