import { h, render } from 'vue';
import RailCards from './rail/RailCards.vue';

/**
 * Keyed cards with optional ordered blocks; the feature owns open-card choice.
 * Renders the RailCards component into `container`, which it owns, and
 * patches it synchronously on every update so the owner can measure at once.
 */
export function createRailCards({
  container,
  document = container?.ownerDocument,
  cardClassName = '',
  badgeClassName = '',
  onParams = () => {},
  onOpen = () => {},
} = {}) {
  if (!document?.createElement || !container) return null;
  let destroyed = false;
  return {
    update(cards = []) {
      if (destroyed) return;
      render(
        h(RailCards, {
          cards,
          cardClassName,
          badgeClassName,
          onParams,
          onOpen,
        }),
        container,
      );
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      render(null, container);
    },
  };
}
