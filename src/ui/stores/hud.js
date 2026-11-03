import { defineStore } from 'pinia';
import { shallowRef } from 'vue';

/**
 * The Intel HUD as its view renders it. IntelHUD presents its readouts,
 * visibility, layout variant and style colors and the application shell
 * publishes them here.
 */
export const useHudStore = defineStore('gev-hud', () => {
  /** The presented HUD, frozen by IntelHUD; null until it is built. */
  const hud = shallowRef(null);

  /** @param {?object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    hud.value = next;
  }

  return { hud, publish };
});
