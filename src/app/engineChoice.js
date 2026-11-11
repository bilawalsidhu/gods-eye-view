/** The localStorage key that remembers an engine choice between visits. */
export const ENGINE_STORAGE_KEY = 'gev.engine';

/**
 * The globe choices: Cesium, Navara at CSS pixels without MSAA (as Cesium
 * draws), and Navara HD at the device pixel ratio with MSAA 4 (on a 2x
 * screen about 1 GiB more: 2.7 GiB against 1.8). The names are product
 * names, never translated.
 */
export const ENGINE_NAMES = Object.freeze({
  cesium: 'Cesium',
  navara: 'Navara',
  'navara-hd': 'Navara HD',
});
export const ENGINE_CHOICES = Object.freeze(Object.keys(ENGINE_NAMES));

/** The choice without one made, and the one a failed start falls back to. */
export const DEFAULT_ENGINE_CHOICE = ENGINE_CHOICES[0];

/** The engine a choice runs: both Navara choices are the Navara engine. */
export const engineOfChoice = (choice) =>
  choice === 'cesium' ? 'cesium' : 'navara';

const known = (value) => {
  const kind = String(value ?? '')
    .trim()
    .toLowerCase();
  return ENGINE_CHOICES.includes(kind) ? kind : null;
};

/**
 * The globe choice for this page: `?engine=cesium|navara|navara-hd`, else
 * the stored `gev.engine`, else `fallback` (Cesium). Navara is experimental; an unknown or
 * unreadable value never selects it.
 * @param {{ search?: string, storage?: { getItem(key: string): string | null } | null, fallback?: string }} [where]
 * @returns {'cesium' | 'navara' | 'navara-hd'}
 */
export function resolveEngineKind({
  search = '',
  storage = null,
  fallback = DEFAULT_ENGINE_CHOICE,
} = {}) {
  const fromQuery = known(new URLSearchParams(search).get('engine'));
  if (fromQuery) return fromQuery;
  let stored = null;
  try {
    stored = storage?.getItem(ENGINE_STORAGE_KEY);
  } catch {
    // Storage can be blocked (private mode, sandboxed frames).
  }
  return known(stored) ?? known(fallback) ?? DEFAULT_ENGINE_CHOICE;
}
