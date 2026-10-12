import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { currentLocale, setLocale, subscribeLocale, t } from './i18n/index.js';
import {
  applyDocumentLanguage,
  applyDocumentTitle,
  resolveStartupLocale,
} from './i18n/browser.js';
import { bindStaticTranslations } from './ui/staticI18n.js';
import { createLanguageControl } from './ui/languageControl.js';

// Locale resolution runs before any control constructs: the saved choice
// wins, then the browser preference, then English. The pre-paint bootstrap
// in index.html has already painted the loading screen; this pass covers
// everything the app itself renders.
setLocale(resolveStartupLocale());
applyDocumentLanguage(currentLocale());
const applyDocumentTitleForLocale = () =>
  applyDocumentTitle(t('boot.language.documentTitle'));
applyDocumentTitleForLocale();
bindStaticTranslations();
subscribeLocale((locale) => {
  applyDocumentLanguage(locale);
  applyDocumentTitleForLocale();
});
createLanguageControl({ select: document.getElementById('language-select') });

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

application.start().catch((error) => {
  console.error("God's Eye View initialization failed:", error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = t('boot.loader.errorPrefix', {
    message: describeError(error),
  });
  loaderStatus.style.color = '#ff4444';
});

export { application };
