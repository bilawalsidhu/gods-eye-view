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

// A module that never finishes loading: a catalog request that stalls.
const STALLED = 'data:text/javascript,await new Promise(() => {})';

let copies = 0;
// Per copy (by query): the catalogs that fail to load ('*' for all) and
// those that never arrive.
const failing = new Map();
const stalled = new Map();

registerHooks({
  resolve(specifier, context, nextResolve) {
    const query = context.parentURL?.split('?')[1];
    if (query?.startsWith('catalog-test-')) {
      // A copy of page.js uses the copy of the translator with its query.
      if (specifier === './index.js')
        return { url: `${INDEX}?${query}`, shortCircuit: true };
      const locale = /^\.\/locales\/(.+)\.json$/.exec(specifier)?.[1];
      const named = (set) => Boolean(set) && (set.has('*') || set.has(locale));
      if (locale && named(failing.get(query)))
        return { url: MISSING, shortCircuit: true };
      if (locale && named(stalled.get(query)))
        return {
          url: STALLED,
          format: 'module',
          importAttributes: {},
          shortCircuit: true,
        };
    }
    return nextResolve(specifier, context);
  },
});

/**
 * A translator with no catalog loaded, and the page entry over it.
 * `failing`: true for every catalog, or the locales whose catalog fails;
 * `stalled`: the locales whose catalog never arrives.
 */
async function freshTranslator({
  failing: fails = false,
  stalled: stalls = [],
} = {}) {
  const query = `catalog-test-${++copies}`;
  if (fails) failing.set(query, new Set(fails === true ? ['*'] : fails));
  if (stalls.length) stalled.set(query, new Set(stalls));
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
  assert.equal(await first, null, 'the earlier call was replaced');
  assert.equal(await second, 'de');
  assert.equal(i18n.getLocale(), 'de');

  const third = i18n.setLocale('ja');
  i18n.setLocale('de');
  assert.equal(await third, null);
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

test('a call a later one replaced resolves, whether the later one applies or fails', async () => {
  const { i18n, page } = await freshTranslator({ failing: ['uk'] });
  const first = i18n.setLocale('ru');
  const second = i18n.setLocale('uk');
  assert.equal(await first, null, 'replaced: neither applied nor failed');
  await assert.rejects(second);
  assert.equal(i18n.getLocale(), 'en');

  const storage = memoryStorage();
  const options = switchOptions(storage);
  const ru = page.switchLocale('de', options);
  const uk = page.switchLocale('uk', options);
  assert.equal(await ru, 'superseded');
  await assert.rejects(uk);
  assert.equal(page.getLocale(), 'en');
  assert.equal(storage.data.size, 0);
});

/** A page whose <html> waits for its language, as index.html does. */
function pendingPage() {
  const attributes = new Set(['data-locale-pending']);
  return {
    documentElement: {
      lang: '',
      dir: '',
      hasAttribute: (name) => attributes.has(name),
      removeAttribute: (name) => attributes.delete(name),
    },
    querySelectorAll: () => [],
  };
}

test('the page shows its waiting text once its language applies', async () => {
  const { page } = await freshTranslator();
  const doc = pendingPage();
  const locale = await page.startPageLocale(doc, {
    location: { search: '?lang=ja' },
    storage: memoryStorage(),
    languages: [],
  });
  assert.equal(locale, 'ja');
  assert.equal(doc.documentElement.lang, 'ja');
  assert.equal(doc.documentElement.hasAttribute('data-locale-pending'), false);
});

test('a catalog that stalls starts the page in English after the timeout', async (t) => {
  const { i18n, page } = await freshTranslator({ stalled: ['ru'] });
  t.mock.method(console, 'error', () => {});
  const doc = pendingPage();
  const started = Date.now();
  const locale = await page.startPageLocale(
    doc,
    {
      location: { search: '?lang=ru' },
      storage: memoryStorage(),
      languages: [],
    },
    { timeoutMs: 50 },
  );
  assert.ok(Date.now() - started < 2000, 'it did not wait for the catalog');
  assert.equal(locale, 'en');
  assert.equal(i18n.getLocale(), 'en');
  assert.deepEqual(
    { lang: doc.documentElement.lang, dir: doc.documentElement.dir },
    { lang: 'en', dir: 'ltr' },
  );
  assert.equal(doc.documentElement.hasAttribute('data-locale-pending'), false);
  assert.equal(page.START_LOCALE_TIMEOUT_MS, 4000);
});

test('the page keeps its waiting text hidden until then, logo and title shown', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(
    new URL('../../index.html', import.meta.url),
    'utf8',
  );
  const css = await readFile(
    new URL('../ui/styles/controls.css', import.meta.url),
    'utf8',
  );
  assert.match(html, /<html lang="en" data-locale-pending>/);
  assert.match(
    css,
    /html\[data-locale-pending\] \[data-i18n\] \{\s*visibility: hidden;/,
  );
  const loader = html.slice(html.indexOf('<div id="loading-screen">'));
  assert.match(loader, /<p class="loader-status" data-i18n>/);
  assert.doesNotMatch(loader.match(/<h2[^>]*>/)[0], /data-i18n/);
  assert.doesNotMatch(
    loader.match(/<span class="loader-logo[^>]*>/)[0],
    /data-i18n/,
  );
});
