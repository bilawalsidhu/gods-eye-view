import { haversineKm, recordLabel } from './watchEngine.js';

/**
 * Geofences with behavior: a circle or polygon plus layers to count. Every
 * layer poll recomputes who is inside, records entries and exits per hour,
 * and can raise an alert on entry. Fences persist across reloads.
 */
export const GEOFENCE_STORAGE_KEY = 'gev:voice-geofences:v1';
const MAX_FENCES = 12;
const MAX_EVENTS = 100;
const MAX_HOURS = 48;

export function pointInPolygon(lat, lon, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [yi, xi] = points[i];
    const [yj, xj] = points[j];
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function insideFence(fence, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const shape = fence.shape || {};
  if (
    shape.kind === 'polygon' &&
    Array.isArray(shape.points) &&
    shape.points.length >= 3
  )
    return pointInPolygon(lat, lon, shape.points);
  if (Number.isFinite(shape.latitude) && Number.isFinite(shape.longitude))
    return (
      haversineKm(lat, lon, shape.latitude, shape.longitude) <= (shape.km || 10)
    );
  return false;
}

/** A view box as a polygon from the camera (rough, height-scaled). */
export function viewPolygon(camera) {
  if (!camera) return null;
  const altKm = Math.max(1, (camera.alt || 0) / 1000);
  const halfLat = Math.min(20, altKm * 0.6 * 0.009); // ~0.009° per km
  const halfLon =
    halfLat / Math.max(0.2, Math.cos((camera.lat * Math.PI) / 180));
  return [
    [camera.lat - halfLat, camera.lon - halfLon],
    [camera.lat - halfLat, camera.lon + halfLon],
    [camera.lat + halfLat, camera.lon + halfLon],
    [camera.lat + halfLat, camera.lon - halfLon],
  ];
}

export function hourKey(t) {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}Z`;
}

export function createGeofenceEngine({
  dataManager,
  getCamera = () => null,
  onEnter = () => {},
  storage = safeStorage(),
  now = () => Date.now(),
} = {}) {
  let fences = load();
  const inside = new Map(); // fence id -> Map(layerId -> Set(entity id))
  let unsubscribe = null;

  function load() {
    try {
      const raw = storage?.getItem(GEOFENCE_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  function save() {
    try {
      storage?.setItem(GEOFENCE_STORAGE_KEY, JSON.stringify(fences));
    } catch {
      /* no-op */
    }
  }
  function records(layerId) {
    if (!dataManager?.isEnabled?.(layerId)) return null;
    const module = dataManager.layers?.get?.(layerId)?.module;
    if (typeof module?.getAnalystRecords !== 'function') return null;
    try {
      return module.getAnalystRecords(6000) || [];
    } catch {
      return [];
    }
  }

  function evaluate(layerId, { prime = false } = {}) {
    const rows = records(layerId);
    if (!rows) return;
    const t = now();
    const hour = hourKey(t);
    let changed = false;
    for (const fence of fences) {
      if (!fence.layers.includes(layerId)) continue;
      const byLayer = inside.get(fence.id) || new Map();
      inside.set(fence.id, byLayer);
      const previous = byLayer.get(layerId) || new Set();
      const current = new Set();
      const currentLabels = new Map();
      for (const record of rows) {
        if (!insideFence(fence, record.lat, record.lon)) continue;
        const id = String(record.id ?? record.icao24 ?? record.mmsi ?? '');
        if (!id) continue;
        current.add(id);
        currentLabels.set(id, recordLabel(record, layerId));
      }
      byLayer.set(layerId, current);
      fence.counts = fence.counts || {};
      const bucket = (fence.counts[hour] = fence.counts[hour] || {
        entered: 0,
        exited: 0,
      });
      if (!prime && byLayer.has(`${layerId}:primed`)) {
        for (const id of current)
          if (!previous.has(id)) {
            bucket.entered++;
            changed = true;
            pushEvent(fence, {
              at: t,
              kind: 'enter',
              layerId,
              id,
              label: currentLabels.get(id),
            });
            if (fence.alertOnEnter)
              onEnter({
                fence: fence.name,
                layerId,
                id,
                label: currentLabels.get(id),
                text: `${currentLabels.get(id)} entered ${fence.name}.`,
              });
          }
        for (const id of previous)
          if (!current.has(id)) {
            bucket.exited++;
            changed = true;
            pushEvent(fence, { at: t, kind: 'exit', layerId, id });
          }
      }
      byLayer.set(`${layerId}:primed`, true);
      fence.inside = fence.inside || {};
      fence.inside[layerId] = {
        count: current.size,
        sample: [...currentLabels.values()].slice(0, 5),
      };
      trimHours(fence);
    }
    if (changed || prime) save();
  }

  function pushEvent(fence, event) {
    fence.events = [event, ...(fence.events || [])].slice(0, MAX_EVENTS);
  }
  function trimHours(fence) {
    const keys = Object.keys(fence.counts || {}).sort();
    while (keys.length > MAX_HOURS) delete fence.counts[keys.shift()];
  }

  return {
    start() {
      if (unsubscribe || typeof dataManager?.subscribeActivity !== 'function')
        return;
      unsubscribe = dataManager.subscribeActivity((event) => {
        if (
          event?.type === 'data-updated' &&
          fences.some((f) => f.layers.includes(event.layerId))
        )
          evaluate(event.layerId);
      });
    },
    evaluate,
    add({ name, shape, layers = ['flights'], alertOnEnter = false }) {
      if (fences.length >= MAX_FENCES)
        throw new Error(`At most ${MAX_FENCES} geofences`);
      const camera = getCamera();
      let resolvedShape = shape || { kind: 'view' };
      if (resolvedShape.kind === 'view') {
        const points = viewPolygon(camera);
        if (!points) throw new Error('Camera position unavailable');
        resolvedShape = { kind: 'polygon', points };
      } else if (resolvedShape.kind === 'circle') {
        resolvedShape = {
          kind: 'circle',
          latitude: Number.isFinite(resolvedShape.latitude)
            ? resolvedShape.latitude
            : camera?.lat,
          longitude: Number.isFinite(resolvedShape.longitude)
            ? resolvedShape.longitude
            : camera?.lon,
          km: resolvedShape.km || 10,
        };
        if (!Number.isFinite(resolvedShape.latitude))
          throw new Error('Camera position unavailable');
      } else if (resolvedShape.kind === 'polygon') {
        const points = (resolvedShape.points || [])
          .map((p) => (Array.isArray(p) ? p : [p.latitude, p.longitude]))
          .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
        if (points.length < 3)
          throw new Error('A polygon needs at least 3 points');
        resolvedShape = { kind: 'polygon', points };
      }
      const fence = {
        id: `g${now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
        name: String(name || `fence ${fences.length + 1}`).slice(0, 60),
        shape: resolvedShape,
        layers: layers.filter(Boolean),
        alertOnEnter: Boolean(alertOnEnter),
        createdAt: now(),
        counts: {},
        events: [],
        inside: {},
      };
      fences.push(fence);
      save();
      this.start();
      for (const layerId of fence.layers) evaluate(layerId, { prime: true });
      return this.describe(fence);
    },
    describe(fence) {
      const total = Object.values(fence.counts || {}).reduce(
        (acc, b) => ({
          entered: acc.entered + b.entered,
          exited: acc.exited + b.exited,
        }),
        { entered: 0, exited: 0 },
      );
      const hours = Object.keys(fence.counts || {})
        .sort()
        .slice(-6);
      return {
        id: fence.id,
        name: fence.name,
        shape:
          fence.shape.kind === 'polygon'
            ? { kind: 'polygon', points: fence.shape.points.length }
            : fence.shape,
        layers: fence.layers,
        alertOnEnter: fence.alertOnEnter,
        insideNow: fence.inside || {},
        lastHours: hours.map((h) => ({ hour: h, ...fence.counts[h] })),
        totals: total,
        recentEvents: (fence.events || []).slice(0, 5),
      };
    },
    list() {
      return fences.map((f) => this.describe(f));
    },
    find(nameOrId) {
      const key = String(nameOrId || '')
        .toLowerCase()
        .trim();
      return (
        fences.find((f) => f.id === nameOrId || f.name.toLowerCase() === key) ||
        fences.find((f) => f.name.toLowerCase().includes(key)) ||
        null
      );
    },
    remove(nameOrId) {
      if (!nameOrId) {
        const n = fences.length;
        fences = [];
        inside.clear();
        save();
        return n;
      }
      const fence = this.find(nameOrId);
      if (!fence) return 0;
      fences = fences.filter((f) => f.id !== fence.id);
      inside.delete(fence.id);
      save();
      return 1;
    },
    /** Points for drawing the fence with annotate_map. */
    outline(fence) {
      if (fence.shape.kind === 'polygon')
        return fence.shape.points.map(([latitude, longitude]) => ({
          latitude,
          longitude,
        }));
      const { latitude, longitude, km } = fence.shape;
      const out = [];
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * 2 * Math.PI;
        const dLat = (km / 111) * Math.cos(a);
        const dLon =
          (km / (111 * Math.max(0.2, Math.cos((latitude * Math.PI) / 180)))) *
          Math.sin(a);
        out.push({ latitude: latitude + dLat, longitude: longitude + dLon });
      }
      return out;
    },
    destroy() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

function safeStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}
