import { showOsmCredit, hideOsmCredit } from '../data/dataCredits.js';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  getSelectedEntityContext,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from '../data/contextStore.js';
import { overlayHost } from './layers/overlayHost.js';
/** Existing standalone application operations, shared by its local layers. */
export const localGeoJsonServices = Object.freeze({
  overlayHost,
  clearSelectedEntityContextForLayer,
  getSelectedEntityContext,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
  governorRequestRender,
  showOsmCredit,
  hideOsmCredit,
});
