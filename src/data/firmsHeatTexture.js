/**
 * WASM heat-texture bridge for the FIRMS cells LOD bands (`global`, `regional`).
 *
 * The legacy cells render creates one ground rectangle ENTITY per aggregated
 * cell (≤1800 global / ≤3600 regional) — Cesium turns each into its own ground
 * geometry, so the per-frame scene cost scales with the cell cap. This module
 * renders the SAME aggregated cells (same `aggregateFires` output, same heat
 * score, same cards/labels) into ONE Gaussian-splat RGBA texture via the
 * wasm-pack crate `rust/firms-renderer/`, displayed as a single
 * ImageMaterialProperty rectangle. N ground primitives → 1.
 *
 * Division of labour (keeps this file unit-testable and Cesium-free):
 * - pure helpers here: texture layout math, splat-input building, buffer→canvas
 * - `firmsHeatmap.js` owns all Cesium objects (rectangle entity, materials)
 * - the crate owns the per-pixel splat accumulation
 *
 * Visual note (sanctioned divergence, docs/PLAN.md Phase 5): the crate's fixed
 * ramp (R=intensity, G=0.6·intensity, B=0) is orange throughout — it does not
 * reproduce the legacy per-cell yellow→orange→red stops. Heat ordering and
 * alpha ramp are preserved via the brightness input; the hard cell edges soften
 * into a continuous field (that is the point of splatting).
 *
 * Kill switch: `?firmsWasm=0` forces the legacy entity path (also the automatic
 * fallback when the WASM module fails to load, initialize, or render).
 */

/** Texture pixels per grid cell. The crate splats a 5×5 σ=1.5 kernel per
 * point; at 6 px/cell neighbouring splats blend into a continuous field while
 * per-cell structure stays readable. Resolution is grid-matched, not
 * screen-matched — Cesium's linear filtering magnifies it across the ground
 * rectangle, so a small texture costs nothing per frame. */
const PX_PER_CELL = 6;
/** Texture size clamps (squared aspect preserved per axis via the same scale). */
const MIN_TEXTURE_PX = 32;
const MAX_TEXTURE_PX = 1024;
/** The crate normalizes brightness over [300, 500] K to 0..255. */
const BRIGHTNESS_MIN = 300;
const BRIGHTNESS_SPAN = 200;
/** Re-attempt a failed WASM load after this long (next cells rebuild). */
const LOAD_RETRY_MS = 60_000;

/**
 * Kill switch + graceful-degradation gate. Read from the URL each call so QA
 * can flip it with a reload, not a rebuild.
 * @returns {boolean} True when the WASM texture path may be attempted.
 */
export function wasmHeatRenderingEnabled() {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get('firmsWasm') !== '0';
  } catch {
    return true;
  }
}

/** Latest module-level load failure (for getStats surfacing). */
let lastLoadError = null;
let lastLoadAttemptMs = -Infinity;
/** @type {?Promise<?object>} Resolved module, or null after a failed attempt. */
let rendererPromise = null;

/**
 * Lazily import and initialize the wasm-pack renderer. The module lives in
 * `public/wasm/firms-renderer/` (gitignored build artifact — regenerate with
 * `npm run build:wasm`), so the import target is a runtime URL, deliberately
 * outside Vite's graph. Failed attempts are remembered for LOAD_RETRY_MS so a
 * missing artifact degrades to the entity path without retrying per rebuild.
 * @returns {?Promise<?object>} Promise of `{ render, version }`, or null when
 *   the WASM path is known-unavailable (recent failure, no dynamic import).
 */
