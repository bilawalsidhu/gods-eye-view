/**
 * customLocations.js — the personalization layer over the bundled location
 * tray: new quick-reference pins, plus renaming/hiding/editing the landmarks
 * of bundled cities without ever touching the shipped source data.
 *
 * A single localStorage-backed store holds one full entry per touched id.
 * An id that already exists in the bundled CITY_POIS is an *override* (the
 * pristine original is kept in BUNDLED_DEFAULTS, captured once at import
 * time, so resetLocation() can always restore it); any other id is a
 * user-created pin. Either way, entries are pushed into the shared CITY_POIS
 * registry via registerLocation() so the existing fly-to/voice/search paths
 * resolve them exactly like a bundled city — no changes needed there.
 */
import {
  CITY_POIS,
  registerLocation,
  unregisterLocation,
} from '../locations.js';

const STORAGE_KEY = 'gev.customLocations.v1';
const ID_PREFIX = 'pin:';
const BUNDLED_DEFAULTS = structuredClone(CITY_POIS);

const isBundledId = (id) =>
  Object.prototype.hasOwnProperty.call(BUNDLED_DEFAULTS, id);

function safeStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function readStore() {
  const storage = safeStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage full or blocked (private browsing) — the edit still works for
    // the rest of this session via the in-memory registry.
  }
}

/** The stored entry for an id if there is one, else its live/bundled entry. */
function currentEntry(store, id) {
  return store[id] || CITY_POIS[id] || BUNDLED_DEFAULTS[id] || null;
}

/**
 * Load previously saved pins and overrides into the live CITY_POIS registry.
 * Call once during app startup, before the location pill tray is first built.
 */
export function hydrateCustomLocations() {
  const store = readStore();
  for (const [id, entry] of Object.entries(store)) {
    if (entry.removed) unregisterLocation(id);
    else registerLocation(id, entry);
  }
  return store;
}

/**
 * Save a new quick-reference pin at the given view and register it
 * immediately so it is flyable without a reload.
 */
export function addCustomLocation({ name, lat, lon, alt, pitch, heading }) {
  const store = readStore();
  const id = `${ID_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const entry = {
    name,
    custom: true,
    groundElevation: 0,
    pois: [{ name, lat, lon, alt, pitch, heading, buildingHeight: 0 }],
  };
  store[id] = entry;
  writeStore(store);
  registerLocation(id, entry);
  return id;
}

/**
 * Remove a location: a custom pin is deleted outright; a bundled city is
 * hidden (its data is kept, so resetLocation()/restoring it works later).
 */
export function removeLocation(id) {
  const store = readStore();
  if (isBundledId(id)) {
    store[id] = { removed: true };
    writeStore(store);
    unregisterLocation(id);
    return;
  }
  delete store[id];
  writeStore(store);
  unregisterLocation(id);
}

/** Rename a city/pin. Works for bundled cities (as a local override) and custom pins alike. */
export function renameLocation(id, name) {
  const trimmed = (name || '').trim();
  const store = readStore();
  const base = currentEntry(store, id);
  if (!trimmed || !base) return;
  const entry = { ...base, name: trimmed };
  if (!isBundledId(id)) entry.custom = true;
  delete entry.removed;
  store[id] = entry;
  writeStore(store);
  registerLocation(id, entry);
}

/** Append a landmark (POI) at the given view to an existing city/pin. */
export function addLocationPoi(id, { name, lat, lon, alt, pitch, heading }) {
  const store = readStore();
  const base = currentEntry(store, id);
  if (!base) return;
  const poi = { name, lat, lon, alt, pitch, heading, buildingHeight: 0 };
  const entry = { ...base, pois: [...base.pois, poi] };
  if (!isBundledId(id)) entry.custom = true;
  delete entry.removed;
  store[id] = entry;
  writeStore(store);
  registerLocation(id, entry);
}

/** Rename a single landmark (POI) within a city/pin's list. */
export function renameLocationPoi(id, poiIndex, name) {
  const trimmed = (name || '').trim();
  const store = readStore();
  const base = currentEntry(store, id);
  if (!trimmed || !base || !base.pois[poiIndex]) return;
  const pois = base.pois.map((poi, index) =>
    index === poiIndex ? { ...poi, name: trimmed } : poi,
  );
  const entry = { ...base, pois };
  if (!isBundledId(id)) entry.custom = true;
  delete entry.removed;
  store[id] = entry;
  writeStore(store);
  registerLocation(id, entry);
}

/**
 * Remove one landmark from a city/pin's list. A city always keeps at least
 * one landmark, so the last one is not removable this way.
 */
export function removeLocationPoi(id, poiIndex) {
  const store = readStore();
  const base = currentEntry(store, id);
  if (!base || base.pois.length <= 1) return;
  const pois = base.pois.filter((_, index) => index !== poiIndex);
  const entry = { ...base, pois };
  if (!isBundledId(id)) entry.custom = true;
  delete entry.removed;
  store[id] = entry;
  writeStore(store);
  registerLocation(id, entry);
}

/** Discard all local edits to a bundled city and restore its shipped default. */
export function resetLocation(id) {
  if (!isBundledId(id)) return;
  const store = readStore();
  delete store[id];
  writeStore(store);
  registerLocation(id, BUNDLED_DEFAULTS[id]);
}

/** True if a bundled city currently differs from its shipped default (renamed or edited, not hidden). */
export function isLocationOverridden(id) {
  if (!isBundledId(id)) return false;
  const stored = readStore()[id];
  return Boolean(stored) && !stored.removed;
}

/** Bundled cities currently hidden by a local "removed" override, for a restore control. */
export function listHiddenBundledLocations() {
  const store = readStore();
  return Object.entries(store)
    .filter(([id, entry]) => isBundledId(id) && entry.removed)
    .map(([id]) => ({ id, name: BUNDLED_DEFAULTS[id].name }));
}

/** Bring back every bundled city currently hidden by a local override. */
export function restoreHiddenBundledLocations() {
  for (const { id } of listHiddenBundledLocations()) resetLocation(id);
}
