import { createStandalonePlaceSearch } from './placeSearch.js';
import { createApplication } from '../app/application.js';
import { createStandaloneScene } from './scene.js';
import { createStandaloneControls } from './controls.js';
import { createStandaloneData } from './data.js';
import { createStandaloneTools } from './tools.js';
import { resolveLocale, applyDocumentLanguage } from '../i18n/locale.js';
import { applyDocumentTranslations, setLocale } from '../i18n/index.js';

// The existing controls and layer catalog contain page-scoped state.
let constructed = false;

/** Compose the standalone application once per page. Reload to start again. */
export function createStandaloneApplication({
  googleApiKey,
  cesiumToken,
  allowQaRegistration = false,
}) {
  if (constructed)
    throw new Error('The standalone application already owns this page');
  constructed = true;
  // Locale is resolved before any UI initialization so <html lang>/<html dir>
  // and every catalog lookup agree from the first painted frame. Module
  // scripts execute after parsing, so the DOM is ready here and every
  // data-i18n* element honors the resolved locale without a reload.
  const activeLocale = resolveLocale();
  setLocale(activeLocale);
  applyDocumentLanguage(document, activeLocale);
  applyDocumentTranslations(document);
  const loadingScreen = document.getElementById('loading-screen');
  const loaderStatus = loadingScreen.querySelector('.loader-status');
  let placeSearch;
  return createApplication({
    createScene: (context) => {
      placeSearch = createStandalonePlaceSearch({
        resolveApiKey: () => googleApiKey,
        signal: context.signal,
      });
      return createStandaloneScene({
        ...context,
        googleApiKey,
        cesiumToken,
        loaderStatus,
      });
    },
    createControls: (context) =>
      createStandaloneControls({ ...context, loaderStatus, placeSearch }),
    createData: (context) =>
      createStandaloneData({ ...context, allowQaRegistration }),
    createTools: (context) =>
      createStandaloneTools({ ...context, loadingScreen, placeSearch }),
  });
}
