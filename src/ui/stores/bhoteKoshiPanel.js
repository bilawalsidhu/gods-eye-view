import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The Bhote Koshi event's reconstruction panel as its view renders it. The
 * event layer (src/data/bhoteKoshiEvent.js) presents each control's state
 * and the field reports; the view sends clicks and slider moves back to the
 * connected controls.
 */
export const useBhoteKoshiPanelStore = defineStore(
  'gev-bhote-koshi-panel',
  () => {
    /**
     * `{owner, sceneBeat, refs, beforeDate, afterDate, reports}`, or null while
     * the event layer is off. Each entry of `refs` holds one control's
     * `textContent`, `hidden`, `disabled`, `value` and `attributes`.
     */
    const panel = shallowRef(null);

    /** @param {?object} next A fresh presentation; every publish re-renders. */
    function publish(next) {
      panel.value = next && markRaw(next);
    }

    /** The controls the panel's buttons, sliders and reports call. */
    const controls = shallowRef(null);

    /** @param {?object} next The controls, or null to disconnect. */
    function connect(next) {
      controls.value = next && markRaw(next);
    }

    return { panel, publish, controls, connect };
  },
);
