// How the product builds its Navara view (S4, S5): render on demand (the
// engine's render.setContinuous turns animation on), MSAA 4 as Cesium's
// msaaSamples, the device pixel ratio unless a measurement pins one, a canvas
// whose WebGL2 context keeps its drawing buffer (Cesium's
// contextOptions.webgl.preserveDrawingBuffer, for captures), and the
// `minimal` look: sky, stars, sky light and sun without post effects —
// Navara's photoreal chain costs about 5 ms a frame and greys the Google
// tiles with tone mapping.

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

const PLANS = {
  minimal: { pluginDefault: false, effects: [] },
  photoreal: { pluginDefault: true, effects: [] },
};

/**
 * What the view adds for a look: descriptor names, or the default plugin's
 * own addDefaultPhotorealScene (sky, sun, aerial perspective, lens flare,
 * tone mapping, SMAA).
 */
export function navaraScenePlan(effects = 'minimal') {
  if (!Object.hasOwn(PLANS, effects))
    throw new RangeError(`Unknown Navara effects: ${effects}`);
  return {
    pluginDefault: PLANS[effects].pluginDefault,
    meshes: ['sky', 'stars'],
    lights: ['skyLightProbe', 'sun'],
    effects: [...PLANS[effects].effects],
  };
}
