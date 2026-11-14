/**
 * Coverage points for the Transit layer's globe view: one soft spot per
 * registered feed, hotter where networks cluster.
 *
 * Built from the registry alone. No feed is polled to draw it, so it says
 * where vehicles CAN be shown, not where any are right now. Only feeds whose
 * live positions have been seen count: a registry row marked
 * `liveSeen: false` (added while its services were not running) gets no
 * spot until it is confirmed.
 *
 * Pure: no Cesium, no DOM.
 */

import { greatCircleKm } from '../geoDistance.js';

/** Feeds within this distance of a feed count as its neighbours. */
export const COVERAGE_NEIGHBOUR_KM = 150;

/**
 * Radius of a spot from orbit, km: a lone feed, and the densest cluster.
 * Far larger than any network: at whole-globe scale a real service area is
 * under a pixel, and the point is to be seen.
 */
export const COVERAGE_FAR_RADIUS_KM = Object.freeze({ lone: 150, dense: 230 });

/**
 * Radius of a spot at regional zoom, km: the feed's own polling radius,
 * held between these bounds so a village network is still a visible patch
 * and a regional coach network does not paint a whole country.
 */
export const COVERAGE_NEAR_RADIUS_KM = Object.freeze({ min: 22, max: 75 });

/** Heat is drawn in this many steps, one draw batch each. */
export const COVERAGE_HEAT_BUCKETS = 6;

/**
 * Share of full strength one spot carries: 1 for a lone network, less for one
 * in a crowd. Spots in a cluster overlap, and at full strength each they
 * pile into a flat white blob with visible disc edges; thinned by the square
 * root of the crowd they add up to one smooth field that still brightens
 * toward its centre.
 * @param {number} neighbours
 * @returns {number} 0..1
 */
export function coverageSpotStrength(neighbours) {
  const crowd = Math.max(0, Number(neighbours) || 0);
  return Number((0.3 + 0.7 / Math.sqrt(1 + crowd)).toFixed(3));
}

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
 * One coverage point per feed that has a centre and has been seen live.
 *
 * `heat` is logarithmic in the number of neighbours and normalized against
 * the densest feed, so a lone network is always 0 (the same deep green and
 * the same size) however crowded the busiest region is, and a hundred French
 * networks do not wash out one in Bismarck. Heat is then stepped into
 * COVERAGE_HEAT_BUCKETS buckets, which set the spot's colour and strength.
 *
 * @param {ReadonlyArray<{id?: string, center: {lat: number, lon: number}}>} feeds
 * @param {{neighbourKm?: number}} [options]
 * @returns {Array<{id: string|null, lat: number, lon: number, neighbours: number,
 *   heat: number, bucket: number, farRadiusKm: number, nearRadiusKm: number,
 *   strength: number, rgb: [number, number, number]}>}
 */
export function buildTransitCoveragePoints(
  feeds,
  { neighbourKm = COVERAGE_NEIGHBOUR_KM } = {},
) {
  const centred = (feeds || []).filter(
    (feed) =>
      feed?.liveSeen !== false &&
      Number.isFinite(feed?.center?.lat) &&
      Number.isFinite(feed?.center?.lon),
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
    const top = COVERAGE_HEAT_BUCKETS - 1;
    const bucket = Math.round(heat * top);
    return {
      id: feed.id ?? null,
      lat: feed.center.lat,
      lon: feed.center.lon,
      neighbours: neighbours[index],
      heat,
      bucket,
      farRadiusKm: Math.round(
        COVERAGE_FAR_RADIUS_KM.lone +
          (COVERAGE_FAR_RADIUS_KM.dense - COVERAGE_FAR_RADIUS_KM.lone) * heat,
      ),
      nearRadiusKm: Math.min(
        COVERAGE_NEAR_RADIUS_KM.max,
        Math.max(
          COVERAGE_NEAR_RADIUS_KM.min,
          Number(feed.loadRadiusKm) || COVERAGE_NEAR_RADIUS_KM.min,
        ),
      ),
      // Colour and strength follow the bucket, so every spot in a batch
      // shares one material.
      strength: coverageSpotStrength(
        Math.expm1((bucket / top) * Math.log1p(densest || 1)),
      ),
      rgb: coverageColorAt(bucket / top),
    };
  });
}
