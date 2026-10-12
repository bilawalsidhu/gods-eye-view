const EARTH_RADIUS_M = 6_371_000;

function toRadians(value) {
  return (value * Math.PI) / 180;
}

export function haversineDistanceMeters(latA, lonA, latB, lonB) {
  if (![latA, lonA, latB, lonB].every((value) => Number.isFinite(value)))
    return null;
  const deltaLat = toRadians(latB - latA);
  const deltaLon = toRadians(lonB - lonA);
  const startLat = toRadians(latA);
  const endLat = toRadians(latB);
  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(startLat) * Math.cos(endLat) * Math.sin(deltaLon / 2) ** 2;
  return Math.round(
    2 *
      EARTH_RADIUS_M *
      Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine)),
  );
}
