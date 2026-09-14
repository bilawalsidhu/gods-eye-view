// God's Eye View i18n core (phase 1): catalog registry, translation, and
// Intl-based formatting. English is the source/fallback catalog; a missing key
// in another locale falls back to English with a development-only warning.
// Every shipped catalog (es, fr, ru, uk) is built UNCONDITIONALLY — the build
// cost is trivial and the registry stays declarative — but only locales in the
// configured pair are offered/accepted (see locale.js resolveLocalePair).
//
// APPEND-ONLY NAMESPACE REGISTRATION
// ─────────────────────────────────────────────────────────────────────────────
// A worker adding a namespace creates locales/<locale>/<ns>.js (exporting
// NAMESPACE plus a default message map of namespace-relative keys), then
// appends ONE import line per locale and pushes the module into that locale's
// array below. Nothing else changes, so concurrent workers merge trivially.
// Namespace-relative keys are prefixed at registration time: shell.*,
// cockpit.*, layers.*, setup.*.
import { DEFAULT_LOCALE, normalizeLocale, writeStoredLocale } from './locale.js';

import * as enShell from './locales/en/shell.js';
import * as enCockpit from './locales/en/cockpit.js';
import * as enLayers from './locales/en/layers.js';
import * as enSetup from './locales/en/setup.js';
import * as esShell from './locales/es/shell.js';
import * as esCockpit from './locales/es/cockpit.js';
import * as esLayers from './locales/es/layers.js';
import * as esSetup from './locales/es/setup.js';
import * as frShell from './locales/fr/shell.js';
import * as frCockpit from './locales/fr/cockpit.js';
import * as frLayers from './locales/fr/layers.js';
import * as frSetup from './locales/fr/setup.js';
import * as ruShell from './locales/ru/shell.js';
import * as ruCockpit from './locales/ru/cockpit.js';
import * as ruLayers from './locales/ru/layers.js';
import * as ruSetup from './locales/ru/setup.js';
import * as ukShell from './locales/uk/shell.js';
import * as ukCockpit from './locales/uk/cockpit.js';
import * as ukLayers from './locales/uk/layers.js';
import * as ukSetup from './locales/uk/setup.js';

// Append new namespace modules here (one import + one entry per locale).
const EN_NAMESPACES = [enShell, enCockpit, enLayers, enSetup];
const ES_NAMESPACES = [esShell, esCockpit, esLayers, esSetup];
const FR_NAMESPACES = [frShell, frCockpit, frLayers, frSetup];
const RU_NAMESPACES = [ruShell, ruCockpit, ruLayers, ruSetup];
const UK_NAMESPACES = [ukShell, ukCockpit, ukLayers, ukSetup];

/**
 * Prefix one namespace module's flat, namespace-relative keys with its
 * declared namespace: { 'title.subtitle': … } + NAMESPACE 'shell' becomes
 * 'shell.title.subtitle'.
 * @param {{NAMESPACE: string, default?: object}} namespaceModule
 * @returns {Record<string, string|object>} Frozen prefixed message map.
 */
export function mergeNamespace(namespaceModule) {
  const prefix = typeof namespaceModule?.NAMESPACE === 'string'
    ? namespaceModule.NAMESPACE.trim()
    : '';
  if (!/^[a-z][a-z0-9-]*$/.test(prefix)) {
    throw new Error(`i18n namespace module must export a lowercase NAMESPACE, got ${JSON.stringify(prefix)}`);
  }
  const merged = {};
  for (const [key, value] of Object.entries(namespaceModule.default || {})) {
    merged[`${prefix}.${key}`] = value;
  }
  return Object.freeze(merged);
}

/** Merge namespaces into one catalog, rejecting duplicate dot-prefixed keys. */
function buildCatalog(namespaceModules) {
  const catalog = {};
  for (const namespaceModule of namespaceModules) {
    for (const [key, value] of Object.entries(mergeNamespace(namespaceModule))) {
      if (Object.hasOwn(catalog, key)) {
        throw new Error(`i18n duplicate catalog key: ${key}`);
      }
      catalog[key] = value;
    }
  }
  return Object.freeze(catalog);
}

const CATALOGS = Object.freeze({
  [DEFAULT_LOCALE]: buildCatalog(EN_NAMESPACES),
  es: buildCatalog(ES_NAMESPACES),
  fr: buildCatalog(FR_NAMESPACES),
  ru: buildCatalog(RU_NAMESPACES),
  uk: buildCatalog(UK_NAMESPACES),
});

