// Locale identity for God's Eye View (i18n phase 1).
//
// English is the default, the authoritative fallback, and the compatibility
// baseline (ai_docs/vision.md). Neutral international Spanish ('es') is the
// first additional locale. This module owns ONLY locale resolution and
// document language metadata — catalogs and translation helpers live in
// src/i18n/index.js.

/** Durable preference key. Matches the repo convention gev:<name>:v1. */
export const LOCALE_STORAGE_KEY = 'gev:locale:v1';

/** Supported locales. 'en' is the default and the fallback catalog locale. */
export const SUPPORTED_LOCALES = Object.freeze(['en', 'es']);

export const DEFAULT_LOCALE = 'en';

/** Document metadata per supported locale. Both shipped locales are LTR. */
export const LOCALE_METADATA = Object.freeze({
  en: Object.freeze({ dir: 'ltr' }),
  es: Object.freeze({ dir: 'ltr' }),
});

/**
 * Map any candidate language tag to a supported locale.
 * 'es' and every regional variant ('es-MX', 'es_419') resolve to 'es';
 * anything unsupported (or not a string) resolves to null so the caller's
 * precedence chain can keep looking.
 * @param {*} candidate Raw locale tag (?lang= value, stored value, navigator entry).
 * @returns {'en'|'es'|null}
 */
export function normalizeLocale(candidate) {
  if (typeof candidate !== 'string') return null;
  const primary = candidate.trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LOCALES.includes(primary) ? primary : null;
}

/**
 * One-shot `?lang=` override, read from the SEARCH string only.
 *
 * The override is never persisted, and it must never leak into the URL hash or
 * share links: it dies with the URL it arrived in (persistLocaleAndReload in
 * src/i18n/index.js strips it when a choice is stored). An unsupported value
 * is ignored rather than forced to English — the rest of the precedence chain
 * still gets to speak.
 * @param {{search?: string}|null} location
 * @returns {'en'|'es'|null}
 */
function queryLocaleOverride(location) {
  const search = location?.search;
  if (!search) return null;
  try {
    return normalizeLocale(new URLSearchParams(search).get('lang'));
  } catch {
    return null;
  }
}

/*
 * STORAGE ACCESS IS LAZY AND GUARDED (same pattern as src/firstRunExperience.js):
 * the `globalThis.localStorage` getter itself can throw SecurityError in Safari
 * private mode or under enterprise policies, so it is only touched inside a
 * try/catch at the moment of use — never in a default parameter. An injected
 * `storage` (tests, embedders) short-circuits the global entirely; `undefined`
 * means "use the global".
 */

/** Read the stored preference, treating every failure as "nothing stored". */
function readStoredLocale(storage) {
  try {
    const store = storage !== undefined ? storage : globalThis.localStorage;
    return normalizeLocale(store?.getItem?.(LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * Write the stored preference, best-effort. Never throws.
 * @returns {boolean} true only if the value actually landed.
 */
export function writeStoredLocale(locale, storage) {
  const normalized = normalizeLocale(locale) || DEFAULT_LOCALE;
  try {
    const store = storage !== undefined ? storage : globalThis.localStorage;
    if (typeof store?.setItem !== 'function') return false;
    store.setItem(LOCALE_STORAGE_KEY, normalized);
    return true;
  } catch {
    // Privacy-restricted or quota-exhausted storage must never break the app.
    return false;
  }
}

/**
 * Resolve the active locale. Precedence (ai_docs/vision.md):
 *
 *   ?lang=<locale> → stored preference → navigator.languages → 'en'
 *
 * Each step that yields nothing (absent or unsupported) defers to the next;
 * only the final English default is unconditional.
 * @param {object} [input]
 * @param {{search?: string, href?: string}|null} [input.location] Location to read ?lang= from.
 * @param {object|null} [input.storage] Injected localStorage-like store; `undefined` uses the global.
 * @param {readonly string[]|null} [input.languages] Browser language list.
 * @returns {'en'|'es'}
 */
export function resolveLocale({
  location = globalThis.location,
  storage,
  languages = globalThis.navigator?.languages,
} = {}) {
  const override = queryLocaleOverride(location);
  if (override) return override;
  const stored = readStoredLocale(storage);
  if (stored) return stored;
  if (Array.isArray(languages)) {
    for (const candidate of languages) {
      const normalized = normalizeLocale(candidate);
      if (normalized) return normalized;
    }
  }
  return DEFAULT_LOCALE;
}

/**
 * Reflect the active locale on the document: `<html lang>` and `<html dir>`
 * must always agree with the language actually being rendered.
 * @param {Document} doc Document whose documentElement carries the metadata.
 * @param {string} locale Locale to apply (normalized here).
 * @returns {boolean} true when the metadata was written.
 */
export function applyDocumentLanguage(doc, locale = DEFAULT_LOCALE) {
  const root = doc?.documentElement;
  if (!root) return false;
  const normalized = normalizeLocale(locale) || DEFAULT_LOCALE;
  root.lang = normalized;
  root.dir = (LOCALE_METADATA[normalized] || LOCALE_METADATA[DEFAULT_LOCALE]).dir;
  return true;
}
