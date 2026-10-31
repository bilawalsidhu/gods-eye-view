import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The Radio panel as its view renders it. RadioControls presents the
 * directory row, station card, transport, volume and playback line
 * (`renderRadioState()`) and publishes them here; it keeps its listeners,
 * the tuner and the Cockpit radio controls. LocalSdrControls publishes the
 * local RTL-SDR card beside it.
 */
export const useRadioStore = defineStore('gev-radio', () => {
  /** The presented panel; null until the controls first render. */
  const view = shallowRef(null);

  /** @param {object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    view.value = markRaw(next);
  }

  /** The local RTL-SDR card; null until its controls first render. */
  const sdr = shallowRef(null);

  /** @param {object} next A fresh presentation of the RTL-SDR card. */
  function publishSdr(next) {
    sdr.value = markRaw(next);
  }

  return { view, publish, sdr, publishSdr };
});
