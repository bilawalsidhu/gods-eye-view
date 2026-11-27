import { defineStore } from 'pinia';
import { presented } from './presented.js';

/**
 * DATA LAYERS ▸ Browse data library as its view renders it. The browser owner
 * (src/ui/libraryBrowser.js) presents whether the dialog is open, the rows
 * the filters show, the stat tiles' summary and Remove all's state, and
 * publishes them here; the view sends clicks and typing to the connected
 * owner.
 */
export const useDataLibraryStore = defineStore('gev-data-library', () => {
  /** The presented browser; null until the owner first publishes. */
  const [view, publish] = presented();

  /** The browser owner the controls call, or null while none is wired. */
  const [controls, connect] = presented();

  return { view, publish, controls, connect };
});
