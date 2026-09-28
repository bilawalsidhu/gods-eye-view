/**
 * customLocations.js — user-added quick-reference location pins.
 *
 * Bundled cities in locations.js are curated and fixed; this is the
 * personalization layer on top, persisted client-side in localStorage and
 * merged into the same shared CITY_POIS registry via registerLocation() so
 * the existing fly-to/voice/search paths need no changes to resolve a pin.
 * Ids are namespaced under ID_PREFIX so a pin can never collide with or
 * overwrite a bundled city.
 */
import { registerLocation, unregisterLocation } from '../locations.js';

const STORAGE_KEY = 'gev.customLocations.v1';
const ID_PREFIX = 'pin:';

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
    // Storage full or blocked (private browsing) — the pin still works for
    // the rest of this session via the in-memory registry.
  }
}

/**
 * Load previously saved pins into the live CITY_POIS registry. Call once
 * during app startup, before the location pill tray is first built.
 */
export function hydrateCustomLocations() {
  const store = readStore();
  for (const [id, entry] of Object.entries(store)) registerLocation(id, entry);
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

/** Remove a previously saved pin from storage and the live registry. */
export function removeCustomLocation(id) {
  const store = readStore();
  delete store[id];
  writeStore(store);
  unregisterLocation(id);
}
