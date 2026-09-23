import {
  DEFAULT_LIMIT,
  DEFAULT_RADIUS_KM,
  clampRadiusKm,
  normalizeRepeaterFilter,
  parseRepeatersResponse,
  withDistanceFrom,
} from '../../sources/hamRepeaters.js';
import { FETCH_TIMEOUT_MS } from './policy.js';

export function createIngestion({ state: layerState, parts, source }) {
  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  async function fetchCatalog(query, outer) {
    const controller = new AbortController();
    // Our own timeout aborts the same controller the caller's abort does, so
    // the rejection alone cannot say which fired. Without this flag a timed-out
    // load is reported as 'cancelled' and the panel shows an empty layer with
    // nothing to explain it and nothing to retry from.
    const deadline = { expired: false };
    const timer = setTimeout(() => {
      deadline.expired = true;
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    outer?.addEventListener('abort', onAbort, { once: true });
    try {
      return await source.getRepeaters(query, { signal: controller.signal });
    } catch (error) {
      if (deadline.expired && error?.name === 'AbortError') {
        const timeout = new Error('Repeater directory timed out');
        timeout.code = 'HAM_REPEATERS_TIMEOUT';
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Load repeaters around a point. Resolves `{ ok, count, area?, error? }`
   * and never throws; a superseded or cancelled load says so.
   */
  async function loadAround(
    lat,
    lon,
    radiusKm = DEFAULT_RADIUS_KM,
    options = {},
  ) {
    const latitude = finite(lat);
    const longitude = finite(lon);
    if (
      latitude === null ||
      longitude === null ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    )
      return {
        ok: false,
        count: 0,
        error: 'A latitude and longitude are required',
      };
    const radius = clampRadiusKm(radiusKm);
    // The query filter and the panel filter are one state.
    if (options.band !== undefined || options.kind !== undefined) {
      layerState._filter = normalizeRepeaterFilter(
        {
          kind: options.kind ?? layerState._filter.kind,
          band: options.band ?? layerState._filter.band,
        },
        layerState._filter,
      );
      parts.rendering.restyleMarkers();
    }
    const origin = options.origin || 'programmatic';
    const reason = options.reason || 'manual';
    const generation = ++layerState._requestGeneration;
    const sessionGeneration = layerState._sessionGeneration;
    layerState._abort?.abort();
    const abort = new AbortController();
    layerState._abort = abort;
    const onOuterAbort = () => abort.abort();
    options.signal?.addEventListener('abort', onOuterAbort, { once: true });
    layerState._loading = true;
    layerState._error = null;
    parts.presentation.emitState();
    const current = () =>
      generation === layerState._requestGeneration &&
      sessionGeneration === layerState._sessionGeneration;
    const filterSnapshot = layerState._filter;
    try {
      const body = await fetchCatalog(
        {
          lat: latitude,
          lon: longitude,
          radiusKm: radius,
          limit: options.limit ?? DEFAULT_LIMIT,
          band: filterSnapshot.band,
          kind: filterSnapshot.kind,
        },
        abort.signal,
      );
      if (!current()) return { ok: false, count: 0, error: 'superseded' };
      const parsed = parseRepeatersResponse(body);
      const rows = [
        ...withDistanceFrom(parsed.repeaters, {
          lat: latitude,
          lon: longitude,
        }),
      ].sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
      parts.rendering.reconcile(rows);
      layerState._area = Object.freeze({
        lat: latitude,
        lon: longitude,
        radiusKm: radius,
        at: Date.now(),
        band: filterSnapshot.band,
        kind: filterSnapshot.kind,
        failed: false,
      });
      layerState._lastLoad = Object.freeze({
        at: new Date().toISOString(),
        origin,
        reason,
        count: rows.length,
      });
      layerState._updatedAt = parsed.updatedAt || new Date().toISOString();
      layerState._stale = Boolean(body?.stale);
      layerState._partial = parsed.partial;
      layerState._errors = Object.freeze(parsed.errors);
      layerState._sources = Object.freeze(parsed.sources);
      layerState._error = null;
      return { ok: true, count: rows.length, area: layerState._area };
    } catch (error) {
      if (!current() || error?.name === 'AbortError')
        return { ok: false, count: 0, error: 'cancelled' };
      layerState._error = error?.message || 'Repeater directory unavailable';
      layerState._stale = layerState._repeaters.length > 0;
      layerState._area = Object.freeze({
        lat: latitude,
        lon: longitude,
        radiusKm: radius,
        at: Date.now(),
        band: filterSnapshot.band,
        kind: filterSnapshot.kind,
        failed: true,
      });
      layerState._lastLoad = Object.freeze({
        at: new Date().toISOString(),
        origin,
        reason,
        count: 0,
        error: layerState._error,
      });
      return {
        ok: false,
        count: 0,
        error: layerState._error,
        area: layerState._area,
      };
    } finally {
      options.signal?.removeEventListener('abort', onOuterAbort);
      if (current()) {
        layerState._loading = false;
        layerState._abort = null;
        parts.presentation.emitState();
      }
    }
  }

  /** Resolve once something is loaded (used by the voice tool). */
  async function ensureLoaded() {
    if (!layerState._repeaters.length)
      await parts.camera.loadFromCamera({
        force: true,
        origin: 'programmatic',
      });
    return layerState._repeaters;
  }

  const methods = {
    /** Manager-owned refresh: the first load after enable, around the view. */
    async update(viewer, { signal = null } = {}) {
      if (!layerState._enabled) return;
      try {
        await parts.camera.loadFromCamera({ origin: 'enable', signal });
      } catch (error) {
        layerState._error = error?.message || 'Repeater directory unavailable';
        parts.presentation.emitState();
      }
    },
  };

  return { methods, loadAround, ensureLoaded };
}
