import {
  extractStationsArray,
  normalizeGbfsBool,
  parseStationInformation,
  parseStationStatus,
  toNonNegativeInteger,
} from '../../sources/gbfsStations.js';

export function createModel({ state: layerState, services, parts, source }) {
  /**
   * Build a globally unique render key for a station.
   * @param {string} cityId - City identifier.
   * @param {string} stationId - Station identifier within the city.
   * @returns {string} Composite key in "cityId:stationId" format.
   */

  function stationKey(cityId, stationId) {
    return `${cityId}:${stationId}`;
  }

  /**
   * Compute the great-circle distance between two points using the Haversine formula.
   * @param {number} aLat - Latitude of point A in degrees.
   * @param {number} aLon - Longitude of point A in degrees.
   * @param {number} bLat - Latitude of point B in degrees.
   * @param {number} bLon - Longitude of point B in degrees.
   * @returns {number} Distance in kilometers.
   */

  function haversineKm(aLat, aLon, bLat, bLon) {
    const toRad = (value) => (value * Math.PI) / 180;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const p1 = toRad(aLat);
    const p2 = toRad(bLat);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  return {
    normalizeGbfsBool,
    toNonNegativeInteger,
    stationKey,
    haversineKm,
    extractStationsArray,
    parseStationInformation,
    parseStationStatus,
  };
}
