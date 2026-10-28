import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDocumentTranslations,
  formatDate,
  formatNumber,
  msg,
  persistLocaleAndReload,
  setLocale,
  t,
  tn,
} from './index.js';
import {
  LOCALE_STORAGE_KEY,
  applyDocumentLanguage,
  normalizeLocale,
  resolveLocale,
  writeStoredLocale,
} from './locale.js';

afterEach(() => setLocale('en'));

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data,
  };
}

test('normalizeLocale folds regional variants and rejects unshipped tags', () => {
  assert.equal(normalizeLocale('ru-RU'), 'ru');
  assert.equal(normalizeLocale(' RU '), 'ru');
  assert.equal(normalizeLocale('en_GB'), 'en');
  assert.equal(normalizeLocale('xx'), null);
  // Explicit script tags take precedence over regional defaults.
  assert.equal(normalizeLocale('zh'), 'zh-CN');
  assert.equal(normalizeLocale('zh-CN'), 'zh-CN');
  assert.equal(normalizeLocale('zh-Hans-SG'), 'zh-CN');
  assert.equal(normalizeLocale('zh-Hant'), 'zh-Hant');
  assert.equal(normalizeLocale(' ZH_hant '), 'zh-Hant');
  assert.equal(normalizeLocale('zh-TW'), 'zh-Hant');
  assert.equal(normalizeLocale('zh-Hant-HK'), 'zh-Hant');
  assert.equal(normalizeLocale('zh-Hans-HK'), 'zh-CN');
  assert.equal(normalizeLocale('zh-Hant-CN'), 'zh-Hant');
  assert.equal(normalizeLocale('zh_HK'), 'zh-Hant');
  assert.equal(normalizeLocale('zh-MO'), 'zh-Hant');
  assert.equal(normalizeLocale(undefined), null);
});

test('resolveLocale: ?lang= wins, then the stored choice, then browser languages, then English', () => {
  const storage = memoryStorage({ [LOCALE_STORAGE_KEY]: 'ru' });
  assert.equal(
    resolveLocale({
      location: { search: '?lang=en' },
      storage,
      languages: ['ru'],
    }),
    'en',
  );
  assert.equal(
    resolveLocale({ location: { search: '' }, storage, languages: ['en'] }),
    'ru',
  );
  assert.equal(
    resolveLocale({
      location: { search: '?lang=xx' },
      storage: memoryStorage(),
      languages: ['de-DE', 'ru-RU'],
    }),
    'ru',
  );
  assert.equal(
    resolveLocale({
      location: { search: '' },
      storage: memoryStorage(),
      languages: ['de'],
    }),
    'en',
  );
});

test('a throwing storage never escapes', () => {
  const storage = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(
    resolveLocale({ location: { search: '' }, storage, languages: [] }),
    'en',
  );
  assert.equal(writeStoredLocale('ru', storage), false);
});

test('applyDocumentLanguage sets lang and dir', () => {
  const doc = { documentElement: {} };
  applyDocumentLanguage(doc, 'ru-RU');
  assert.deepEqual(doc.documentElement, { lang: 'ru', dir: 'ltr' });
});

test('t() returns English text in English and translates in Russian', () => {
  assert.equal(t('POWERED UP'), 'POWERED UP');
  setLocale('ru');
  assert.notEqual(t('POWERED UP'), 'POWERED UP');
});

test('t() interpolates named values and keeps unknown names literal', () => {
  assert.equal(
    t('Save failed: {detail}', { detail: 'disk full' }),
    'Save failed: disk full',
  );
  assert.equal(
    t('Hello {who} {missing}', { who: 'pilot' }),
    'Hello pilot {missing}',
  );
});

test('t() falls back to English for text without a translation', () => {
  setLocale('ru');
  assert.equal(t('No such message {n}', { n: 1 }), 'No such message 1');
});

test('tn() picks English and Russian plural forms', () => {
  const label = (count) =>
    tn(
      count,
      'POWER UP · {count} KEY WAITING',
      'POWER UP · {count} KEYS WAITING',
    );
  assert.equal(label(1), 'POWER UP · 1 KEY WAITING');
  assert.equal(label(3), 'POWER UP · 3 KEYS WAITING');
  setLocale('ru');
  assert.match(label(1), / 1 КЛЮЧ(?![А-ЯЁ])/);
  assert.match(label(3), / 3 КЛЮЧА(?![А-ЯЁ])/);
  assert.match(label(5), / 5 КЛЮЧЕЙ(?![А-ЯЁ])/);
  assert.match(label(21), / 21 КЛЮЧ(?![А-ЯЁ])/);
});

