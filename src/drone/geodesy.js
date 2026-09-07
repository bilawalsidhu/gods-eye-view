export const EARTH_RADIUS_METERS = 6_371_008.8;

const TO_RADIANS = Math.PI / 180;
const TO_DEGREES = 180 / Math.PI;

export function normalizeLongitude(longitude) {
  if (longitude >= -180 && longitude < 180) return Object.is(longitude, -0) ? 0 : longitude;
  return ((longitude + 540) % 360) - 180;
}

export function distanceMeters(a, b) {
  const lat1 = a.latitude * TO_RADIANS;
  const lat2 = b.latitude * TO_RADIANS;
  const deltaLat = (b.latitude - a.latitude) * TO_RADIANS;
  const deltaLon = normalizeLongitude(b.longitude - a.longitude) * TO_RADIANS;
  const h = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function headingDegrees(a, b) {
  if (distanceMeters(a, b) < 1e-6) return 0;
  const lat1 = a.latitude * TO_RADIANS;
  const lat2 = b.latitude * TO_RADIANS;
  const deltaLon = normalizeLongitude(b.longitude - a.longitude) * TO_RADIANS;
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return (Math.atan2(y, x) * TO_DEGREES + 360) % 360;
}

export function interpolateGeodesic(a, b, fraction) {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError('fraction must be between 0 and 1');
  }
  if (fraction === 0) return { latitude: a.latitude, longitude: a.longitude };
  if (fraction === 1) return { latitude: b.latitude, longitude: b.longitude };

  const angularDistance = distanceMeters(a, b) / EARTH_RADIUS_METERS;
  const sinDistance = Math.sin(angularDistance);
  if (Math.abs(sinDistance) < 1e-12) {
    const deltaLon = normalizeLongitude(b.longitude - a.longitude);
    return {
      latitude: a.latitude + (b.latitude - a.latitude) * fraction,
      longitude: normalizeLongitude(a.longitude + deltaLon * fraction),
    };
  }

  const aWeight = Math.sin((1 - fraction) * angularDistance) / sinDistance;
  const bWeight = Math.sin(fraction * angularDistance) / sinDistance;
  const lat1 = a.latitude * TO_RADIANS;
  const lon1 = a.longitude * TO_RADIANS;
  const lat2 = b.latitude * TO_RADIANS;
  const lon2 = b.longitude * TO_RADIANS;
  const x = aWeight * Math.cos(lat1) * Math.cos(lon1)
    + bWeight * Math.cos(lat2) * Math.cos(lon2);
  const y = aWeight * Math.cos(lat1) * Math.sin(lon1)
    + bWeight * Math.cos(lat2) * Math.sin(lon2);
  const z = aWeight * Math.sin(lat1) + bWeight * Math.sin(lat2);

  return {
    latitude: Math.atan2(z, Math.sqrt(x * x + y * y)) * TO_DEGREES,
    longitude: normalizeLongitude(Math.atan2(y, x) * TO_DEGREES),
  };
}
