import { defineStore } from 'pinia';
import { presented } from './presented.js';

/**
 * Scene sharing as its views render it. The sharing owner
 * (src/scenes/sharing.js) offers the EDIT DETAILS / SHARE SCENE bar and
 * presents its one open dialog here; the views send clicks, typing and file
 * choices back to the connected dialog.
 */
export const useSceneSharingStore = defineStore('gev-scene-sharing', () => {
  /** The bar's actions ({edit, share}), or null while no owner offers it. */
  const [toolbar, offerToolbar] = presented();

  /** The open dialog's presentation, or null while none is open. */
  const [dialog, publishDialog] = presented();

  /** The open dialog the view calls, or null while none is wired. */
  const [controls, connect] = presented();

  return { toolbar, offerToolbar, dialog, publishDialog, controls, connect };
});