test('t() context separates identical English with different meanings', () => {
  assert.equal(t('CLEAR', { context: 'action' }), 'CLEAR');
  setLocale('ru');
  assert.notEqual(t('CLEAR', { context: 'action' }), t('CLEAR'));
});

test('msg() returns its text unchanged', () => {
  assert.equal(msg('Live Flights'), 'Live Flights');
});

test('Intl formatters follow the active locale', () => {
  const date = new Date(Date.UTC(2026, 0, 15));
  const options = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  };
  assert.equal(formatDate(date, options), 'January 15, 2026');
  assert.equal(formatNumber(1234.5), '1,234.5');
  setLocale('ru');
  assert.equal(formatDate(date, options), '15 января 2026 г.');
  assert.equal(formatNumber(1234.5), '1 234,5');
});

function fakeElement({ text = '', attributes = {} } = {}) {
  const attrs = new Map(Object.entries(attributes));
  return {
    textContent: text,
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute: (name, value) => attrs.set(name, value),
    attrs,
  };
}

test('applyDocumentTranslations translates opted-in text and attributes in place', () => {
  const label = fakeElement({ text: '\n  POWERED\n  UP  ' });
  const pin = fakeElement({ attributes: { title: 'POWERED UP' } });
  const unknown = fakeElement({ text: 'No such message' });
  const doc = {
    querySelectorAll(selector) {
      if (selector === '[data-i18n]') return [label, unknown];
      if (selector === '[data-i18n-title]') return [pin];
      return [];
    },
  };
  assert.equal(
    applyDocumentTranslations(doc),
    0,
    'English leaves markup alone',
  );
  setLocale('ru');
  assert.equal(applyDocumentTranslations(doc), 2);
  assert.equal(label.textContent, t('POWERED UP'));
  assert.equal(pin.attrs.get('title'), t('POWERED UP'));
  assert.equal(unknown.textContent, 'No such message');
});

test('persistLocaleAndReload keeps the choice in ?lang when storage is blocked', () => {
  const calls = [];
  const location = {
    href: 'https://gev.local/?x=1#scene=a',
    assign: (url) => calls.push(['assign', url]),
    reload: () => calls.push(['reload']),
  };
  const history = {
    replaceState: (_s, _t, url) => calls.push(['replace', url]),
  };
  const storage = {
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(
    persistLocaleAndReload('ru', { location, history, storage }),
    true,
  );
  assert.deepEqual(calls, [
    ['replace', 'https://gev.local/?x=1&lang=ru#scene=a'],
    ['reload'],
  ]);
});

test('persistLocaleAndReload stores the choice, keeps the hash, strips ?lang', () => {
  const storage = memoryStorage();
  const calls = [];
  const location = {
    href: 'https://gev.local/?lang=en&x=1#scene=a',
    assign: (url) => calls.push(['assign', url]),
    reload: () => calls.push(['reload']),
  };
  const history = {
    replaceState: (_s, _t, url) => calls.push(['replace', url]),
  };
  assert.equal(
    persistLocaleAndReload('ru', { location, history, storage }),
    true,
  );
  assert.equal(storage.data.get(LOCALE_STORAGE_KEY), 'ru');
  assert.deepEqual(calls, [
    ['replace', 'https://gev.local/?x=1#scene=a'],
    ['reload'],
  ]);
});

test('tn() shows a caller-formatted count and still picks the form by number', () => {
  const label = (n) =>
    tn(n, '{count} map object', '{count} map objects', {
      count: formatNumber(n),
    });
  assert.equal(label(12345), '12,345 map objects');
  assert.equal(tn(12345, '{count} file', '{count} files'), '12345 files');
  setLocale('ru');
  try {
    assert.equal(label(12345), '12 345 объектов на карте');
    assert.equal(label(1), '1 объект на карте');
  } finally {
    setLocale('en');
  }
});
