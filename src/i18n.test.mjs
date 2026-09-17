import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectInitialLocale,
  getLocale,
  setLocale,
  toggleLocale,
  t,
  subscribeLocale,
  applyTranslations,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
} from './i18n/index.js';

test('i18n module provides supported locales', () => {
  assert.ok(SUPPORTED_LOCALES.includes('en'));
  assert.ok(SUPPORTED_LOCALES.includes('zh-TW'));
  assert.equal(DEFAULT_LOCALE, 'en');
});

test('t() returns translated strings and fallbacks', () => {
  setLocale('en');
  assert.equal(t('app.title'), "GOD'S EYE VIEW");
  assert.equal(t('style.normal'), 'Normal');
  assert.equal(t('non.existent.key', 'Fallback Text'), 'Fallback Text');

  setLocale('zh-TW');
  assert.equal(t('app.subtitle'), '全球態勢 · 盡收眼底');
  assert.equal(t('style.normal'), '正常');
  assert.equal(t('cctv.title'), '即時監視器');

  // Switch back to en
  setLocale('en');
  assert.equal(t('style.normal'), 'Normal');
});

test('toggleLocale switches back and forth', () => {
  setLocale('en');
  assert.equal(getLocale(), 'en');

  const next = toggleLocale();
  assert.equal(next, 'zh-TW');
  assert.equal(getLocale(), 'zh-TW');

  const back = toggleLocale();
  assert.equal(back, 'en');
  assert.equal(getLocale(), 'en');
});

test('subscribeLocale notifies on locale change', () => {
  setLocale('en');
  const seen = [];
  const unsubscribe = subscribeLocale((locale) => {
    seen.push(locale);
  });

  setLocale('zh-TW');
  setLocale('en');
  unsubscribe();
  setLocale('zh-TW');

  assert.deepEqual(seen, ['zh-TW', 'en']);
  setLocale('en');
});

test('applyTranslations updates mock DOM elements', () => {
  setLocale('zh-TW');

  const textNode1 = { dataset: { i18n: 'style.normal' }, textContent: 'Old Normal' };
  const textNode2 = { dataset: { i18n: 'style.retro' }, textContent: 'Old Retro' };
  const titleNode = { dataset: { i18nTitle: 'actions.share' }, title: 'Old Share' };
  const ariaNode = {
    dataset: { i18nAriaLabel: 'actions.northUpAria' },
    getAttribute: () => 'Old North',
    setAttribute(attr, val) {
      this[attr] = val;
    },
  };
  const placeholderNode = {
    dataset: { i18nPlaceholder: 'dock.searchPlaceholder' },
    placeholder: 'Old Search',
  };

  const container = {
    querySelectorAll(selector) {
      if (selector === '[data-i18n]') return [textNode1, textNode2];
      if (selector === '[data-i18n-title]') return [titleNode];
      if (selector === '[data-i18n-aria-label]') return [ariaNode];
      if (selector === '[data-i18n-placeholder]') return [placeholderNode];
      return [];
    },
    querySelector() {
      return null;
    },
  };

  applyTranslations(container);

  assert.equal(textNode1.textContent, '正常');
  assert.equal(textNode2.textContent, 'CRT');
  assert.equal(titleNode.title, '複製視角分享連結');
  assert.equal(ariaNode['aria-label'], '重設為正北朝上');
  assert.equal(placeholderNode.placeholder, '搜尋城市、地標、經緯度或座標...');

  setLocale('en');
});
