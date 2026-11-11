/**
 * Static credits follow the source actually on screen, including fallback.
 * @param {{ addStatic: (html: string, options?: { onScreen?: boolean }) => () => void }} credits
 *   A globe engine's credits capability.
 */
export function createMapCredits(credits) {
  let remove = null;
  let markup = null;
  return {
    show(html) {
      if (html === markup) return;
      try {
        remove?.();
        remove = null;
        if (html) remove = credits.addStatic(html, { onScreen: true });
        markup = html;
      } catch {
        /* Switching remains usable without a credit display. */
      }
    },
    destroy() {
      this.show(null);
    },
  };
}
