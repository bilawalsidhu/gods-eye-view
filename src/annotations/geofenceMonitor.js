/**
 * Geofence monitor: evaluates live entity coordinates against active polygon
 * on every position update.
 *
 * - Active polygon comes from geofenceTool (via getPolygon callback).
 * - Live entities come from dataManager's enabled layers via getAnalystRecords().
 * - On every `data-updated` activity (fired after each layer's update()), all
 *   enabled layers are polled and each entity's lon/lat is tested with
 *   point-in-polygon.
 * - In-memory state tracker prevents duplicate alerts: internal `geofence:enter`
 *   fires only on initial outside->inside transition.
 * - Drawing or editing the fence re-baselines silently: entities already
 *   inside start as inside instead of firing one breach each.
 * - With no fence drawn the monitor is idle: it pulls no records and keeps
 *   no state. Tracker entries for entities that left the feed are pruned.
 * - Also exposes evaluatePoint() for single-position checks.
 */
import { pointInPolygon, evaluateBatch } from './geofenceIntersection.js';
import { createGeofenceStateTracker } from './geofenceStateTracker.js';
import {
  isValidWebhookUrl,
  buildBreachPayload,
  dispatchBreach,
} from './geofenceWebhook.js';

export function createGeofenceMonitor({
  getPolygon,
  dataManager,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
}) {
  let destroyed = false;
  const tracker = createGeofenceStateTracker();
  let insideEntities = new Map(); // key -> entity (only currently inside)
  let lastInsideCount = 0;
  let lastEvaluation = null;
  const listeners = new Set();
  let webhookUrl = null;
  let lastWebhookError = null;

  const getActivePolygon = () => {
    try {
      const poly = typeof getPolygon === 'function' ? getPolygon() : null;
      if (!poly) return null;
      // geofenceTool returns { vertices: [...] } or array
      if (Array.isArray(poly)) return poly.length >= 3 ? poly : null;
      if (Array.isArray(poly.vertices))
        return poly.vertices.length >= 3 ? poly.vertices : null;
      return null;
    } catch {
      return null;
    }
  };

  /** Stable identity, or null when the record has none. Records without an
   * id are untrackable: keying them by coordinates would re-alert on every
   * position update as the coordinates change, so they are skipped. */
  const stableId = (...candidates) => {
    for (const c of candidates) {
      if (c === null || c === undefined) continue;
      if (typeof c === 'string' && c.trim() === '') continue;
      return c;
    }
    return null;
  };

  const entityKey = (layerKey, e) => {
    const id = stableId(
      e.icao24,
      e.mmsi,
      e.id,
      e.icao,
      e._raw?.icao24,
      e._raw?.mmsi,
      e._raw?.id,
    );
    return id === null ? null : `${layerKey}:${id}`;
  };

  const collectLiveEntities = () => {
    if (!dataManager?.layers) return [];
    const all = [];
    for (const [layerKey, entry] of dataManager.layers) {
      try {
        if (!entry?.enabled) continue;
        const mod = entry.module;
        if (typeof mod?.getAnalystRecords !== 'function') continue;
        // Respect enabled check inside getAnalystRecords too
        const records = mod.getAnalystRecords(2000) || [];
        for (const r of records) {
          // Normalize to { layerKey, id, lon, lat, _raw }
          const lon = r.lon ?? r.longitude ?? r.lng;
          const lat = r.lat ?? r.latitude;
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          const id = stableId(r.icao24, r.mmsi, r.id, r.icao);
          if (id === null) continue;
          all.push({
            layerKey,
            id,
            lon,
            lat,
            _raw: r,
          });
        }
      } catch {
        // one bad layer must not break others
      }
    }
    return all;
  };

  const notify = (evt) => {
    for (const cb of listeners) {
      try {
        cb(evt);
      } catch (e) {
        console.warn('[GeofenceMonitor] listener error:', e);
      }
    }
  };

  const setWebhookUrl = (url) => {
    const trimmed = String(url || '').trim();
    if (!trimmed) {
      webhookUrl = null;
      lastWebhookError = null;
      return true;
    }
    if (!isValidWebhookUrl(trimmed)) return false;
    webhookUrl = trimmed;
    lastWebhookError = null;
    return true;
  };

  // Fire-and-forget. Never rejects: a failed POST is recorded for
  // diagnostics and swallowed, so a dead webhook cannot surface as an
  // unhandled rejection on every breach.
  const dispatchWebhookForEnter = (entity) => {
    if (!webhookUrl) return Promise.resolve(null);
    let payload;
    try {
      payload = buildBreachPayload(entity, { now });
    } catch (err) {
      lastWebhookError = String(err?.message || err);
      return Promise.resolve(null);
    }
    return dispatchBreach(webhookUrl, payload, fetchImpl).then(
      () => null,
      (err) => {
        lastWebhookError = String(err?.message || err);
        console.warn('[Geofence] webhook POST failed:', err);
        return null;
      },
    );
  };

  const sendTestPayload = async () => {
    if (!webhookUrl) throw new Error('Webhook URL not configured');
    const mockEntity = {
      id: 'TEST-123',
      layerKey: 'test',
      lon: 0,
      lat: 0,
      _raw: { speedMps: 0 },
    };
    const payload = {
      ...buildBreachPayload(mockEntity, { now }),
      test: true,
    };
    return dispatchBreach(webhookUrl, payload, fetchImpl);
  };

  const emitInternalEnter = (entity, polygon) => {
    // Internal event only on initial outside->inside, never duplicate
    try {
      if (
        typeof window !== 'undefined' &&
        typeof window.dispatchEvent === 'function'
      ) {
        window.dispatchEvent(
          new CustomEvent('geofence:enter', {
            detail: {
              entity,
              polygon: polygon ? [...polygon] : null,
              at: Date.now(),
            },
          }),
        );
      }
    } catch {}
    // Also notify via document for non-window contexts
    try {
      if (
        typeof document !== 'undefined' &&
        typeof document.dispatchEvent === 'function'
      ) {
        document.dispatchEvent(
          new CustomEvent('geofence:enter', {
            detail: {
              entity,
              polygon: polygon ? [...polygon] : null,
              at: Date.now(),
            },
          }),
        );
      }
    } catch {}
    // Dispatch HTTP POST immediately on confirmed breach
    dispatchWebhookForEnter(entity);
  };

  const evaluateAll = () => {
    if (destroyed) return { inside: [], outside: [], entered: [], exited: [] };
    const polygon = getActivePolygon();

    // No fence: stay idle. Pulling every layer's records on each
    // data-updated just to track entities against nothing wastes work and
    // grows the tracker without bound, so skip the collection entirely.
    if (!polygon) {
      const had =
        tracker.size > 0 || insideEntities.size > 0 || lastInsideCount > 0;
      tracker.clear();
      insideEntities = new Map();
      lastInsideCount = 0;
      lastEvaluation = {
        at: Date.now(),
        total: 0,
        inside: 0,
        outside: 0,
        entered: 0,
        exited: 0,
      };
      if (had) {
        notify({
          type: 'evaluation',
          inside: [],
          outside: [],
          total: 0,
          polygon: null,
        });
      }
      return {
        inside: [],
        outside: [],
        entered: [],
        exited: [],
        total: 0,
      };
    }

    const entities = collectLiveEntities();
    const { inside, outside } = evaluateBatch(
      entities.map((e) => ({ ...e, lon: e.lon, lat: e.lat })),
      polygon,
    );

    const entered = [];
    const exited = [];
    const nextInsideMap = new Map();
    const seen = new Set();

    // Use state tracker to dedupe: only initial outside->inside triggers enter
    for (const e of inside) {
      const k = entityKey(e.layerKey, e);
      if (k === null) continue;
      seen.add(k);
      const transition = tracker.update(k, true);
      nextInsideMap.set(k, e);
      if (transition === 'entered') {
        entered.push(e);
        insideEntities.set(k, e);
        emitInternalEnter(e, polygon);
      } else {
        // already inside -> no duplicate, keep entity
        insideEntities.set(k, e);
      }
    }
    for (const e of outside) {
      const k = entityKey(e.layerKey, e);
      if (k === null) continue;
      seen.add(k);
      const transition = tracker.update(k, false);
      if (transition === 'exited') {
        exited.push(e);
        insideEntities.delete(k);
      }
    }

    // Drop state for entities that left the feed: without pruning, every
    // record ever seen lingers in the tracker and the inside map forever.
    for (const k of tracker.getAll().keys()) {
      if (!seen.has(k)) {
        tracker.remove(k);
        insideEntities.delete(k);
      }
    }

    lastInsideCount = nextInsideMap.size;
    lastEvaluation = {
      at: Date.now(),
      total: entities.length,
      inside: nextInsideMap.size,
      outside: outside.length,
      entered: entered.length,
      exited: exited.length,
    };

    if (entered.length) {
      notify({
        type: 'enter',
        entered,
        inside: [...nextInsideMap.values()],
        outside,
        polygon: [...polygon],
      });
    }
    if (exited.length) {
      notify({
        type: 'exit',
        exited,
        inside: [...nextInsideMap.values()],
        outside,
        polygon: [...polygon],
      });
    }
    if (entered.length || exited.length) {
      notify({
        type: 'transition',
        entered,
        exited,
        inside: [...nextInsideMap.values()],
        outside,
        polygon: [...polygon],
      });
    }

    // Always notify evaluation for UI counts
    notify({
      type: 'evaluation',
      inside: [...nextInsideMap.values()],
      outside,
      total: entities.length,
      polygon: [...polygon],
    });

    return {
      inside: [...nextInsideMap.values()],
      outside,
      entered,
      exited,
      total: entities.length,
    };
  };

  const evaluatePoint = (lon, lat) => {
    const polygon = getActivePolygon();
    if (!polygon) return false;
    return pointInPolygon(lon, lat, polygon);
  };

  // Re-baseline when the fence itself is drawn or edited: the boundary
  // moved, not the entities, so everything already inside starts as inside
  // without firing enter events or webhooks. Only later movement across the
  // boundary counts as a breach.
  const seedFromLiveEntities = (polygon) => {
    const entities = collectLiveEntities();
    const { inside, outside } = evaluateBatch(
      entities.map((e) => ({ ...e, lon: e.lon, lat: e.lat })),
      polygon,
    );
    tracker.clear();
    insideEntities = new Map();
    for (const e of inside) {
      const k = entityKey(e.layerKey, e);
      if (k === null) continue;
      tracker.seed(k, true);
      insideEntities.set(k, e);
    }
    for (const e of outside) {
      const k = entityKey(e.layerKey, e);
      if (k === null) continue;
      tracker.seed(k, false);
    }
    lastInsideCount = insideEntities.size;
    lastEvaluation = {
      at: Date.now(),
      total: entities.length,
      inside: insideEntities.size,
      outside: outside.length,
      entered: 0,
      exited: 0,
    };
    notify({
      type: 'evaluation',
      inside: [...insideEntities.values()],
      outside,
      total: entities.length,
      polygon: [...polygon],
    });
    return {
      inside: [...insideEntities.values()],
      outside,
      entered: [],
      exited: [],
      total: entities.length,
    };
  };

  // Re-evaluate when polygon changes (draw/edit/clear)
  const notifyPolygonChanged = () => {
    if (destroyed) return;
    const poly = getActivePolygon();
    if (!poly) {
      const prev = [...insideEntities.values()];
      tracker.clear();
      insideEntities = new Map();
      lastInsideCount = 0;
      if (prev.length) {
        notify({
          type: 'transition',
          entered: [],
          exited: prev,
          inside: [],
          outside: [],
          polygon: null,
        });
        notify({
          type: 'exit',
          exited: prev,
          inside: [],
          outside: [],
          polygon: null,
        });
      }
      notify({
        type: 'evaluation',
        inside: [],
        outside: [],
        total: 0,
        polygon: null,
      });
      return;
    }
    // Polygon drawn or edited: seed the baseline silently instead of
    // treating every covered record as a fresh breach.
    seedFromLiveEntities(poly);
  };

  // Single-entity update helper for direct position updates (deduped)
  const updateEntity = (layerKey, id, lon, lat) => {
    if (destroyed) return null;
    const polygon = getActivePolygon();
    if (!polygon) {
      const k = `${layerKey}:${id}`;
      const t = tracker.update(k, false);
      if (t === 'exited') insideEntities.delete(k);
      return null;
    }
    const isInside = pointInPolygon(lon, lat, polygon);
    const k = `${layerKey}:${id}`;
    const transition = tracker.update(k, isInside);
    if (transition === 'entered') {
      const entity = { layerKey, id, lon, lat };
      insideEntities.set(k, entity);
      emitInternalEnter(entity, polygon);
      notify({
        type: 'enter',
        entered: [entity],
        inside: [...insideEntities.values()],
        outside: [],
        polygon: [...polygon],
      });
      return 'entered';
    }
    if (transition === 'exited') {
      const entity = { layerKey, id, lon, lat };
      insideEntities.delete(k);
      notify({
        type: 'exit',
        exited: [entity],
        inside: [...insideEntities.values()],
        outside: [],
        polygon: [...polygon],
      });
      return 'exited';
    }
    return null;
  };

  let unsubscribeActivity = null;
  if (dataManager?.subscribeActivity) {
    unsubscribeActivity = dataManager.subscribeActivity((change) => {
      if (destroyed) return;
      if (change?.type === 'data-updated') {
        // Every position update from any layer triggers evaluation
        evaluateAll();
      }
    });
  }

  // Also subscribe to generic lifecycle subscribe for fallback (some layers use refresh)
  let unsubscribeLifecycle = null;
  if (dataManager?.subscribe) {
    unsubscribeLifecycle = dataManager.subscribe((change) => {
      if (destroyed) return;
      if (change?.type === 'refresh' && change?.layerId) {
        evaluateAll();
      }
    });
  }

  const api = {
    evaluatePoint,
    evaluateAll,
    evaluateBatch: (entities) => {
      const polygon = getActivePolygon();
      return evaluateBatch(entities, polygon);
    },
    updateEntity,
    notifyPolygonChanged,
    setWebhookUrl,
    getWebhookUrl: () => webhookUrl,
    getLastWebhookError: () => lastWebhookError,
    sendTestPayload,
    getInsideCount: () => lastInsideCount,
    getInsideEntities: () => [...insideEntities.values()],
    getLastEvaluation: () => (lastEvaluation ? { ...lastEvaluation } : null),
    getPolygon: getActivePolygon,
    getTracker: () => tracker,
    isInside: (layerKey, id) => tracker.isInside(`${layerKey}:${id}`),
    onEnter: (cb) => {
      if (typeof cb !== 'function') return () => {};
      const wrapped = (evt) => {
        if (evt?.type === 'enter' && Array.isArray(evt.entered)) {
          for (const e of evt.entered) {
            try {
              cb(e, evt);
            } catch (err) {
              console.warn('[GeofenceMonitor] onEnter error:', err);
            }
          }
        }
      };
      listeners.add(wrapped);
      return () => listeners.delete(wrapped);
    },
    subscribe: (cb) => {
      if (typeof cb !== 'function') return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    clearTracker: () => {
      tracker.clear();
      insideEntities = new Map();
      lastInsideCount = 0;
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      try {
        unsubscribeActivity?.();
      } catch {}
      try {
        unsubscribeLifecycle?.();
      } catch {}
      listeners.clear();
      tracker.clear();
      insideEntities.clear();
    },
    diagnostics: () => ({
      destroyed,
      hasPolygon: Boolean(getActivePolygon()),
      insideCount: lastInsideCount,
      listeners: listeners.size,
      lastEvaluation,
      // The URL itself is a secret (Slack-style webhook tokens ride in the
      // path), so diagnostics report only whether one is configured.
      hasWebhookUrl: Boolean(webhookUrl),
      lastWebhookError,
    }),
  };

  if (typeof window !== 'undefined') {
    window.__gevGeofenceMonitor = api;
  }

  return api;
}

/** Convenience init for app wiring: connects geofenceTool + dataManager */
export function initGeofenceMonitor({ geofenceTool, dataManager }) {
  if (!geofenceTool || !dataManager) return null;
  const monitor = createGeofenceMonitor({
    getPolygon: () => geofenceTool.geofence?.vertices ?? null,
    dataManager,
  });

  // Re-evaluate immediately when polygon is drawn/edited/cleared,
  // not just on next data-updated.
  const unsub =
    typeof geofenceTool.onPolygonChange === 'function'
      ? geofenceTool.onPolygonChange(() => monitor.notifyPolygonChanged())
      : null;

  const origDestroy = monitor.destroy.bind(monitor);
  monitor.destroy = () => {
    try {
      unsub?.();
    } catch {}
    origDestroy();
  };

  return monitor;
}
