import { waitForSignal } from '../../sources/requestDeadline.js';
import {
  loadMilitaryNames,
  militaryNamesInView,
  nameMilitaryFragment,
} from '../../data/militaryNames.js';
import {
  createOpenFreeMapSource,
  decodeOpenFreeMapMilitaryTile,
} from '../../sources/openFreeMap.js';
import {
  mergeMilitaryFragments,
  militaryNameInView,
} from '../../sources/militaryTileGeometry.js';
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

/**
 * OpenMapTiles carries `landuse=military` only from z9; coarser tiles omit it,
 * so a view that needs them would read as an empty (falsely all-clear) area.
 */
export const MILITARY_TILE_MIN_ZOOM = 9;

/** Per-view tile cap for installation tiles. */
export const MILITARY_TILE_MAX = 16;

/**
 * Pick the finest installation tile zoom that fits the view, or null when even
 * z9 would exceed the tile cap (the caller uses bundled named points).
 * @param {{south:number, west:number, north:number, east:number}} box View box.
 * @returns {number|null} Tile zoom.
 */
export function installationTileZoom(box) {
  let zoom =
    Math.max(box.north - box.south, box.east - box.west) > 0.2 ? 10 : 12;
  const fits = (z) =>
    tilesForBounds(box, z, { maxTiles: MILITARY_TILE_MAX + 1 }).length <=
    MILITARY_TILE_MAX;
  while (zoom > MILITARY_TILE_MIN_ZOOM && !fits(zoom)) zoom -= 1;
  return fits(zoom) ? zoom : null;
}

/**
 * Square window around a context subject that fits the installation tile cap
 * at the military minimum zoom: 100 km half-width at mid latitudes, shrinking
 * toward the poles where z9 tiles are shorter.
 * @param {{latitude:number, longitude:number}} anchor Subject position.
 * @returns {{south:number, west:number, north:number, east:number,
 *   radiusM:number}|null} Bounded box, or null for an invalid anchor.
 */
export function installationAnchorBox(anchor) {
  const { latitude, longitude } = anchor || {};
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 85 ||
    Math.abs(longitude) > 180
  )
    return null;
  for (let radiusM = 100_000; radiusM >= 10_000; radiusM *= 0.8) {
    const latSpan = radiusM / 111_320;
    const lonSpan =
      latSpan / Math.max(0.05, Math.cos((latitude * Math.PI) / 180));
    const box = {
      south: Math.max(-85, latitude - latSpan),
      north: Math.min(85, latitude + latSpan),
      west: Math.max(-180, longitude - lonSpan),
      east: Math.min(180, longitude + lonSpan),
    };
    if (
      tilesForBounds(box, MILITARY_TILE_MIN_ZOOM, {
        maxTiles: MILITARY_TILE_MAX + 1,
      }).length <= MILITARY_TILE_MAX
    )
      return { ...box, radiusM: Math.round(radiusM) };
  }
  return null;
}

/** Read mapped installations and explicit nearby-place searches through fixed endpoints. */
export function createInstallationSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  tileFetchImpl = (...args) => globalThis.fetch(...args),
  loadNames = loadMilitaryNames,
  mapTiles = createOpenFreeMapSource({
    fetchImpl: tileFetchImpl,
    decode: decodeOpenFreeMapMilitaryTile,
  }),
} = {}) {
  let overpassUnavailable = false;
  const installationIds = new Map();
  async function getNamedSites(box, signal, thinned = true) {
    const names = await waitForSignal(loadNames(), signal).catch((cause) => {
      signal?.throwIfAborted();
      throw Object.assign(
        new Error('Mapped names temporarily unavailable', { cause }),
        {
          failureReason: 'names_unavailable',
        },
      );
    });
    signal?.throwIfAborted();
    // The map keeps one site per display cell; queries can ask for all.
    const { records, count } = militaryNamesInView(
      names,
      box,
      thinned ? undefined : Infinity,
      thinned,
    );
    return {
      records,
      namedInView: count,
      wide: true,
      status: 'ready',
      tileSource: true,
      saturated: false,
      droppedCount: 0,
      source: 'OpenStreetMap',
    };
  }
  async function getTileSites(box, signal, thinned) {
    const zoom = installationTileZoom(box);
    if (zoom === null) return getNamedSites(box, signal, thinned);
    let names = null;
    const namesJob = waitForSignal(loadNames(), signal)
      .then((loaded) => {
        names = loaded;
        return loaded;
      })
      .catch(() => null);
    let result;
    try {
      result = await mapTiles.fetchBounds(box, { zoom, signal });
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error;
      // Name the tile source: an Overpass reason here would be untrue.
      throw Object.assign(
        error instanceof Error ? error : new Error(String(error)),
        {
          failureReason: 'tiles_unavailable',
        },
      );
    }
    signal?.throwIfAborted();
    const snapshot = (names) => {
      const fragments = result.tiles
        .flatMap((tile) => tile.military)
        .map((record) => nameMilitaryFragment(record, names));
      const retrievedAt = new Date().toISOString();
      return {
        records: mergeMilitaryFragments(
          fragments.slice(0, 2048),
          installationIds,
        ).map((record) => ({
          ...militaryNameInView(record, box),
          retrievedAt,
          sources: record.sources.map((source) => ({ ...source, retrievedAt })),
        })),
        status: 'ready',
        droppedCount: 0,
        saturated: result.partial || fragments.length > 2048,
        source: 'OpenStreetMap tiles',
        tileSource: true,
      };
    };
    const payload = snapshot(names);
    if (!names)
      payload.enrichment = namesJob.then((loaded) =>
        loaded && !signal?.aborted ? snapshot(loaded) : null,
      );
    return payload;
  }
  return {
    destroy() {
      mapTiles.clear();
      installationIds.clear();
    },
    async getMappedSites(box, { exact = false, thinned = true, signal } = {}) {
      const { south, west, north, east } = box || {};
      if (
        ![south, west, north, east].every(Number.isFinite) ||
        south < -90 ||
        north > 90 ||
        west < -180 ||
        west > 180 ||
        east < -180 ||
        east > 180 ||
        north <= south ||
        east === west
      )
        throw new TypeError('A bounded installation viewport is required');
      signal?.throwIfAborted();
      if (east < west || north - south > 10 || east - west > 10)
        return getNamedSites(box, signal, thinned);
      if (overpassUnavailable) return getTileSites(box, signal, thinned);
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
        return getTileSites(box, signal, thinned);
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
