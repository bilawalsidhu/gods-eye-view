// The interface language picker without a DOM: row order, search, the
// keyboard model and what choosing a language does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCALE_SEARCH_THRESHOLD,
  TYPEAHEAD_RESET_MS,
  applyLocaleChoice,
  buildLocaleOptions,
  createLocalNameReader,
  createLocalePickerModel,
  filterLocaleOptions,
  foldSearchText,
  moveActiveIndex,
  typeaheadIndex,
} from './localePicker.js';
import { LOCALES, LOCALE_NAMES } from '../i18n/locale.js';

const NAMES = {
  en: 'English',
  es: 'Español',
  ru: 'Русский',
  de: 'Deutsch',
  fr: 'Français',
  pt: 'Português',
  tr: 'Türkçe',
  uk: 'Українська',
  ja: '日本語',
};
const MANY = Object.keys(NAMES);

const codes = (rows) => rows.map((row) => row.code);

// Few enough languages that the picker has no search field.
const UNSEARCHED = ['en', 'es', 'ru', 'uk', 'zh-CN', 'zh-Hant'];

test('the current language comes first, the rest by their own names', () => {
  assert.deepEqual(
    codes(
      buildLocaleOptions({
        locales: LOCALES,
        current: 'ru',
        nativeNames: LOCALE_NAMES,
      }),
    ),
    ['ru', 'uk', 'de', 'en', 'es', 'fr', 'it', 'pt', 'zh-CN', 'zh-Hant', 'ja'],
  );
  assert.deepEqual(
    codes(
      buildLocaleOptions({
        locales: LOCALES,
        current: 'es',
        nativeNames: LOCALE_NAMES,
      }),
    ),
    ['es', 'de', 'en', 'fr', 'it', 'pt', 'ru', 'uk', 'zh-CN', 'zh-Hant', 'ja'],
  );
  assert.deepEqual(
    codes(
      buildLocaleOptions({
        locales: LOCALES,
        current: 'en',
        nativeNames: LOCALE_NAMES,
      }),
    ),
    ['en', 'de', 'es', 'fr', 'it', 'pt', 'ru', 'uk', 'zh-CN', 'zh-Hant', 'ja'],
  );
  const rows = buildLocaleOptions({
    locales: MANY,
    current: 'en',
    nativeNames: NAMES,
  });
  assert.deepEqual(codes(rows), [
    'en',
    'de',
    'es',
    'fr',
    'pt',
    'tr',
    'ru',
    'uk',
    'ja',
  ]);
  assert.deepEqual(
    rows.map((row) => row.selected),
    [true, false, false, false, false, false, false, false, false],
  );
});

test('each row gets the interface-language name for search, unless it only repeats the native one', () => {
  const local = createLocalNameReader('ru');
  const rows = buildLocaleOptions({
    locales: LOCALES,
    current: 'ru',
    nativeNames: LOCALE_NAMES,
    localName: local,
  });
  const byCode = Object.fromEntries(rows.map((row) => [row.code, row]));
  assert.equal(byCode.en.localName, 'английский');
  assert.equal(byCode.es.localName, 'испанский');
  assert.equal(byCode.de.localName, 'немецкий');
  assert.equal(byCode.fr.localName, 'французский');
  assert.equal(byCode.ru.localName, '', 'русский only repeats Русский');
  const english = buildLocaleOptions({
    locales: LOCALES,
    current: 'en',
    nativeNames: LOCALE_NAMES,
    localName: createLocalNameReader('en'),
  });
  assert.equal(english.find((row) => row.code === 'es').localName, 'Spanish');
  assert.equal(english.find((row) => row.code === 'fr').localName, 'French');
});

test('without Intl.DisplayNames the interface-language name is simply left out', () => {
  const read = createLocalNameReader('ru', null);
  assert.equal(read('en'), '');
  class Broken {
    of() {
      throw new RangeError('bad code');
    }
  }
  assert.equal(createLocalNameReader('ru', Broken)('en'), '');
  class Echo {
    of(code) {
      return code;
    }
  }
  assert.equal(
    createLocalNameReader('ru', Echo)('xx'),
    '',
    'a code echoed back is no name',
  );
});

