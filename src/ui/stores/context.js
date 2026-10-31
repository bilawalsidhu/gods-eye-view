import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The Context panel's mode switch as its view renders it. ContextControls
 * presents the selected mode, the transition busy state and the nearby
 * sites search (`_presentContext()`) and publishes them here; it
 * keeps its listeners and transactions. The Contacts layer publishes its
 * panel beside it, and the app connects that layer's navigation.
 */
export const useContextStore = defineStore('gev-context', () => {
  /** The presented mode switch; null until the controls first render. */
  const view = shallowRef(null);

  /** @param {object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    view.value = markRaw(next);
  }

  /** The Contacts panel; null until the layer first publishes. */
  const awareness = shallowRef(null);

  /** @param {object} next A fresh presentation of the Contacts panel. */
  function publishAwareness(next) {
    awareness.value = next && markRaw(next);
  }

  /**
   * The Contacts layer whose navigation the panel calls: `navigatePrevious`,
   * `focusCurrent`, `navigateNext` and `focusTarget`.
   */
  const awarenessLayer = shallowRef(null);

  /** @param {?object} layer The Contacts layer, or null to disconnect. */
  function connectAwareness(layer) {
    awarenessLayer.value = layer && markRaw(layer);
  }

  return {
    view,
    publish,
    awareness,
    publishAwareness,
    awarenessLayer,
    connectAwareness,
  };
});
