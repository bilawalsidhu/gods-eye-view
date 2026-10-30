// God's Eye View i18n: the English source text is the message key.
//
//   t('Save keys')                                   → 'Сохранить ключи'
//   t('Cleared {name}', { name })                    → named interpolation
//   tn(count, '{count} camera', '{count} cameras')   → plural by Intl.PluralRules
//   t('CLEAR', { context: 'action' })                → same English, own entry
//   msg('Live Flights')                              → marks a string kept in data
//                                                      for a later t(); returns it as is
//
// English needs no catalog. Every other locale is one flat JSON file,
// locales/<code>.json, keyed by the English text (for tn, by the English
// plural form). A missing or empty entry falls back to English.
// `npm run i18n` keeps the catalogs in step with the code. Guide: docs/I18N.md.
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  writeStoredLocale,
} from './locale.js';
import de from './locales/de.json' with { type: 'json' };
import es from './locales/es.json' with { type: 'json' };
import fr from './locales/fr.json' with { type: 'json' };
import it from './locales/it.json' with { type: 'json' };
import ja from './locales/ja.json' with { type: 'json' };
import pt from './locales/pt.json' with { type: 'json' };
import ru from './locales/ru.json' with { type: 'json' };
import uk from './locales/uk.json' with { type: 'json' };
import zhCN from './locales/zh-CN.json' with { type: 'json' };
import zhHant from './locales/zh-Hant.json' with { type: 'json' };

const CATALOGS = Object.freeze({
  de,
  es,
  fr,
  it,
  ja,
  pt,
  ru,
  uk,
  'zh-CN': zhCN,
  'zh-Hant': zhHant,
});

let currentLocale = DEFAULT_LOCALE;

/** The catalog for a locale; null for English and unknown codes. */
export function getCatalog(locale) {
  return CATALOGS[normalizeLocale(locale)] ?? null;
}

/** Active locale. */
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

/** Development-only warning; silent under node:test and in production. */
function warnMissing(text) {
  if (import.meta.env?.DEV !== true) return;
  console.warn(
    `[i18n] no ${currentLocale} translation for ${JSON.stringify(text)}`,
  );
}

const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/g;

/** Named {placeholder} interpolation. Unknown names stay literal so a gap
 * stays visible instead of silently vanishing. */
function interpolate(pattern, values) {
  if (!values) return pattern;
  return pattern.replace(PLACEHOLDER_PATTERN, (literal, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : literal,
  );
}

/** A catalog string with something to show; an empty one counts as missing. */
const filled = (value) => typeof value === 'string' && value.trim() !== '';

function lookup(text) {
  const catalog = CATALOGS[currentLocale];
  if (!catalog) return undefined;
  const entry = Object.hasOwn(catalog, text) ? catalog[text] : undefined;
  if (filled(entry) || (entry && typeof entry === 'object')) return entry;
  warnMissing(text);
  return undefined;
}

/**
 * Translate English source text into the active locale.
 * @param {string} text English text, e.g. 'Hold Space to talk'
 * @param {object} [values] Named interpolation values. `context` tells
 *   apart identical English with different meanings: t('CLEAR', { context:
 *   'action' }) is the catalog entry "action|CLEAR"; English is unchanged.
 * @returns {string}
 */
export function t(text, values) {
  const entry = lookup(values?.context ? `${values.context}|${text}` : text);
  return interpolate(typeof entry === 'string' ? entry : text, values);
}

/**
 * Translate a count-dependent message. The catalog entry for `other` holds
 * one form per Intl.PluralRules category of the locale ({ one, few, many, other }
 * for Russian). `{count}` is always available to the pattern: the raw number,
 * unless `values.count` gives its display text, e.g. `formatNumber(n)`.
 * @param {number} count
 * @param {string} one English singular, e.g. '{count} camera'
 * @param {string} other English plural, e.g. '{count} cameras'
 * @param {object} [values] Extra interpolation values; a `count` here is
 *   shown in place of the number (the plural form still follows `count`)
 * @returns {string}
 */
export function tn(count, one, other, values) {
  const entry = lookup(other);
  const category = pluralRules(currentLocale).select(count);
  let pattern;
  const forms = entry && typeof entry === 'object' ? entry : null;
  if (forms && (filled(forms[category]) || filled(forms.other))) {
    pattern = filled(forms[category]) ? forms[category] : forms.other;
  } else {
    pattern = pluralRules(DEFAULT_LOCALE).select(count) === 'one' ? one : other;
  }
  return interpolate(pattern, { count, ...values });
}

/**
 * Translate text that may be ours or may come from a provider: a catalog
 * entry is used when there is one, anything else shows as given, without a
 * missing-translation warning.
 */
export function translateKnown(text) {
  const catalog = CATALOGS[currentLocale];
  if (!catalog || typeof text !== 'string') return text;
  const entry = Object.hasOwn(catalog, text) ? catalog[text] : undefined;
  return filled(entry) ? entry : text;
}

/** Mark English text that is stored in data and translated later by t(). */
export function msg(text) {
  return text;
}

const pluralRulesCache = new Map();

function pluralRules(locale) {
  let rules = pluralRulesCache.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
  }
  return rules;
}

