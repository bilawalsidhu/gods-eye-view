import { h, render } from 'vue';
import RailCardBlocks from './rail/RailCardBlocks.vue';

/**
 * Optional, ordered blocks without disclosure state. All controls are keyed.
 * Renders the RailCardBlocks component into `container`, which it owns, and
 * patches it synchronously on every update.
 */
export function createRailCardBlocks({ container, cardId, onParams }) {
  let destroyed = false;
  return {
    update(blocks = []) {
      if (destroyed) return;
      render(h(RailCardBlocks, { blocks, cardId, onParams }), container);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      render(null, container);
    },
  };
}
