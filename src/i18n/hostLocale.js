/**
 * The page's language, for an application that words its own text beside
 * Core's: read the active locale, and hear when it changes. Core translates
 * only its own strings; text an application hands Core (a cockpit subject
 * provider's labels and HUD view, say) is shown as given, so the application
 * words it for `getLocale()` and words it again on `onLocaleChange`.
 */
export { getLocale, onLocaleChange } from './index.js';
