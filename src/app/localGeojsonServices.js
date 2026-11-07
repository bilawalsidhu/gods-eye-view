import { showOsmCredit, hideOsmCredit } from '../data/dataCredits.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
  getSelectedEntityContext,
} from '../data/contextStore.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
/** Existing standalone application operations, shared by its local layers. */
export const localGeoJsonServices = Object.freeze({
  overlayHost: Object.freeze({
    clearSource: clearOverlaySource,
    setEntries: setOverlayEntries,
    setVisible: setOverlaySourceVisible,
  }),
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
  getSelectedEntityContext,
  showOsmCredit,
  hideOsmCredit,
});
