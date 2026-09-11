// Locale identity for God's Eye View (i18n phase 1).
//
// English is the default-without-configuration, the ALWAYS-shipped fallback
// catalog, and the compatibility baseline (ai_docs/vision.md). Neutral
// international Spanish ('es') is the default secondary locale; French ('fr')
// ships fully translated. Which pair the app actually offers is
// configured at build/dev time through GEV_DEFAULT_LOCALE /
// GEV_SECONDARY_LOCALE (vite.config.js client defines) and resolved here.
// This module owns ONLY locale resolution and document language metadata —
// catalogs and translation helpers live in src/i18n/index.js.

/** Durable preference key. Matches the repo convention gev:<name>:v1. */
export const LOCALE_STORAGE_KEY = 'gev:locale:v1';

/**
 * Locales with a shipped catalog. 'en' is the fallback catalog locale
 * (DEFAULT_LOCALE); every entry here can be normalized and looked up, though
 * only locales in the configured PAIR (see resolveLocalePair) are offered in
 * the UI and accepted during resolution.
 */
export const CATALOG_LOCALES = Object.freeze(['en', 'es', 'fr']);

/** Fallback catalog locale and no-config default: always English. */
export const DEFAULT_LOCALE = 'en';

/** Built-in pair used when no env/config shapes one, or a configured one is unusable. */
const FALLBACK_PAIR = Object.freeze({ defaultLocale: 'en', secondaryLocale: 'es' });

/** Document metadata per shipped locale. All shipped locales are LTR. */
export const LOCALE_METADATA = Object.freeze({
  en: Object.freeze({ dir: 'ltr' }),
  es: Object.freeze({ dir: 'ltr' }),
  fr: Object.freeze({ dir: 'ltr' }),
});

/**
 * Map any candidate language tag to a shipped catalog locale. 'es'/'fr' and
 * every regional variant ('es-MX', 'fr_CA') resolve to the primary tag;
 * anything without a catalog (or not a string) resolves to null so the
 * caller's precedence chain can keep looking.
 * @param {*} candidate Raw locale tag (?lang= value, stored value, navigator entry).
 * @returns {'en'|'es'|'fr'|null}
 */
export function normalizeLocale(candidate) {
  if (typeof candidate !== 'string') return null;
  const primary = candidate.trim().toLowerCase().split(/[-_]/)[0];
  return CATALOG_LOCALES.includes(primary) ? primary : null;
}

/**
 * Read the configured pair from the two client defines. Both spellings are
 * replaced TEXTUALLY by Vite (vite.config.js `define`), so they must stay
 * verbatim member expressions. Under node:test `import.meta.env` is absent
 * and the first access throws; the catch turns that into "use the defaults".
 * @returns {{defaultLocale?: string, secondaryLocale?: string}}
 */
function readEnvLocalePair() {
  try {
    return {
      defaultLocale: import.meta.env.GEV_DEFAULT_LOCALE,
      secondaryLocale: import.meta.env.GEV_SECONDARY_LOCALE,
    };
  } catch {
    return {};
  }
}

/** A blank string means "unset" (an empty .env line), not an invalid value. */
function orBuiltIn(value, builtIn) {
  return typeof value === 'string' && value.trim() ? value : builtIn;
}

/** Development-only diagnostics, same gate as warnMissingKey in index.js. */
function warnInvalidPair(rawDefault, rawSecondary) {
  // Vite replaces import.meta.env at build time; under node:test it is absent,
  // so warnings never fire in CI — only on the dev server.
  if (import.meta.env?.DEV !== true) return;
  console.warn(
    `[i18n] unusable locale pair ${JSON.stringify(String(rawDefault))}/`
    + `${JSON.stringify(String(rawSecondary))} — falling back to en+es`,
  );
}

/**
 * Resolve the offered locale pair. With no argument the two client defines are
 * read (GEV_DEFAULT_LOCALE default 'en', GEV_SECONDARY_LOCALE default 'es');
 * an explicit { defaultLocale, secondaryLocale } injects a pair for tests and
 * embedders — injected fields never fall through to the env. If either value
 * is unsupported, or the pair degenerates (same locale twice), the built-in
 * en+es pair is returned and a dev-only console.warn explains why.
 *
 * availableLocales is the deduped [default, secondary, 'en'] triple — English
 * is always shippable because its catalog is the unconditional fallback.
 * @param {{defaultLocale?: string, secondaryLocale?: string}} [config]
 * @returns {{defaultLocale: string, secondaryLocale: string, availableLocales: readonly string[]}} Frozen.
 */
