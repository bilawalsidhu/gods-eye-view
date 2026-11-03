import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * Scene sharing as its views render it. The sharing owner
 * (src/scenes/sharing.js) offers the EDIT DETAILS / SHARE SCENE bar and
 * presents its one open dialog here; the views send clicks, typing and file
 * choices back to the connected dialog.
 */
export const useSceneSharingStore = defineStore('gev-scene-sharing', () => {
  /** The bar's actions ({edit, share}), or null while no owner offers it. */
  const toolbar = shallowRef(null);

  /** @param {?{edit: Function, share: Function}} next */
  function offerToolbar(next) {
    toolbar.value = next && markRaw(next);
  }

  /** The open dialog's presentation, or null while none is open. */
  const dialog = shallowRef(null);

  /** @param {?object} next A fresh presentation; every publish re-renders. */
  function publishDialog(next) {
    dialog.value = next && markRaw(next);
  }

  /** The open dialog the view calls, or null while none is wired. */
  const controls = shallowRef(null);

  /** @param {?object} next The dialog, or null to disconnect. */
  function connect(next) {
    controls.value = next && markRaw(next);
  }

  return { toolbar, offerToolbar, dialog, publishDialog, controls, connect };
});
