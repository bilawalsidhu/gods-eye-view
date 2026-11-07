/**
 * One static on-screen credit per active provider (engine.credits): CC
 * BY-SA imagery needs visible attribution that goes away with the imagery.
 * `view` is the layer's display (render/display.js).
 */
export function createCredits() {
  /** @type {Map<string, () => void>} provider id → its credit's remover */
  const shown = new Map();

  function show(view, def) {
    if (shown.has(def.id)) return;
    const credits = view?.engine?.credits;
    if (!credits) return;
    try {
      shown.set(def.id, credits.addStatic(def.credit.html, { onScreen: true }));
    } catch {
      /* credit display unavailable */
    }
  }

  function hide(_view, def) {
    const remove = shown.get(def.id);
    if (!remove) return;
    try {
      remove();
    } catch {
      /* credit display already torn down */
    }
    shown.delete(def.id);
  }

  function hideAll(view) {
    for (const id of [...shown.keys()]) hide(view, { id });
  }

  return { show, hide, hideAll };
}
