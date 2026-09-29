const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

function finiteTime(value) {
  if (Number.isFinite(value)) return Number(value);
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function labelKey(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return null;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatObservedTrafficAge(ageMs) {
  const age = Math.max(0, Number(ageMs) || 0);
  if (age < 60_000) return `${Math.max(0, Math.round(age / 1000))}s ago`;
  if (age < 60 * 60_000) return `${Math.round(age / 60_000)}m ago`;
  if (age < 24 * 60 * 60_000)
    return `${Math.round(age / (60 * 60_000))}h ago`;
  return `${Math.round(age / (24 * 60 * 60_000))}d ago`;
}

export function observedTrafficClassMix(counts, { limit = 3 } = {}) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts))
    return null;
  const entries = Object.entries(counts)
    .map(([key, raw]) => [labelKey(key), finiteNonNegative(raw)])
    .filter(([key, value]) => key && value !== null && value > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!(total > 0)) return null;
  return entries
    .slice(0, Math.max(1, Number(limit) || 1))
    .map(([key, value]) => `${Math.round((100 * value) / total)}% ${key}`)
    .join(' · ');
}

function observationTime(record) {
  return (
    finiteTime(record?.windowEnd) ??
    finiteTime(record?.observedAt) ??
    Number.NEGATIVE_INFINITY
  );
}

function unavailableSummary(cameraId) {
  return {
    cameraId,
    state: 'unavailable',
    statusLabel: 'TRAFFIC OBS · UNAVAILABLE',
    primary: null,
    classMix: null,
    ageMs: null,
    ageLabel: null,
    source: null,
    quality: null,
    partial: false,
    recordId: null,
    cardDetails: [],
  };
}

function unknownSummary(cameraId, snapshot) {
  return {
    cameraId,
    state: 'unknown',
    statusLabel: 'TRAFFIC OBS · UNKNOWN',
    primary: null,
    classMix: null,
    ageMs: null,
    ageLabel: null,
    source: snapshot?.source || null,
    quality: null,
    partial: Boolean(snapshot?.partial),
    recordId: null,
    cardDetails: [],
  };
}

/**
 * Build a camera-scoped, read-only presentation summary from the #830 contract.
 *
 * One freshest matching record is selected deliberately. Multiple approach or
 * road-segment records are never summed here because their counting windows may
 * overlap or represent different movements.
 */
export function summarizeCameraTrafficObservation(
  snapshot,
  cameraId,
  {
    now = Date.now(),
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
  } = {},
) {
  const id = String(cameraId || '').trim();
  if (!id || !snapshot?.configured) return null;

  const records = Array.isArray(snapshot.records) ? snapshot.records : [];
  const matches = records.filter((record) => record?.cameraId === id);
  if (!matches.length)
    return snapshot.error
      ? unavailableSummary(id)
      : unknownSummary(id, snapshot);

  const record = [...matches].sort(
    (a, b) =>
      observationTime(b) - observationTime(a) ||
      String(a?.id || '').localeCompare(String(b?.id || '')),
  )[0];
  const observedAt = observationTime(record);
  if (!Number.isFinite(observedAt)) return unknownSummary(id, snapshot);

  const ageMs = Math.max(0, Number(now) - observedAt);
  const staleLimit = Math.max(0, Number(staleAfterMs) || 0);
  const stale = Boolean(snapshot.error) || ageMs > staleLimit;
  const partial = Boolean(snapshot.partial);
  const state = stale ? 'stale' : partial ? 'partial' : 'fresh';
  const rate = finiteNonNegative(record?.flow?.vehiclesPerMin);
  const counts = record?.flow?.counts;
  const classMix = observedTrafficClassMix(counts);
  const countTotal =
    counts && typeof counts === 'object' && !Array.isArray(counts)
      ? Object.values(counts).reduce((sum, raw) => {
          const value = finiteNonNegative(raw);
          return sum + (value ?? 0);
        }, 0)
      : 0;
  const primary =
    rate !== null
      ? `${formatNumber(rate)} veh/min`
      : countTotal > 0
        ? `${formatNumber(countTotal)} vehicles`
        : Array.isArray(record?.movements) && record.movements.length
          ? `${record.movements.length} movement${record.movements.length === 1 ? '' : 's'}`
          : 'Measured traffic';
  const source =
    record?.provenance?.source ||
    record?.sourceId ||
    snapshot?.source ||
    null;
  const quality = record?.quality?.status || null;
  const ageLabel = formatObservedTrafficAge(ageMs);
  const statusLabel = stale
    ? 'TRAFFIC OBS · STALE'
    : partial
      ? 'TRAFFIC OBS · PARTIAL'
      : 'TRAFFIC OBS · MEASURED';

  const cardDetails = [
    primary,
    classMix || ageLabel,
  ].filter(Boolean);

  return {
    cameraId: id,
    state,
    statusLabel,
    primary,
    classMix,
    ageMs,
    ageLabel,
    source,
    quality,
    partial,
    recordId: record.id || null,
    cardDetails,
  };
}

export function formatCameraTrafficObservation(summary) {
  if (!summary) return '';
  if (summary.state === 'unknown' || summary.state === 'unavailable')
    return summary.statusLabel;
  return [
    summary.statusLabel,
    summary.primary,
    summary.classMix,
    summary.ageLabel,
    summary.source,
  ]
    .filter(Boolean)
    .join(' · ');
}
