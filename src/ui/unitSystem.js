import { ref } from 'vue';
import {
  bindUnitSystem,
  getUnitSystem,
  setUnitSystem,
  writeStoredUnitSystem,
} from '../units.js';

let pageUnitSystem = null;

/**
 * Hold the page's unit system in a Vue ref, once, so every view that formats
 * a quantity while rendering re-renders when it changes (src/units.js).
 * @returns {import('vue').Ref<'metric'|'imperial'>}
 */
export function applicationUnitSystem() {
  if (pageUnitSystem) return pageUnitSystem;
  pageUnitSystem = ref(getUnitSystem());
  bindUnitSystem(pageUnitSystem);
  return pageUnitSystem;
}

/**
 * Show `system` and keep it for the next visit.
 * @param {'metric'|'imperial'} system
 * @param {{storage?: Storage}} [options]
 * @returns {'metric'|'imperial'} The system applied.
 */
export function chooseUnitSystem(system, { storage } = {}) {
  const applied = setUnitSystem(system);
  writeStoredUnitSystem(applied, storage);
  return applied;
}

/** The other system: what the toggle switches to. */
export const otherUnitSystem = (system) =>
  system === 'imperial' ? 'metric' : 'imperial';
