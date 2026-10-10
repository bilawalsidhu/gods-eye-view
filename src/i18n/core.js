/**
 * Lightweight i18n engine shared by every surface that renders user text.
 *
 * This module is deliberately portable: it imports nothing and never touches
 * `window`, `document`, or `localStorage`. Locale detection, persistence and
 * DOM updates live in `browser.js` and the UI layer, so reusable modules can
 * translate their own labels without crossing an architectural boundary.
 *
 * Messages are nested objects addressed by dot paths (`layers.vessels`).
 * The English pack is complete and acts as the fallback; a locale pack may
 * omit a key to inherit it. Plural messages are `{ one, other }` (optionally
 * more Intl.PluralRules categories) and require a `count` parameter.
 *
 * Interpolation uses `{name}` placeholders. A parameter that is not supplied
 * stays visible as `{name}` rather than rendering `undefined`, so a bad call
 * is diagnosable instead of silently wrong.
 */

export const DEFAULT_LOCALE = 'en';

/** Locales with a complete message pack in `locales/`. */
export const SUPPORTED_LOCALES = Object.freeze(['en', 'zh-CN']);

/** Language-display names use each language's own name. */
export const LOCALE_DISPLAY_NAMES = Object.freeze({
  en: 'English',
  'zh-CN': '简体中文',
});

const IDENTITY_TAGS = Object.freeze({
  en: 'en',
  'zh-CN': 'zh-CN',
});

/** Whether the tag names a locale this app ships messages for. */
export function isSupportedLocale(tag) {
  return typeof tag === 'string' && SUPPORTED_LOCALES.includes(tag);
}

/**
 * Map a BCP-47 language tag to a supported locale, or return null.
 * Chinese variants (`zh`, `zh-Hans`, `zh-Hans-CN`, `zh-SG`) resolve to the
 * single shipped Simplified Chinese locale; `zh-Hant*` also resolves to it
 * rather than falling straight back to English.
 */
export function normalizeLocaleTag(tag) {
  if (typeof tag !== 'string') return null;
  const lower = tag.toLowerCase().replace(/_/g, '-');
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  if (lower === 'zh' || lower.startsWith('zh-')) return 'zh-CN';
  return null;
}

/**
 * Pick the first supported locale from an ordered preference list such as
 * `navigator.languages`. Returns null when nothing matches.
 */
export function detectLocaleFromTags(tags) {
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    const normalized = normalizeLocaleTag(tag);
    if (normalized) return normalized;
  }
  return null;
}

function lookupPath(messages, key) {
  if (!messages) return { found: false };
  let node = messages;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object' || !(part in node)) {
      return { found: false };
    }
    node = node[part];
  }
  return { found: true, value: node };
}

function interpolate(template, params, onMissingParam) {
  if (!/\{\w+\}/.test(template)) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params?.[name];
    if (value === undefined || value === null) {
      onMissingParam?.(name);
      return match;
    }
    return String(value);
  });
}

/**
 * Create a translator.
 *
 * @param {object} options
 * @param {Record<string, object>} options.messages locale pack table keyed by
 *   supported locale tag; `fallbackLocale` must have an entry.
 * @param {string} [options.fallbackLocale] locale consulted for missing keys.
 * @param {string} [options.initialLocale] starting locale (defaults to the
 *   fallback).
 * @param {(key: string, locale: string) => void} [options.onMissingKey]
 *   diagnostics hook for keys missing from every pack.
 * @param {(name: string) => void} [options.onMissingParam] diagnostics hook
 *   for interpolation placeholders without a supplied parameter.
 */
export function createI18n({
  messages,
  fallbackLocale = DEFAULT_LOCALE,
  initialLocale = fallbackLocale,
  onMissingKey,
  onMissingParam,
} = {}) {
  if (!messages || !messages[fallbackLocale]) {
    throw new Error(`i18n requires a ${fallbackLocale} message pack`);
  }
  let currentLocale = isSupportedLocale(initialLocale)
    ? initialLocale
    : fallbackLocale;
  const listeners = new Set();
  const numberFormatters = new Map();
  const dateTimeFormatters = new Map();
  const pluralRules = new Map();

  function pluralCategory(count) {
    const rules =
      pluralRules.get(currentLocale) ??
      new Intl.PluralRules(IDENTITY_TAGS[currentLocale] ?? currentLocale);
    pluralRules.set(currentLocale, rules);
    try {
      return rules.select(Number(count));
    } catch {
      return 'other';
    }
  }

  function resolve(key, params) {
    let entry = lookupPath(messages[currentLocale], key);
    if (!entry.found && currentLocale !== fallbackLocale) {
      const fallbackEntry = lookupPath(messages[fallbackLocale], key);
      if (fallbackEntry.found) entry = fallbackEntry;
    }
    if (!entry.found) {
      onMissingKey?.(key, currentLocale);
      return key;
    }
    if (typeof entry.value === 'string') {
      return interpolate(entry.value, params, onMissingParam);
    }
    if (entry.value && typeof entry.value === 'object') {
      const count = params ? Number(params.count) : Number.NaN;
      const template = Number.isFinite(count)
        ? (entry.value[pluralCategory(count)] ?? entry.value.other)
        : entry.value.other;
      if (typeof template === 'string') {
        return interpolate(template, params, onMissingParam);
      }
    }
    onMissingKey?.(key, currentLocale);
    return key;
  }

  function setLocale(locale) {
    const next = isSupportedLocale(locale) ? locale : fallbackLocale;
    if (next === currentLocale) return next;
    currentLocale = next;
    for (const listener of [...listeners]) listener(currentLocale);
    return currentLocale;
  }

  function formatNumber(value, options) {
    const cacheKey = JSON.stringify(options ?? null);
    const formatterKey = `${currentLocale}\u0000${cacheKey}`;
    let formatter = numberFormatters.get(formatterKey);
    if (!formatter) {
      formatter = new Intl.NumberFormat(
        IDENTITY_TAGS[currentLocale] ?? currentLocale,
        options,
      );
      numberFormatters.set(formatterKey, formatter);
    }
    return formatter.format(value);
  }

  function formatDateTime(value, options) {
    const cacheKey = JSON.stringify(options ?? null);
    const formatterKey = `${currentLocale}\u0000${cacheKey}`;
    let formatter = dateTimeFormatters.get(formatterKey);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(
        IDENTITY_TAGS[currentLocale] ?? currentLocale,
        options,
      );
      dateTimeFormatters.set(formatterKey, formatter);
    }
    return formatter.format(value);
  }

  return {
    /** Translate one key with optional `{name}` parameters. */
    t: resolve,
    /** Current locale tag. */
    getLocale: () => currentLocale,
    /** Switch locale (unsupported tags fall back) and notify subscribers. */
    setLocale,
    /** Subscribe to locale changes; returns an unsubscribe function. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Locale-aware number formatting with cached Intl instances. */
    formatNumber,
    /** Locale-aware date-time formatting with cached Intl instances. */
    formatDateTime,
  };
}
