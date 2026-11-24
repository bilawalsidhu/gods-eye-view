import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The Space Missions panel as its views render it. The Space Missions layer
 * publishes its roster and selected mission here, and SpaceMissionsControls
 * publishes whether the layer is on. Nothing here belongs to Context.
 */
export const useSpaceMissionsStore = defineStore('gev-space-missions', () => {
  /** Whether the Space Missions layer is on or starting. */
  const enabled = shallowRef(false);

  /** @param {boolean} next Whether the layer is on or starting. */
  function setEnabled(next) {
    enabled.value = Boolean(next);
  }

  /** The roster; null until the layer first presents it. */
  const roster = shallowRef(null);

  /** The selected space mission; null while none is selected. */
  const mission = shallowRef(null);

  /**
   * @param {?{roster: ?object, mission: ?object}} next The layer's view. The
   *   layer keeps an unchanged roster's object, which re-renders nothing.
   */
  function publish(next) {
    roster.value = next?.roster ? markRaw(next.roster) : null;
    mission.value = next?.mission ? markRaw(next.mission) : null;
  }

  /** The Space Missions layer whose panel commands the components call. */
  const layer = shallowRef(null);

  /** @param {?object} next The Space Missions layer, or null to disconnect. */
  function connect(next) {
    layer.value = next && markRaw(next);
  }

  return { enabled, setEnabled, roster, mission, publish, layer, connect };
});
