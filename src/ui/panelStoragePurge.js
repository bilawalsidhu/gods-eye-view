/**
 * Legacy panel-storage purge (docs/PLAN.md Phase 7, PR #190) — panel keys are
 * namespaced by layout/position versions (`godsEyeView.v6.panelCollapsed.*`,
 * `godsEyeView.v8.panelPos.*`) precisely so a stale layout can be ignored on
 * restore; but "ignored" left every superseded generation in localStorage
 * forever. This module removes keys from VERSIONED PANEL FAMILIES only —
 * every other `godsEyeView.*` key (calibrations, scene projects, voice cost
 * limits, tile caches, feature keys) and every non-GEV key is never touched,
 * so bumping a panel version here after changing the constants in ui.js is
 * the whole migration.
 *
 * Pure helpers are exported for tests; `purgeStalePanelStorage` is the
 * side-effectful entry point ui.js calls once during panel init.
 */

const VERSIONED_PANEL_KEY = /^godsEyeView\.v(\d+)\.(panelPos|panelCollapsed|layoutResetNotified)(?:\.|$)/;

/**
 * The version each key family is versioned against. Positions and the
 * one-shot reset marker follow PANEL_POSITION_STORAGE_VERSION; collapsed
 * state follows PANEL_LAYOUT_STORAGE_VERSION (they reset independently by
 * design — see the constants in src/ui.js).
 * @param {string} family - Key family to resolve; `panelCollapsed` follows
 *   the layout version, everything else the position version.
 * @param {{positionVersion: string, layoutVersion: string}} versions - Live
 *   `vN` strings from ui.js for the two independently versioned families.
 * @returns {string} The live `vN` string `family` is versioned against.
 */
function currentVersionFor(family, { positionVersion, layoutVersion }) {
  return family === 'panelCollapsed' ? layoutVersion : positionVersion;
}

/**
 * The keys from the versioned panel families that a CURRENT layout would
 * never read again — i.e. whose `vN` does not match the family's live
 * version. Keys outside these families are returned untouched (never stale).
 * @param {string[]} keys Every key in the storage bucket.
 * @param {{positionVersion: string, layoutVersion: string}} versions The
 *   live `vN` strings (e.g. 'v8' / 'v6').
 * @returns {string[]} The stale subset of `keys`, in input order.
 */
export function stalePanelStorageKeys(keys, { positionVersion, layoutVersion }) {
  return (keys || []).filter((key) => {
    const match = VERSIONED_PANEL_KEY.exec(key);
    if (!match) return false;
    const [, version, family] = match;
    return `v${version}` !== currentVersionFor(family, { positionVersion, layoutVersion });
  });
}

/**
 * Remove stale versioned panel keys from a storage bucket. Storage failures
 * are swallowed (private-mode browsers, quota errors) — a purge that cannot
 * run must never break panel init.
 * @param {{getItem?: Function, key: Function, removeItem: Function}} storage
 *   Anything shaped like localStorage (the `key(i)` + `length` contract).
 * @param {{positionVersion: string, layoutVersion: string}} versions - Live
 *   `vN` strings passed through to `stalePanelStorageKeys`; ui.js supplies
 *   the `PANEL_POSITION_STORAGE_VERSION`/`PANEL_LAYOUT_STORAGE_VERSION`
 *   constants.
 * @returns {string[]} The keys actually removed.
 */
export function purgeStalePanelStorage(storage, versions) {
  try {
    const keys = [];
    for (let i = 0; i < storage.length; i += 1) keys.push(storage.key(i));
    const stale = stalePanelStorageKeys(keys, versions);
    for (const key of stale) storage.removeItem(key);
    return stale;
  } catch {
    return [];
  }
}
