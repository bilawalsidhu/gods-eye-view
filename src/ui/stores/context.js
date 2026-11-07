import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The Context panel's mode switch as its view renders it. ContextControls
 * presents the selected mode, the transition busy state and the nearby
 * sites search (`_presentContext()`) and publishes them here; it
 * keeps its listeners and transactions. The Contacts and Space Missions
 * layers publish their panels beside it, and the app connects each layer's
 * commands.
 */
export const useContextStore = defineStore('gev-context', () => {
  /** The presented mode switch; null until the controls first render. */
  const view = shallowRef(null);

  /** @param {object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    view.value = markRaw(next);
  }

  /** The Contacts panel; null until the layer first publishes. */
  const awareness = shallowRef(null);

  /** @param {object} next A fresh presentation of the Contacts panel. */
  function publishAwareness(next) {
    awareness.value = next && markRaw(next);
  }

  /**
   * The Contacts layer whose navigation the panel calls: `navigatePrevious`,
   * `focusCurrent`, `navigateNext` and `focusTarget`.
   */
  const awarenessLayer = shallowRef(null);

  /** @param {?object} layer The Contacts layer, or null to disconnect. */
  function connectAwareness(layer) {
    awarenessLayer.value = layer && markRaw(layer);
  }

  /** The Space Missions roster; null until the layer first presents it. */
  const missionRoster = shallowRef(null);

  /** The selected space mission; null while none is selected. */
  const mission = shallowRef(null);

  /**
   * @param {?{roster: ?object, mission: ?object}} next The layer's view. The
   *   layer keeps an unchanged roster's object, which re-renders nothing.
   */
  function publishMissions(next) {
    missionRoster.value = next?.roster ? markRaw(next.roster) : null;
    mission.value = next?.mission ? markRaw(next.mission) : null;
  }

  /** The Space Missions layer whose panel commands the components call. */
  const missionsLayer = shallowRef(null);

  /** @param {?object} layer The Space Missions layer, or null to disconnect. */
  function connectMissions(layer) {
    missionsLayer.value = layer && markRaw(layer);
  }

  return {
    view,
    publish,
    awareness,
    publishAwareness,
    awarenessLayer,
    connectAwareness,
    missionRoster,
    mission,
    publishMissions,
    missionsLayer,
    connectMissions,
  };
});
