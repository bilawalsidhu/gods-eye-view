import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The preset places' controls as the Omnibar and the scene chrome render
 * them. LocationControls presents whose landmarks are shown, the place
 * lookup's error and whether it runs, and the ORBIT indicator, and
 * publishes them here.
 */
export const useLocationStore = defineStore('gev-location', () => {
  /** The presented controls; null until they first render. */
  const view = shallowRef(null);

  /** @param {?object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    view.value = next && markRaw(next);
  }

  /** The controls whose `chooseCity(id)` and `choosePoi(index)` the Omnibar's chips call. */
  const controls = shallowRef(null);

  /** @param {?object} next The location controls, or null to disconnect. */
  function connect(next) {
    controls.value = next && markRaw(next);
  }

  return { view, publish, controls, connect };
});
