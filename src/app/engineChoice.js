/** The localStorage key that remembers an engine choice between visits. */
export const ENGINE_STORAGE_KEY = 'gev.engine';

const KINDS = new Set(['cesium', 'navara']);

const known = (value) => {
  const kind = String(value ?? '')
    .trim()
    .toLowerCase();
  return KINDS.has(kind) ? kind : null;
};

/**
 * The globe engine for this page: `?engine=cesium|navara`, else the stored
 * `gev.engine`, else Cesium. Navara is experimental; an unknown or unreadable
 * value never selects it.
 * @param {{ search?: string, storage?: { getItem(key: string): string | null } | null }} [where]
 * @returns {'cesium' | 'navara'}
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