test('search folds case and diacritics, and matches either name or the code', () => {
  assert.equal(foldSearchText('  Español '), 'espanol');
  assert.equal(foldSearchText('Français'), 'francais');
  assert.equal(foldSearchText('Ёлка'), 'елка');
  const rows = buildLocaleOptions({
    locales: MANY,
    current: 'ru',
    nativeNames: NAMES,
    localName: createLocalNameReader('ru'),
  });
  assert.deepEqual(codes(filterLocaleOptions(rows, 'espan')), ['es']);
  assert.deepEqual(codes(filterLocaleOptions(rows, 'ESPAÑ')), ['es']);
  assert.deepEqual(codes(filterLocaleOptions(rows, 'francais')), ['fr']);
  assert.deepEqual(codes(filterLocaleOptions(rows, 'turkce')), ['tr']);
  assert.deepEqual(
    codes(filterLocaleOptions(rows, 'испан')),
    ['es'],
    'by the interface-language name',
  );
  assert.deepEqual(
    codes(filterLocaleOptions(rows, 'УКРАИН')),
    ['uk'],
    'й folds to и',
  );
  assert.deepEqual(
    codes(filterLocaleOptions(rows, 'JA')),
    ['ja'],
    'by the code',
  );
  assert.deepEqual(
    codes(filterLocaleOptions(rows, '  ')),
    codes(rows),
    'empty keeps all',
  );
  assert.deepEqual(filterLocaleOptions(rows, 'klingon'), []);
});

test('the search field appears only above the threshold', () => {
  assert.equal(LOCALE_SEARCH_THRESHOLD, 8);
  assert.equal(
    createLocalePickerModel({ current: 'en' }).searchable,
    LOCALES.length > LOCALE_SEARCH_THRESHOLD,
  );
  const eight = MANY.slice(0, 8);
  assert.equal(
    createLocalePickerModel({
      locales: eight,
      nativeNames: NAMES,
      current: 'en',
    }).searchable,
    false,
  );
  assert.equal(
    createLocalePickerModel({
      locales: MANY,
      nativeNames: NAMES,
      current: 'en',
    }).searchable,
    true,
  );
});

test('choosing the current language changes nothing; another asks, then switches', () => {
  const calls = [];
  const actions = (answer) => ({
    current: 'ru',
    confirmSwitch: () => {
      calls.push('confirm');
      return answer;
    },
    switchLocale: (locale) => calls.push(`switch:${locale}`),
  });
  assert.equal(applyLocaleChoice('ru', actions(true)), 'unchanged');
  assert.deepEqual(calls, [], 'no prompt, no reload');
  assert.equal(applyLocaleChoice('es', actions(false)), 'declined');
  assert.deepEqual(calls, ['confirm']);
  assert.equal(applyLocaleChoice('es', actions(true)), 'switched');
  assert.deepEqual(calls, ['confirm', 'confirm', 'switch:es']);
});

test('navigation keys move without wrapping', () => {
  assert.equal(moveActiveIndex('ArrowDown', 0, 3), 1);
  assert.equal(moveActiveIndex('ArrowDown', 2, 3), 2);
  assert.equal(moveActiveIndex('ArrowUp', 0, 3), 0);
  assert.equal(moveActiveIndex('ArrowUp', 2, 3), 1);
  assert.equal(moveActiveIndex('ArrowDown', -1, 3), 0);
  assert.equal(moveActiveIndex('ArrowUp', -1, 3), 2);
  assert.equal(moveActiveIndex('Home', 2, 3), 0);
  assert.equal(moveActiveIndex('End', 0, 3), 2);
  assert.equal(moveActiveIndex('Tab', 0, 3), null);
  assert.equal(moveActiveIndex('ArrowDown', 0, 0), null);
});

test('type-ahead cycles by first letter and refines with more letters', () => {
  const rows = buildLocaleOptions({
    locales: MANY,
    current: 'en',
    nativeNames: NAMES,
  });
  // en, de, es, fr, pt, tr, ru, uk, ja
  assert.equal(
    typeaheadIndex(rows, 'e', 0),
    2,
    'from English, e moves on to Español',
  );
  assert.equal(typeaheadIndex(rows, 'e', 2), 0, 'and wraps back to English');
  assert.equal(
    typeaheadIndex(rows, 'ee', 2),
    0,
    'a repeated letter keeps cycling',
  );
  assert.equal(typeaheadIndex(rows, 'es', 0), 2);
  assert.equal(
    typeaheadIndex(rows, 'en', 0),
    0,
    'a longer prefix may stay put',
  );
  assert.equal(
    typeaheadIndex(rows, 'р', 0),
    6,
    'Русский by its Cyrillic letter',
  );
  assert.equal(typeaheadIndex(rows, 'q', 0), -1);
});

