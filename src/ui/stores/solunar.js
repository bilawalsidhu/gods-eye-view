import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The SOLUNAR card as its view renders it: the next seven local days at one
 * map spot. The card owner (src/solunar/panel.js) publishes the presentation
 * — the spot, the 12 h / 24 h choice and the week — and the view
 * (src/ui/views/panels/SolunarPanel.vue) renders it and sends the buttons'
 * clicks back through the connected controls.
 */
export const useSolunarStore = defineStore('gev-solunar', () => {
  /**
   * `{spot, hour12, days, rule}`, or null while no owner is mounted. Each
   * day carries its local date, the times of the day in milliseconds and the
   * moon phase, the feeding windows and the day rating.
   */
  const panel = shallowRef(null);

  /** The controls the view's buttons call. */
  const controls = shallowRef(null);

  /** @param {?object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    panel.value = next && markRaw(next);
  }

  /** @param {?object} next The controls, or null to disconnect. */
  function connect(next) {
    controls.value = next && markRaw(next);
  }

  return { panel, publish, controls, connect };
});
