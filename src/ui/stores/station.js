import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';
import { createOwners } from './owners.js';

/**
 * The STATION section in Context as its view renders it: the selected
 * station's controls (Automatic or Manual, the moving parts by hand), where
 * its joint angles come from right now, and a zoom to it. The satellites
 * layer's station panel presents it (`gev-station` store) and answers its
 * controls through act(): `setStationMode`, `chooseStation`, `slideStation`,
 * `resumeStationArm`, `zoomStation`.
 */
export const useStationStore = defineStore('gev-station', () => {
  /** The presented section; null while no station is selected. */
  const view = shallowRef(null);

  /** @param {?object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    view.value = next && markRaw(next);
  }

  const { connect, detach, act } = createOwners();

  return { view, publish, connect, detach, act };
});
