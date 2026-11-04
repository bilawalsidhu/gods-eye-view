import { defineStore } from 'pinia';
import { shallowRef } from 'vue';

/**
 * The Global Context compass and contact direction overlay as its view
 * renders it. The awareness layer presents it through
 * `subscribeDirectionOverlay()` and the application shell publishes it here.
 */
export const useAwarenessDirectionStore = defineStore(
  'gev-awareness-direction',
  () => {
    /**
     * `{container, hidden, ring, heading, labels, markers}`, or null while
     * the layer has no overlay. `container` is the element it sits in.
     */
    const overlay = shallowRef(null);

    /**
     * @param {?object} next A fresh presentation, frozen by the layer; every
     *   publish re-renders.
     */
    function publish(next) {
      overlay.value = next;
    }

    return { overlay, publish };
  },
);
