/**
 * Interface language picker: a HUD button in the bottom-right corner that
 * opens a listbox of the shipped languages.
 *
 * The logic is pure and DOM-free; the LocalePicker view renders it. The
 * shell decides what a choice does (confirm, reload).
 *
 * The list follows the ARIA listbox pattern: the button opens it, focus moves
 * into the list (or into the search field, which is a combobox, once there are
 * more than LOCALE_SEARCH_THRESHOLD languages), and aria-activedescendant
 * marks the active option.
 */

import { t } from '../i18n/index.js';
import { LOCALES, LOCALE_NAMES } from '../i18n/locale.js';

/** Above this many languages the list gets a search field. */
export const LOCALE_SEARCH_THRESHOLD = 8;

/** Type-ahead keystrokes closer together than this extend one prefix. */
export const TYPEAHEAD_RESET_MS = 500;

const CHINESE_LABELS = {
  'zh-CN': 'Chinese (Simplified)',
  'zh-Hant': 'Chinese (Traditional)',
};

/**
 * Text folded for search: no diacritics, lower case. 'Español' → 'espanol',
 * 'Ёжик' → 'ежик'.
 * @param {unknown} text
 * @returns {string}
 */
export function foldSearchText(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * A reader of language names in the interface language, via Intl.DisplayNames.
 * Returns '' for anything it cannot name (no Intl support, unknown code).
 * @param {string} locale Interface language.
 * @param {typeof Intl.DisplayNames} [DisplayNames]
 * @returns {(code: string) => string}
 */
export function createLocalNameReader(
  locale,
  DisplayNames = globalThis.Intl?.DisplayNames,
) {
  let names = null;
  try {
    names = new DisplayNames([locale], { type: 'language', fallback: 'none' });
  } catch {
    return () => '';
  }
  return (code) => {
    try {
      const name = names.of(code);
      return typeof name === 'string' && name !== code ? name : '';
    } catch {
      return '';
    }
  };
}

/**
 * The rows of the list: the current language first, then the rest in
 * alphabetical order of their own-language names (collated for the
 * interface language). `localName` is the name in the interface language,
 * left empty when it only repeats `nativeName`.
 * @param {object} input
 * @param {readonly string[]} input.locales
 * @param {string} input.current
 * @param {Record<string, string>} input.nativeNames
 * @param {(code: string) => string} [input.localName]
 * @returns {Array<{code: string, nativeName: string, localName: string, selected: boolean}>}
 */
export function buildLocaleOptions({
  locales,
  current,
  nativeNames,
  localName = () => '',
}) {
  const rows = locales.map((code) => {
    const nativeName = nativeNames[code] || code;
    const translated = localName(code) || '';
    return {
      code,
      nativeName,
      localName:
        foldSearchText(translated) === foldSearchText(nativeName)
          ? ''
          : translated,
      selected: code === current,
    };
  });
  let collate;
  try {
    collate = new Intl.Collator(current).compare;
  } catch {
    collate = (a, b) => a.localeCompare(b);
  }
  const others = rows
    .filter((row) => !row.selected)
    .sort((a, b) => collate(a.nativeName, b.nativeName));
  return [...rows.filter((row) => row.selected), ...others];
}

/**
 * Rows matching a search: by own-language name, interface-language name or
 * code, ignoring case and diacritics. An empty query keeps every row.
 * @template {{code: string, nativeName: string, localName: string}} Row
 * @param {Row[]} options
 * @param {string} query
 * @returns {Row[]}
 */
export function filterLocaleOptions(options, query) {
  const needle = foldSearchText(query);
  if (!needle) return options.slice();
  return options.filter((option) =>
    [option.nativeName, option.localName, option.code].some((value) =>
      foldSearchText(value).includes(needle),
    ),
  );
}

/**
 * The option a navigation key moves to; null for any other key. The list
 * does not wrap, as in the ARIA listbox pattern.
 * @param {string} key
 * @param {number} index Active option, -1 for none.
 * @param {number} count
 * @returns {number|null}
 */
export function moveActiveIndex(key, index, count) {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return index < 0 ? 0 : Math.min(index + 1, count - 1);
    case 'ArrowUp':
      return index < 0 ? count - 1 : Math.max(index - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * Type-ahead: the next option after `fromIndex` (wrapping) whose own-language
 * or interface-language name starts with `buffer`. A buffer of one repeated
 * letter cycles through the options starting with that letter.
 * @param {Array<{nativeName: string, localName: string}>} options
 * @param {string} buffer
 * @param {number} fromIndex
 * @returns {number} -1 when nothing matches.
 */
export function typeaheadIndex(options, buffer, fromIndex) {
  const folded = foldSearchText(buffer);
  if (!folded || !options.length) return -1;
  const repeated = [...folded].every((char) => char === folded[0]);
  const prefix = repeated ? folded[0] : folded;
  // A longer prefix keeps refining the current option; a single letter moves on.
  const start = repeated ? fromIndex + 1 : Math.max(fromIndex, 0);
  for (let step = 0; step < options.length; step++) {
    const index = (start + step) % options.length;
    const option = options[index];
    if (
      foldSearchText(option.nativeName).startsWith(prefix) ||
      foldSearchText(option.localName).startsWith(prefix)
    )
      return index;
  }
  return -1;
}

/**
 * What choosing a language does: the current one changes nothing, another
 * one switches.
 * @param {string} locale
 * @param {{current: string, switchLocale: (locale: string) => void}} actions
 * @returns {'unchanged'|'switched'}
 */
export function applyLocaleChoice(locale, { current, switchLocale }) {
  if (locale === current) return 'unchanged';
  switchLocale(locale);
  return 'switched';
}

/**
 * The picker's state without a DOM: open/closed, query, visible rows, active
 * row and type-ahead. `keydown` answers what a key did so the DOM layer only
 * has to render and focus.
 * @param {object} input
 * @param {readonly string[]} [input.locales]
 * @param {string} input.current
 * @param {Record<string, string>} [input.nativeNames]
 * @param {(code: string) => string} [input.localName]
 * @param {number} [input.searchThreshold]
 * @param {() => number} [input.now]
 */
export function createLocalePickerModel({
  locales = LOCALES,
  current,
  nativeNames = LOCALE_NAMES,
  localName = () => '',
  searchThreshold = LOCALE_SEARCH_THRESHOLD,
  now = () => Date.now(),
}) {
  const options = buildLocaleOptions({
    locales,
    current,
    nativeNames,
    localName,
  });
  const searchable = locales.length > searchThreshold;
  let open = false;
  let query = '';
  let visible = options;
  let active = -1;
  let typed = '';
  let typedAt = -Infinity;

  const activateSelected = () => {
    const selected = visible.findIndex((option) => option.selected);
    active = visible.length ? Math.max(selected, 0) : -1;
  };

  return {
    current,
    options,
    searchable,
    get open() {
      return open;
    },
    get query() {
      return query;
    },
    get visible() {
      return visible;
    },
    get activeIndex() {
      return active;
    },
    get activeOption() {
      return visible[active] || null;
    },
    openList() {
      open = true;
      query = '';
      visible = options;
      typed = '';
      activateSelected();
    },
    closeList() {
      open = false;
      typed = '';
    },
    setQuery(text) {
      query = String(text ?? '');
      visible = filterLocaleOptions(options, query);
      // The current language stays active while it matches; else the first.
      activateSelected();
    },
    setActive(index) {
      if (index >= 0 && index < visible.length) active = index;
    },
    /**
     * @param {{key: string, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean}} event
     * @returns {{handled: boolean, close?: boolean, choose?: string}}
     */
    keydown({ key, altKey = false, ctrlKey = false, metaKey = false }) {
      if (!open) return { handled: false };
      if (key === 'Escape') return { handled: true, close: true };
      if (key === 'Enter' || (key === ' ' && !searchable)) {
        const option = visible[active];
        return option
          ? { handled: true, choose: option.code }
          : { handled: true };
      }
      // In the search field Home/End move the caret, as in the APG combobox.
      if (searchable && (key === 'Home' || key === 'End'))
        return { handled: false };
      const moved = moveActiveIndex(key, active, visible.length);
      if (moved !== null) {
        active = moved;
        return { handled: true };
      }
      const printable =
        key.length === 1 && key !== ' ' && !altKey && !ctrlKey && !metaKey;
      // With a search field, letters are typed into it.
      if (!printable || searchable) return { handled: false };
      const time = now();
      typed = time - typedAt > TYPEAHEAD_RESET_MS ? key : typed + key;
      typedAt = time;
      const match = typeaheadIndex(visible, typed, active);
      if (match >= 0) active = match;
      return { handled: true };
    },
  };
}

/* ── Presentation ──────────────────────────────────────────────────────── */

/** Thin-line globe, check mark and caret, drawn in currentColor. */
export const LOCALE_PICKER_ICONS = Object.freeze({
  globe: {
    stroke: [
      'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18Z',
      'M12 3c-2.6 2.5-3.9 5.5-3.9 9s1.3 6.5 3.9 9',
      'M12 3c2.6 2.5 3.9 5.5 3.9 9s-1.3 6.5-3.9 9',
      'M3 12h18',
      'M4.3 7.5h15.4',
      'M4.3 16.5h15.4',
    ],
  },
  check: { stroke: ['M5 12.5l4.3 4.3L19 7'] },
  caret: { fill: ['M7 10h10l-5 5.5Z'] },
});

/**
 * The code shown beside a language's name. Chinese variants are named by
 * script rather than region, in English.
 * @param {string} code
 * @returns {{text: string, lang: string|undefined}}
 */
export function localeOptionCode(code) {
  return CHINESE_LABELS[code]
    ? { text: CHINESE_LABELS[code], lang: 'en' }
    : { text: code.toUpperCase(), lang: undefined };
}
