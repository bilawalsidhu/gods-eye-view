import { readResponseJsonCapped } from '../../sources/httpBody.js';

export const WEATHER_ALERTS_RESPONSE_LIMIT = 4 * 1024 * 1024;
export const WEATHER_ALERTS_ZONE_LIMIT = 300;
export const WEATHER_ALERTS_ZONE_CONCURRENCY = 5;

const malformed = () => new Error('Malformed CAP alert snapshot');
const text = (value, max = 512) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/.test(value)
  )
    throw malformed();
  return value.trim();
};
const validTime = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw malformed();
  return value;
};
const pair = (value) => {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1]) ||
    value[0] < -180 ||
    value[0] > 180 ||
    value[1] < -90 ||
    value[1] > 90
  )
    throw malformed();
  return [value[0], value[1]];
};
const ring = (value, budget) => {
  if (!Array.isArray(value) || value.length < 3 || value.length > 20_000)
    throw malformed();
  const points = value.map((item) => {
    if (++budget.coordinates > 100_000) throw malformed();
    return pair(item);
  });
  const first = points[0],
    last = points.at(-1);
  if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);
  if (points.length < 4) throw malformed();
  return points;
};
function normalizeGeoJson(value, budget = { coordinates: 0 }) {
  if (!value || !['Polygon', 'MultiPolygon'].includes(value.type)) return null;
  const polygon = (rings) => {
    if (!Array.isArray(rings) || !rings.length || rings.length > 64)
      throw malformed();
    return rings.map((item) => ring(item, budget));
  };
  const coordinates =
    value.type === 'Polygon'
      ? polygon(value.coordinates)
      : (() => {
          if (
            !Array.isArray(value.coordinates) ||
            !value.coordinates.length ||
            value.coordinates.length > 256
          )
            throw malformed();
          return value.coordinates.map(polygon);
        })();
  return { type: value.type, coordinates };
}
function normalizeCapPolygon(value, budget) {
  if (value?.type !== 'polygon' || !Array.isArray(value.coordinates))
    return null;
  const coordinates = value.coordinates.map(([latitude, longitude]) => {
    if (++budget.coordinates > 100_000) throw malformed();
    return pair([longitude, latitude]);
  });
  return normalizeGeoJson(
    { type: 'Polygon', coordinates: [coordinates] },
    budget,
  );
}
function normalizeCircle(value) {
  if (
    value?.type !== 'circle' ||
    !Array.isArray(value.center) ||
    value.center.length !== 2 ||
    !value.center.every(Number.isFinite) ||
    value.center[0] < -90 ||
    value.center[0] > 90 ||
    value.center[1] < -180 ||
    value.center[1] > 180 ||
    !Number.isFinite(value.radiusKm) ||
    value.radiusKm <= 0 ||
    value.radiusKm > 1_000
  )
    return null;
  const [latitude, longitude] = value.center;
  const angular = value.radiusKm / 6371;
  const lat = (latitude * Math.PI) / 180;
  const lon = (longitude * Math.PI) / 180;
  const points = [];
  for (let index = 0; index < 48; index++) {
    const bearing = (index * 2 * Math.PI) / 48;
    const nextLat = Math.asin(
      Math.sin(lat) * Math.cos(angular) +
        Math.cos(lat) * Math.sin(angular) * Math.cos(bearing),
    );
    const nextLon =
      lon +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(lat),
        Math.cos(angular) - Math.sin(lat) * Math.sin(nextLat),
      );
    points.push([
      (((nextLon * 180) / Math.PI + 540) % 360) - 180,
      (nextLat * 180) / Math.PI,
    ]);
  }
  points.push([...points[0]]);
  return { type: 'Polygon', coordinates: [points] };
}
function areaGeometry(area, budget) {
  return (
    normalizeGeoJson(area?.geometry, budget) ||
    normalizeCapPolygon(area?.geometry, budget) ||
    normalizeCircle(area?.geometry)
  );
}
function nwsSource(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'api.weather.gov' &&
      url.pathname.startsWith('/alerts/') &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
function zoneIds(value) {
  if (typeof value !== 'string') return [];
  return [
    ...new Set(value.toUpperCase().match(/\b[A-Z]{2}[CZ]\d{3}\b/g) || []),
  ];
}
function zoneType(id, event) {
  if (id[2] === 'C') return 'county';
  return /fire weather|red flag/i.test(event) ? 'fire' : 'forecast';
}
function chooseInfo(raw) {
  if (!Array.isArray(raw.info) || raw.info.length === 0) return null;
  return (
    raw.info.find((item) => /^en(?:-|$)/i.test(item?.language || '')) ||
    raw.info[0]
  );
}

/** Project a lifecycle-normalized CAP snapshot; this layer must not infer update/cancel state locally. */
export function normalizeCapSnapshot(value, { now = Date.now() } = {}) {
  if (
    value?.source !== 'cap' ||
    !Array.isArray(value.alerts) ||
    value.alerts.length > 2_000
  )
    throw malformed();
  const generatedAt = validTime(value.generatedAt);
  if (!generatedAt) throw malformed();
  const seen = new Set();
  const budget = { coordinates: 0 };
  const alerts = [];
  for (const raw of value.alerts) {
    if (
      !raw ||
      !nwsSource(raw.source) ||
      raw.region !== 'US' ||
      raw.status !== 'Actual' ||
      raw.scope !== 'Public' ||
      raw.msgType !== 'Alert' ||
      typeof raw.identifier !== 'string' ||
      !raw.identifier.trim() ||
      raw.identifier.length > 512 ||
      seen.has(raw.identifier)
    )
      continue;
    const info = chooseInfo(raw);
    if (!info || !text(info.event, 160)) continue;
    const expires = validTime(info.expires);
    if (expires && Date.parse(expires) <= now) continue;
    const areas = Array.isArray(info.areas) ? info.areas.slice(0, 128) : [];
    const normalizedAreas = areas.map((area) => ({
      description:
        typeof area?.description === 'string'
          ? area.description.slice(0, 512)
          : '',
      geocode:
        typeof area?.geocode === 'string' ? area.geocode.slice(0, 2_000) : '',
      geometry: areaGeometry(area, budget),
    }));
    const geometries = normalizedAreas
      .map(({ geometry }) => geometry)
      .filter(Boolean);
    alerts.push({
      id: raw.identifier,
      sender: text(raw.sender, 256),
      event: text(info.event, 160),
      headline: info.headline
        ? text(info.headline, 512)
        : text(info.event, 160),
      description: info.description ? text(info.description, 16_000) : '',
      instruction: info.instruction ? text(info.instruction, 8_000) : '',
      severity: ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'].includes(
        info.severity,
      )
        ? info.severity
        : 'Unknown',
      urgency: typeof info.urgency === 'string' ? info.urgency : 'Unknown',
      certainty:
        typeof info.certainty === 'string' ? info.certainty : 'Unknown',
      sent: validTime(raw.sent),
      onset: validTime(info.onset),
      expires,
      areas: normalizedAreas,
      geometries,
    });
    seen.add(raw.identifier);
  }
  return { schemaVersion: 1, generatedAt, alerts };
}

