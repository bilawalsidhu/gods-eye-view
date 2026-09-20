/**
 * Standing alerts over live layer data. A watch is a layer plus a scope plus
 * filters; whenever the layer publishes a new snapshot, records that match for
 * the first time raise an alert. Watches persist in localStorage so "tell me
 * when a plane enters 20 km of home" survives a reload.
 */
export const WATCH_STORAGE_KEY = 'gev:voice-watches:v1';
const MAX_WATCHES = 12;
const MAX_SEEN_PER_WATCH = 400;
const MIN_ALERT_GAP_MS = 4000;

export const WATCHABLE_LAYERS = Object.freeze([
  'flights',
  'military',
  'ais-live-vessels',
  'earthquakes',
  'local-firms',
]);

export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Evaluate one filter clause against a record. */
export function matchesFilter(record, { field, op, value }) {
  const actual = record?.[field];
  if (actual == null) return false;
  switch (op) {
    case 'gt':
      return Number(actual) > Number(value);
    case 'gte':
      return Number(actual) >= Number(value);
    case 'lt':
      return Number(actual) < Number(value);
    case 'lte':
      return Number(actual) <= Number(value);
    case 'eq':
      return String(actual).toLowerCase() === String(value).toLowerCase();
    case 'neq':
      return String(actual).toLowerCase() !== String(value).toLowerCase();
    case 'contains':
      return String(actual).toLowerCase().includes(String(value).toLowerCase());
    default:
      return false;
  }
}

/** Resolve a scope into a center + radius using the camera when needed. */
export function resolveScope(scope, camera) {
  if (!scope || scope.kind === 'anywhere') return null;
  if (scope.kind === 'radius') {
    if (!Number.isFinite(scope.latitude) || !Number.isFinite(scope.longitude))
      return camera
        ? { lat: camera.lat, lon: camera.lon, km: scope.km || 25 }
        : null;
    return { lat: scope.latitude, lon: scope.longitude, km: scope.km || 25 };
  }
  if (scope.kind === 'view') {
    if (!camera) return null;
    const altKm = (camera.alt || 0) / 1000;
    return {
      lat: camera.lat,
      lon: camera.lon,
      km: Math.min(2500, Math.max(25, altKm * 1.6)),
    };
  }
  return null;
}

/** Copy records with distanceKm from the scope center (or camera) filled in. */
export function withDistance(records, resolved, camera = null) {
  const center =
    resolved || (camera ? { lat: camera.lat, lon: camera.lon } : null);
  if (!center) return records;
  return records.map((record) =>
    Number.isFinite(record?.lat) && Number.isFinite(record?.lon)
      ? {
          ...record,
          distanceKm:
            Math.round(
              haversineKm(record.lat, record.lon, center.lat, center.lon) * 10,
            ) / 10,
        }
      : record,
  );
}

export function inScope(record, resolved) {
  if (!resolved) return true;
  if (!Number.isFinite(record?.lat) || !Number.isFinite(record?.lon))
    return false;
  return (
    haversineKm(record.lat, record.lon, resolved.lat, resolved.lon) <=
    resolved.km
  );
}

export function recordLabel(record, layer) {
  if (!record) return 'unknown';
  if (layer === 'earthquakes')
    return `M${Number(record.mag).toFixed(1)} ${record.place || 'earthquake'}`;
  if (layer === 'local-firms') return `fire ${Math.round(record.frp || 0)} MW`;
  return (
    record.callsign || record.name || record.label || record.id || 'contact'
  );
}

export function describeMatch(record, layer) {
  const parts = [];
  if (!record?.operator && record?.airlineHint) parts.push(record.airlineHint);
  if (Number.isFinite(record?.altitudeM))
    parts.push(`${Math.round(record.altitudeM / 100) * 100} m`);
  if (Number.isFinite(record?.speedKts))
    parts.push(`${Math.round(record.speedKts)} knots`);
  if (record?.operator) parts.push(record.operator);
  if (record?.destination) parts.push(`to ${record.destination}`);
  if (record?.shipType) parts.push(record.shipType);
  if (layer === 'earthquakes' && Number.isFinite(record?.depth))
    parts.push(`${Math.round(record.depth)} km deep`);
  return parts.join(', ');
}