/**
 * The merged catalog for a locale (frozen; for coverage/parity tests and
 * tooling — runtime lookups go through t()).
 * @param {string} locale
 * @returns {Record<string, string|object>|null}
 */
export function getCatalog(locale) {
  const normalized = normalizeLocale(locale);
  return (normalized && CATALOGS[normalized]) || null;
}

let currentLocale = DEFAULT_LOCALE;

/** Active locale (any catalog locale; pair-scoped by resolveLocale at boot). */
export function getLocale() {
  return currentLocale;
}

/**
 * Switch the active locale. Pure state change: call applyDocumentLanguage /
 * applyDocumentTranslations to reflect it in the DOM.
 * @returns {string} The locale actually applied (normalized).
 */
export function setLocale(locale) {
  const normalized = normalizeLocale(locale) || DEFAULT_LOCALE;
  if (normalized !== currentLocale) {
    currentLocale = normalized;
    formatterCache.clear();
  }
  return currentLocale;
}

/** Development-only missing-key warning. Off under node:test and prod builds. */
function warnMissingKey(key, detail) {
  // Vite replaces import.meta.env at build time; under node:test it is absent,
  // so warnings never fire in CI — only on the dev server.
  if (import.meta.env?.DEV !== true) return;
  console.warn(`[i18n] missing key "${key}"${detail ? ` (${detail})` : ''}`);
}

/**
 * Pure lookup shared by t() and the parity tests: the requested locale first,
 * then the English fallback catalog.
 * @param {Record<string, object>} catalogs Catalog map to read from.
 * @param {string} locale Locale to resolve within that map.
 * @param {string} key Dot-prefixed message key.
 * @returns {string|object|undefined} Raw entry, or undefined when nowhere.
 */
export function resolveMessage(catalogs, locale, key) {
  const source = catalogs || CATALOGS;
  const normalized = normalizeLocale(locale);
  if (normalized && source[normalized] && Object.hasOwn(source[normalized], key)) {
    return source[normalized][key];
  }
  const fallback = source[DEFAULT_LOCALE];
  return fallback && Object.hasOwn(fallback, key) ? fallback[key] : undefined;
}

/** Whether the key resolves in the active locale or the English fallback. */
export function hasMessage(key) {
  return resolveMessage(CATALOGS, currentLocale, key) !== undefined;
}

const pluralRulesCache = new Map();

function pluralRulesFor(locale) {
  let rules = pluralRulesCache.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
  }
  return rules;
}

/** Select a { one, other } variant via Intl.PluralRules for the active locale. */
function selectPluralPattern(entry, values, key) {
  const count = values?.count;
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    warnMissingKey(key, 'plural entry requires a finite {count} value');
    return entry.other ?? entry.one;
  }
  const category = pluralRulesFor(currentLocale).select(count);
  return entry[category] ?? entry.other;
}

const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/g;

/** Named {placeholder} interpolation. Unprovided names stay literal so a gap
 * stays visible during development instead of silently vanishing. */
function interpolate(pattern, values) {
  if (!values || typeof pattern !== 'string') return pattern;
  return pattern.replace(PLACEHOLDER_PATTERN, (literal, name) => (
    Object.hasOwn(values, name) ? String(values[name]) : literal
  ));
}

/**
 * Translate one dot-prefixed key in the active locale. Missing keys in a
 * non-English locale fall back to English; keys missing everywhere return the
 * key itself. Plural entries ({ one, other }) require a numeric `count` value.
 * @param {string} key e.g. 'layers.clear.toast.cleared'
 * @param {object} [values] Named interpolation values, e.g. { count: 3, detail: '…' }
 * @returns {string}
 */
export function t(key, values) {
  const entry = resolveMessage(CATALOGS, currentLocale, key);
  if (entry === undefined) {
    warnMissingKey(key, `not in ${currentLocale} or en catalog`);
    return key;
  }
  if (currentLocale !== DEFAULT_LOCALE && !Object.hasOwn(CATALOGS[currentLocale] || {}, key)) {
    warnMissingKey(key, `missing in ${currentLocale}, using en fallback`);
  }
  const pattern = typeof entry === 'string'
    ? entry
    : selectPluralPattern(entry, values, key);
  return interpolate(pattern, values);
}

/*
 * Intl formatters are memoized per (kind, locale, options): the constructors
 * are expensive and stage-3 extraction will format numbers and dates on panel
 * refresh paths. The cache is cleared whenever the active locale changes.
 */
const formatterCache = new Map();