/** Resolve missing NWS UGC areas in bounded batches and cache valid polygons. */
export function createNwsZoneResolver({
  fetchImpl = (...args) => globalThis.fetch(...args),
  concurrency = WEATHER_ALERTS_ZONE_CONCURRENCY,
  maxZones = WEATHER_ALERTS_ZONE_LIMIT,
  maxZoneBytes = 1024 * 1024,
} = {}) {
  const cache = new Map();
  const lookup = async (type, id, signal) => {
    const key = `${type}:${id}`;
    if (cache.has(key)) return cache.get(key);
    const pending = (async () => {
      const response = await fetchImpl(`/api/weather-zones/${type}/${id}`, {
        signal,
        cache: 'force-cache',
        redirect: 'error',
        headers: { accept: 'application/geo+json, application/json' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const feature = await readResponseJsonCapped(
        response,
        maxZoneBytes,
        signal,
      );
      const geometry = normalizeGeoJson(feature?.geometry);
      return geometry ? { id, geometry } : null;
    })();
    cache.set(key, pending);
    try {
      const result = await pending;
      if (!result) cache.delete(key);
      while (cache.size > maxZones) cache.delete(cache.keys().next().value);
      return result;
    } catch (error) {
      cache.delete(key);
      if (signal?.aborted) throw error;
      return null;
    }
  };
  return {
    async resolve(alerts, { signal } = {}) {
      const tasks = [];
      const seen = new Set();
      for (const alert of alerts) {
        for (const [areaIndex, area] of alert.areas.entries()) {
          if (area.geometry) continue;
          for (const id of zoneIds(area.geocode)) {
            const type = zoneType(id, alert.event);
            const key = `${alert.id}:${areaIndex}:${type}:${id}`;
            if (!seen.has(key)) {
              seen.add(key);
              tasks.push({ alertId: alert.id, areaIndex, type, id });
            }
            if (tasks.length >= maxZones) break;
          }
          if (tasks.length >= maxZones) break;
        }
        if (tasks.length >= maxZones) break;
      }
      const resolved = new Map();
      const width = Math.max(1, Math.min(6, Math.trunc(concurrency) || 1));
      for (let index = 0; index < tasks.length; index += width) {
        signal?.throwIfAborted();
        const batch = await Promise.all(
          tasks.slice(index, index + width).map(async (task) => ({
            ...task,
            zone: await lookup(task.type, task.id, signal),
          })),
        );
        for (const item of batch)
          if (item.zone) {
            const key = `${item.alertId}:${item.areaIndex}`;
            const geometries = resolved.get(key) || [];
            geometries.push(item.zone.geometry);
            resolved.set(key, geometries);
          }
      }
      return alerts.map((alert) => {
        const areas = alert.areas.map((area, index) => ({
          ...area,
          geometry:
            area.geometry || resolved.get(`${alert.id}:${index}`)?.[0] || null,
        }));
        return {
          ...alert,
          areas,
          geometries: areas.map(({ geometry }) => geometry).filter(Boolean),
        };
      });
    },
    getCacheSize: () => cache.size,
  };
}

/** Lazy CAP acquisition plus optional NWS zone enrichment; no CAP lifecycle logic. */
export function createWeatherAlertsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  zoneResolver = createNwsZoneResolver({ fetchImpl }),
  timeoutMs = 15_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('CAP request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl('/api/cap', {
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'error',
          headers: { accept: 'application/json' },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`CAP HTTP ${response.status}`);
        }
        const payload = await readResponseJsonCapped(
          response,
          WEATHER_ALERTS_RESPONSE_LIMIT,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        const snapshot = normalizeCapSnapshot(payload);
        const alerts = await zoneResolver.resolve(snapshot.alerts, {
          signal: controller.signal,
        });
        return { ...snapshot, alerts };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
