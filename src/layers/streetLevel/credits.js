import * as Cesium from 'cesium';

/**
 * One on-screen Cesium credit per active provider. Street-level imagery is
 * typically CC BY-SA, which needs visible attribution that goes away with
 * the imagery, so these are static credits added and removed per provider.
 */
export function createCredits() {
  /** @type {Map<string, object>} provider id → Cesium.Credit */
  const shown = new Map();

  function show(viewer, def) {
    if (shown.has(def.id) || !viewer?.creditDisplay) return;
    try {
      const credit = new Cesium.Credit(def.credit.html, true);
      viewer.creditDisplay.addStaticCredit(credit);
      shown.set(def.id, credit);
    } catch {
      /* credit display unavailable */
    }
  }

  function hide(viewer, def) {
    const credit = shown.get(def.id);
    if (!credit) return;
    try {
      viewer?.creditDisplay?.removeStaticCredit?.(credit);
    } catch {
      /* credit display already torn down */
    }
    shown.delete(def.id);
  }

  function hideAll(viewer) {
    for (const id of [...shown.keys()]) hide(viewer, { id });
  }

  return { show, hide, hideAll };
}
