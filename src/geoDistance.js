/** Mean spherical Earth radius used by lightweight client-side distance checks. */
export const EARTH_RADIUS_KM = 6371;

const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Great-circle distance between two latitude/longitude points.
 * Positional arguments always use latitude, longitude order.
 */
export function greatCircleKm(lat1, lon1, lat2, lon2) {
  const latitude1 = lat1 * DEGREES_TO_RADIANS;
  const latitude2 = lat2 * DEGREES_TO_RADIANS;
  const latitudeDelta = (lat2 - lat1) * DEGREES_TO_RADIANS;
  const longitudeDelta = (lon2 - lon1) * DEGREES_TO_RADIANS;
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
  const bounded = Math.min(1, Math.max(0, haversine));
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
}

/** Great-circle distance in metres, with the same latitude/longitude order. */
export function greatCircleMeters(lat1, lon1, lat2, lon2) {
  return greatCircleKm(lat1, lon1, lat2, lon2) * 1000;
}
