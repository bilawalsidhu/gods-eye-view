import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The map cards the world overlay (src/overlays/worldOverlay.js) hands to its
 * view to draw as elements. The application shell publishes the card list
 * here whenever a card's content changes, and passes every painted frame's
 * positions straight to the view's writer, outside reactivity.
 */
export const useWorldOverlayCardsStore = defineStore(
  'gev-world-overlay-cards',
  () => {
    /**
     * `{owner, style, cards: [{key, kind, title, details, accent, w, h, padX, padY,
     * titleH, lineH}]}`, or null without an overlay host.
     */
    const view = shallowRef(null);

    /** @param {?object} next A fresh card list. */
    function publish(next) {
      view.value = next && markRaw(next);
    }

    let writer = null;

    /**
     * The view's frame writer, or null when it unmounts.
     * @param {?(frames: object[], count: number) => void} next
     */
    function connectWriter(next) {
      writer = next;
    }

    /** Pass one frame's pooled positions to the view; they are not retained. */
    function writeFrame(frames, count) {
      writer?.(frames, count);
    }

    return { view, publish, connectWriter, writeFrame };
  },
);
