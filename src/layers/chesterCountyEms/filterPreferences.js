import { COUNTIES } from './counties.js';

export const COUNTY_FILTER_STORAGE_KEY = 'gev:county-ems:filters:v1';
export const INCIDENT_CATEGORIES = Object.freeze(['fire', 'ems', 'traffic']);
const COUNTY_IDS = COUNTIES.map((county) => county.id);
const DEFAULT_COUNTIES = COUNTIES.filter(
  (county) => county.defaultEnabled !== false,
).map((county) => county.id);
const allowed = { categories: INCIDENT_CATEGORIES, counties: COUNTY_IDS };
const defaults = () => ({
  categories: [...INCIDENT_CATEGORIES],
  counties: [...DEFAULT_COUNTIES],
});
function normalize(values, ids) {
  return Array.isArray(values) &&
    values.length <= ids.length &&
    values.every((value) => ids.includes(value))
    ? ids.filter((id) => values.includes(id))
    : null;
}

/** Browser-local filter choices only; incident data and selection stay transient. */
export function createCountyFilterPreferences({
  storage = () => globalThis.window?.localStorage,
} = {}) {
  let saved;
  function read() {
    if (!saved) {
      saved = defaults();
      try {
        const raw = storage()?.getItem(COUNTY_FILTER_STORAGE_KEY);
        const parsed =
          typeof raw === 'string' && raw.length <= 4096
            ? JSON.parse(raw)
            : null;
        if (parsed?.v === 1) {
          for (const [key, ids] of Object.entries(allowed))
            saved[key] = normalize(parsed[key], ids) ?? saved[key];
        }
      } catch {
        // Missing, corrupt or unavailable storage keeps the normal defaults.
      }
    }
    return { categories: [...saved.categories], counties: [...saved.counties] };
  }
  return {
    get: read,
    set(patch) {
      const next = read();
      let changed = false;
      for (const [key, ids] of Object.entries(allowed)) {
        if (!Object.hasOwn(patch, key)) continue;
        const value = normalize(patch[key], ids);
        if (value === null) continue;
        next[key] = value;
        changed = true;
      }
      if (changed) {
        saved = next;
        try {
          storage()?.setItem(
            COUNTY_FILTER_STORAGE_KEY,
            JSON.stringify({ v: 1, ...saved }),
          );
        } catch {
          // Controls remain usable for this session if browser storage is blocked.
        }
      }
      return read();
    },
  };
}
