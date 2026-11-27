import { defineStore } from 'pinia';
import { computed, markRaw, shallowRef } from 'vue';

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
    const panel = shallowRef(null);
    const hiddenOwner = shallowRef(null);
    const visiblePanel = computed(() =>
      panel.value?.owner !== hiddenOwner.value ? panel.value : null,
    );

    /** @param {?object} next A fresh presentation; every publish re-renders. */
    function publish(next) {
      panel.value = next && markRaw(next);
    }

    /** The controls the panel's buttons, sliders and reports call. */
    const controls = shallowRef(null);

    /** @param {?object} next The controls, or null to disconnect. */
    function connect(next) {
      hiddenOwner.value = null;
      controls.value = next && markRaw(next);
    }

    function leaveView(owner) {
      if (!owner || visiblePanel.value?.owner !== owner) return false;
      hiddenOwner.value = owner;
      return true;
    }

    function showView(owner) {
      if (owner && panel.value?.owner === owner && hiddenOwner.value === owner)
        hiddenOwner.value = null;
    }

    return {
      panel,
      visiblePanel,
      publish,
      controls,
      connect,
      leaveView,
      showView,
    };
  },
);
