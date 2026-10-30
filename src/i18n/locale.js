// Which locale the page runs in: ?lang= → stored choice → browser languages →
// English. Only shipped locales are ever selected.

/** Durable preference key. Matches the repo convention gev:<name>:v1. */
export const LOCALE_STORAGE_KEY = 'gev:locale:v1';

/** Source language and fallback. */
export const DEFAULT_LOCALE = 'en';

/** Shipped locales; order does not matter. Adding one: docs/TRANSLATORS.md. */
export const LOCALES = Object.freeze([
  'en',
  'de',
  'es',
  'fr',
  'it',
  'ja',
  'pt',
  'ru',
  'uk',
  'zh-CN',
  'zh-Hant',
]);

/** Each locale named in its own language, for the selector. */
export const LOCALE_NAMES = Object.freeze({
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
  ja: '日本語',
  pt: 'Português (Brasil)',
  ru: 'Русский',
  uk: 'Українська',
  'zh-CN': '中文（简体）',
  'zh-Hant': '中文（繁體）',
});

/** Right-to-left locales. */
const RTL_LOCALES = Object.freeze([]);

/**
 * Map any language tag to a shipped locale: 'ru-RU' and 'RU' → 'ru',
 * 'de-AT' and 'de_CH' → 'de', 'ja-JP' → 'ja',
 * 'pt-BR' and 'pt-PT' → 'pt' (Brazilian Portuguese),
 * 'zh', 'zh-CN' and 'zh-Hans-SG' → 'zh-CN';
 * 'zh-Hant', 'zh-TW', 'zh-HK' and 'zh-MO' → 'zh-Hant'.
 * @returns {string|null}
 */
export function normalizeLocale(candidate) {
  if (typeof candidate !== 'string') return null;
  const [primary, ...rest] = candidate.trim().toLowerCase().split(/[-_]/);
  if (primary === 'zh') {
    if (rest.includes('hans')) return 'zh-CN';
    return rest.some((part) => ['hant', 'tw', 'hk', 'mo'].includes(part))
      ? 'zh-Hant'
      : 'zh-CN';
  }
  return LOCALES.includes(primary) ? primary : null;
}

function queryLocale(location) {
  try {
    return normalizeLocale(new URLSearchParams(location?.search).get('lang'));
  } catch {
    return null;
  }
}

function readStoredLocale(storage) {
  try {
    const store = storage !== undefined ? storage : globalThis.localStorage;
    return normalizeLocale(store?.getItem?.(LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Store the choice; false when storage is unavailable. */
export function writeStoredLocale(locale, storage) {
  const normalized = normalizeLocale(locale) || DEFAULT_LOCALE;
  try {
    const store = storage !== undefined ? storage : globalThis.localStorage;
    if (typeof store?.setItem !== 'function') return false;
    store.setItem(LOCALE_STORAGE_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the boot locale. Every input is injectable for tests. */
export function resolveLocale({
  location = globalThis.location,
  storage,
  languages = globalThis.navigator?.languages,
} = {}) {
  const fromQuery = queryLocale(location);
  if (fromQuery) return fromQuery;
  const stored = readStoredLocale(storage);
  if (stored) return stored;
  for (const candidate of Array.isArray(languages) ? languages : []) {
    const normalized = normalizeLocale(candidate);
    if (normalized) return normalized;
  }
  return DEFAULT_LOCALE;
}

/** Set <html lang> and <html dir>. */
export function applyDocumentLanguage(doc, locale = DEFAULT_LOCALE) {
  const root = doc?.documentElement;
  if (!root) return false;
  const normalized = normalizeLocale(locale) || DEFAULT_LOCALE;
  root.lang = normalized;
  root.dir = RTL_LOCALES.includes(normalized) ? 'rtl' : 'ltr';
  return true;
}
