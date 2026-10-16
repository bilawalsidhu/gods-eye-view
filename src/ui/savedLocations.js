export const SAVED_LOCATIONS_STORAGE_KEY = 'gev:saved-locations:v1';
export const MAX_SAVED_LOCATIONS = 24;

function storageOrNull(injected) {
  if (injected !== undefined) return injected;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedText(value, maxLength) {
  const text = String(value || '').trim();
  return text && text.length <= maxLength ? text : null;
}

function defaultIdFactory() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function')
      return globalThis.crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `saved-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Normalize one persisted saved-location record.
 *
 * The record stores a semantic typed GEV action rather than DOM/camera method
 * names so recall can later flow through the same navigation owner as voice and
 * other controls.
 *
 * @param {object} value Candidate record.
 * @returns {object|null} Normalized record or null when invalid.
 */
export function normalizeSavedLocation(value) {
  if (!value || typeof value !== 'object') return null;
  const id = boundedText(value.id, 120);
  const label = boundedText(value.label, 80);
  const action = String(value.action || '');
  if (!id || !label || action !== 'fly_to_location') return null;

  const rawArgs = value.args;
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs))
    return null;
  const latitude = finite(rawArgs.latitude);
  const longitude = finite(rawArgs.longitude);
  if (
    latitude === null ||
    latitude < -90 ||
    latitude > 90 ||
    longitude === null ||
    longitude < -180 ||
    longitude > 180
  )
    return null;

  const args = { latitude, longitude };
  if (rawArgs.rangeM != null) {
    const rangeM = finite(rawArgs.rangeM);
    if (rangeM === null || rangeM < 100 || rangeM > 20_000_000) return null;
    args.rangeM = rangeM;
  }
  if (rawArgs.viewMode != null) {
    if (!['close', 'overview'].includes(rawArgs.viewMode)) return null;
    args.viewMode = rawArgs.viewMode;
  }

  const createdAt = finite(value.createdAt);
  return {
    id,
    label,
    action: 'fly_to_location',
    args,
    createdAt: createdAt !== null && createdAt >= 0 ? createdAt : 0,
  };
}

/**
 * Create a new normalized saved location.
 * @param {object} input Label and fly_to_location arguments.
 * @param {object} [options]
 * @param {() => string} [options.idFactory]
 * @param {() => number} [options.now]
 * @returns {object|null}
 */
export function createSavedLocation(
  input,
  { idFactory = defaultIdFactory, now = Date.now } = {},
) {
  return normalizeSavedLocation({
    id: idFactory(),
    label: input?.label,
    action: 'fly_to_location',
    args: input?.args,
    createdAt: now(),
  });
}

export function loadSavedLocations(storage) {
  const store = storageOrNull(storage);
  try {
    const raw = store?.getItem?.(SAVED_LOCATIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeSavedLocation)
      .filter(Boolean)
      .slice(0, MAX_SAVED_LOCATIONS);
  } catch {
    return [];
  }
}

export function persistSavedLocations(locations, storage) {
  const store = storageOrNull(storage);
  if (typeof store?.setItem !== 'function') return false;
  const normalized = (Array.isArray(locations) ? locations : [])
    .map(normalizeSavedLocation)
    .filter(Boolean)
    .slice(0, MAX_SAVED_LOCATIONS);
  try {
    store.setItem(SAVED_LOCATIONS_STORAGE_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

export function upsertSavedLocation(locations, value) {
  const next = normalizeSavedLocation(value);
  const current = Array.isArray(locations)
    ? locations.map(normalizeSavedLocation).filter(Boolean)
    : [];
  if (!next) return current.slice(0, MAX_SAVED_LOCATIONS);
  return [next, ...current.filter((item) => item.id !== next.id)].slice(
    0,
    MAX_SAVED_LOCATIONS,
  );
}

export function removeSavedLocation(locations, id) {
  const target = String(id || '');
  return (Array.isArray(locations) ? locations : [])
    .map(normalizeSavedLocation)
    .filter((item) => item && item.id !== target)
    .slice(0, MAX_SAVED_LOCATIONS);
}
