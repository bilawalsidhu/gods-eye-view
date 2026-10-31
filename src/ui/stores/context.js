import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The Context panel's mode switch as its view renders it. ContextControls
 * presents the selected mode, the transition busy state and the nearby
 * sites search (`_presentContext()`) and publishes them here; it
 * keeps its listeners and transactions.
 */
export const useContextStore = defineStore('gev-context', () => {
  /** The presented mode switch; null until the controls first render. */
  const view = shallowRef(null);

  /** @param {object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    view.value = markRaw(next);
  }

  return { view, publish };
});
