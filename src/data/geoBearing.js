/** Return the initial great-circle bearing between two latitude/longitude points. */
export function bearingBetweenCoordinates(fromLat, fromLon, toLat, toLon) {
  if (![fromLat, fromLon, toLat, toLon].every(Number.isFinite)) return null;
  const fromLatitude = fromLat * Math.PI / 180;
  const toLatitude = toLat * Math.PI / 180;
  const longitudeDelta = (toLon - fromLon) * Math.PI / 180;
  const y = Math.sin(longitudeDelta) * Math.cos(toLatitude);
  const x = Math.cos(fromLatitude) * Math.sin(toLatitude)
    - Math.sin(fromLatitude) * Math.cos(toLatitude) * Math.cos(longitudeDelta);
  if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12) return null;
  return ((Math.atan2(y, x) * 180 / Math.PI) % 360 + 360) % 360;
}
