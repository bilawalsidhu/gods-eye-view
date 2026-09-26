import { createOpenFreeMapSource } from '../../sources/openFreeMap.js';
import { mergeMilitaryFragments } from '../../sources/militaryTileGeometry.js';
import { tilesForBounds } from '../../data/tomtomTiles.js';
import {
  isUnavailableCapability,
  sourceResponseError,
} from '../../sources/capability.js';
import { normalizeMilitaryInstallations } from '../../data/militaryInstallationData.js';

/** Preserve legacy cache admission even when the explicit saturation flag is absent. */
export function installationResponseSaturated(payload) {
  if (typeof payload?.saturated === 'boolean') return payload.saturated;
  const cap = Number(payload?.elementCap);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return Array.isArray(payload?.elements) && payload.elements.length >= cap;
}

/** Read mapped installations and explicit nearby-place searches through fixed endpoints. */
export function createInstallationSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  mapTiles = createOpenFreeMapSource({ fetchImpl }),
} = {}) {
  let overpassUnavailable = false;
  const installationIds = new Map();
  async function getTileSites(box, signal) {
    let zoom =
      Math.max(box.north - box.south, box.east - box.west) > 0.2 ? 10 : 12;
    while (zoom > 6 && tilesForBounds(box, zoom, { maxTiles: 17 }).length > 16)
      zoom -= 1;
    const result = await mapTiles.fetchBounds(box, { zoom, signal });
    const fragments = result.tiles.flatMap((tile) => tile.military);
    const retrievedAt = new Date().toISOString();
    return {
      records: mergeMilitaryFragments(
        fragments.slice(0, 2048),
        installationIds,
      ).map((record) => ({
        ...record,
        retrievedAt,
        sources: record.sources.map((source) => ({ ...source, retrievedAt })),
      })),
      status: 'ready',
      droppedCount: 0,
      saturated: result.partial || fragments.length > 2048,
      source: 'OpenStreetMap tiles',
      tileSource: true,
    };
  }
  return {
    destroy() {
      mapTiles.clear();
      installationIds.clear();
    },
    async getMappedSites(box, { exact = false, signal } = {}) {
      const { south, west, north, east } = box || {};
      if (
        ![south, west, north, east].every(Number.isFinite) ||
        south < -90 ||
        north > 90 ||
        west < -180 ||
        east > 180 ||
        north <= south ||
        east <= west ||
        north - south > 10 ||
        east - west > 10
      )
        throw new TypeError('A bounded installation viewport is required');
      signal?.throwIfAborted();
      if (overpassUnavailable) return getTileSites(box, signal);
      const query = new URLSearchParams(
        Object.entries({ south, west, north, east }).map(([key, value]) => [
          key,
          value.toFixed(5),
        ]),
      );
      if (exact) query.set('exact', '1');
      const response = await fetchImpl(`/api/military-installations?${query}`, {
        signal,
      });
      const body = await response.json();
      signal?.throwIfAborted();
      if (isUnavailableCapability(body)) {
        overpassUnavailable = true;
        return getTileSites(box, signal);
      }
      if (!response.ok)
        throw Object.assign(
          sourceResponseError(
            body,
            response,
            'Installation context unavailable',
          ),
          {
            failureReason: ['rate_limited', 'timeout', 'query_failed'].includes(
              body?.reason,
            )
              ? body.reason
              : 'unavailable',
          },
        );
      if (!Array.isArray(body?.elements))
        throw new Error('Malformed installation snapshot');
      return {
        ...normalizeMilitaryInstallations(
          body,
          body.retrievedAt || new Date().toISOString(),
        ),
        status: body.status,
        saturated: installationResponseSaturated(body),
      };
    },
    async searchNearby({ latitude, longitude, radiusM }, { signal } = {}) {
      if (
        ![latitude, longitude, radiusM].every(Number.isFinite) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180 ||
        radiusM < 1000 ||
        radiusM > 50000
      )
        throw new TypeError('Invalid nearby installation search');
      signal?.throwIfAborted();
      const response = await fetchImpl(
        `/api/google/text-search?${new URLSearchParams({
          q: 'military installation',
          lat: latitude.toFixed(5),
          lon: longitude.toFixed(5),
          radiusM: String(radiusM),
        })}`,
        { signal },
      );
      const payload = await response.json();
      signal?.throwIfAborted();
      if (!response.ok)
        throw new Error(
          payload?.error || `Google Places HTTP ${response.status}`,
        );
      if (!Array.isArray(payload?.places))
        throw new Error('Malformed nearby-place snapshot');
      return payload;
    },
  };
}
