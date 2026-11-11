import * as context from '../data/contextStore.js';
import { worldOverlayFor } from '../overlays/worldOverlay.js';
import { showOsmCredit, hideOsmCredit } from '../data/dataCredits.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
  getSelectedEntityContext,
} from '../data/contextStore.js';

/** Existing standalone application operations, shared by its local layers. */
export const localGeoJsonServices = Object.freeze({
  context,
  overlayHost: worldOverlayFor,
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
  getSelectedEntityContext,
  showOsmCredit,
  hideOsmCredit,
});
