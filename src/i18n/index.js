/**
 * The application's shared i18n instance.
 *
 * UI modules import `{ t }` (and the other helpers) directly — the translator
 * reads its live locale state on every call, so a locale switch takes effect
 * on the next render without rebuilding imports. The instance stays free of
 * browser globals: detection and persistence live in `browser.js`, DOM
 * rebinding in `src/ui/staticI18n.js`.
 */
import { createI18n, DEFAULT_LOCALE } from './core.js';
import en from './locales/en.js';
import zhCN from './locales/zh-CN.js';

export const i18n = createI18n({
  messages: { en, 'zh-CN': zhCN },
  fallbackLocale: DEFAULT_LOCALE,
  initialLocale: DEFAULT_LOCALE,
  onMissingKey(key, locale) {
    if (import.meta.env?.DEV) {
      console.warn(`[i18n] missing message for "${key}" (locale: ${locale})`);
    }
  },
  onMissingParam(name) {
    if (import.meta.env?.DEV) {
      console.warn(`[i18n] interpolation parameter "${name}" was not supplied`);
    }
  },
});

/** Translate one key with optional `{name}` parameters. */
export const t = i18n.t;
/** Locale-aware number formatting. */
export const formatNumber = i18n.formatNumber;
/** Locale-aware date-time formatting. */
export const formatDateTime = i18n.formatDateTime;
/** Current locale tag (`'en'` or `'zh-CN'`). */
export const currentLocale = i18n.getLocale;
/** Switch the UI language and notify subscribers. */
export const setLocale = i18n.setLocale;
/** Subscribe to locale changes; the returned function unsubscribes. */
export const subscribeLocale = i18n.subscribe;
