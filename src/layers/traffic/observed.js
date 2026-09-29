const GEOMETRY_TYPES = new Set([
  'road-segment',
  'approach',
  'intersection',
]);

export const OBSERVED_TRAFFIC_GEOMETRY_TYPES = Object.freeze([
  ...GEOMETRY_TYPES,
]);

export const DEFAULT_OBSERVED_TRAFFIC_STALE_AFTER_MS = 5 * 60 * 1000;

function safeString(value, maxLength = 160) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function finiteTimestamp(value) {
  if (Number.isFinite(value)) return Number(value);
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizedCoordinate(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lon = Number(value[0]);
  const lat = Number(value[1]);
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    lon < -180 ||
    lon > 180 ||
    lat < -90 ||
    lat > 90
  )
    return null;
  return [lon, lat];
}

function normalizeGeometry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const type = safeString(value.type, 40);
  if (!GEOMETRY_TYPES.has(type)) return null;

  if (type === 'intersection') {
    const point = normalizedCoordinate(value.coordinates);
    return point ? { type, coordinates: point } : null;
  }

  if (!Array.isArray(value.coordinates) || value.coordinates.length < 2)
    return null;
  const coordinates = value.coordinates.map(normalizedCoordinate);
  if (coordinates.some((point) => point === null)) return null;
  return { type, coordinates };
}

function normalizeCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const counts = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = safeString(rawKey, 48);
    const count = nonNegativeNumber(rawValue);
    if (!key || count === null) continue;
    counts[key] = count;
  }
  return counts;
}

function normalizeMovement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const from = safeString(value.from, 80);
  const to = safeString(value.to, 80);
  const label = safeString(value.label, 120);
  const count = nonNegativeNumber(value.count);
  const vehiclesPerMin = nonNegativeNumber(value.vehiclesPerMin);
  if (
    !from &&
    !to &&
    !label &&
    count === null &&
    vehiclesPerMin === null
  )
    return null;
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(label ? { label } : {}),
    ...(count !== null ? { count } : {}),
    ...(vehiclesPerMin !== null ? { vehiclesPerMin } : {}),
  };
}

function normalizeQuality(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = safeString(value.status, 64);
  const score = Number(value.score);
  const normalizedScore =
    Number.isFinite(score) && score >= 0 && score <= 1 ? score : null;
  if (!status && normalizedScore === null) return null;
  return {
    ...(status ? { status } : {}),
    ...(normalizedScore !== null ? { score: normalizedScore } : {}),
  };
}

function normalizeProvenance(value, sourceId) {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    source: safeString(raw.source, 160) || sourceId,
    ...(safeString(raw.method, 120)
      ? { method: safeString(raw.method, 120) }
      : {}),
  };
}

/**
 * Normalize one provider-neutral observed-traffic record.
 *
 * Invalid records return null so a snapshot can retain valid siblings while
 * reporting itself partial.
 */
export function normalizeObservedTrafficRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const id = safeString(value.id, 160);
  const sourceId = safeString(value.sourceId, 160);
  const observedAt = finiteTimestamp(value.observedAt);
  const geometry = normalizeGeometry(value.geometry);
  if (!id || !sourceId || observedAt === null || !geometry) return null;

  const windowStart = finiteTimestamp(value.windowStart);
  const windowEnd = finiteTimestamp(value.windowEnd);
  if (
    windowStart !== null &&
    windowEnd !== null &&
    windowEnd < windowStart
  )
    return null;

  const vehiclesPerMin = nonNegativeNumber(value.flow?.vehiclesPerMin);
  const counts = normalizeCounts(value.flow?.counts);
  const movements = Array.isArray(value.movements)
    ? value.movements.map(normalizeMovement).filter(Boolean).slice(0, 32)
    : [];

  return {
    id,
    sourceId,
    observedAt,
    ...(windowStart !== null ? { windowStart } : {}),
    ...(windowEnd !== null ? { windowEnd } : {}),
    ...(safeString(value.cameraId, 160)
      ? { cameraId: safeString(value.cameraId, 160) }
      : {}),
    geometry,
    flow: {
      ...(vehiclesPerMin !== null ? { vehiclesPerMin } : {}),
      counts,
    },
    movements,
    quality: normalizeQuality(value.quality),
    provenance: normalizeProvenance(value.provenance, sourceId),
  };
}

export function emptyObservedTrafficSnapshot() {
  return {
    configured: false,
    source: null,
    fetchedAt: null,
    records: [],
    received: 0,
    accepted: 0,
    dropped: 0,
    staleCount: 0,
    partial: false,
    stale: false,
    error: null,
    state: 'unconfigured',
    latestObservedAt: null,
  };
}

