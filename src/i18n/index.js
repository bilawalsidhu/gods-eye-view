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
  intlLocale,
  isRtlLocale,
  normalizeLocale,
  writeStoredLocale,
} from './locale.js';
import ar from './locales/ar.json' with { type: 'json' };
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
  ar,
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

// The page's locale. The UI binds it to its vue-i18n instance's
// (src/ui/i18n.js), so a Vue render that translates re-renders when it
// changes; until then, and in portable code, it is plain state.
let pageLocale = { value: DEFAULT_LOCALE };

/**
 * Keep the active locale in `locale`, a ref such as a vue-i18n composer's
 * `locale`. It takes the current locale; switch with setLocale afterwards.
 * @param {{value: string}} locale
 */
export function bindLocale(locale) {
  locale.value = pageLocale.value;
  pageLocale = locale;
  bound = true;
}

let bound = false;
const localeListeners = new Set();

/**
 * Call `listener` after the active locale changes, so code that shows text it
 * translated itself (a status line, a count, a time) shows it again. Text a
 * Vue view translates while rendering follows the locale without this.
 * @param {() => void} listener
 * @returns {() => void} Stops listening.
 */
export function onLocaleChange(listener) {
  if (typeof listener !== 'function') return () => {};
  localeListeners.add(listener);
  return () => localeListeners.delete(listener);
}

/**
 * Tell the listeners the locale changed. setLocale does this for an unbound
 * locale; the owner of a bound ref calls it when the ref changes.
 */
export function notifyLocaleChange() {
  for (const listener of [...localeListeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[i18n] locale listener failed', error);
    }
  }
}

/** The catalog for a locale; null for English and unknown codes. */
export function getCatalog(locale) {
  return CATALOGS[normalizeLocale(locale)] ?? null;
}

let boundValue = DEFAULT_LOCALE;
let activeLocale = DEFAULT_LOCALE;

/** Active locale, normalized: a bound ref may be set to any language tag. */
export function getLocale() {
  const value = pageLocale.value;
  if (value !== boundValue) {
    boundValue = value;
    activeLocale = normalizeLocale(value) || DEFAULT_LOCALE;
  }
  return activeLocale;
}

/**
 * A value inserted into right-to-left text as one unit: `30 م` next to
 * `Sentinel-2` would otherwise lend its digits to the Latin run and leave the
 * unit stranded. First-strong isolates (U+2068…U+2069) in RTL locales only.
 */
export function isolate(text) {
  return isRtlLocale(getLocale()) ? `\u2068${text}\u2069` : String(text);
}

const CODE_BEFORE_VALUE =
  /(?<![\p{L}\p{N}])([A-Z][A-Z0-9/]+) (\u2068[^\u2068\u2069]*\u2069)/gu;

/**
 * A Latin code and the isolated value after it ("HDG 68\u00b0") as one unit in
 * right-to-left text. Two codes in a row (HDG 68\u00b0 \u00b7 FOV 44\u00b0) otherwise form a
 * single left-to-right run and the second code ends up beside the first
 * value. Applies to t() output; a no-op outside RTL locales.
 */
export function keepCodesWithValues(text) {
  if (!isRtlLocale(getLocale())) return text;
  return String(text).replace(CODE_BEFORE_VALUE, '\u2068$1 $2\u2069');
}

/**
 * Switch the active locale. Views re-render and onLocaleChange listeners
 * word their text again; the application keeps <html lang>/<html dir> and
 * the page's data-i18n markup in step.
 * @returns {string} The locale actually applied (normalized).
 */
export function setLocale(locale) {
  const normalized = normalizeLocale(locale) || DEFAULT_LOCALE;
  if (normalized !== pageLocale.value) {
    pageLocale.value = normalized;
    formatterCache.clear();
    if (!bound) notifyLocaleChange();
  }
  return normalized;
}

