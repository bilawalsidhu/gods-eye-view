import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
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
  governorRequestRender,
});
