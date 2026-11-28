import { defineStore } from 'pinia';
import { presented } from './presented.js';

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
     * `textContent`, `hidden`, `disabled`, `value` and `attributes`; the
     * cinematic button's also holds `pressed`.
     */
    const [panel, publish] = presented();

    /** The controls the panel's buttons, sliders and reports call. */
    const [controls, connect] = presented();

    return { panel, publish, controls, connect };
  },
);
