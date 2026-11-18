import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The visible map target list as its view renders it. The world overlay
 * (src/overlays/worldOverlay.js) presents the actionable cards it painted and
 * the last focus announcement; the application shell publishes them here and
 * connects the overlay's activation.
 */
export const useWorldOverlayActionsStore = defineStore(
  'gev-world-overlay-actions',
  () => {
    /**
     * `{owner, items: [{key, label, selected}], status}`, or null without an
     * overlay host. `owner` is passed back with each activation.
     */
    const actions = shallowRef(null);

    /** @param {?object} next A fresh presentation; every publish re-renders. */
    function publish(next) {
      actions.value = next && markRaw(next);
    }

    /** The controls whose `activate(owner, key)` a target button calls. */
    const controls = shallowRef(null);

    /** @param {?object} next The controls, or null to disconnect. */
    function connect(next) {
      controls.value = next && markRaw(next);
    }

    return { actions, publish, controls, connect };
  },
);