/** Development-only warning; silent under node:test and in production. */
function warnMissing(text) {
  if (import.meta.env?.DEV !== true) return;
  console.warn(
    `[i18n] no ${getLocale()} translation for ${JSON.stringify(text)}`,
  );
}

const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/g;

/** Named {placeholder} interpolation. Unknown names stay literal so a gap
 * stays visible instead of silently vanishing. */
function interpolate(pattern, values) {
  if (!values) return pattern;
  // In a right-to-left page each value is isolated: a time, a code or an
  // English name keeps its own order instead of mixing with the sentence.
  return pattern.replace(PLACEHOLDER_PATTERN, (literal, name) => {
    if (!Object.hasOwn(values, name)) return literal;
    const value = String(values[name]);
    return value === '' ? value : isolate(value);
  });
}

/** A catalog string with something to show; an empty one counts as missing. */
const filled = (value) => typeof value === 'string' && value.trim() !== '';

function lookup(text) {
  const catalog = CATALOGS[getLocale()];
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
  const category = pluralRules(getLocale()).select(count);
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
  const catalog = CATALOGS[getLocale()];
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
  const cacheKey = `${kind}|${getLocale()}|${options ? JSON.stringify(options) : ''}`;
  let formatter = formatterCache.get(cacheKey);
  if (!formatter) {
    formatter = new Constructor(intlLocale(getLocale()), options);
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
  if (getLocale() === 'en') return new Date(time).toISOString().slice(5, 10);
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
  return getLocale() === 'ja'
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

// Per element, the English source a pass read and the text it wrote, so a
// later pass in another locale, English included, starts from the source
// rather than from that text. Text that code wrote since is the new source.
const documentSources = new WeakMap();

/**
 * Translate every opted-in element in `doc` into the active locale. Runs at
 * boot and again after every locale change (the page's own markup, such as
 * a host's, is not rendered by a view).
 * @param {Document|Element} doc
 * @returns {number} Count of element/attribute writes performed.
 */
export function applyDocumentTranslations(doc) {
  if (typeof doc?.querySelectorAll !== 'function') return 0;
  let applied = 0;
  for (const [marker, attribute] of DOCUMENT_TRANSLATION_TARGETS) {
    for (const element of doc.querySelectorAll(`[${marker}]`)) {
      const read = () =>
        attribute
          ? element.getAttribute(attribute)
          : normalizeMarkupText(element.textContent);
      let sources = documentSources.get(element);
      if (!sources) documentSources.set(element, (sources = {}));
      const shown = read();
      const known = sources[marker];
      const source = known && shown === known.written ? known.source : shown;
      sources[marker] = { source, written: shown };
      if (!source) continue;
      const context = attribute
        ? null
        : element.getAttribute?.('data-i18n-context');
      const text = context ? t(source, { context }) : t(source);
      if (text === shown) continue;
      if (attribute) element.setAttribute(attribute, text);
      else element.textContent = text;
      sources[marker].written = read();
      applied += 1;
    }
  }
  return applied;
}

/**
 * Store a locale choice for the next visit and keep the address in step
 * without reloading: ?lang is dropped once the choice is stored, or carries
 * the choice where storage is blocked (share links drop it:
 * ShareLinkManager.copyLink). The hash is kept exactly. setLocale applies
 * the choice to the page.
 * @returns {string} The normalized locale.
 */
export function persistLocale(
  locale,
  {
    location = globalThis.location,
    history = globalThis.history,
    storage,
  } = {},
) {
  const normalized = normalizeLocale(locale) || DEFAULT_LOCALE;
  const stored = writeStoredLocale(normalized, storage);
  try {
    const url = new URL(location.href);
    if (stored) url.searchParams.delete('lang');
    else url.searchParams.set('lang', normalized);
    if (url.href !== location.href) history?.replaceState?.(null, '', url.href);
  } catch {
    // Without a location or history the stored choice still applies.
  }
  return normalized;
}
