import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyDocumentLanguage,
  applyDocumentTitle,
  detectBrowserLocale,
  LOCALE_STORAGE_KEY,
  persistLocale,
  readStoredLocale,
  resolveStartupLocale,
} from './browser.js';

/** Temporarily replace globalThis.localStorage, restoring whatever was there. */
function withFakeLocalStorage(value, styles = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const descriptor = {
    configurable: true,
    ...('get' in styles
      ? { get: styles.get }
      : {
          value,
          writable: true,
        }),
  };
  Object.defineProperty(globalThis, 'localStorage', descriptor);
  return () => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  };
}

test('readStoredLocale accepts a supported saved choice and rejects the rest', () => {
  assert.equal(readStoredLocale({ getItem: () => 'zh-CN' }), 'zh-CN');
  assert.equal(readStoredLocale({ getItem: () => 'en' }), 'en');
  assert.equal(readStoredLocale({ getItem: () => 'fr-FR' }), null);
  assert.equal(readStoredLocale({ getItem: () => null }), null);
  assert.equal(readStoredLocale({ getItem: () => 42 }), null);
  assert.equal(readStoredLocale(null), null);
});

test('readStoredLocale survives a getItem that throws', () => {
  assert.equal(
    readStoredLocale({
      getItem() {
        throw new Error('denied');
      },
    }),
    null,
  );
});

test('persistLocale survives a setItem that throws', () => {
  assert.doesNotThrow(() =>
    persistLocale('zh-CN', {
      setItem() {
        throw new Error('quota');
      },
    }),
  );
});

test('persistLocale writes through the namespaced key', () => {
  const writes = [];
  persistLocale('en', {
    setItem(key, value) {
      writes.push([key, value]);
    },
  });
  assert.deepEqual(writes, [[LOCALE_STORAGE_KEY, 'en']]);
});

test('P1: a localStorage getter that throws cannot block startup', () => {
  const restore = withFakeLocalStorage(undefined, {
    get() {
      throw new Error('privacy mode');
    },
  });
  try {
    assert.equal(readStoredLocale(), null);
    // The saved choice is gone, so startup falls through to the browser
    // preference (this machine's Node navigator reports zh-CN) and then en.
    assert.equal(resolveStartupLocale(), detectBrowserLocale() ?? 'en');
    assert.doesNotThrow(() => persistLocale('zh-CN'));
  } finally {
    restore();
  }
});

test('P1: a missing localStorage resolves through browser preference', () => {
  const restore = withFakeLocalStorage(undefined);
  try {
    assert.equal(resolveStartupLocale(), detectBrowserLocale() ?? 'en');
  } finally {
    restore();
  }
});

test('P2: unsupported navigator.languages falls through to navigator.language', () => {
  assert.equal(
    detectBrowserLocale({ languages: ['fr-FR'], language: 'zh-CN' }),
    'zh-CN',
  );
  assert.equal(
    detectBrowserLocale({ languages: ['en-US', 'fr'], language: 'zh-CN' }),
    'en',
  );
  assert.equal(detectBrowserLocale({ language: 'zh-CN' }), 'zh-CN');
  assert.equal(detectBrowserLocale({ languages: ['fr'], language: 'fr' }), null);
  assert.equal(detectBrowserLocale({}), null);
});

test('applyDocumentLanguage sets <html lang>', () => {
  const fake = { documentElement: { lang: 'en' } };
  applyDocumentLanguage('zh-CN', fake);
  assert.equal(fake.documentElement.lang, 'zh-CN');
  applyDocumentLanguage('zh-CN', {});
  applyDocumentLanguage('zh-CN', null);
});

test('P2: applyDocumentTitle keeps the title on the locale contract', () => {
  const fake = { title: "God's Eye View" };
  applyDocumentTitle("God's Eye View", fake);
  assert.equal(fake.title, "God's Eye View");
  applyDocumentTitle('', fake);
  assert.equal(fake.title, "God's Eye View", 'an empty title is ignored');
  applyDocumentTitle('x', null);
});

test('resolveStartupLocale prefers the saved choice over the browser', () => {
  assert.equal(
    resolveStartupLocale({ getItem: () => 'zh-CN' }),
    'zh-CN',
  );
});
