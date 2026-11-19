/**
 * @module i18n/page
 * @description The page's interface language, for an application that
 * composes Core and offers its own language choice (a menu item, a settings
 * page) instead of the globe picker. It starts the language the standalone
 * application starts, keeps `<html lang>`/`<html dir>` and the page's
 * `data-i18n` markup in step, and switches in place, stored for the next
 * visit, exactly as the picker does. It also exports the translator itself,
 * and lets the application show its own text for Core's messages
 * (`setMessageOverrides`). Guide: docs/I18N.md.
 */
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_NAMES,
  applyDocumentLanguage,
  isRtlLocale,
  normalizeLocale,
  resolveLocale,
} from './locale.js';
import {
  applyDocumentTranslations,
  getLocale,
  onLocaleChange,
  persistLocale,
  setLocale,
} from './index.js';

export {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_NAMES,
  applyDocumentTranslations,
  getLocale,
  isRtlLocale,
  onLocaleChange,
};
// The translator Core's own text goes through, for an application's text and
// for showing its own wording of Core's messages (setMessageOverrides).
export {
  formatDate,
  formatNumber,
  formatRelativeTime,
  msg,
  setMessageOverrides,
  t,
  tn,
  translateKnown,
} from './index.js';

/**
 * Start the page in its language: `?lang=`, then the stored choice, then the
 * browser's languages, then English. Call it before any view renders, so
 * every lookup and `<html lang>`/`<html dir>` agree from the first frame; the
 * page's static `data-i18n` markup (a loading screen) is translated now.
 * @param {Document} [doc]
 * @param {Parameters<typeof resolveLocale>[0]} [inputs] Location, storage
 *   and languages, for tests.
 * @returns {string} The active locale.
 */
export function startPageLocale(doc = globalThis.document, inputs) {
  const locale = setLocale(resolveLocale(inputs));
  applyDocumentLanguage(doc, locale);
  applyDocumentTranslations(doc);
  return locale;
}

/**
 * Keep `<html lang>`/`<html dir>` and the page's `data-i18n` markup in step
 * with every language switch.
 * @param {Document} [doc]
 * @returns {() => void} Stops following.
 */
export function followPageLocale(doc = globalThis.document) {
  return onLocaleChange(() => {
    applyDocumentLanguage(doc, getLocale());
    applyDocumentTranslations(doc);
  });
}

/**
 * Switch the page to `locale` in place and keep it for the next visit. The
 * active language, or an unknown code that would fall back to it, changes
 * nothing.
 * @param {string} locale One of LOCALES.
 * @param {Parameters<typeof persistLocale>[1]} [options] Location, history
 *   and storage, for tests.
 * @returns {'unchanged'|'switched'}
 */
export function switchLocale(locale, options) {
  const next = normalizeLocale(locale) || DEFAULT_LOCALE;
  if (next === getLocale()) return 'unchanged';
  setLocale(persistLocale(next, options));
  return 'switched';
}
