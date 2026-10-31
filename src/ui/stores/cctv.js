import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The CCTV panel's buttons, CAL chip and meta line as its view renders them.
 * CctvControls presents them (`presentCctvPanel()`) and publishes here; it
 * keeps its listeners on the buttons and paints the picker, frame, source
 * badge, calibration readout and summary itself.
 */
export const useCctvStore = defineStore('gev-cctv', () => {
  /** The presented panel; null until the controls first render. */
  const view = shallowRef(null);

  /** @param {object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    view.value = markRaw(next);
  }

  return { view, publish };
});
