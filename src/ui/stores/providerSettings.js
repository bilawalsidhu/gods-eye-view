import { defineStore } from 'pinia';
import { presented } from './presented.js';

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
    const [view, publish] = presented();

    /** The setup owner the controls call, or null while none is wired. */
    const [controls, connect] = presented();

    return { view, publish, controls, connect };
  },
);
