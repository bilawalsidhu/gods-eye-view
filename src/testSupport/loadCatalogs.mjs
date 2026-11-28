// Every translation catalog, loaded before a test runs: `node
// --import=./src/testSupport/loadCatalogs.mjs`. The page loads a catalog when
// its locale is chosen, so setLocale applies a locale only once its catalog
// is in; with all of them loaded, a test's setLocale('ru') applies at once and
// the t() after it reads Russian. `npm test` passes this flag to every test.
import { loadCatalog } from '../i18n/index.js';
import { LOCALES } from '../i18n/locale.js';

await Promise.all(LOCALES.map((locale) => loadCatalog(locale)));