test('keyboard model: open on the current language, move, choose, close', () => {
  const model = createLocalePickerModel({
    locales: UNSEARCHED,
    current: 'ru',
    localName: createLocalNameReader('ru'),
  });
  assert.deepEqual(
    model.keydown({ key: 'ArrowDown' }),
    { handled: false },
    'closed: ignored',
  );
  model.openList();
  assert.equal(model.activeOption.code, 'ru');
  assert.deepEqual(model.keydown({ key: 'ArrowDown' }), { handled: true });
  // Russian collation puts the other Cyrillic name next.
  assert.equal(model.activeOption.code, 'uk');
  model.keydown({ key: 'End' });
  assert.equal(model.activeOption.code, 'zh-Hant');
  model.keydown({ key: 'Home' });
  assert.equal(model.activeOption.code, 'ru');
  model.keydown({ key: 'ArrowUp' });
  assert.equal(model.activeOption.code, 'ru', 'no wrap at the top');
  assert.deepEqual(model.keydown({ key: 'Enter' }), {
    handled: true,
    choose: 'ru',
  });
  model.keydown({ key: 'ArrowDown' });
  assert.deepEqual(model.keydown({ key: ' ' }), {
    handled: true,
    choose: 'uk',
  });
  assert.deepEqual(model.keydown({ key: 'Escape' }), {
    handled: true,
    close: true,
  });
  assert.deepEqual(
    model.keydown({ key: 'Tab' }),
    { handled: false },
    'Tab leaves the list',
  );
  model.closeList();
  assert.equal(model.open, false);
});

test('keyboard model: type-ahead resets after a pause and ignores shortcuts', () => {
  let clock = 0;
  const model = createLocalePickerModel({
    locales: UNSEARCHED,
    current: 'en',
    now: () => clock,
  });
  model.openList();
  assert.deepEqual(model.keydown({ key: 'e' }), { handled: true });
  assert.equal(model.activeOption.code, 'es');
  clock += 100;
  model.keydown({ key: 's' });
  assert.equal(model.activeOption.code, 'es', '"es" keeps Español');
  clock += TYPEAHEAD_RESET_MS + 1;
  model.keydown({ key: 'Р' });
  assert.equal(model.activeOption.code, 'ru');
  assert.deepEqual(
    model.keydown({ key: 'z' }),
    { handled: true },
    'an unmatched letter is still the list’s, not a global hotkey',
  );
  assert.equal(model.activeOption.code, 'ru');
  assert.deepEqual(model.keydown({ key: 'c', metaKey: true }), {
    handled: false,
  });
});

test('keyboard model with search: letters, Space, Home and End belong to the field', () => {
  const model = createLocalePickerModel({
    locales: MANY,
    nativeNames: NAMES,
    current: 'en',
    localName: createLocalNameReader('en'),
  });
  model.openList();
  assert.deepEqual(model.keydown({ key: 'f' }), { handled: false });
  assert.deepEqual(model.keydown({ key: ' ' }), { handled: false });
  assert.deepEqual(model.keydown({ key: 'Home' }), { handled: false });
  model.setQuery('SPAN');
  assert.deepEqual(codes(model.visible), ['es']);
  assert.equal(model.activeOption.code, 'es');
  assert.deepEqual(model.keydown({ key: 'Enter' }), {
    handled: true,
    choose: 'es',
  });
  model.setQuery('e');
  assert.equal(
    model.activeOption.code,
    'en',
    'the current language stays active while it matches',
  );
  model.keydown({ key: 'ArrowDown' });
  assert.notEqual(model.activeOption.code, 'en');
  model.setQuery('nothing like it');
  assert.equal(model.activeOption, null);
  assert.deepEqual(
    model.keydown({ key: 'Enter' }),
    { handled: true },
    'nothing to choose',
  );
  model.openList();
  assert.equal(model.query, '', 'reopening clears the search');
  assert.equal(model.visible.length, MANY.length);
});
