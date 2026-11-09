import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The wind inspection marker as its view renders it. The marker owner
 * (src/layers/wind/inspectionMarker.js) presents where the inspected point
 * falls on screen after every rendered frame.
 */
export const useWindInspectionStore = defineStore('gev-wind-inspection', () => {
  /**
   * `{owner, container, visible, left, top}`, in pixels from the container's
   * corner, or null while no point is inspected.
   */
  const marker = shallowRef(null);

  /** @param {?object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    marker.value = next && markRaw(next);
  }

  return { marker, publish };
});
