// Render-quality presets for the main viewer.
//
// WHY THIS EXISTS
//
// The viewer ships at msaaSamples 4 and never sets `resolutionScale`, so it
// renders at full device pixel ratio with 4x multisampling. On a discrete GPU
// that is the right default and this module leaves it untouched. On integrated
// graphics it is the difference between a usable globe and a slideshow.
//
// Measured on an Intel UHD 770 (ANGLE/D3D11, i7-12700T), 1264x705 canvas,
// keyless Esri basemap, no layers enabled, parked camera, warm tile cache.
// Median rendered fps over 4 interleaved A/B rounds, frames counted from
// `scene.postRender` with the canvas size asserted unchanged on every arm:
//
//     as shipped (msaa 4, scale 1.0) ............ 17.9 fps
//     msaa 2 .................................... 20.5 fps   (+15%)
//     msaa 1 .................................... 29.6 fps   (+65%)
//     resolutionScale 0.75 ...................... 26.3 fps   (+47%)
//     resolutionScale 0.5 ....................... 35.6 fps   (+99%)
//     msaa 1 + resolutionScale 0.5 .............. 46.5 fps  (+160%)
//
// Two things that sound like wins measured as noise on that hardware and are
// deliberately NOT part of any preset: dropping `preserveDrawingBuffer`
// (17.9 -> 18.2 fps, overlapping samples across two runs) and removing every
// `backdrop-filter` (+6% in one run, -1% in another).
//
// Scaling is sub-linear: fitting frame time against pixel count across scales
// 1.0/0.75/0.5/0.35/0.25 gives roughly 22 ms fixed + 40 ms per megapixel. The
// fixed term is outside JS (the main thread is idle ~72% of the time and the
// Cesium render phase measures ~11 ms), so no preset here can exceed roughly
// 44 fps on that machine. Presets buy back the resolution-dependent half.
//
// DEFAULT IS UNCHANGED. 'high' reproduces today's behavior exactly; nothing
// below applies unless a user opts in.

/**
 * @typedef {object} RenderQualityPreset
 * @property {number} msaaSamples Cesium `scene.msaaSamples`.
 * @property {number} resolutionScale Cesium `viewer.resolutionScale`.
 * @property {string} description Short human-readable summary.
 */

/** The shipped default: full resolution, 4x MSAA. Identical to prior behavior. */
export const RENDER_QUALITY_DEFAULT = 'high';

/** @type {Readonly<Record<string, RenderQualityPreset>>} */
export const RENDER_QUALITY_PRESETS = Object.freeze({
  high: Object.freeze({
    msaaSamples: 4,
    resolutionScale: 1.0,
    description: 'Full resolution, 4x MSAA (default, unchanged)',
  }),
  balanced: Object.freeze({
    msaaSamples: 2,
    resolutionScale: 0.85,
    description: 'Slightly softer edges, ~15% fewer pixels',
  }),
  performance: Object.freeze({
    msaaSamples: 1,
    resolutionScale: 0.6,
    description: 'No MSAA, 60% resolution — for integrated GPUs',
  }),
});

/** Preset names, in descending visual fidelity. */
export const RENDER_QUALITY_NAMES = Object.freeze(
  Object.keys(RENDER_QUALITY_PRESETS),
);

/**
 * Resolve the requested preset name from a `location.search` string.
 *
 * Mirrors the existing query-flag convention (`?detectDebug=1`,
 * `?trafficDebug=1`): a pure function over the search string so it is
 * testable without a DOM, and total — an unknown, empty or malformed value
 * falls back to the default rather than throwing.
 *
 * @param {string} [search] A `location.search` string.
 * @returns {string} A key of `RENDER_QUALITY_PRESETS`.
 */
export function resolveRenderQualityName(search) {
  let raw = null;
  try {
    raw = new URLSearchParams(String(search ?? '')).get('quality');
  } catch {
    return RENDER_QUALITY_DEFAULT;
  }
  if (raw == null) return RENDER_QUALITY_DEFAULT;
  const name = String(raw).trim().toLowerCase();
  return Object.hasOwn(RENDER_QUALITY_PRESETS, name)
    ? name
    : RENDER_QUALITY_DEFAULT;
}

/**
 * Look up a preset by name, falling back to the default.
 * @param {string} [name]
 * @returns {RenderQualityPreset}
 */
export function renderQualityPreset(name) {
  const key = Object.hasOwn(RENDER_QUALITY_PRESETS, String(name))
    ? String(name)
    : RENDER_QUALITY_DEFAULT;
  return RENDER_QUALITY_PRESETS[key];
}

/**
 * Apply a preset to a live viewer.
 *
 * Both properties are runtime-settable in Cesium, so this deliberately does
 * NOT touch viewer construction — the preset can be changed later without
 * rebuilding the WebGL context. Applying 'high' is a no-op against a
 * freshly-created viewer.
 *
 * Fails soft: a viewer whose scene is missing (or a Cesium build that rejects
 * a value) must never take down startup over a display preference.
 *
 * @param {object} viewer A Cesium Viewer.
 * @param {string} [name] Preset name; unknown names use the default.
 * @returns {RenderQualityPreset|null} The preset applied, or null if it could not be.
 */
export function applyRenderQuality(viewer, name) {
  const preset = renderQualityPreset(name);
  if (!viewer?.scene) return null;
  try {
    viewer.scene.msaaSamples = preset.msaaSamples;
    viewer.resolutionScale = preset.resolutionScale;
    return preset;
  } catch {
    return null;
  }
}