export function loadHeatRenderer() {
  const now = Date.now();
  if (rendererPromise && now - lastLoadAttemptMs < LOAD_RETRY_MS) return rendererPromise;
  lastLoadAttemptMs = now;
  lastLoadError = null;
  const glueUrl = new URL('/wasm/firms-renderer/firms_renderer.js', globalThis.location?.href || 'file:///');
  rendererPromise = import(/* @vite-ignore */ glueUrl.href)
    .then((mod) => {
      const init = mod.default;
      if (typeof init !== 'function') throw new Error('wasm glue has no default init');
      return init().then(() => {
        if (typeof mod.render_heatmap !== 'function') throw new Error('wasm glue lacks render_heatmap');
        return {
          render: mod.render_heatmap,
          version: mod.version,
        };
      });
    })
    .catch((error) => {
      lastLoadError = String(error?.message || error).slice(0, 120);
      return null;
    });
  return rendererPromise;
}

/** Last WASM glue load error (null when none), for layer stats/QA. */
export function lastRendererError() {
  return lastLoadError;
}

/**
 * Compute the splat-texture layout for a padded view bounds + grid size.
 * Anti-meridian aware: a wrapping bounds (west > east) maps longitudes onto
 * [west, west + 360) so cell centers right of the anti-meridian land at the
 * texture's right edge, and the Cesium rectangle (which supports west > east)
 * maps it back around the globe.
 * @param {{west: number, south: number, east: number, north: number, wraps: boolean}|null} bounds
 *   Padded degree bounds (null → whole-globe texture).
 * @param {number} gridDegrees - Active LOD grid size.
 * @returns {?{width: number, height: number, west: number, south: number,
 *   lonSpan: number, latSpan: number}} Layout, or null when degenerate.
 */
export function computeHeatTextureLayout(bounds, gridDegrees) {
  const west = bounds ? bounds.west : -180;
  const south = bounds ? bounds.south : -90;
  const east = bounds ? bounds.east : 180;
  const north = bounds ? bounds.north : 90;
  const lonSpan = bounds?.wraps ? east - west + 360 : east - west;
  const latSpan = north - south;
  if (!(lonSpan > 0) || !(latSpan > 0) || !(gridDegrees > 0)) return null;

  // Square pixels: one scale derived from the cell size, applied to both axes.
  const scale = PX_PER_CELL / gridDegrees;
  const width = Math.max(MIN_TEXTURE_PX, Math.min(MAX_TEXTURE_PX, Math.round(lonSpan * scale)));
  const height = Math.max(MIN_TEXTURE_PX, Math.min(MAX_TEXTURE_PX, Math.round(latSpan * scale)));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { width, height, west, south, lonSpan, latSpan };
}

/**
 * Map a cell's longitude into the texture's unwrapped [west, west + 360)
 * domain (no-op for non-wrapping bounds).
 * @param {number} lon - Cell center longitude in degrees.
 * @param {{west: number, wraps: boolean}} bounds - Degree bounds.
 * @returns {number} Texture-domain longitude.
 */
export function textureDomainLon(lon, bounds) {
  if (!bounds?.wraps) return lon;
  let unwrapped = lon;
  while (unwrapped < bounds.west) unwrapped += 360;
  while (unwrapped >= bounds.west + 360) unwrapped -= 360;
  return unwrapped;
}

/**
 * Build the flat Float64/Int32 splat inputs the crate's `render_heatmap`
 * expects, from the heat-sorted capped cell list.
 *
 * Brightness encodes the legacy normalized intensity: `sqrt(score/maxScore)`
 * — the exact value the entity path uses for its alpha ramp — rescaled into
 * the crate's 300–500 K window, so texture heat ordering matches the entity
 * path cell-for-cell.
 * @param {Array<Object>} cells - Aggregated cells (aggregateFires output).
 * @param {{gridDegrees: number}} lod - Active LOD descriptor.
 * @param {{west: number, south: number, east: number, north: number,
 *   wraps: boolean}|null} bounds - Padded degree bounds (null → all cells).
 * @returns {{lons: Float64Array, lats: Float64Array, brights: Int32Array,
 *   maxScore: number}|null} Splat inputs, or null when nothing qualifies.
 */
