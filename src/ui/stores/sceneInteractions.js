import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The active shot's Scene actions panel as its view renders it. The scene
 * interactions owner (src/scenes/interactions.js) presents the actions, the
 * status line and the source card here; the view sends action clicks back to
 * the connected controls.
 */
export const useSceneInteractionsStore = defineStore(
  'gev-scene-interactions',
  () => {
    /**
     * `{id, owner, container, items, status, busy, selected, outlined,
     * card}`, or null while the shot has no actions. `container` is the
     * element it sits in; `owner` is passed back with each dispatch.
     */
    const panel = shallowRef(null);

    /** @param {?object} next A fresh presentation; every publish re-renders. */
    function publish(next) {
      panel.value = next && markRaw(next);
    }

    /** The controls whose `dispatch(id, owner)` an action button calls. */
    const controls = shallowRef(null);

    /** @param {?object} next The controls, or null to disconnect. */
    function connect(next) {
      controls.value = next && markRaw(next);
    }

    return { panel, publish, controls, connect };
  },
);
