import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * DATA LAYERS ▸ Browse data library as its view renders it. The browser owner
 * (src/ui/libraryBrowser.js) presents whether the dialog is open, the rows
 * the filters show, the stat tiles' summary and Remove all's state, and
 * publishes them here; the view sends clicks and typing to the connected
 * owner.
 */
export const useDataLibraryStore = defineStore('gev-data-library', () => {
  /** The presented browser; null until the owner first publishes. */
  const view = shallowRef(null);

  /** @param {?object} next A fresh presentation; every publish re-renders. */
  function publish(next) {
    view.value = next && markRaw(next);
  }

  /** The browser owner the controls call, or null while none is wired. */
  const controls = shallowRef(null);

  /** @param {?object} next The owner's controls, or null to disconnect. */
  function connect(next) {
    controls.value = next && markRaw(next);
  }

  return { view, publish, controls, connect };
});