/**
 * Normalize one source response and derive freshness/presentation state.
 */
export function normalizeObservedTrafficSnapshot(
  value,
  {
    now = Date.now(),
    staleAfterMs = DEFAULT_OBSERVED_TRAFFIC_STALE_AFTER_MS,
  } = {},
) {
  if (value?.configured === false) return emptyObservedTrafficSnapshot();

  const fetchedAt = finiteTimestamp(value?.fetchedAt) ?? now;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ...emptyObservedTrafficSnapshot(),
      configured: true,
      fetchedAt,
      error: 'Observed traffic source unavailable',
      state: 'error',
    };
  }

  const inputRecords = Array.isArray(value.records) ? value.records : [];
  const records = inputRecords
    .map(normalizeObservedTrafficRecord)
    .filter(Boolean);
  const dropped = inputRecords.length - records.length;
  const staleLimit = Math.max(0, Number(staleAfterMs) || 0);
  const staleCount = records.filter(
    (record) => now - (record.windowEnd ?? record.observedAt) > staleLimit,
  ).length;
  const latestObservedAt = records.reduce(
    (latest, record) => Math.max(latest, record.observedAt),
    0,
  );
  const error = value.error ? 'Observed traffic source unavailable' : null;
  const partial = Boolean(value.partial || dropped > 0 || staleCount > 0);

  let state = 'empty';
  if (error) state = 'error';
  else if (records.length && staleCount === records.length) state = 'stale';
  else if (partial) state = 'partial';
  else if (records.length) state = 'fresh';

  return {
    configured: true,
    source: safeString(value.source, 160),
    fetchedAt,
    records,
    received: inputRecords.length,
    accepted: records.length,
    dropped,
    staleCount,
    partial,
    stale: staleCount > 0,
    error,
    state,
    latestObservedAt: latestObservedAt || null,
  };
}

function isAbortError(error, signal) {
  return signal?.aborted || error?.name === 'AbortError';
}

/**
 * Wrap any external producer in the observed-traffic source contract.
 *
 * With no read function the source is deliberately inert and returns an
 * unconfigured snapshot, preserving the shipped Traffic behavior.
 */
export function createObservedTrafficSource({
  read = null,
  label = 'Observed traffic',
  staleAfterMs = DEFAULT_OBSERVED_TRAFFIC_STALE_AFTER_MS,
} = {}) {
  if (read !== null && typeof read !== 'function')
    throw new TypeError('Observed traffic read must be a function');

  const sourceLabel = safeString(label, 160) || 'Observed traffic';
  return {
    label: sourceLabel,
    configured: typeof read === 'function',

    async request(query = {}, { signal = null, now = Date.now() } = {}) {
      if (typeof read !== 'function') return emptyObservedTrafficSnapshot();
      signal?.throwIfAborted?.();
      try {
        const result = await read(query, { signal });
        signal?.throwIfAborted?.();
        return normalizeObservedTrafficSnapshot(
          {
            configured: true,
            source: result?.source || sourceLabel,
            ...result,
          },
          { now, staleAfterMs },
        );
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        return normalizeObservedTrafficSnapshot(
          {
            configured: true,
            source: sourceLabel,
            error: true,
            records: [],
          },
          { now, staleAfterMs },
        );
      }
    },
  };
}

/** Own one Traffic instance's optional observed-source snapshot. */
export function createObservedTraffic({
  state: layerState,
  observedSource = null,
}) {
  const source =
    observedSource && typeof observedSource.request === 'function'
      ? observedSource
      : createObservedTrafficSource();

  function getObservedTrafficSnapshot() {
    return layerState._observedTrafficSnapshot;
  }

  async function refreshObservedTraffic(
    query = {},
    { signal = null, now = Date.now() } = {},
  ) {
    const generation = ++layerState._observedTrafficGeneration;
    layerState._observedTrafficLoading = true;
    try {
      const snapshot = await source.request(query, { signal, now });
      if (generation === layerState._observedTrafficGeneration)
        layerState._observedTrafficSnapshot = snapshot;
      return snapshot;
    } finally {
      if (generation === layerState._observedTrafficGeneration)
        layerState._observedTrafficLoading = false;
    }
  }

  function resetObservedTraffic() {
    layerState._observedTrafficGeneration += 1;
    layerState._observedTrafficLoading = false;
    layerState._observedTrafficSnapshot = emptyObservedTrafficSnapshot();
  }

  return {
    methods: {
      getObservedTrafficSnapshot,
      refreshObservedTraffic,
    },
    resetObservedTraffic,
  };
}
