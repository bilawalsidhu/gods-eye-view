import { creditFromMarkup } from '../render/creditMarkup.js';
import { findCredits } from '../render/rendererOf.js';

/**
 * The on-map credit of the source actually on screen, including fallback,
 * through the renderer's credits port. A source's credit is markup with one
 * link, read as the port's plain data.
 */
export function createMapCredits(viewer) {
  let off = null;
  let markup = null;
  return {
    show(html) {
      if (html === markup) return;
      const credits = findCredits(viewer);
      if (!credits) return;
      off?.();
      off = html
        ? credits.addStatic({ ...creditFromMarkup(html), inline: true })
        : null;
      markup = html;
    },
    destroy() {
      this.show(null);
    },
  };
}