/*
 * Intl formatters are memoized per (kind, locale, options): the constructors
 * are expensive and panels format on refresh paths. The cache is cleared
 * whenever the active locale changes.
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

const UTC_DAY_MONTH = Object.freeze({
  day: '2-digit',
  month: '2-digit',
  timeZone: 'UTC',
});

/**
 * The UTC day and month of a time, for "MM-DD HH:MM UTC" readouts: "10-13" in
 * English, "13.10" in Russian, "13/10" in Spanish, never read as a
 * range. Takes an ISO string (its date part is used as written) or a time.
 * @param {string|number|Date} value
 * @returns {string} '' when the value is not a time.
 */
export function formatUtcDayMonth(value) {
  const written =
    typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  const time = written
    ? Date.UTC(Number(written[1]), Number(written[2]) - 1, Number(written[3]))
    : new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  if (currentLocale === 'en') return new Date(time).toISOString().slice(5, 10);
  return cachedFormatter('date', Intl.DateTimeFormat, UTC_DAY_MONTH).format(
    time,
  );
}

/**
 * Locale-aware relative time (Intl.RelativeTimeFormat), e.g.
 * formatRelativeTime(-5, 'minute') → '5 minutes ago' / '5 минут назад' /
 * '5分前'.
 */
export function formatRelativeTime(value, unit = 'second', options) {
  const text = cachedFormatter('relative', Intl.RelativeTimeFormat, {
    numeric: 'auto',
    ...options,
  }).format(value, unit);
  // CLDR spaces Japanese (5 分前); the ja catalog writes the number and its
  // unit together (5分前), so the two must not differ on one screen.
  return currentLocale === 'ja'
    ? text.replace(/(?<=\d) (?=\p{Script=Han})/gu, '')
    : text;
}

/** Collapse markup whitespace so a message reads the same in HTML and JS. */
function normalizeMarkupText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Markup opt-in: the element's own English text or attribute is the source.
 *   <span data-i18n>Normal</span>
 *   <button title="Pin" data-i18n-title>…</button>
 * Also data-i18n-aria-label and data-i18n-placeholder. data-i18n-context
 * gives the element's text a context, as t(text, { context }) does:
 *   <option data-i18n data-i18n-context="radio tag">All</option>
 */
const DOCUMENT_TRANSLATION_TARGETS = Object.freeze([
  ['data-i18n', null],
  ['data-i18n-title', 'title'],
  ['data-i18n-aria-label', 'aria-label'],
  ['data-i18n-placeholder', 'placeholder'],
]);

/**
 * Translate every opted-in element in `doc`. Runs once at boot; switching
 * locale reloads the page.
 * @param {Document|Element} doc
 * @returns {number} Count of element/attribute writes performed.
 */
export function applyDocumentTranslations(doc) {
  if (typeof doc?.querySelectorAll !== 'function') return 0;
  if (!CATALOGS[currentLocale]) return 0;
  let applied = 0;
  for (const [marker, attribute] of DOCUMENT_TRANSLATION_TARGETS) {
    for (const element of doc.querySelectorAll(`[${marker}]`)) {
      const source = attribute
        ? element.getAttribute(attribute)
        : normalizeMarkupText(element.textContent);
      if (!source) continue;
      const context = attribute
        ? null
        : element.getAttribute?.('data-i18n-context');
      const text = context ? t(source, { context }) : t(source);
      if (text === source) continue;
      if (attribute) element.setAttribute(attribute, text);
      else element.textContent = text;
      applied += 1;
    }
  }
  return applied;
}

const unsavedWorkChecks = new Set();

/**
 * Name work that switching language would lose: the switch reloads the page,
 * and the language switch asks first while any check reports something.
 * @param {() => string|null|undefined} check Returns a msg() label (e.g.
 *   msg('unsaved CCTV calibration')) while there is such work, else nothing.
 * @returns {() => void} Removes the check.
 */
export function registerUnsavedWork(check) {
  if (typeof check !== 'function') return () => {};
  unsavedWorkChecks.add(check);
  return () => unsavedWorkChecks.delete(check);
}

/**
 * What a reload would lose right now, translated, without repeats.
 * @returns {string[]}
 */
export function describeUnsavedWork() {
  const labels = new Set();
  for (const check of unsavedWorkChecks) {
    try {
      const label = check();
      if (typeof label === 'string' && label) labels.add(t(label));
    } catch {
      // A failing check must not block the switch.
    }
  }
  return [...labels];
}

/**
 * Persist a locale choice, then reload preserving window.location.hash exactly
 * and stripping ?lang from the search string, so the stored choice applies.
 * Where storage is blocked, ?lang carries the choice instead (share links
 * drop it: ShareLinkManager.copyLink).
 * @returns {boolean} true when a reload was triggered.
 */
export function persistLocaleAndReload(
  locale,
  {
    location = globalThis.location,
    history = globalThis.history,
    storage,
  } = {},
) {
  const normalized = normalizeLocale(locale) || DEFAULT_LOCALE;
  const stored = writeStoredLocale(normalized, storage);
  if (!location || typeof location.assign !== 'function') return false;
  let target = location.href;
  try {
    // Without storage the choice only survives in the URL, so keep it there.
    const url = new URL(location.href);
    if (stored) url.searchParams.delete('lang');
    else url.searchParams.set('lang', normalized);
    target = url.href;
  } catch {
    // Keep the current href.
  }
  // location.assign() to the identical URL does not navigate, so strip ?lang
  // in place and force a real reload instead.
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
