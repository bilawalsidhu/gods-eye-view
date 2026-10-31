import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The Display panel as its view renders it. VisualSettings presents its
 * groups (`_presentDisplay()`), AircraftDisplay the 3D aircraft group, the
 * draw tool its controls and the file import its list, and each publishes
 * here; each keeps its listeners on the controls.
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

  /** The Draw controls; null until the draw tool first renders. */
  const draw = shallowRef(null);

  /** @param {object} next A fresh presentation of the Draw controls. */
  function publishDraw(next) {
    draw.value = markRaw(next);
  }

  /** The imported files and hint; null until the file import renders. */
  const geoImport = shallowRef(null);

  /** @param {object} next A fresh presentation of the imported files. */
  function publishGeoImport(next) {
    geoImport.value = markRaw(next);
  }

  return {
    view,
    publish,
    models3d,
    publishModels3d,
    draw,
    publishDraw,
    geoImport,
    publishGeoImport,
  };
});
