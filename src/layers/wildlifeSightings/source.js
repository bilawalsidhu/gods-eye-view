import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { mergeSightings } from './records.js';
import { wildlifeMeasure } from './performance.js';
import { ACARTIA_GUARD_BOX, TAXA_PRESETS } from './policy.js';
import { boxIntersects } from './viewport.js';
import {
  WILDLIFE_GRID_MAX_ZOOM,
  WILDLIFE_GRID_TILE_CAP,
  wildlifeGridCellId,
} from './gridViewport.js';

// Leave room for projected observations while bounding malformed proxy replies.
const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
// The proxy owns upstream pacing; observation requests precede these workers.
export const WILDLIFE_GRID_CONCURRENCY = 4;
export const WILDLIFE_GRID_CACHE_MAX = 400;
export const WILDLIFE_GRID_TTL_MS = 15 * 60_000;
// Match the proxy's one-hour stale allowance. Keep the original data time so
// repeated refresh failures never extend a tile's usable life.
const GRID_STALE_MAX_MS = 3_600_000;
const HOUR_MS = 3_600_000;

function validTile(tile) {
  return (
    !!tile &&
    Number.isInteger(tile.z) &&
    tile.z >= 0 &&
    tile.z <= WILDLIFE_GRID_MAX_ZOOM &&
    Number.isInteger(tile.x) &&
    Number.isInteger(tile.y) &&
    tile.x >= 0 &&
    tile.y >= 0 &&
    tile.x < 2 ** tile.z &&
    tile.y < 2 ** tile.z
  );
}

function validProjectedGrid(payload) {
  return (
    Number.isFinite(payload?.fetchedAt) &&
    Number.isSafeInteger(payload.totalResults) &&
    payload.totalResults >= 0 &&
    (payload.stale === undefined || typeof payload.stale === 'boolean') &&
    Array.isArray(payload.cells) &&
    payload.cells.length <= 4096 &&
    payload.cells.every(
      (cell) =>
        cell &&
        Object.keys(cell).sort().join(',') === 'cellCount,id,lat,lon' &&
        /^grid:\d+\/\d+\/\d+:\d+:\d+$/.test(cell.id) &&
        Number.isSafeInteger(cell.cellCount) &&
        cell.cellCount > 0 &&
        Number.isFinite(cell.lat) &&
        Math.abs(cell.lat) <= 90 &&
        Number.isFinite(cell.lon) &&
        Math.abs(cell.lon) <= 180 &&
        wildlifeGridCellId(
          cell.lat,
          cell.lon,
          Number(cell.id.split(':')[1].split('/')[0]),
        ) === cell.id,
    ) &&
    new Set(payload.cells.map((cell) => cell.id)).size ===
      payload.cells.length &&
    payload.cells.reduce((sum, cell) => sum + cell.cellCount, 0) ===
      payload.totalResults
  );
}

function retryAfterSeconds(value, nowMs) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? Math.ceil(seconds) : null;
  }
  // Reject malformed numeric values rather than letting Date.parse interpret
  // them as calendar dates. HTTP dates include a named weekday or month.
  if (!/[a-z]/i.test(text)) return null;
  const deadline = Date.parse(text);
  return Number.isFinite(deadline) && Number.isFinite(nowMs)
    ? Math.max(0, Math.ceil((deadline - nowMs) / 1000))
    : null;
}

function validProjectedRows(rows, origin) {
  return (
    Array.isArray(rows) &&
    rows.every(
      (row) =>
        row &&
        typeof row.stableId === 'string' &&
        row.stableId.startsWith(
          origin === 'inaturalist' ? 'inat:' : 'acartia:',
        ) &&
        row.origin === origin &&
        Number.isFinite(row.lat) &&
        Math.abs(row.lat) <= 90 &&
        Number.isFinite(row.lon) &&
        Math.abs(row.lon) <= 180,
    )
  );
}

/** Return the status a failure reports. The proxy marks upstream failures
 * with X-Upstream-Status; without it the HTTP status is the signal. */
function wildlifeFailureStatus(error) {
  return (
    error?.upstreamStatus ||
    error?.status ||
    Number(/HTTP (\d{3})/.exec(error?.message || '')?.[1]) ||
    0
  );
}

