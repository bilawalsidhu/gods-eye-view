// Static credits on Navara's attribution UI (view.attribution, the
// AttributionPlugin). Navara matches entries by content and drops duplicates,
// so one HTML string is shown once and counted here, staying until its last
// holder removes it. Navara has no separate on-screen strip: an `onScreen`
// credit opens the attribution card (collapsed by default) so the list is on
// screen; logos that must stay visible (Google) are sources with a `logo`,
// added by maps.js.

/**
 * @param {{ attribution?: { add: Function, remove: Function } }} view
 * @returns {{ credits: object, destroy: () => void }}
 */
export function createNavaraCredits(view) {
  const counts = new Map();
  const release = (html) => {
    if (!counts.has(html)) return;
    const count = counts.get(html);
    if (count > 1) return counts.set(html, count - 1);
    counts.delete(html);
    view.attribution?.remove([{ attributionHtml: html }]);
  };
  const credits = {
    addStatic(html, { onScreen = false } = {}) {
      const text = String(html);
      const count = counts.get(text) ?? 0;
      counts.set(text, count + 1);
      if (count === 0) view.attribution?.add([{ attributionHtml: text }]);
      if (onScreen) view.attribution?.show();
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        release(text);
      };
    },
  };
  return {
    credits,
    destroy() {
      for (const html of [...counts.keys()]) {
        counts.set(html, 1);
        release(html);
      }
    },
  };
}
