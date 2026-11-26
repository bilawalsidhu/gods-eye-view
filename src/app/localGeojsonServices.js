import { showOsmCredit, hideOsmCredit } from '../data/dataCredits.js';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  getSelectedEntityContext,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from '../data/contextStore.js';
import {
  clearOverlaySource,
  registerWorldOverlayPaintLane,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { keyholeLabelAlphaFromGeometry } from '../celestialRing.js';
/** Existing standalone application operations, shared by its local layers. */
export const localGeoJsonServices = Object.freeze({
  overlayHost: Object.freeze({
    clearSource: clearOverlaySource,
    setEntries: setOverlayEntries,
    setVisible: setOverlaySourceVisible,
  }),
  clearSelectedEntityContextForLayer,
  getSelectedEntityContext,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
  governorRequestRender,
  showOsmCredit,
  hideOsmCredit,
  // Count markers of a clustered layer paint on the world overlay.
  registerPaintLane: registerWorldOverlayPaintLane,
  keyholeAlpha: keyholeLabelAlphaFromGeometry,
});
