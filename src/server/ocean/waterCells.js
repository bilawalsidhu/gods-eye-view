/**
 * @file Water-cell mask for ocean-field coverage accounting.
 *
 * The HF-radar tier is only served when the objective analysis actually fills
 * the view. Measuring that as `finite cells / ALL cells` silently penalises
 * every coastal box, which is exactly where HF radar exists: a 1° box centred
 * on Monterey Bay is roughly half land (the Santa Cruz mountains and the
 * Salinas valley), so an analysis that covers the water perfectly still scores
 * ~40% and is demoted to the 0.25° global tier. Measured live 2026-09-01: the
 * same radar hour scored 20% over a 1°×1° coastal box and 99.9% over a
 * 0.6°×0.6° box moved offshore — the difference was land, not data.
 *
 * So coverage is computed over the cells that COULD hold a current. This module
 * classifies a field lattice against the bundled GSHHG 1/8° land/sea bitmask
 * that already ships with this project for click gating and drift beaching.
 *
 * Three-state mask semantics matter here. Only `MASK_LAND` is excluded;
 * `MASK_COASTAL` (a 1/8° cell containing a shoreline, so partly wet) stays
 * eligible, because HF radar legitimately reports vectors inside those cells
 * and refusing them would re-introduce the same coastal penalty in miniature.
 *
 * @module server/ocean/waterCells
 */

// The Node byte source, not `data/landSeaMask.js`: this module runs in the
// dev/preview server, where the browser loader's `fetch` of a file: URL cannot
// work. Both sit over the same pure codec, so the decoded mask is identical.
import { loadLandSeaMaskNode, maskStateAt, MASK_LAND } from '../landSeaMaskNode.js';

/**
 * Classify every cell of a field lattice as water-eligible or land.
 *
 * The lattice is the `{lat0, lon0, dLat, dLon, nLat, nLon}` geometry the field
 * payload ships, indexed row-major as `latIndex * nLon + lonIndex`. Longitudes
 * beyond ±180 (an antimeridian-crossing box) are wrapped before lookup.
 *
 * @param {{lat0: number, lon0: number, dLat: number, dLon: number, nLat: number, nLon: number}} grid
 * @param {{width: number, height: number, data: Uint8Array}} mask - Decoded bitmask.
 * @returns {{eligible: Uint8Array, eligibleCount: number, landCount: number}}
 *   `eligible[k] === 1` where the cell may hold a current. Counts sum to
 *   `nLat * nLon`.
 */
export function classifyWaterCells(grid, mask) {
  const { lat0, lon0, dLat, dLon, nLat, nLon } = grid;
  const total = nLat * nLon;
  const eligible = new Uint8Array(total);
  let eligibleCount = 0;
  for (let i = 0; i < nLat; i += 1) {
    const lat = lat0 + i * dLat;
    for (let j = 0; j < nLon; j += 1) {
      // Wrap into [-180, 180) — the payload's lon axis may run past +180.
      const lon = ((lon0 + j * dLon + 180) % 360 + 360) % 360 - 180;
      if (maskStateAt(mask, lat, lon) !== MASK_LAND) {
        eligible[i * nLon + j] = 1;
        eligibleCount += 1;
      }
    }
  }
  return { eligible, eligibleCount, landCount: total - eligibleCount };
}

/**
 * Load the bundled mask and classify a lattice, or return null when the mask is
 * unavailable.
 *
 * A missing mask must NOT be treated as "everything is water" or as "nothing
 * is" — either would silently change the tier decision. Callers fall back to
 * whole-lattice coverage and say so, rather than reporting a water-relative
 * number they could not compute.
 *
 * @param {Object} grid - Field lattice geometry, see {@link classifyWaterCells}.
 * @param {{loadMask?: Function}} [deps] - Injectable loader for tests.
 * @returns {Promise<?{eligible: Uint8Array, eligibleCount: number, landCount: number}>}
 */
export async function classifyWaterCellsFromBundle(grid, deps = {}) {
  const load = deps.loadMask ?? loadLandSeaMaskNode;
  try {
    const mask = await load();
    if (!mask?.data || !mask.width || !mask.height) return null;
    return classifyWaterCells(grid, mask);
  } catch {
    return null;
  }
}

/**
 * Coverage of an analysed field over the cells that could hold a current.
 *
 * @param {Array<?number>} u - Wire-format u array; `null` marks no data.
 * @param {?{eligible: Uint8Array, eligibleCount: number}} water - Classification,
 *   or null when the mask was unavailable.
 * @returns {{coverage: number, waterRelative: boolean, eligibleCount: number}}
 *   `waterRelative` is false when the figure had to fall back to whole-lattice
 *   coverage, so the caller can label it honestly.
 */
export function waterCoverage(u, water) {
  if (!water || water.eligibleCount <= 0) {
    const finite = u.reduce((count, value) => count + (value == null ? 0 : 1), 0);
    return {
      coverage: u.length > 0 ? finite / u.length : 0,
      waterRelative: false,
      eligibleCount: u.length,
    };
  }
  let finite = 0;
  for (let k = 0; k < u.length; k += 1) {
    if (water.eligible[k] === 1 && u[k] != null) finite += 1;
  }
  return {
    coverage: finite / water.eligibleCount,
    waterRelative: true,
    eligibleCount: water.eligibleCount,
  };
}

/**
 * Blank land cells in a packed field, in place.
 *
 * A Barnes kernel with a 10 km length scale happily extrapolates a vector up to
 * 3L inland, and the global tier's 0.25° cells straddle coastlines. Drawing a
 * current over dry land is the most obviously wrong thing this layer could do,
 * so land cells are set to `null` — no data, not zero.
 *
 * @param {Array<?number>} u @param {Array<?number>} v
 * @param {?{eligible: Uint8Array}} water
 * @returns {number} Count of cells blanked.
 */
export function blankLandCells(u, v, water) {
  if (!water) return 0;
  let blanked = 0;
  for (let k = 0; k < u.length; k += 1) {
    if (water.eligible[k] !== 1 && u[k] != null) {
      u[k] = null;
      v[k] = null;
      blanked += 1;
    }
  }
  return blanked;
}
