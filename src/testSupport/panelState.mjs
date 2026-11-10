// src/testSupport/panelState.mjs — present a panel's state the way the shell
// does (PanelChrome._presentPanel), drawn at once as its root's v-panel-state
// would, for fixtures whose panels are plain objects with a classList.
import { applyPanelState, readPanelState } from '../ui/rail/panelState.js';

/**
 * @param {object|string} panelOrId A panel, or its id in `documentRef`.
 * @param {object} [patch] The state that changes.
 * @param {Document} [documentRef]
 */
export function presentPanelLocally(
  panelOrId,
  patch = {},
  documentRef = globalThis.document,
) {
  const panel =
    typeof panelOrId === 'string'
      ? documentRef?.getElementById(panelOrId)
      : panelOrId;
  if (panel) applyPanelState(panel, { ...readPanelState(panel), ...patch });
}
