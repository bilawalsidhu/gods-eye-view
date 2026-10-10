export const SAVED_LOCATIONS_STORAGE_KEY = 'godsEyeView.savedLocations.v1';
export const MAX_SAVED_LOCATIONS = 24;

function finite(value) {
  return Number.isFinite(Number(value));
}

function createId() {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  return `saved-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeSavedLocation(value) {
  if (!value || typeof value !== 'object') return null;
  const camera = value.camera;
  if (!camera || typeof camera !== 'object') return null;
  if (!String(value.name || '').trim()) return null;
  if (!finite(camera.lat) || !finite(camera.lon) || !finite(camera.alt)) return null;

  return {
    id: String(value.id || createId()),
    name: String(value.name).trim().slice(0, 80),
    camera: {
      lat: Number(camera.lat),
      lon: Number(camera.lon),
      alt: Math.max(1, Number(camera.alt)),
      heading: finite(camera.heading) ? Number(camera.heading) : 0,
      pitch: finite(camera.pitch) ? Number(camera.pitch) : -35,
      roll: finite(camera.roll) ? Number(camera.roll) : 0,
    },
    mapStack: value.mapStack ? String(value.mapStack) : null,
    createdAt: finite(value.createdAt) ? Number(value.createdAt) : Date.now(),
  };
}

export function loadSavedLocations(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(SAVED_LOCATIONS_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeSavedLocation).filter(Boolean).slice(0, MAX_SAVED_LOCATIONS);
  } catch {
    return [];
  }
}

export function persistSavedLocations(locations, storage = globalThis.localStorage) {
  const valid = Array.isArray(locations)
    ? locations.map(normalizeSavedLocation).filter(Boolean).slice(0, MAX_SAVED_LOCATIONS)
    : [];
  try {
    storage?.setItem(SAVED_LOCATIONS_STORAGE_KEY, JSON.stringify(valid));
  } catch {
    return false;
  }
  return true;
}

export function upsertSavedLocation(locations, location) {
  const next = normalizeSavedLocation(location);
  if (!next) return Array.isArray(locations) ? locations.slice() : [];
  const existing = Array.isArray(locations) ? locations.filter((item) => item?.id !== next.id) : [];
  return [next, ...existing].slice(0, MAX_SAVED_LOCATIONS);
}

export function removeSavedLocation(locations, id) {
  return (Array.isArray(locations) ? locations : []).filter((item) => item?.id !== id);
}
