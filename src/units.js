/**
 * The measurement system the page shows: `metric` (°C, km, m, km/h) or
 * `imperial` (°F, mi, ft, mph). Aviation and marine readings keep their own
 * units in both (feet and knots for flights, knots and hectopascals for
 * storms, nautical miles on the cockpit radar), as do readings written for an
 * AI tool or kept in a share link: only text shown to a person converts.
 *
 * Like the locale (src/i18n/index.js), the choice is a plain value until the
 * page binds it to a Vue ref (src/ui/unitSystem.js), so a view that formats a
 * quantity while rendering re-renders when the choice changes. Code that
 * formatted text itself listens with onUnitSystemChange.
 */

export const UNIT_SYSTEMS = Object.freeze(['metric', 'imperial']);
export const DEFAULT_UNIT_SYSTEM = 'metric';
export const UNIT_SYSTEM_STORAGE_KEY = 'gev:units:v1';

export const FEET_PER_METRE = 3.28084;
export const METRES_PER_MILE = 1609.344;
export const MM_PER_INCH = 25.4;
export const MPH_PER_KPH = 0.6213711922;

/** @returns {'metric'|'imperial'|null} */
export function normalizeUnitSystem(value) {
  return UNIT_SYSTEMS.includes(value) ? value : null;
}

/** The stored choice, or null where none is stored or storage is blocked. */
export function readStoredUnitSystem(storage) {
  try {
    const store = storage !== undefined ? storage : globalThis.localStorage;
    return normalizeUnitSystem(store?.getItem?.(UNIT_SYSTEM_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Keep a choice for the next visit; false where storage is blocked. */
export function writeStoredUnitSystem(system, storage) {
  const normalized = normalizeUnitSystem(system);
  if (!normalized) return false;
  try {
    const store = storage !== undefined ? storage : globalThis.localStorage;
    if (!store?.setItem) return false;
    store.setItem(UNIT_SYSTEM_STORAGE_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}

let unitState = { value: readStoredUnitSystem() || DEFAULT_UNIT_SYSTEM };
const listeners = new Set();

/**
 * Hold the choice in `ref` from now on (a Vue ref), so views that read it
 * while rendering follow it. The ref starts at the current choice.
 * @param {{value: string}} ref
 */
export function bindUnitSystem(ref) {
  ref.value = getUnitSystem();
  unitState = ref;
}

/** @returns {'metric'|'imperial'} */
export function getUnitSystem() {
  return normalizeUnitSystem(unitState.value) || DEFAULT_UNIT_SYSTEM;
}

export const usesImperial = () => getUnitSystem() === 'imperial';

/**
 * Show `system` from now on; listeners hear of a change.
 * @returns {'metric'|'imperial'} The system applied.
 */
export function setUnitSystem(system) {
  const next = normalizeUnitSystem(system) || DEFAULT_UNIT_SYSTEM;
  if (next === getUnitSystem()) return next;
  unitState.value = next;
  for (const listener of [...listeners]) {
    try {
      listener(next);
    } catch (error) {
      console.error('[units] listener failed', error);
    }
  }
  return next;
}

/**
 * Call `listener` after the unit system changes.
 * @param {(system: 'metric'|'imperial') => void} listener
 * @returns {() => void} Stops listening.
 */
export function onUnitSystemChange(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const celsiusToFahrenheit = (celsius) => (celsius * 9) / 5 + 32;
