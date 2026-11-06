/** The localStorage key that remembers an engine choice between visits. */
export const ENGINE_STORAGE_KEY = 'gev.engine';

/**
 * The globe choices: Cesium, Navara at CSS pixels without MSAA (as Cesium
 * draws), and Navara HD at the device pixel ratio with MSAA 4 (on a 2x
 * screen about 1 GiB more: 2.7 GiB against 1.8).
 */
export const ENGINE_CHOICES = Object.freeze(['cesium', 'navara', 'navara-hd']);

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
 * the stored `gev.engine`, else Cesium. Navara is experimental; an unknown or
 * unreadable value never selects it.
 * @param {{ search?: string, storage?: { getItem(key: string): string | null } | null }} [where]
 * @returns {'cesium' | 'navara' | 'navara-hd'}
 */
export function resolveEngineKind({ search = '', storage = null } = {}) {
  const fromQuery = known(new URLSearchParams(search).get('engine'));
  if (fromQuery) return fromQuery;
  let stored = null;
  try {
    stored = storage?.getItem(ENGINE_STORAGE_KEY);
  } catch {
    // Storage can be blocked (private mode, sandboxed frames).
  }
  return known(stored) ?? 'cesium';
}