/** Whether a failure asks clients to wait before the next request. */
export function wildlifeFailureRetryable(error) {
  const status = wildlifeFailureStatus(error);
  return status === 429 || status >= 500;
}

/** Prefer the failure that carries retry timing, then the longest wait. */
export function preferredWildlifeFailure(errors) {
  const failures = errors.filter(Boolean);
  const retryable = failures.filter(wildlifeFailureRetryable);
  if (!retryable.length) return failures[0] || null;
  return retryable.reduce((best, error) =>
    (Number.isFinite(error.retryAfterSec) ? error.retryAfterSec : -1) >
    (Number.isFinite(best.retryAfterSec) ? best.retryAfterSec : -1)
      ? error
      : best,
  );
}

/** Merge occupied cells incrementally; neighboring UTFGrid hit tiles can
 * report the same geographic cell, so source ids remain the dedupe key. */
export function combineWildlifeGridSnapshots(snapshots, error = null) {
  const cells = [
    ...new Map(
      snapshots
        .flatMap((snapshot) => snapshot.cells)
        .map((cell) => [cell.id, cell]),
    ).values(),
  ];
  const totalResults = cells.reduce((sum, cell) => sum + cell.cellCount, 0);
  if (!Number.isSafeInteger(totalResults))
    throw new Error('Malformed iNaturalist grid response');
  const retryAfter = [
    ...snapshots.map((snapshot) => snapshot.retryAfterSec),
    error?.retryAfterSec,
  ].filter(Number.isFinite);
  const stale = snapshots.some((snapshot) => snapshot.stale === true);
  return {
    cells,
    totalResults,
    fetchedAt: Math.min(...snapshots.map((snapshot) => snapshot.fetchedAt)),
    stale,
    ...(stale
      ? {
          upstreamStatus: Math.max(
            0,
            ...snapshots.map((snapshot) => snapshot.upstreamStatus || 0),
          ),
        }
      : {}),
    ...(error ? { error } : {}),
    ...(retryAfter.length ? { retryAfterSec: Math.max(...retryAfter) } : {}),
  };
}

/** Request both provider proxies when coverage calls for it. API-specific
 * parameters (Cetacea, photo requirement, observation window) belong to the proxy. */
