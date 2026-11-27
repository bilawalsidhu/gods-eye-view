import { creditFromMarkup } from '../../render/creditMarkup.js';
import { findCredits } from '../../render/rendererOf.js';

/**
 * One credit per active provider, through the renderer's credits port,
 * that goes away with the imagery: on the map for a credit that asks for
 * it (`credit.onMap`, Google's), in the "Data attribution" list for every
 * other. A provider's credit is markup with one link, read as the port's
 * plain data.
 */
export function createCredits() {
  /** @type {Map<string, () => void>} provider id → the credit's Off */
  const shown = new Map();

  function show(viewer, def) {
    if (shown.has(def.id)) return;
    const credits = findCredits(viewer);
    if (!credits) return;
    shown.set(
      def.id,
      credits.addStatic({
        ...creditFromMarkup(def.credit.html),
        inline: Boolean(def.credit.onMap),
      }),
    );
  }

  function hide(_viewer, def) {
    const off = shown.get(def.id);
    if (!off) return;
    shown.delete(def.id);
    off();
  }

  function hideAll(viewer) {
    for (const id of [...shown.keys()]) hide(viewer, { id });
  }

  return { show, hide, hideAll };
}
