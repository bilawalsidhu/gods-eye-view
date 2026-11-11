import {
  extractStationsArray,
  normalizeGbfsBool,
  parseStationInformation,
  parseStationStatus,
  toNonNegativeInteger,
} from '../../sources/gbfsStations.js';
import { greatCircleKm } from '../../geoDistance.js';

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
    return greatCircleKm({ lat: aLat, lon: aLon }, { lat: bLat, lon: bLon });
  }

  /**
   * Drop stations outside a city's load radius. Some operators list depots on
   * other continents as in-service stations in a city's feed (Bogotá's and
   * Santiago's PBSC feeds carry warehouses in São Paulo and Madrid), which
   * would otherwise draw as live docks thousands of kilometres away.
   * @param {{ centerLat: number, centerLon: number, loadRadiusKm: number }} city
   * @param {Map<string, Object>} stationMap - Parsed station info map.
   * @returns {Map<string, Object>} Stations within the city's load radius.
   */

  function stationsWithinCity(city, stationMap) {
    const kept = new Map();
    for (const [stationId, station] of stationMap) {
      const distance = haversineKm(
        city.centerLat,
        city.centerLon,
        station.lat,
        station.lon,
      );
      if (distance <= city.loadRadiusKm) kept.set(stationId, station);
    }
    return kept;
  }

  return {
    normalizeGbfsBool,
    toNonNegativeInteger,
    stationKey,
    haversineKm,
    stationsWithinCity,
    extractStationsArray,
    parseStationInformation,
    parseStationStatus,
  };
}