export function resolveLocalePair(config) {
  const injected = typeof config === 'object' && config !== null
    && (config.defaultLocale !== undefined || config.secondaryLocale !== undefined);
  const raw = injected ? config : readEnvLocalePair();
  const rawDefault = orBuiltIn(raw?.defaultLocale, FALLBACK_PAIR.defaultLocale);
  const rawSecondary = orBuiltIn(raw?.secondaryLocale, FALLBACK_PAIR.secondaryLocale);
  const defaultLocale = normalizeLocale(rawDefault);
  const secondaryLocale = normalizeLocale(rawSecondary);
  if (!defaultLocale || !secondaryLocale || defaultLocale === secondaryLocale) {
    warnInvalidPair(rawDefault, rawSecondary);
    return pairOf(FALLBACK_PAIR.defaultLocale, FALLBACK_PAIR.secondaryLocale);
  }
  return pairOf(defaultLocale, secondaryLocale);
}

/** Freeze the deduped pair + always-shipped English. */
function pairOf(defaultLocale, secondaryLocale) {
  const availableLocales = [...new Set([defaultLocale, secondaryLocale, DEFAULT_LOCALE])];
  return Object.freeze({
    defaultLocale,
    secondaryLocale,
    availableLocales: Object.freeze(availableLocales),
  });
}

/**
 * Locales the app offers and accepts, in selector order: the configured
 * default, the secondary locale, then English if not already present.
 * @param {{defaultLocale?: string, secondaryLocale?: string}} [config] Injectable pair (tests/embedders).
 * @returns {readonly string[]}
 */
export function availableLocales(config) {
  return resolveLocalePair(config).availableLocales;
}

/**
 * One-shot `?lang=` override, read from the SEARCH string only.
 *
 * The override is never persisted, and it must never leak into the URL hash or
 * share links: it dies with the URL it arrived in (persistLocaleAndReload in
 * src/i18n/index.js strips it when a choice is stored). An unsupported value —
 * or a shipped locale outside the configured pair — is ignored rather than
 * forced to English; the rest of the precedence chain still gets to speak.
 * @param {{search?: string}|null} location
 * @param {readonly string[]} availableLocales Resolved pair locales.
 * @returns {string|null}
 */
function queryLocaleOverride(location, availableLocales) {
  const search = location?.search;
  if (!search) return null;
  try {
    return normalizeIfAvailable(new URLSearchParams(search).get('lang'), availableLocales);
  } catch {
    return null;
  }
}

/** Normalize a candidate, keeping it only when the pair offers that locale. */
function normalizeIfAvailable(candidate, availableLocales) {
  const normalized = normalizeLocale(candidate);
  return normalized && availableLocales.includes(normalized) ? normalized : null;
}

/*
 * STORAGE ACCESS IS LAZY AND GUARDED (same pattern as src/firstRunExperience.js):
 * the `globalThis.localStorage` getter itself can throw SecurityError in Safari
 * private mode or under enterprise policies, so it is only touched inside a
 * try/catch at the moment of use — never in a default parameter. An injected
 * `storage` (tests, embedders) short-circuits the global entirely; `undefined`
 * means "use the global".
 */

/** Read the stored preference, treating every failure as "nothing stored".
 * A stored locale outside the current pair reads as absent. */
function readStoredLocale(storage, availableLocales) {
  try {
    const store = storage !== undefined ? storage : globalThis.localStorage;
    return normalizeIfAvailable(store?.getItem?.(LOCALE_STORAGE_KEY), availableLocales);
  } catch {
    return null;
  }
}

/**
 * Write the stored preference, best-effort. Never throws. The stored value is
 * any shipped catalog locale (pair membership is re-checked at resolution
 * time, so a choice made under one configuration degrades gracefully when the
 * pair changes).
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
 *   ?lang=<locale> → stored preference → navigator.languages → configured default
 *
 * Every step only accepts locales in the configured pair (which always
 * includes English); each step that yields nothing (absent or out-of-pair)
 * defers to the next. Without env configuration the pair is en+es and the
 * configured default is English, byte-identical to the pre-configuration
 * resolution chain.
 * @param {object} [input]
 * @param {{search?: string, href?: string}|null} [input.location] Location to read ?lang= from.
 * @param {object|null} [input.storage] Injected localStorage-like store; `undefined` uses the global.
 * @param {readonly string[]|null} [input.languages] Browser language list.
 * @param {{defaultLocale?: string, secondaryLocale?: string}} [input.config] Injectable pair (tests/embedders); omit to read the client defines.
 * @returns {string}
 */
export function resolveLocale({
  location = globalThis.location,
  storage,
  languages = globalThis.navigator?.languages,
  config,
} = {}) {
  const { availableLocales: offered, defaultLocale } = resolveLocalePair(config);
  const override = queryLocaleOverride(location, offered);
  if (override) return override;
  const stored = readStoredLocale(storage, offered);
  if (stored) return stored;
  if (Array.isArray(languages)) {
    for (const candidate of languages) {
      const normalized = normalizeIfAvailable(candidate, offered);
      if (normalized) return normalized;
    }
  }
  return defaultLocale;
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