function cachedFormatter(kind, Constructor, options) {
  const cacheKey = `${kind}|${currentLocale}|${options ? JSON.stringify(options) : ''}`;
  let formatter = formatterCache.get(cacheKey);
  if (!formatter) {
    formatter = new Constructor(currentLocale, options);
    formatterCache.set(cacheKey, formatter);
  }
  return formatter;
}

/** Locale-aware number formatting (Intl.NumberFormat). */
export function formatNumber(value, options) {
  return cachedFormatter('number', Intl.NumberFormat, options).format(value);
}

/** Locale-aware date/time formatting (Intl.DateTimeFormat). */
export function formatDate(value, options) {
  return cachedFormatter('date', Intl.DateTimeFormat, options).format(value);
}

/**
 * Locale-aware relative time (Intl.RelativeTimeFormat). `value` is the signed
 * distance in `unit`, e.g. formatRelativeTime(-5, 'minute') →
 * '5 minutes ago' (en) / 'hace 5 minutos' (es).
 * @param {number} value Signed distance in `unit`.
 * @param {string} [unit] Intl unit ('second', 'minute', 'hour', 'day', …).
 * @param {object} [options] Intl.RelativeTimeFormat options (numeric, style).
 */
export function formatRelativeTime(value, unit = 'second', options) {
  return cachedFormatter('relative', Intl.RelativeTimeFormat, { numeric: 'auto', ...options })
    .format(value, unit);
}

/** DOM write targets for applyDocumentTranslations: textContent plus the
 * three presentation attributes vision.md requires to agree with visible
 * labels. Never innerHTML — translation functions return text. */
const DOCUMENT_TRANSLATION_TARGETS = Object.freeze([
  Object.freeze({
    attribute: 'data-i18n',
    apply(element, text) { element.textContent = text; },
  }),
  Object.freeze({
    attribute: 'data-i18n-title',
    apply(element, text) { element.setAttribute('title', text); },
  }),
  Object.freeze({
    attribute: 'data-i18n-aria-label',
    apply(element, text) { element.setAttribute('aria-label', text); },
  }),
  Object.freeze({
    attribute: 'data-i18n-placeholder',
    apply(element, text) { element.setAttribute('placeholder', text); },
  }),
]);

/**
 * Apply catalog text to every element carrying an i18n attribute in `doc`.
 * Elements whose key resolves nowhere are left untouched (warned in dev).
 * @param {Document} doc
 * @returns {number} Count of element/attribute writes performed.
 */
export function applyDocumentTranslations(doc) {
  if (typeof doc?.querySelectorAll !== 'function') return 0;
  let applied = 0;
  for (const target of DOCUMENT_TRANSLATION_TARGETS) {
    for (const element of doc.querySelectorAll(`[${target.attribute}]`)) {
      const key = element.getAttribute?.(target.attribute);
      if (!key) continue;
      if (!hasMessage(key)) {
        warnMissingKey(key, `attribute ${target.attribute}`);
        continue;
      }
      target.apply(element, t(key));
      applied += 1;
    }
  }
  return applied;
}

/**
 * Persist a locale choice, then reload preserving window.location.hash exactly
 * and stripping ?lang from the search string — the override is one-shot and
 * must never graduate into the stored URL. Storage is best-effort: where
 * storage is blocked (private mode) the preference simply will not survive.
 * @param {string} locale Locale the user chose (normalized here).
 * @param {object} [deps]
 * @param {{href: string, assign: Function}} [deps.location]
 * @param {object} [deps.storage] Injected localStorage-like store.
 * @returns {boolean} true when a reload was triggered.
 */
export function persistLocaleAndReload(locale, {
  location = globalThis.location,
  history = globalThis.history,
  storage,
} = {}) {
  const normalized = normalizeLocale(locale) || DEFAULT_LOCALE;
  writeStoredLocale(normalized, storage);
  if (!location || typeof location.assign !== 'function') return false;
  const stripLang = () => {
    try {
      const url = new URL(location.href);
      url.searchParams.delete('lang');
      return url.href;
    } catch {
      return location.href;
    }
  };
  // location.assign() to the byte-identical URL performs NO navigation in
  // real browsers (the common case: no ?lang present, hash unchanged), so a
  // stored locale change would never reload. Strip ?lang via replaceState
  // (no extra history entry) and force a real reload instead.
  const target = stripLang();
  try {
    history?.replaceState?.(null, '', target);
  } catch {
    // replaceState is best-effort; the reload below still applies.
  }
  if (typeof location.reload === 'function') {
    location.reload();
  } else {
    location.assign(target);
  }
  return true;
}
