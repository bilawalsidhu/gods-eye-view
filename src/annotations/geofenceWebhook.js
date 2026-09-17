/**
 * Geofence webhook: builds structured JSON payload and dispatches HTTP POST
 * on confirmed boundary breach (outside->inside).
 *
 * Pure, testable. No DOM.
 */

export function isValidWebhookUrl(url) {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function extractSpeed(entity) {
  if (!entity) return null;
  const raw = entity._raw ?? entity;
  const candidates = [
    raw.speedMps,
    raw.speedKts,
    raw.velocity,
    raw.speed,
    raw.velocityMps,
    entity.speedMps,
    entity.speedKts,
    entity.speed,
  ];
  for (const v of candidates) {
    if (Number.isFinite(v)) return v;
  }
  return null;
}

export function buildBreachPayload(entity, { now = () => new Date().toISOString() } = {}) {
  const raw = entity?._raw ?? {};
  const entityId =
    entity?.id ?? raw.icao24 ?? raw.mmsi ?? entity?.icao24 ?? entity?.mmsi ?? 'unknown';
  const lon = entity?.lon ?? raw.lon ?? raw.longitude;
  const lat = entity?.lat ?? raw.latitude;
  const speed = extractSpeed(entity);
  return {
    entityId: String(entityId),
    timestamp: now(),
    coordinates: {
      lon: Number.isFinite(lon) ? lon : null,
      lat: Number.isFinite(lat) ? lat : null,
    },
    speed: speed,
    layer: entity?.layerKey ?? null,
  };
}

export async function dispatchBreach(url, payload, fetchImpl = fetch) {
  const trimmed = String(url || '').trim();
  if (!isValidWebhookUrl(trimmed)) {
    throw new Error('Invalid webhook URL');
  }
  const res = await fetchImpl(trimmed, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Webhook POST failed: ${res.status}`);
  }
  return res;
}
