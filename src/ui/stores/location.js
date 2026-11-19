import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The dock's location tray as its view renders it. LocationControls
 * presents the city pills, the landmark row, the mini status, the search
 * error, the search field's open and searching state and the ORBIT indicator
 * and publishes them here; it keeps the search field's key, input and blur
 * listeners.
 */
export const useLocationStore = defineStore('gev-location', () => {
  /** The presented tray; null until the controls first render. */
  const view = shallowRef(null);

  /** @param {?object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    view.value = next && markRaw(next);
  }

  /** The controls whose `chooseCity(id)` and `choosePoi(index)` pills call. */
  const controls = shallowRef(null);

  /** @param {?object} next The location controls, or null to disconnect. */
  function connect(next) {
    controls.value = next && markRaw(next);
  }

  return { view, publish, controls, connect };
});
