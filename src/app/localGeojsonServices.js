import { showOsmCredit, hideOsmCredit } from '../data/dataCredits.js';
import { governorRequestRender } from '../renderGovernor.js';
import {
  formatDate,
  formatNumber,
  isolate,
  onLocaleChange,
  t,
} from '../i18n/index.js';
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
  showOsmCredit,
  hideOsmCredit,
  // The translator, formatters and language-change subscription for layer text
  // that follows the active language (the USGS water cards). The standalone
  // infrastructure package does not bundle them; it takes them from here.
  i18n: Object.freeze({ t, formatNumber, formatDate, isolate, onLocaleChange }),
});
