import { CITY_BY_ID } from './registry.js';
import {
  parseStationInformation,
  parseStationStatus,
} from '../../sources/gbfsStations.js';
import { greatCircleKm } from '../../geoDistance.js';

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
    const distance = greatCircleKm(
      { lat: city.centerLat, lon: city.centerLon },
      { lat: station.lat, lon: station.lon },
    );
    if (distance <= city.loadRadiusKm) kept.set(stationId, station);
  }
  return kept;
}

export function createIngestion({
  state: layerState,
  services,
  parts,
  source,
}) {
  /** Increment the loading reference count and mark loading state active. */

  function beginLoading() {
    layerState._loadingOps++;
    layerState._loading = true;
  }

  /** Decrement the loading reference count; clear loading flag when zero. */

  function endLoading() {
    layerState._loadingOps = Math.max(0, layerState._loadingOps - 1);
    layerState._loading = layerState._loadingOps > 0;
  }

  /**
   * Abort an in-flight GBFS request for a specific city and remove it from the map.
   * @param {Map<string, { controller: AbortController }>} map - In-flight request map.
   * @param {string} cityId - City whose request should be cancelled.
   */

  function abortInFlight(map, cityId) {
    const entry = map.get(cityId);
    if (!entry) return;
    try {
      entry.controller?.abort();
    } catch {
      // no-op
    }
    map.delete(cityId);
  }

  /** Abort all in-flight station info and status requests across all cities. */

  function abortAllInFlight() {
    for (const cityId of layerState._inFlightInfo.keys())
      abortInFlight(layerState._inFlightInfo, cityId);
    for (const cityId of layerState._inFlightStatus.keys())
      abortInFlight(layerState._inFlightStatus, cityId);
  }

  /**
   * Load station information for a city. Returns cached data if available,
   * deduplicates concurrent requests, and caches the result on success.
   * Station info is static metadata (location, name, capacity) and is
   * fetched once per city per session.
   * @param {string} cityId - City identifier.
   * @returns {Promise<Map<string, Object>>} Map of stationId to station info.
   * @throws {Error} On unknown city, fetch failure, or empty station list.
   */

  async function loadCityStationInfo(cityId) {
    if (layerState._stationInfoCache.has(cityId))
      return layerState._stationInfoCache.get(cityId);
    const inFlight = layerState._inFlightInfo.get(cityId);
    if (inFlight) return inFlight.promise;

    const city = CITY_BY_ID.get(cityId);
    if (!city) throw new Error(`Unknown GBFS city "${cityId}"`);
    const controller = new AbortController();

    const promise = (async () => {
      beginLoading();
      try {
        const payload = await source.getStations(city.stationInformationUrl, {
          signal: controller.signal,
        });
        const stationMap = stationsWithinCity(
          city,
          parseStationInformation(payload),
        );
        if (stationMap.size === 0) {
          throw new Error(`No station information for ${city.city}`);
        }
        layerState._stationInfoCache.set(cityId, stationMap);
        return stationMap;
      } finally {
        endLoading();
      }
    })().finally(() => {
      // Clean up in-flight entry only if it is still ours (not replaced by a newer request)
      const current = layerState._inFlightInfo.get(cityId);
      if (current && current.controller === controller)
        layerState._inFlightInfo.delete(cityId);
    });

    layerState._inFlightInfo.set(cityId, { promise, controller });
    return promise;
  }

  /**
   * Load real-time station status for a city (bike/dock counts, operational flags).
   * Unlike station info, status is NOT served from cache — it is always re-fetched
   * to keep availability data current. Concurrent requests are deduplicated.
   * @param {string} cityId - City identifier.
   * @returns {Promise<Map<string, Object>>} Map of stationId to status objects.
   * @throws {Error} On unknown city or fetch failure.
   */

  async function loadCityStationStatus(cityId) {
    const inFlight = layerState._inFlightStatus.get(cityId);
    if (inFlight) return inFlight.promise;

    const city = CITY_BY_ID.get(cityId);
    if (!city) throw new Error(`Unknown GBFS city "${cityId}"`);
    const controller = new AbortController();

    const promise = (async () => {
      beginLoading();
      try {
        const payload = await source.getStations(city.stationStatusUrl, {
          signal: controller.signal,
        });
        const statusMap = parseStationStatus(payload);
        layerState._statusCache.set(cityId, {
          statusMap,
          timestamp: Date.now(),
        });
        return statusMap;
      } finally {
        endLoading();
      }
    })().finally(() => {
      const current = layerState._inFlightStatus.get(cityId);
      if (current && current.controller === controller)
        layerState._inFlightStatus.delete(cityId);
    });

    layerState._inFlightStatus.set(cityId, { promise, controller });
    return promise;
  }
  const methods = {
    /**
     * Periodic update tick — re-fetches station status for all active cities
     * and refreshes point colors/sizes. Called by the layer manager at
     * STATUS_POLL_MS intervals.
     * @returns {Promise<void>}
     */
    async update() {
      if (!layerState._enabled || layerState._activeCityIds.size === 0) return;

      const generation = layerState._proximityGeneration;
      const cityIds = Array.from(layerState._activeCityIds);
      const isCurrent = (cityId) =>
        layerState._enabled &&
        layerState._activeCityIds.has(cityId) &&
        generation === layerState._proximityGeneration;
      let refreshed = false;
      await Promise.all(
        cityIds.map(async (cityId) => {
          try {
            const statusMap = await loadCityStationStatus(cityId);
            if (!isCurrent(cityId)) return;
            parts.rendering.applyStatusToPoints(cityId, statusMap);
            layerState._failedCityIds.delete(cityId);
            refreshed = true;
          } catch (error) {
            if (error?.name === 'AbortError' || !isCurrent(cityId)) return;
            console.warn(
              `[Data:Bikeshare] ${cityId} status update error:`,
              error,
            );
            layerState._failedCityIds.add(cityId);
          }
        }),
      );

      layerState._count = layerState._stationRenderMap.size;
      // Freshness advances only on a poll that actually refreshed a city.
      if (refreshed && layerState._count > 0)
        layerState._lastUpdate = Date.now();
    },
  };

  return {
    beginLoading,
    endLoading,
    abortInFlight,
    abortAllInFlight,
    loadCityStationInfo,
    loadCityStationStatus,
    methods,
  };
}