export function createWatchEngine({
  dataManager,
  getCamera = () => null,
  onAlert = () => {},
  storage = safeStorage(),
  now = () => Date.now(),
  maxRecords = 5000,
} = {}) {
  let watches = load();
  let unsubscribe = null;
  let lastAlertAt = -Infinity;
  const queue = [];

  function load() {
    try {
      const raw = storage?.getItem(WATCH_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed)
        ? parsed.map((w) => ({ ...w, seen: new Set(w.seen || []) }))
        : [];
    } catch {
      return [];
    }
  }
  function save() {
    try {
      storage?.setItem(
        WATCH_STORAGE_KEY,
        JSON.stringify(
          watches.map((w) => ({
            ...w,
            seen: [...w.seen].slice(-MAX_SEEN_PER_WATCH),
          })),
        ),
      );
    } catch {
      /* storage may be unavailable */
    }
  }

  function records(layer) {
    if (!dataManager?.isEnabled?.(layer)) return null;
    const module = dataManager.layers?.get?.(layer)?.module;
    if (typeof module?.getAnalystRecords !== 'function') return null;
    try {
      return module.getAnalystRecords(maxRecords) || [];
    } catch {
      return [];
    }
  }

  function flush() {
    if (!queue.length) return;
    const gap = now() - lastAlertAt;
    if (gap < MIN_ALERT_GAP_MS) {
      setTimeout(flush, MIN_ALERT_GAP_MS - gap)?.unref?.();
      return;
    }
    const alert = queue.shift();
    lastAlertAt = now();
    onAlert(alert);
    if (queue.length) setTimeout(flush, MIN_ALERT_GAP_MS)?.unref?.();
  }

  function evaluate(layerId, { prime = false } = {}) {
    const camera = getCamera();
    let changed = false;
    for (const watch of watches.slice()) {
      if (watch.layer !== layerId) continue;
      const raw = records(layerId);
      if (!raw) continue;
      const resolved = resolveScope(watch.scope, watch.scopeCamera || camera);
      const rows = withDistance(raw, resolved, watch.scopeCamera || camera);
      const filters = Array.isArray(watch.filters) ? watch.filters : [];
      let fired = false;
      for (const record of rows) {
        const id = String(record.id ?? record.icao24 ?? record.mmsi ?? '');
        if (!id) continue;
        if (!inScope(record, resolved)) continue;
        if (!filters.every((f) => matchesFilter(record, f))) continue;
        if (watch.seen.has(id)) continue;
        watch.seen.add(id);
        changed = true;
        if (prime) continue; // existing matches at creation are baseline, not news
        fired = true;
        queue.push({
          watchId: watch.id,
          description: watch.description,
          layer: layerId,
          record,
          label: recordLabel(record, layerId),
          detail: describeMatch(record, layerId),
          text: `${watch.description}: ${recordLabel(record, layerId)}${
            describeMatch(record, layerId)
              ? `, ${describeMatch(record, layerId)}`
              : ''
          }.`,
        });
        if (watch.once) break;
      }
      if (fired && watch.once) {
        watches = watches.filter((w) => w.id !== watch.id);
        changed = true;
      }
      if (watch.seen.size > MAX_SEEN_PER_WATCH)
        watch.seen = new Set([...watch.seen].slice(-MAX_SEEN_PER_WATCH));
    }
    if (changed) save();
    flush();
  }

  function start() {
    if (unsubscribe || typeof dataManager?.subscribeActivity !== 'function')
      return;
    unsubscribe = dataManager.subscribeActivity((event) => {
      if (
        event?.type === 'data-updated' &&
        WATCHABLE_LAYERS.includes(event.layerId)
      )
        evaluate(event.layerId);
    });
  }

  return {
    start,
    add({ layer, description, scope, filters = [], once = false }) {
      if (!WATCHABLE_LAYERS.includes(layer))
        throw new Error(`Cannot watch layer ${layer}`);
      if (watches.length >= MAX_WATCHES)
        throw new Error(`At most ${MAX_WATCHES} alerts`);
      const camera = getCamera();
      const watch = {
        id: `w${now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
        layer,
        description: String(description || 'alert').slice(0, 80),
        scope: scope || { kind: 'anywhere' },
        // Freeze "view"/"here" to the camera at creation so the alert does not drift.
        scopeCamera:
          scope?.kind === 'view' ||
          (scope?.kind === 'radius' && !Number.isFinite(scope?.latitude))
            ? camera
            : null,
        filters,
        once: Boolean(once),
        createdAt: now(),
        seen: new Set(),
      };
      watches.push(watch);
      save();
      start();
      evaluate(layer, { prime: true });
      const resolved = resolveScope(watch.scope, watch.scopeCamera || camera);
      return {
        id: watch.id,
        layer,
        description: watch.description,
        radiusKm: resolved ? Math.round(resolved.km) : null,
        enabled: Boolean(dataManager?.isEnabled?.(layer)),
        baseline: watch.seen.size,
      };
    },
    list() {
      return watches.map((w) => ({
        id: w.id,
        layer: w.layer,
        description: w.description,
        scope: w.scope?.kind || 'anywhere',
        filters: w.filters,
        once: w.once,
        seen: w.seen.size,
      }));
    },
    clear(id) {
      const before = watches.length;
      watches = id ? watches.filter((w) => w.id !== id) : [];
      save();
      return before - watches.length;
    },
    evaluate,
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
