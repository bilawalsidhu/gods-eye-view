import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createI18n,
  DEFAULT_LOCALE,
  detectLocaleFromTags,
  isSupportedLocale,
  normalizeLocaleTag,
} from './core.js';

const MESSAGES = {
  en: {
    simple: 'Plain',
    greet: 'Hello {name}',
    missingParam: 'Value {absent}',
    layers: { vessels: 'Vessels', cleared: { one: 'Cleared {count} layer', other: 'Cleared {count} layers' } },
  },
  'zh-CN': {
    simple: '普通',
    greet: '你好，{name}',
    layers: { vessels: '船舶', cleared: { other: '已清除 {count} 个图层' } },
  },
};

function createTranslator(overrides = {}) {
  const missingKeys = [];
  const missingParams = [];
  const i18n = createI18n({
    messages: MESSAGES,
    fallbackLocale: 'en',
    initialLocale: 'en',
    onMissingKey: (key, locale) => missingKeys.push({ key, locale }),
    onMissingParam: (name) => missingParams.push(name),
    ...overrides,
  });
  return { i18n, missingKeys, missingParams };
}

test('translates keys in the active locale', () => {
  const { i18n } = createTranslator();
  assert.equal(i18n.t('simple'), 'Plain');
  i18n.setLocale('zh-CN');
  assert.equal(i18n.t('simple'), '普通');
});

test('falls back to English for keys missing in the active pack', () => {
  const { i18n, missingKeys } = createTranslator();
  i18n.setLocale('zh-CN');
  assert.equal(i18n.t('missingParam', { nothing: 1 }), 'Value {absent}');
  assert.deepEqual(missingKeys, []);
});

test('a key missing everywhere returns the key itself and reports once', () => {
  const { i18n, missingKeys } = createTranslator();
  assert.equal(i18n.t('nope.nope'), 'nope.nope');
  assert.deepEqual(missingKeys, [{ key: 'nope.nope', locale: 'en' }]);
});

test('interpolates parameters without string concatenation', () => {
  const { i18n } = createTranslator();
  assert.equal(i18n.t('greet', { name: 'Aeryn' }), 'Hello Aeryn');
  i18n.setLocale('zh-CN');
  assert.equal(i18n.t('greet', { name: 'Aeryn' }), '你好，Aeryn');
});

test('a missing interpolation parameter stays visible instead of rendering undefined', () => {
  const { i18n, missingParams } = createTranslator();
  assert.equal(i18n.t('greet'), 'Hello {name}');
  assert.deepEqual(missingParams, ['name']);
  assert.equal(i18n.t('greet', { name: null }), 'Hello {name}');
});

test('plural messages select the English category and the Chinese other form', () => {
  const { i18n } = createTranslator();
  assert.equal(i18n.t('layers.cleared', { count: 1 }), 'Cleared 1 layer');
  assert.equal(i18n.t('layers.cleared', { count: 3 }), 'Cleared 3 layers');
  i18n.setLocale('zh-CN');
  assert.equal(i18n.t('layers.cleared', { count: 1 }), '已清除 1 个图层');
  assert.equal(i18n.t('layers.cleared', { count: 3 }), '已清除 3 个图层');
});

test('setLocale notifies subscribers with the new locale and supports unsubscribe', () => {
  const { i18n } = createTranslator();
  const seen = [];
  const unsubscribe = i18n.subscribe((locale) => seen.push(locale));
  i18n.setLocale('zh-CN');
  unsubscribe();
  i18n.setLocale('en');
  assert.deepEqual(seen, ['zh-CN']);
  assert.equal(i18n.getLocale(), 'en');
});

test('an unsupported locale falls back instead of switching', () => {
  const { i18n } = createTranslator();
  i18n.setLocale('fr-FR');
  assert.equal(i18n.getLocale(), 'en');
});

test('number and date formatting follow the active locale with cached formatters', () => {
  const { i18n } = createTranslator();
  assert.equal(i18n.formatNumber(12345.6, { maximumFractionDigits: 1 }), '12,345.6');
  i18n.setLocale('zh-CN');
  assert.equal(i18n.formatNumber(12345.6, { maximumFractionDigits: 1 }), '12,345.6');
  const formatted = i18n.formatDateTime(
    new Date('2026-03-05T00:00:00Z'),
    { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' },
  );
  assert.match(formatted, /2026/);
  assert.ok(formatted.includes('3') || formatted.includes('三'));
});

test('normalizeLocaleTag maps Chinese variants to zh-CN and rejects others', () => {
  assert.equal(normalizeLocaleTag('zh'), 'zh-CN');
  assert.equal(normalizeLocaleTag('zh-Hans'), 'zh-CN');
  assert.equal(normalizeLocaleTag('zh_HANS_CN'), 'zh-CN');
  assert.equal(normalizeLocaleTag('zh-SG'), 'zh-CN');
  assert.equal(normalizeLocaleTag('zh-Hant-TW'), 'zh-CN');
  assert.equal(normalizeLocaleTag('en-US'), 'en');
  assert.equal(normalizeLocaleTag('en'), 'en');
  assert.equal(normalizeLocaleTag('fr'), null);
  assert.equal(normalizeLocaleTag(42), null);
});

test('detectLocaleFromTags walks the preference list in order', () => {
  assert.equal(detectLocaleFromTags(['fr', 'zh-CN', 'en']), 'zh-CN');
  assert.equal(detectLocaleFromTags(['en-GB', 'zh']), 'en');
  assert.equal(detectLocaleFromTags([]), null);
  assert.equal(detectLocaleFromTags(undefined), null);
});

test('supported-locale helpers agree with the default', () => {
  assert.ok(isSupportedLocale(DEFAULT_LOCALE));
  assert.ok(!isSupportedLocale('zh-HK'));
  assert.equal(DEFAULT_LOCALE, 'en');
});

test('creating a translator without the fallback pack throws', () => {
  assert.throws(() => createI18n({ messages: { 'zh-CN': {} } }));
});
