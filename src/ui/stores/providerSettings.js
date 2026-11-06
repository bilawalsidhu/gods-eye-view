import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * Provider Settings (the dev-only key setup) as its view renders it. The
 * setup owner (src/keySetup.js) presents the POWER UP chip, the dialog, its
 * key rows, the field values and the status line, and publishes them here;
 * the view sends clicks and typing to the connected owner.
 */
export const useProviderSettingsStore = defineStore(
  'gev-provider-settings',
  () => {
    /** The presented setup; null until the owner first publishes. */
    const view = shallowRef(null);

    /** @param {?object} next A fresh presentation; every publish re-renders. */
    function publish(next) {
      view.value = next && markRaw(next);
    }

    /** The setup owner the controls call, or null while none is wired. */
    const controls = shallowRef(null);

    /** @param {?object} next The owner, or null to disconnect. */
    function connect(next) {
      controls.value = next && markRaw(next);
    }

    return { view, publish, controls, connect };
  },
);