export function createWildlifeSightingsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const gridCache = new Map();
  const gridInFlight = new Map();
  async function readProxy(url, provider, signal, { grid = false } = {}) {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, { signal });
    signal?.throwIfAborted();
    const retryAfterSec = retryAfterSeconds(
      response.headers?.get?.('Retry-After'),
      now(),
    );
    const upstreamStatus =
      Number(response.headers?.get?.('X-Upstream-Status')) || 0;
    if (!response.ok) {
      await response.body?.cancel?.();
      signal?.throwIfAborted();
      const error = new Error(
        provider === 'iNaturalist' && upstreamStatus === 429
          ? 'iNaturalist rate limited'
          : `${provider} HTTP ${response.status}`,
      );
      error.status = response.status;
      error.upstreamStatus = upstreamStatus;
      if (retryAfterSec !== null) error.retryAfterSec = retryAfterSec;
      throw error;
    }
    let payload;
    try {
      payload = await readResponseJsonCapped(
        response,
        SNAPSHOT_MAX_BYTES,
        signal,
      );
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`Malformed ${provider} response`, { cause: error });
    }
    signal?.throwIfAborted();
    if (
      payload &&
      typeof payload === 'object' &&
      (payload.stale === true ||
        response.headers?.get?.('X-Data-Stale') === 'true')
    ) {
      payload.stale = true;
      if (retryAfterSec !== null) payload.retryAfterSec = retryAfterSec;
      payload.upstreamStatus = upstreamStatus;
    }
    if (grid) {
      if (!wildlifeMeasure('tile-decode', () => validProjectedGrid(payload)))
        throw new Error('Malformed iNaturalist grid response');
      return payload;
    }
    const origin = provider === 'iNaturalist' ? 'inaturalist' : 'acartia';
    if (
      !validProjectedRows(payload?.rows, origin) ||
      (origin === 'inaturalist' &&
        (!Number.isSafeInteger(payload.totalResults) ||
          payload.totalResults < 0))
    ) {
      throw new Error(`Malformed ${provider} response`);
    }
    return payload;
  }

  function readGridTile(key, url, metadata, signal) {
    signal?.throwIfAborted();
    let pending = gridInFlight.get(key);
    if (!pending || pending.controller.signal.aborted) {
      const controller = new AbortController();
      pending = { controller, consumers: new Set(), promise: null };
      const entry = pending;
      pending.promise = readProxy(url, 'iNaturalist', controller.signal, {
        grid: true,
      })
        .then((value) => {
          gridCache.delete(key);
          gridCache.set(key, {
            value,
            savedAt: value.stale ? Math.min(now(), value.fetchedAt) : now(),
            ...metadata,
          });
          while (gridCache.size > WILDLIFE_GRID_CACHE_MAX)
            gridCache.delete(gridCache.keys().next().value);
          return value;
        })
        .finally(() => {
          if (gridInFlight.get(key) === entry) gridInFlight.delete(key);
        });
      gridInFlight.set(key, pending);
    }
    const consumer = {};
    pending.consumers.add(consumer);
    return new Promise((resolve, reject) => {
      const finish = (aborted = false) => {
        signal?.removeEventListener('abort', abort);
        pending.consumers.delete(consumer);
        if (aborted && !pending.consumers.size) pending.controller.abort();
      };
      const abort = () => {
        finish(true);
        reject(signal.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      pending.promise.then(
        (value) => {
          finish();
          resolve(value);
        },
        (error) => {
          finish();
          reject(error);
        },
      );
    });
  }

  /** Publish cached tiles immediately and refresh their occupied cells. */
  async function getGridSnapshot({
    tiles,
    confirmed = false,
    taxa = 'all',
    signal,
    onTile,
  } = {}) {
    signal?.throwIfAborted();
    if (
      !Array.isArray(tiles) ||
      !tiles.length ||
      tiles.length > WILDLIFE_GRID_TILE_CAP ||
      !tiles.every(validTile)
    )
      throw new TypeError('Wildlife grid requires visible tiles');
    const preset = TAXA_PRESETS.some((item) => item.value === taxa)
      ? taxa
      : 'all';
    const unique = [
      ...new Map(
        tiles.map((tile) => [`${tile.z}/${tile.x}/${tile.y}`, tile]),
      ).values(),
    ].sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);
    const windowKey = Math.floor(
      (now() - (preset === 'whales' ? 168 : 48) * HOUR_MS) / HOUR_MS,
    );
    const snapshots = new Array(unique.length);
    const failures = new Array(unique.length);
    const usable = (entry) => {
      const age = now() - entry.value.fetchedAt;
      return age >= 0 && age <= GRID_STALE_MAX_MS;
    };
    const touch = (key, entry) => {
      gridCache.delete(key);
      gridCache.set(key, entry);
    };
    function cachedFallback(tile, tileKey) {
      let exact = null;
      const adjacent = [];
      for (const [key, entry] of gridCache) {
        if (!usable(entry)) continue;
        if (key.startsWith(tileKey)) {
          if (!exact || entry.savedAt > exact.savedAt) exact = entry;
        } else if (
          entry.preset === preset &&
          entry.confirmed === confirmed &&
          Math.abs(entry.tile.z - tile.z) === 1 &&
          (entry.tile.z < tile.z
            ? entry.tile.x === Math.floor(tile.x / 2) &&
              entry.tile.y === Math.floor(tile.y / 2)
            : Math.floor(entry.tile.x / 2) === tile.x &&
              Math.floor(entry.tile.y / 2) === tile.y)
        ) {
          adjacent.push(entry);
        }
      }
      if (exact) return { ...exact.value, stale: true };
      if (!adjacent.length) return null;
      // Preserve cached geographic centres and counts while exact tiles load.
      const newest = [
        ...new Map(
          adjacent
            .sort((a, b) => a.savedAt - b.savedAt)
            .map((entry) => [
              `${entry.tile.z}/${entry.tile.x}/${entry.tile.y}`,
              entry,
            ]),
        ).values(),
      ];
      const parent = newest.find((entry) => entry.tile.z < tile.z);
      const values = parent
        ? [parent.value]
        : newest.map((entry) => entry.value);
      const value = combineWildlifeGridSnapshots(values);
      value.cells = value.cells.filter((cell) =>
        wildlifeGridCellId(cell.lat, cell.lon, tile.z)?.startsWith(
          `grid:${tile.z}/${tile.x}/${tile.y}:`,
        ),
      );
      value.totalResults = value.cells.reduce(
        (sum, cell) => sum + cell.cellCount,
        0,
      );
      return { ...value, stale: true };
    }
    function publish(index, value) {
      signal?.throwIfAborted();
      snapshots[index] = value;
      onTile?.(value, { tile: unique[index] });
    }
    const requests = [];
    // Publish all cached coverage before slow misses can occupy the workers.
    for (let index = 0; index < unique.length; index += 1) {
      const tile = unique[index];
      const tileKey = `${tile.z}/${tile.x}/${tile.y}:${preset}:${confirmed ? 'research' : 'all'}:`;
      const key = `${tileKey}${windowKey}`;
      const cached = gridCache.get(key);
      const age = cached ? now() - cached.savedAt : Infinity;
      if (
        age >= 0 &&
        age < WILDLIFE_GRID_TTL_MS &&
        !cached.value.stale &&
        usable(cached)
      ) {
        touch(key, cached);
        publish(index, cached.value);
        continue;
      }
      const fallback = cachedFallback(tile, tileKey);
      if (fallback) publish(index, fallback);
      requests.push({ index, tile, key });
    }
    let cursor = 0;
    async function worker() {
      while (cursor < requests.length) {
        signal?.throwIfAborted();
        const { index, tile, key } = requests[cursor++];
        const query = new URLSearchParams({
          z: String(tile.z),
          x: String(tile.x),
          y: String(tile.y),
          taxa: preset,
        });
        if (confirmed) query.set('quality', 'research');
        try {
          let value = await readGridTile(
            key,
            `/api/inaturalist/grid?${query}`,
            { tile, preset, confirmed },
            signal,
          );
          signal?.throwIfAborted();
          publish(index, value);
          if (value.stale && !value.upstreamStatus) {
            // A server SWR response paints immediately. Join its existing
            // refresh so this same view receives the new cells when ready.
            query.set('refresh', 'wait');
            value = await readGridTile(
              key,
              `/api/inaturalist/grid?${query}`,
              { tile, preset, confirmed },
              signal,
            );
            publish(index, value);
          }
        } catch (error) {
          signal?.throwIfAborted();
          failures[index] = error;
          // Other tiles can already be cached or in flight. Keep their
          // progressive coverage even if one upstream request fails.
        }
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(WILDLIFE_GRID_CONCURRENCY, requests.length) },
        worker,
      ),
    );
    signal?.throwIfAborted();
    const failure = preferredWildlifeFailure(failures);
    if (!snapshots.some(Boolean) && failure) throw failure;
    return combineWildlifeGridSnapshots(snapshots.filter(Boolean), failure);
  }

  /** Merge recent provider rows with source availability and cache age. */
  async function getSnapshotDetail({
    signal,
    box = null,
    boxes = null,
    scope = 'view',
    confirmed = false,
    taxa = 'all',
  } = {}) {
    signal?.throwIfAborted();
    const preset = TAXA_PRESETS.some((item) => item.value === taxa)
      ? taxa
      : 'all';
    const requestBoxes =
      scope === 'global'
        ? [null]
        : Array.isArray(boxes)
          ? boxes
          : box
            ? [box]
            : [];
    if (!requestBoxes.length)
      throw new TypeError('Wildlife sightings require a view box');
    const useAcartia =
      scope !== 'global' &&
      ['all', 'Mammalia', 'whales'].includes(preset) &&
      requestBoxes.some((bounds) => boxIntersects(bounds, ACARTIA_GUARD_BOX));

    // Each box settles independently: one failed antimeridian half must not
    // discard the other half, and neither may discard a good Acartia reply.
    const inatRequest = Promise.allSettled(
      requestBoxes.map((bounds) => {
        const params = new URLSearchParams({
          scope: scope === 'global' ? 'global' : 'view',
          taxa: preset,
        });
        if (confirmed) params.set('quality', 'research');
        if (scope !== 'global') {
          for (const key of ['south', 'west', 'north', 'east'])
            params.set(key, String(bounds[key]));
        }
        return readProxy(
          `/api/inaturalist/observations?${params}`,
          'iNaturalist',
          signal,
        );
      }),
    );
    const acartiaRequest = useAcartia
      ? readProxy('/api/acartia/sightings', 'Acartia', signal)
      : Promise.resolve(null);
    const [inatResult, acartiaResult] = await Promise.allSettled([
      inatRequest,
      acartiaRequest,
    ]);
    signal?.throwIfAborted();
    const inatSnapshots = [];
    const failedBoxes = [];
    let inatError = null;
    inatResult.value.forEach((result, index) => {
      if (result.status === 'fulfilled') inatSnapshots.push(result.value);
      else {
        failedBoxes.push(requestBoxes[index]);
        inatError ??= result.reason;
      }
    });
    // Fail outright only when nothing succeeded; otherwise draw what arrived
    // and report the failed source in its per-source status.
    const acartiaError =
      useAcartia && acartiaResult.status === 'rejected'
        ? acartiaResult.reason
        : null;
    if (
      !inatSnapshots.length &&
      (!useAcartia || acartiaResult.status !== 'fulfilled')
    )
      throw preferredWildlifeFailure([inatError, acartiaError]);
    const inatRows = inatSnapshots.flatMap((snapshot) => snapshot.rows);
    const acartiaSnapshot =
      acartiaResult.status === 'fulfilled' ? acartiaResult.value : null;
    const acartiaRows = acartiaSnapshot?.rows || [];
    const rows = mergeSightings(inatRows, acartiaRows, {
      nowMs: now(),
      taxa: preset,
      confirmed,
    });
    const inatDates = inatSnapshots
      .map((snapshot) => snapshot.fetchedAt)
      .filter(Number.isFinite);
    const inatFetchedAt = inatDates.length ? Math.min(...inatDates) : null;
    const inatStale = inatSnapshots.some((snapshot) => snapshot.stale === true);
    const acartiaStale = acartiaSnapshot?.stale === true;
    const drawnAcartia = rows.filter((row) => row.origin === 'acartia').length;
    const dates = [
      inatFetchedAt,
      drawnAcartia ? acartiaSnapshot?.fetchedAt : null,
    ].filter(Number.isFinite);
    const retryAfter = [
      ...inatSnapshots.map((snapshot) => snapshot.retryAfterSec),
      drawnAcartia ? acartiaSnapshot?.retryAfterSec : null,
    ].filter(Number.isFinite);
    return {
      rows,
      stale: inatStale || (drawnAcartia > 0 && acartiaStale),
      ...(inatStale || acartiaStale
        ? {
            upstreamStatus: Math.max(
              0,
              ...inatSnapshots.map((snapshot) => snapshot.upstreamStatus || 0),
              acartiaSnapshot?.upstreamStatus || 0,
            ),
          }
        : {}),
      fetchedAt: dates.length ? Math.min(...dates) : null,
      totalResults:
        inatSnapshots.reduce(
          (total, snapshot) => total + snapshot.totalResults,
          0,
        ) + drawnAcartia,
      scope: scope === 'global' ? 'global' : 'view',
      partial: inatSnapshots.some((snapshot) => snapshot.partial === true),
      ...(retryAfter.length ? { retryAfterSec: Math.max(...retryAfter) } : {}),
      sources: {
        inaturalist: {
          ok: !inatError,
          stale: inatStale,
          fetchedAt: inatFetchedAt,
          count: rows.filter((row) => row.origin === 'inaturalist').length,
          ...(inatError ? { error: inatError, failedBoxes } : {}),
        },
        acartia: {
          ok: !acartiaError,
          stale: acartiaStale,
          fetchedAt: Number.isFinite(acartiaSnapshot?.fetchedAt)
            ? acartiaSnapshot.fetchedAt
            : null,
          count: drawnAcartia,
          ...(acartiaError ? { error: acartiaError } : {}),
        },
      },
    };
  }

  return {
    /** Return recent, privacy-projected rows without source status metadata. */
    async getSnapshot(options = {}) {
      return (await getSnapshotDetail(options)).rows;
    },
    getSnapshotDetail,
    getGridSnapshot,
  };
}