export function buildSplatInputs(cells, lod, bounds) {
  if (!Array.isArray(cells) || !cells.length || !(lod?.gridDegrees > 0)) return null;

  // Loop (not spread) — the cap is 3600 today but the V8 spread-arg limit bit
  // this codebase once already (vite/proxies/firms.js FIRMS RangeError).
  let maxScore = 1;
  for (const cell of cells) {
    const score = cellScore(cell);
    if (score > maxScore) maxScore = score;
  }

  const inside = bounds
    ? cells.filter((cell) => cellInBounds(cell, lod.gridDegrees, bounds))
    : cells;
  if (!inside.length) return null;

  const lons = new Float64Array(inside.length);
  const lats = new Float64Array(inside.length);
  const brights = new Int32Array(inside.length);
  for (let i = 0; i < inside.length; i += 1) {
    const cell = inside[i];
    const normalized = Math.min(1, Math.sqrt(cellScore(cell) / maxScore));
    lons[i] = textureDomainLon(cell.lonCell + lod.gridDegrees / 2, bounds ?? undefined);
    lats[i] = cell.latCell + lod.gridDegrees / 2;
    brights[i] = Math.round(BRIGHTNESS_MIN + normalized * BRIGHTNESS_SPAN);
  }
  return { lons, lats, brights, maxScore };
}

/** Same weight as firmsHeatmap.heatScore — duplicated here (not imported) to
 * keep this module importable from unit tests without pulling Cesium in.
 * If one changes, change both; the texture/entity alpha parity depends on it. */
function cellScore(cell) {
  return cell.intensity + cell.count * 0.8 + cell.night * 0.6 + cell.maxFrp * 0.12;
}

/** Point-in-bounds in degrees (cell rectangle vs padded bounds), mirroring
 * firmsHeatmap.cellIntersectsBounds — keep in sync with it. */
function cellInBounds(cell, gridDegrees, bounds) {
  if (cell.latCell + gridDegrees < bounds.south || cell.latCell > bounds.north) return false;
  const west = cell.lonCell;
  const east = cell.lonCell + gridDegrees;
  if (bounds.wraps) return east >= bounds.west || west <= bounds.east;
  return east >= bounds.west && west <= bounds.east;
}

/**
 * Run the WASM splat pass and paint the result into a canvas.
 * @param {{render: Function}} renderer - Loaded WASM renderer.
 * @param {{lons: Float64Array, lats: Float64Array, brights: Int32Array}} inputs
 *   - From {@link buildSplatInputs}.
 * @param {{width: number, height: number, west: number, south: number,
 *   lonSpan: number, latSpan: number}} layout - From computeHeatTextureLayout.
 * @param {Document|object} [documentLike=document] - DOM (injected for tests).
 * @returns {?{canvas: HTMLCanvasElement, pixels: Uint8ClampedArray}} Painted
 *   canvas, or null when the render produced nothing usable.
 */
export function renderHeatTexture(renderer, inputs, layout, documentLike = globalThis.document) {
  if (!renderer || !inputs || !layout) return null;
  const pixels = renderer.render(
    inputs.lons,
    inputs.lats,
    inputs.brights,
    layout.width,
    layout.height,
    layout.west,
    layout.west + layout.lonSpan,
    layout.south,
    layout.south + layout.latSpan,
  );
  if (!(pixels instanceof globalThis.Uint8ClampedArray) || pixels.length !== layout.width * layout.height * 4) {
    return null;
  }
  if (!documentLike) return null;
  const canvas = documentLike.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  // Browser: new ImageData(data, w, h) is the only constructor form that
  // accepts pixel data. Node test stubs (no ImageData global) inject
  // createImageData instead.
  const imageData = typeof ImageData === 'function'
    ? new ImageData(pixels, layout.width, layout.height)
    : documentLike.createImageData(pixels, layout.width, layout.height);
  context.putImageData(imageData, 0, 0);
  return { canvas, pixels };
}
