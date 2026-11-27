import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The top-bar omnibar's link to the shell. The shell connects the actions
 * the omnibar offers: `layers()` lists the data layers as `{id, name,
 * enabled}`, and `setLayer(id, enabled)` turns one on or off as a user click
 * would. `creditPlaces()`, optional, credits the bundled Wikidata place
 * packs once a name from them is shown, and `creditSuggestions(shown)`,
 * optional, shows the OpenStreetMap credit while Photon's suggestions are.
 * `lookupEntities({text, signal})`, or null, asks the host's entity lookup
 * (src/app/controls.js) for the typed line, and `findLookedUp(match,
 * {signal})` finds one of its answers in its layer (src/ui/entityLookup.js).
 * Place search runs through the
 * location controls and Ask GEV through the voice controls, so neither is
 * repeated here.
 */
export const useOmnibarStore = defineStore('gev-omnibar', () => {
  /** `{layers(), setLayer(id, enabled), creditPlaces?()}`, or null while disconnected. */
  const controls = shallowRef(null);

  /** @param {?object} next The shell's omnibar actions, or null. */
  function connect(next) {
    controls.value = next && markRaw(next);
  }

  /**
   * The voice action runner, `(name, args) → Promise<result>`: the same
   * actions voice and chat call, run directly without a model. Null while no
   * voice runtime is up.
   */
  const runner = shallowRef(null);

  /** @param {?Function} next The runner, or null to disconnect. */
  function connectRunner(next) {
    runner.value = next ? markRaw(next) : null;
  }

  return { controls, connect, runner, connectRunner };
});
