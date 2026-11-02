/**
 * Local equirectangular distance in km, for viewer-proximity gates. Takes the
 * short way round, so points either side of 180° stay close.
 */
export function approxDistanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111.32;
  let dLonDeg = lon2 - lon1;
  dLonDeg -= 360 * Math.round(dLonDeg / 360);
  const dLon =
    dLonDeg * 111.32 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}
