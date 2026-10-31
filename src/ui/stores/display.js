import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The Display panel as its view renders it. VisualSettings presents its
 * groups (`_presentDisplay()`) and AircraftDisplay the 3D aircraft group,
 * and each publishes here; both keep their listeners on the controls.
 */
export const useDisplayStore = defineStore('gev-display', () => {
  /** The presented panel; null until VisualSettings first renders. */
  const view = shallowRef(null);

  /** @param {object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    view.value = markRaw(next);
  }

  /** The 3D aircraft group; null until AircraftDisplay first renders. */
  const models3d = shallowRef(null);

  /** @param {object} next A fresh presentation of the 3D aircraft group. */
  function publishModels3d(next) {
    models3d.value = markRaw(next);
  }

  return { view, publish, models3d, publishModels3d };
});
