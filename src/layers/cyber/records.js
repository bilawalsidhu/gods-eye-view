const iso = (value) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

function boundedText(value, max = 160) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max && !/[\u0000-\u001f<>]/.test(text)
    ? text
    : null;
}

/** Validate one normalized, provider-attributed Cyber observation. */
function normalizeObservation(value, provider) {
  if (!value || typeof value !== 'object') return null;
  const id = boundedText(value.id, 120);
  const category = boundedText(value.category, 80);
  const source = boundedText(value.source, 160);
  const observedAt = iso(value.observedAt);
  if (!id || !category || value.provider !== provider || !source) return null;
  const coordinatesPresent = value.latitude != null || value.longitude != null;
  let latitude = null;
  let longitude = null;
  if (coordinatesPresent) {
    if (
      !Number.isFinite(value.latitude) ||
      value.latitude < -90 ||
      value.latitude > 90 ||
      !Number.isFinite(value.longitude) ||
      value.longitude < -180 ||
      value.longitude > 180 ||
      !['country', 'network-approximate'].includes(value.geographicPrecision) ||
      !boundedText(value.geographicMethod, 120) ||
      !boundedText(value.geographicProvenance, 200)
    )
      return null;
    latitude = value.latitude;
    longitude = value.longitude;
  }
  const share =
    Number.isFinite(value.share) && value.share >= 0 && value.share <= 100
      ? value.share
      : null;
  const rank =
    Number.isInteger(value.rank) && value.rank > 0 ? value.rank : null;
  const indicatorType = boundedText(value.indicator?.type, 24);
  const indicatorValue = boundedText(value.indicator?.value, 160);
  return Object.freeze({
    id,
    provider,
    category,
    source,
    observedAt,
    windowStart: iso(value.windowStart),
    windowEnd: iso(value.windowEnd),
    latitude,
    longitude,
    geographicPrecision: coordinatesPresent ? value.geographicPrecision : null,
    geographicMethod: coordinatesPresent ? value.geographicMethod : null,
    geographicProvenance: coordinatesPresent
      ? value.geographicProvenance
      : null,
    locationCode: boundedText(value.locationCode, 2),
    locationName: boundedText(value.locationName, 100),
    share,
    rank,
    hostname: boundedText(value.hostname, 253),
    indicator:
      indicatorType && indicatorValue
        ? Object.freeze({ type: indicatorType, value: indicatorValue })
        : null,
    detail: boundedText(value.detail, 160),
  });
}

/** Normalize a provider snapshot into the Cyber domain and reject raw records. */
export function normalizeCyberSnapshot(value, provider) {
  if (
    !['cloudflare-radar', 'dshield'].includes(provider) ||
    !value ||
    value.schemaVersion !== 1 ||
    value.provider !== provider ||
    !Array.isArray(value.observations) ||
    value.observations.length > 32
  )
    throw new Error('Malformed Cyber provider response');
  const fetchedAt = iso(value.fetchedAt);
  const attribution = boundedText(value.attribution, 200);
  if (!fetchedAt || !attribution)
    throw new Error('Malformed Cyber provider response');
  const observations = value.observations.map((record) =>
    normalizeObservation(record, provider),
  );
  if (observations.some((record) => !record))
    throw new Error('Malformed Cyber provider response');
  const ports =
    provider === 'dshield' && Array.isArray(value.ports)
      ? value.ports.slice(0, 10).map((port) => ({
          rank:
            Number.isInteger(port?.rank) && port.rank > 0 ? port.rank : null,
          port:
            Number.isInteger(port?.port) && port.port >= 0 && port.port <= 65535
              ? port.port
              : null,
          protocol: boundedText(port?.protocol, 16),
          label: boundedText(port?.label, 100),
          sources:
            Number.isInteger(port?.sources) && port.sources >= 0
              ? port.sources
              : null,
        }))
      : [];
  if (
    ports.some((port) => port.rank == null || port.port == null || !port.label)
  )
    throw new Error('Malformed Cyber provider response');
  return Object.freeze({
    provider,
    attribution,
    fetchedAt,
    stale: value.stale === true,
    windowStart: iso(value.windowStart),
    windowEnd: iso(value.windowEnd),
    notice: boundedText(value.notice, 240),
    observations: Object.freeze(observations),
    ports: Object.freeze(ports),
  });
}

export { normalizeObservation as normalizeCyberObservation };
