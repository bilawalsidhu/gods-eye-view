// src/i18n/catalogLoading.test.mjs — a translation catalog loads when its
// locale is chosen, not with the page: setLocale and switchLocale wait for it,
// the last choice wins while catalogs load, and a catalog that fails to load
// leaves the language as it was.
//
// `npm test` loads every catalog before the tests run, so each test here
// imports a copy of the translator of its own (a query on its URL makes a
// separate module) that has loaded none.
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCALE_STORAGE_KEY } from './locale.js';

const INDEX = new URL('./index.js', import.meta.url).href;
const PAGE = new URL('./page.js', import.meta.url).href;
const MISSING = new URL('./locales/missing-for-test.json', import.meta.url)
  .href;

let copies = 0;
// Copies whose catalogs fail to load, by query.
const offline = new Set();

registerHooks({
  resolve(specifier, context, nextResolve) {
    const query = context.parentURL?.split('?')[1];
    if (query?.startsWith('catalog-test-')) {
      // A copy of page.js uses the copy of the translator with its query.
      if (specifier === './index.js')
        return { url: `${INDEX}?${query}`, shortCircuit: true };
      if (offline.has(query) && /^\.\/locales\/.+\.json$/.test(specifier))
        return { url: MISSING, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

/** A translator with no catalog loaded, and the page entry over it. */
async function freshTranslator({ failing = false } = {}) {
  const query = `catalog-test-${++copies}`;
  if (failing) offline.add(query);
  const i18n = await import(`${INDEX}?${query}`);
  const page = await import(`${PAGE}?${query}`);
  return { i18n, page, query };
}

function memoryStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
  };
}

function switchOptions(storage = memoryStorage()) {
  return {
    location: { href: 'https://example.test/' },
    history: { replaceState() {} },
    storage,
  };
}

test('only the chosen locale loads, and it applies once loaded', async () => {
  const { i18n } = await freshTranslator();
  assert.equal(i18n.getCatalog('ar'), null, 'nothing loads with the page');
  const switching = i18n.setLocale('ar');
  assert.equal(i18n.getLocale(), 'en', 'not before its catalog is in');
  assert.equal(i18n.t('Close'), 'Close', 'no half-translated text');
  assert.equal(await switching, 'ar');
  assert.equal(i18n.getLocale(), 'ar');
  assert.notEqual(i18n.t('Close'), 'Close');
  assert.ok(i18n.getCatalog('ar'));
  for (const other of ['de', 'he', 'ru', 'zh-CN'])
    assert.equal(i18n.getCatalog(other), null, `${other} stays unloaded`);
  assert.equal(i18n.t('no such message'), 'no such message', 'English');
  // English needs no catalog and a loaded one applies at once.
  i18n.setLocale('en');
  assert.equal(i18n.getLocale(), 'en');
  i18n.setLocale('ar');
  assert.equal(i18n.getLocale(), 'ar');
});

test('the last choice wins while catalogs load', async () => {
  const { i18n } = await freshTranslator();
  const first = i18n.setLocale('ar');
  const second = i18n.setLocale('de');
  assert.equal(await first, 'de', 'the earlier call reports the later');
  assert.equal(await second, 'de');
  assert.equal(i18n.getLocale(), 'de');

  const third = i18n.setLocale('ja');
  i18n.setLocale('de');
  assert.equal(await third, 'de');
  assert.equal(i18n.getLocale(), 'de', 'Japanese, arriving late, is dropped');
});

test('a catalog that fails to load keeps the current language', async () => {
  const { i18n } = await freshTranslator({ failing: true });
  await assert.rejects(i18n.setLocale('fr'));
  assert.equal(i18n.getLocale(), 'en');
  assert.equal(i18n.getCatalog('fr'), null);
  const heard = [];
  const off = i18n.onLocaleChange(() => heard.push(i18n.getLocale()));
  await assert.rejects(i18n.setLocale('fr'), 'a failed load is tried again');
  off();
  assert.deepEqual(heard, [], 'nothing changed');
});

test('the page starts in English when its language fails to load', async (t) => {
  const { page } = await freshTranslator({ failing: true });
  t.mock.method(console, 'error', () => {});
  const doc = {
    documentElement: { lang: '', dir: '' },
    querySelectorAll: () => [],
  };
  const locale = await page.startPageLocale(doc, {
    location: { search: '?lang=he' },
    storage: memoryStorage(),
    languages: [],
  });
  assert.equal(locale, 'en');
  assert.deepEqual(doc.documentElement, { lang: 'en', dir: 'ltr' });
});

test('switchLocale stores only the choice that applied', async () => {
  const { page } = await freshTranslator();
  const storage = memoryStorage();
  const options = switchOptions(storage);
  const first = page.switchLocale('ru', options);
  const second = page.switchLocale('uk', options);
  assert.equal(await first, 'superseded');
  assert.equal(await second, 'switched');
  assert.equal(page.getLocale(), 'uk');
  assert.equal(storage.data.get(LOCALE_STORAGE_KEY), 'uk');

  // Choosing the shown language again while another loads keeps it.
  const away = page.switchLocale('sv', options);
  const back = page.switchLocale('uk', options);
  assert.equal(await away, 'superseded');
  assert.equal(await back, 'unchanged');
  assert.equal(page.getLocale(), 'uk');
  assert.equal(storage.data.get(LOCALE_STORAGE_KEY), 'uk');
});

test('switchLocale rejects and stores nothing when the catalog fails', async () => {
  const { page } = await freshTranslator({ failing: true });
  const storage = memoryStorage();
  await assert.rejects(page.switchLocale('it', switchOptions(storage)));
  assert.equal(page.getLocale(), 'en');
  assert.equal(storage.data.size, 0);
});
