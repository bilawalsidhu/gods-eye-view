/**
 * Coverage points for the Transit layer's globe view: one soft spot per
 * registered feed, hotter where networks cluster.
 *
 * Built from the registry alone. No feed is polled to draw it, so it says
 * where vehicles CAN be shown, not where any are right now.
 *
 * Pure: no Cesium, no DOM.
 */

import { greatCircleKm } from '../geoDistance.js';

/** Feeds within this distance of a feed count as its neighbours. */
export const COVERAGE_NEIGHBOUR_KM = 150;

/** Spot diameter in CSS px: a lone feed, and the densest cluster. */
export const COVERAGE_SPOT_PX = Object.freeze({ lone: 18, dense: 34 });

/**
 * The bus green of the vehicle markers, from a deep green for a lone network
 * to a pale core where many overlap. The lone end is saturated on purpose: a
 * light translucent green vanishes into pale basemaps and desert imagery.
 */
export const COVERAGE_PALETTE = Object.freeze([
  { at: 0.0, rgb: [24, 196, 106] },
  { at: 0.5, rgb: [94, 240, 138] },
  { at: 1.0, rgb: [206, 255, 196] },
]);

/**
 * Palette colour at a normalized heat.
 * @param {number} t 0..1 (clamped)
 * @returns {[number, number, number]} RGB, 0..255.
 */
export function coverageColorAt(t) {
  const v = Math.min(1, Math.max(0, Number(t) || 0));
  let i = 1;
  while (i < COVERAGE_PALETTE.length - 1 && COVERAGE_PALETTE[i].at < v) i += 1;
  const a = COVERAGE_PALETTE[i - 1];
  const b = COVERAGE_PALETTE[i];
  const k = (v - a.at) / (b.at - a.at || 1);
  return [0, 1, 2].map((c) => Math.round(a.rgb[c] + (b.rgb[c] - a.rgb[c]) * k));
}

/**
 * One coverage point per feed that has a centre.
 *
 * `heat` is logarithmic in the number of neighbours and normalized against
 * the densest feed, so a lone network is always 0 (the same deep green and
 * the same size) however crowded the busiest region is, and a hundred French
 * networks do not wash out one in Bismarck.
 *
 * @param {ReadonlyArray<{id?: string, center: {lat: number, lon: number}}>} feeds
 * @param {{neighbourKm?: number}} [options]
 * @returns {Array<{id: string|null, lat: number, lon: number, neighbours: number,
 *   heat: number, sizePx: number, rgb: [number, number, number]}>}
 */
export function buildTransitCoveragePoints(
  feeds,
  { neighbourKm = COVERAGE_NEIGHBOUR_KM } = {},
) {
  const centred = (feeds || []).filter(
    (feed) =>
      Number.isFinite(feed?.center?.lat) && Number.isFinite(feed?.center?.lon),
  );
  const neighbours = centred.map(
    (feed) =>
      centred.filter(
        (other) =>
          other !== feed &&
          greatCircleKm(feed.center, other.center) <= neighbourKm,
      ).length,
  );
  const densest = Math.max(0, ...neighbours);
  return centred.map((feed, index) => {
    const heat = densest
      ? Math.log1p(neighbours[index]) / Math.log1p(densest)
      : 0;
    return {
      id: feed.id ?? null,
      lat: feed.center.lat,
      lon: feed.center.lon,
      neighbours: neighbours[index],
      heat,
      sizePx: Math.round(
        COVERAGE_SPOT_PX.lone +
          (COVERAGE_SPOT_PX.dense - COVERAGE_SPOT_PX.lone) * heat,
      ),
      rgb: coverageColorAt(heat),
    };
  });
}
