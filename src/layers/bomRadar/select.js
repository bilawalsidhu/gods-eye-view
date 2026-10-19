import { BOM_RANGE_KM, bomProductRangeKm } from './records.js';

/** Camera altitude (metres) below which the finest product is preferred. */
export const BOM_NEAR_HEIGHT_M = 150_000;
/** Camera altitude (metres) below which the 128 km product is preferred. */
export const BOM_MID_HEIGHT_M = 600_000;
// Another radar must be this much closer before the view switches to it.
const RADAR_SWITCH_RATIO = 0.85;
// Altitude margin before a different range replaces the current product.
const HEIGHT_HYSTERESIS = 1.25;
// Nearest radars tried when the closest has no product covering the view.
const NEAREST_RADARS = 3;

/** Preferred range, then fallbacks, for a camera this high above the ellipsoid. */
export function bomRangePreference(heightMetres) {
  const height = Number.isFinite(heightMetres) ? heightMetres : Infinity;
  if (height < BOM_NEAR_HEIGHT_M) return [64, 128, 256, 512];
  if (height < BOM_MID_HEIGHT_M) return [128, 256, 64, 512];
  return [256, 512, 128, 64];
}

/** Great-circle distance in kilometres. */
export function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const validView = (view) =>
  Number.isFinite(view?.lat) &&
  Number.isFinite(view?.lon) &&
  Math.abs(view.lat) <= 90 &&
  Math.abs(view.lon) <= 180;

/**
 * Choose the radar product for what the camera is looking at: the nearest
 * radar that has frames, at a range that suits the camera's altitude and still
 * reaches the view centre. Falls back to whatever ranges the radar offers.
 * @param {object} input
 * @param {Array<{id: string, products: string[], center?: {lat: number, lon: number}}>} input.radars
 *   Radars from the proxy; those without a known centre are skipped.
 * @param {{lat: number, lon: number}} input.view Ground point at the view centre.
 * @param {number} input.height Camera altitude above the ellipsoid in metres.
 * @param {string|null} [input.current] Product on screen; kept while it stays reasonable.
 * @returns {{product: string, radarId: string, rangeKm: number, distanceKm: number}|null}
 *   Null when no known radar reaches the view centre.
 */
export function pickBomProduct({ radars, view, height, current = null }) {
  if (!Array.isArray(radars) || !validView(view)) return null;
  const ranked = radars
    .filter(
      (radar) =>
        radar?.center &&
        Number.isFinite(radar.center.lat) &&
        Number.isFinite(radar.center.lon) &&
        Array.isArray(radar.products) &&
        radar.products.some((product) => bomProductRangeKm(product) !== null),
    )
    .map((radar) => ({ radar, distance: distanceKm(view, radar.center) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, NEAREST_RADARS);
  const choose = ({ radar, distance }, preference) => {
    for (const range of preference) {
      const product = radar.products.find(
        (id) => bomProductRangeKm(id) === range,
      );
      if (product && range >= distance)
        return { product, radarId: radar.id, rangeKm: range, distance };
    }
    return null;
  };
  const preferred = bomRangePreference(height);
  const currentRange = bomProductRangeKm(current);
  if (currentRange !== null) {
    const entry = ranked.find(({ radar }) => radar.products.includes(current));
    // Keep the current product while its radar is not clearly beaten, its
    // range still reaches the view and the altitude has not moved decisively.
    if (
      entry &&
      entry.distance <= currentRange &&
      !(
        ranked[0].radar !== entry.radar &&
        ranked[0].distance < entry.distance * RADAR_SWITCH_RATIO
      ) &&
      [height / HEIGHT_HYSTERESIS, height, height * HEIGHT_HYSTERESIS].some(
        (h) => bomRangePreference(h)[0] === currentRange,
      )
    )
      return {
        product: current,
        radarId: entry.radar.id,
        rangeKm: currentRange,
        distanceKm: entry.distance,
      };
  }
  for (const entry of ranked) {
    const pick = choose(entry, preferred);
    if (pick) {
      const { distance, ...rest } = pick;
      return { ...rest, distanceKm: distance };
    }
  }
  return null;
}

/** Range label used in the UI, e.g. `128 km`. */
export function bomRangeLabel(rangeKm) {
  return Object.values(BOM_RANGE_KM).includes(rangeKm) ? `${rangeKm} km` : '';
}
