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

  const entityKey = (layerKey, e) => {
    const id =
      e.icao24 ?? e.mmsi ?? e.id ?? e.icao ?? JSON.stringify([e.lon, e.lat]);
    return `${layerKey}:${id}`;
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
          all.push({
            layerKey,
            id: r.icao24 ?? r.mmsi ?? r.id,
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

  const dispatchWebhookForEnter = (entity) => {
    if (!webhookUrl) return Promise.resolve(null);
    const payload = buildBreachPayload(entity, { now });
    // Fire-and-forget, but capture errors for diagnostics
    return dispatchBreach(webhookUrl, payload, fetchImpl).catch((err) => {
      lastWebhookError = String(err?.message || err);
      console.warn('[Geofence] webhook POST failed:', err);
      throw err;
    });
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
    const entities = collectLiveEntities();

    // No polygon: everything outside, clear tracker to prevent stale inside
    if (!polygon) {
      const inside = [];
      const outside = entities;
      // Mark all previously inside as exited in tracker (no enter events)
      for (const e of entities) {
        const k = entityKey(e.layerKey, e);
        const res = tracker.update(k, false);
        if (res === 'exited') {
          insideEntities.delete(k);
        }
      }
      lastInsideCount = 0;
      lastEvaluation = {
        at: Date.now(),
        total: entities.length,
        inside: 0,
        outside: outside.length,
        entered: 0,
        exited: 0,
      };
      notify({
        type: 'evaluation',
        inside,
        outside,
        total: entities.length,
        polygon: null,
      });
      return {
        inside,
        outside,
        entered: [],
        exited: [],
        total: entities.length,
      };
    }

    const { inside, outside } = evaluateBatch(
      entities.map((e) => ({ ...e, lon: e.lon, lat: e.lat })),
      polygon,
    );

    const entered = [];
    const exited = [];
    const nextInsideMap = new Map();

    // Use state tracker to dedupe: only initial outside->inside triggers enter
    for (const e of inside) {
      const k = entityKey(e.layerKey, e);
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
      const transition = tracker.update(k, false);
      if (transition === 'exited') {
        exited.push(e);
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
    // Polygon changed: re-evaluate immediately against current live data
    evaluateAll();
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
      webhookUrl,
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
