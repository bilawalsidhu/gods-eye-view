import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The Display panel as its view renders it. VisualSettings presents the
 * post-processing groups (`_presentDisplay()`) and publishes them here;
 * it keeps its listeners on the panel's controls.
 */
export const useDisplayStore = defineStore('gev-display', () => {
  /** The presented panel; null until VisualSettings first renders. */
  const view = shallowRef(null);

  /** @param {object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    view.value = markRaw(next);
  }

  return { view, publish };
});
