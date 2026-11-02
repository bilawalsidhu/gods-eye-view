/**
 * Interface language picker: a HUD button in the bottom-right corner that
 * opens a listbox of the shipped languages.
 *
 * The logic is pure and DOM-free; mountLocalePicker() only renders it. The
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
 * What choosing a language does. The current one changes nothing; another one
 * switches after `confirmSwitch()` agrees (it asks when a reload loses work).
 * @param {string} locale
 * @param {{current: string, confirmSwitch: () => boolean, switchLocale: (locale: string) => void}} actions
 * @returns {'unchanged'|'declined'|'switched'}
 */
export function applyLocaleChoice(
  locale,
  { current, confirmSwitch, switchLocale },
) {
  if (locale === current) return 'unchanged';
  if (!confirmSwitch()) return 'declined';
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

/* ── DOM ───────────────────────────────────────────────────────────────── */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Thin-line globe, check mark and caret, drawn in currentColor. */
const ICONS = Object.freeze({
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

function icon(documentRef, name, className) {
  const svg = documentRef.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', className);
  const { stroke = [], fill = [] } = ICONS[name];
  for (const d of stroke) {
    const path = documentRef.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.4');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }
  for (const d of fill) {
    const path = documentRef.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
  }
  return svg;
}

function element(documentRef, tag, className) {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  return node;
}

/**
 * Render the picker into `root` and wire it.
 * @param {object} input
 * @param {HTMLElement} input.root Empty #locale-picker container.
 * @param {string} input.current Active interface language.
 * @param {(locale: string) => void} input.onSelect Called after the list
 *   closes, for a language other than the current one.
 * @param {readonly string[]} [input.locales]
 * @param {Record<string, string>} [input.nativeNames]
 * @param {number} [input.searchThreshold]
 * @returns {{open: Function, close: Function, isOpen: () => boolean, destroy: Function}}
 */
export function mountLocalePicker({
  root,
  current,
  onSelect,
  locales = LOCALES,
  nativeNames = LOCALE_NAMES,
  searchThreshold = LOCALE_SEARCH_THRESHOLD,
}) {
  const documentRef = root.ownerDocument;
  const windowRef = documentRef.defaultView;
  const model = createLocalePickerModel({
    locales,
    current,
    nativeNames,
    localName: createLocalNameReader(current),
    searchThreshold,
  });
  const id = root.id || 'locale-picker';
  const ids = {
    popup: `${id}-popup`,
    heading: `${id}-heading`,
    listbox: `${id}-listbox`,
    option: (code) => `${id}-option-${code}`,
  };

  root.textContent = '';
  root.classList.add('locale-picker');

  const button = element(documentRef, 'button', 'locale-picker-button');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', ids.popup);
  button.setAttribute(
    'aria-label',
    t('Language: {language}', {
      language: nativeNames[current] || current,
    }),
  );
  button.title = t('Change the interface language');
  const code = element(documentRef, 'span', 'locale-picker-code');
  code.setAttribute('translate', 'no');
  code.setAttribute('aria-hidden', 'true');
  code.textContent = current.toUpperCase();
  button.append(
    icon(documentRef, 'globe', 'locale-picker-globe'),
    code,
    icon(documentRef, 'caret', 'locale-picker-caret'),
  );

  const popup = element(documentRef, 'div', 'locale-picker-popup');
  popup.id = ids.popup;
  popup.hidden = true;
  const heading = element(documentRef, 'div', 'locale-picker-heading');
  heading.id = ids.heading;
  heading.textContent = t('Interface language');
  popup.append(heading);

  const listbox = element(documentRef, 'ul', 'locale-picker-list');
  listbox.id = ids.listbox;
  listbox.setAttribute('role', 'listbox');
  listbox.setAttribute('aria-labelledby', ids.heading);
  listbox.tabIndex = -1;

  let search = null;
  if (model.searchable) {
    search = element(documentRef, 'input', 'locale-picker-search');
    search.type = 'search';
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.setAttribute('role', 'combobox');
    search.setAttribute('aria-autocomplete', 'list');
    search.setAttribute('aria-expanded', 'true');
    search.setAttribute('aria-controls', ids.listbox);
    search.setAttribute('aria-label', t('Search languages'));
    search.placeholder = t('Search languages');
    popup.append(search);
  }
  popup.append(listbox);
  const empty = element(documentRef, 'p', 'locale-picker-empty');
  empty.setAttribute('role', 'status');
  empty.textContent = t('No matching languages');
  empty.hidden = true;
  popup.append(empty);
  root.append(button, popup);

  const optionNodes = new Map();
  for (const option of model.options) {
    const item = element(documentRef, 'li', 'locale-picker-option');
    item.id = ids.option(option.code);
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(option.selected));
    item.lang = option.code;
    item.dataset.locale = option.code;
    const name = element(documentRef, 'span', 'locale-picker-native');
    name.textContent = option.nativeName;
    // Chinese variants are distinguished by script rather than region.
    const meta = element(documentRef, 'span', 'locale-picker-meta');
    const codeLabel = element(documentRef, 'span', 'locale-picker-option-code');
    codeLabel.setAttribute('translate', 'no');
    codeLabel.textContent =
      CHINESE_LABELS[option.code] || option.code.toUpperCase();
    if (CHINESE_LABELS[option.code]) codeLabel.lang = 'en';
    meta.append(codeLabel);
    const text = element(documentRef, 'span', 'locale-picker-text');
    text.append(name, meta);
    item.append(text);
    if (option.selected)
      item.append(icon(documentRef, 'check', 'locale-picker-check'));
    optionNodes.set(option.code, item);
  }

  const focusTarget = () => search || listbox;

  const render = () => {
    const visible = new Set(model.visible.map((option) => option.code));
    listbox.replaceChildren(
      ...model.visible.map((option) => optionNodes.get(option.code)),
    );
    for (const [localeCode, item] of optionNodes) {
      item.classList.toggle(
        'is-active',
        visible.has(localeCode) && model.activeOption?.code === localeCode,
      );
    }
    empty.hidden = model.visible.length > 0;
    const activeNode = model.activeOption
      ? optionNodes.get(model.activeOption.code)
      : null;
    if (activeNode) {
      focusTarget().setAttribute('aria-activedescendant', activeNode.id);
      activeNode.scrollIntoView?.({ block: 'nearest' });
    } else {
      focusTarget().removeAttribute('aria-activedescendant');
    }
  };

  let swallowSpaceKeyup = false;

  const close = ({ restoreFocus = false } = {}) => {
    if (!model.open) return;
    model.closeList();
    popup.hidden = true;
    root.classList.remove('is-open');
    button.setAttribute('aria-expanded', 'false');
    windowRef?.removeEventListener('keydown', onWindowKeyDown, true);
    documentRef.removeEventListener('pointerdown', onDocumentPointerDown, true);
    if (restoreFocus) button.focus({ preventScroll: true });
  };

  const choose = (localeCode) => {
    close({ restoreFocus: true });
    if (localeCode !== current) onSelect(localeCode);
  };

  const open = () => {
    if (model.open) return;
    model.openList();
    if (search) search.value = '';
    popup.hidden = false;
    root.classList.add('is-open');
    button.setAttribute('aria-expanded', 'true');
    render();
    // Window capture runs before the document-level shortcut handlers
    // (cockpit, hotkeys, push-to-talk), so keys typed in the list stay here.
    windowRef?.addEventListener('keydown', onWindowKeyDown, true);
    documentRef.addEventListener('pointerdown', onDocumentPointerDown, true);
    focusTarget().focus({ preventScroll: true });
  };

  function onWindowKeyDown(event) {
    if (!model.open || event.isComposing) return;
    const inside = root.contains(event.target);
    if (!inside && event.key !== 'Escape') return;
    const result = model.keydown(event);
    if (!result.handled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (result.close) close({ restoreFocus: true });
    else if (result.choose) {
      if (event.key === ' ') swallowSpaceKeyup = true;
      choose(result.choose);
    } else render();
  }

  function onDocumentPointerDown(event) {
    if (!root.contains(event.target)) close();
  }

  const onButtonClick = () => {
    if (model.open) close({ restoreFocus: true });
    else open();
  };

  const onButtonKeyDown = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    event.stopPropagation();
    open();
  };

  // Space chose an option and moved focus here; its keyup must not click.
  const onButtonKeyUp = (event) => {
    if (event.key !== ' ' || !swallowSpaceKeyup) return;
    swallowSpaceKeyup = false;
    event.preventDefault();
  };

  const optionFromEvent = (event) =>
    event.target?.closest?.('[role="option"]')?.dataset.locale || null;

  const onListClick = (event) => {
    const localeCode = optionFromEvent(event);
    if (localeCode) choose(localeCode);
  };

  const onListPointerMove = (event) => {
    const localeCode = optionFromEvent(event);
    if (!localeCode || model.activeOption?.code === localeCode) return;
    model.setActive(
      model.visible.findIndex((option) => option.code === localeCode),
    );
    render();
  };

  const onSearchInput = () => {
    model.setQuery(search.value);
    render();
  };

  const onFocusOut = (event) => {
    const next = event.relatedTarget;
    if (model.open && next && !root.contains(next)) close();
  };

  button.addEventListener('click', onButtonClick);
  button.addEventListener('keydown', onButtonKeyDown);
  button.addEventListener('keyup', onButtonKeyUp);
  listbox.addEventListener('click', onListClick);
  listbox.addEventListener('pointermove', onListPointerMove);
  search?.addEventListener('input', onSearchInput);
  root.addEventListener('focusout', onFocusOut);

  return {
    open,
    close,
    isOpen: () => model.open,
    destroy() {
      close();
      button.removeEventListener('click', onButtonClick);
      button.removeEventListener('keydown', onButtonKeyDown);
      button.removeEventListener('keyup', onButtonKeyUp);
      listbox.removeEventListener('click', onListClick);
      listbox.removeEventListener('pointermove', onListPointerMove);
      search?.removeEventListener('input', onSearchInput);
      root.removeEventListener('focusout', onFocusOut);
      root.textContent = '';
    },
  };
}
