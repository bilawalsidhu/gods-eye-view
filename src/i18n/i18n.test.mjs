// i18n core behavior: locale resolution precedence (incl. ?lang=), guarded
// storage, English fallback, interpolation, plural selection, document
// application on all four attributes, and hash-exact reload handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_METADATA,
  LOCALE_STORAGE_KEY,
  applyDocumentLanguage,
  availableLocales,
  normalizeLocale,
  resolveLocale,
  resolveLocalePair,
  writeStoredLocale,
} from './locale.js';
import {
  applyDocumentTranslations,
  formatDate,
  formatNumber,
  formatRelativeTime,
  getCatalog,
  getLocale,
  hasMessage,
  persistLocaleAndReload,
  resolveMessage,
  setLocale,
  t,
} from './index.js';

// Tests mutate module locale state; each dependent test re-pins it.
function pinLocale(locale) {
  assert.equal(setLocale(locale), locale);
}

test('normalizeLocale folds regional variants and rejects unsupported tags', () => {
  assert.equal(normalizeLocale('es'), 'es');
  assert.equal(normalizeLocale('ES'), 'es');
  assert.equal(normalizeLocale('es-MX'), 'es');
  assert.equal(normalizeLocale('es_419'), 'es');
  assert.equal(normalizeLocale('en'), 'en');
  assert.equal(normalizeLocale('en-GB'), 'en');
  assert.equal(normalizeLocale('fr'), 'fr');
  assert.equal(normalizeLocale('FR'), 'fr');
  assert.equal(normalizeLocale('fr-CA'), 'fr');
  assert.equal(normalizeLocale('fr_FR'), 'fr');
  assert.equal(normalizeLocale('ru'), 'ru');
  assert.equal(normalizeLocale('RU'), 'ru');
  assert.equal(normalizeLocale('ru-RU'), 'ru');
  assert.equal(normalizeLocale('ru_KZ'), 'ru');
  assert.equal(normalizeLocale('uk'), 'uk');
  assert.equal(normalizeLocale('UK'), 'uk', 'uppercase country spelling still folds to the language tag');
  assert.equal(normalizeLocale('uk-UA'), 'uk');
  assert.equal(normalizeLocale('uk_UA'), 'uk');
  assert.equal(normalizeLocale('de'), null, 'no shipped de catalog');
  assert.equal(normalizeLocale('english'), null);
  assert.equal(normalizeLocale(''), null);
  assert.equal(normalizeLocale(null), null);
  assert.equal(normalizeLocale(42), null);
});

test('resolution precedence: ?lang= overrides everything and is never persisted', () => {
  const storage = { getItem: () => 'en', setItem() { throw new Error('must not be written'); } };
  assert.equal(resolveLocale({
    location: { search: '?lang=es' },
    storage,
    languages: ['en-US'],
  }), 'es');
  // A garbage override is ignored — the chain keeps looking.
  assert.equal(resolveLocale({
    location: { search: '?lang=de' },
    storage,
    languages: ['en-US'],
  }), 'en');
  // A shipped catalog locale outside the DEFAULT pair (en+es) is equally
  // ignored: fr only resolves while the configured pair offers it.
  assert.equal(resolveLocale({
    location: { search: '?lang=fr' },
    storage,
    languages: ['en-US'],
  }), 'en');
});

test('resolution precedence: stored preference outranks navigator languages', () => {
  assert.equal(resolveLocale({
    location: { search: '' },
    storage: { getItem: () => 'es' },
    languages: ['en-US', 'en'],
  }), 'es');
});

test('resolution precedence: navigator languages resolve before the English default', () => {
  assert.equal(resolveLocale({
    location: { search: '' },
    storage: { getItem: () => 'xx' },
    languages: ['fr-CA', 'es-MX', 'en'],
  }), 'es');
  assert.equal(resolveLocale({ location: { search: '' }, storage: null, languages: ['fr-CA'] }), 'en');
  assert.equal(resolveLocale({ location: null, storage: null, languages: null }), DEFAULT_LOCALE);
});

test('guarded storage: a throwing store (private mode / quota) never escapes', () => {
  const hostile = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
  };
  assert.equal(resolveLocale({ location: { search: '' }, storage: hostile, languages: ['es'] }), 'es');
  assert.equal(writeStoredLocale('es', hostile), false);
  assert.equal(writeStoredLocale('es', { setItem() { throw new Error('quota'); } }), false);
  assert.equal(writeStoredLocale('es', {}), false, 'no setItem function means no write');
  assert.equal(writeStoredLocale('es-AR', { setItem() {} }), true, 'stored value is normalized');
});

test('applyDocumentLanguage reflects lang and dir from locale metadata', () => {
  const makeDoc = () => ({ documentElement: { lang: '', dir: '' } });
  const enDoc = makeDoc();
  assert.equal(applyDocumentLanguage(enDoc, 'en'), true);
  assert.deepEqual({ lang: enDoc.documentElement.lang, dir: enDoc.documentElement.dir },
    { lang: 'en', dir: LOCALE_METADATA.en.dir });
  assert.equal(LOCALE_METADATA.en.dir, 'ltr', 'English is LTR by metadata');
  const esDoc = makeDoc();
  assert.equal(applyDocumentLanguage(esDoc, 'es-MX'), true);
  assert.deepEqual({ lang: esDoc.documentElement.lang, dir: esDoc.documentElement.dir },
    { lang: 'es', dir: LOCALE_METADATA.es.dir });
  assert.equal(LOCALE_METADATA.es.dir, 'ltr', 'Spanish is LTR by metadata');
  const frDoc = makeDoc();
  assert.equal(applyDocumentLanguage(frDoc, 'fr-CA'), true);
  assert.deepEqual({ lang: frDoc.documentElement.lang, dir: frDoc.documentElement.dir },
    { lang: 'fr', dir: LOCALE_METADATA.fr.dir });
  assert.equal(LOCALE_METADATA.fr.dir, 'ltr', 'French is LTR by metadata');
  const ruDoc = makeDoc();
  assert.equal(applyDocumentLanguage(ruDoc, 'ru-RU'), true);
  assert.deepEqual({ lang: ruDoc.documentElement.lang, dir: ruDoc.documentElement.dir },
    { lang: 'ru', dir: LOCALE_METADATA.ru.dir });
  assert.equal(LOCALE_METADATA.ru.dir, 'ltr', 'Russian is LTR by metadata');
  const ukDoc = makeDoc();
  assert.equal(applyDocumentLanguage(ukDoc, 'uk_UA'), true);
  assert.deepEqual({ lang: ukDoc.documentElement.lang, dir: ukDoc.documentElement.dir },
    { lang: 'uk', dir: LOCALE_METADATA.uk.dir });
  assert.equal(LOCALE_METADATA.uk.dir, 'ltr', 'Ukrainian is LTR by metadata');
  assert.equal(applyDocumentLanguage(null, 'es'), false);
  assert.equal(applyDocumentLanguage({ documentElement: null }, 'es'), false);
  // An unsupported locale still yields valid metadata, never an empty dir.
  const fallbackDoc = makeDoc();
  applyDocumentLanguage(fallbackDoc, 'de');
  assert.equal(fallbackDoc.documentElement.lang, DEFAULT_LOCALE);
  assert.equal(fallbackDoc.documentElement.dir, 'ltr');
});

test('t() resolves seed keys, interpolates named placeholders, and keeps unknown ones literal', () => {
  pinLocale('en');
  assert.equal(t('shell.title.subtitle'), 'NO PLACE LEFT BEHIND');
  assert.equal(
    t('shell.loading.status.tilesUnavailable', { detail: '403 from ion' }),
    'Google 3D Tiles unavailable (403 from ion). Loading the keyless globe...',
  );
  assert.equal(
    t('shell.loading.status.tilesUnavailable', {}),
    'Google 3D Tiles unavailable ({detail}). Loading the keyless globe...',
    'an unprovided name stays visible instead of silently vanishing',
  );
});

test('t() selects one/other plural variants per locale through Intl.PluralRules', () => {
  pinLocale('en');
  assert.equal(t('layers.clear.toast.cleared', { count: 1 }), 'Cleared 1 data layer');
  assert.equal(t('layers.clear.toast.cleared', { count: 3 }), 'Cleared 3 data layers');
  assert.equal(t('layers.clear.toast.notCleared', { count: 1 }),
    '1 data layer could not be cleared');
  pinLocale('es');
  // es holds translated values since stage-3 translation; what is under test
  // is es plural category selection through the real es catalog values.
  assert.equal(t('layers.clear.toast.cleared', { count: 1 }), 'Se limpió 1 capa de datos');
  assert.equal(t('layers.clear.toast.cleared', { count: 3 }), 'Se limpiaron 3 capas de datos');
});

test('a missing key returns the key itself and never warns outside dev builds', () => {
  pinLocale('en');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    assert.equal(t('shell.definitely.not.here'), 'shell.definitely.not.here');
    assert.equal(hasMessage('shell.definitely.not.here'), false);
    assert.equal(hasMessage('shell.title.subtitle'), true);
  } finally {
    console.warn = originalWarn;
  }
  // import.meta.env is absent under node:test, so the DEV gate keeps the
  // console quiet here; the warn path itself only runs on the dev server.
  assert.deepEqual(warnings, []);
});

test('a key missing in es resolves through the English fallback (pure lookup)', () => {
  // The shipped es seed mirrors en key-for-key, so the fallback path is
  // exercised through the pure resolver with synthetic catalogs — exactly the
  // shape stage-3 leaves behind while es translation lags.
  const catalogs = {
    es: Object.freeze({}),
    en: Object.freeze({ 'a.b': 'EN ONLY' }),
  };
  assert.equal(resolveMessage(catalogs, 'es', 'a.b'), 'EN ONLY');
  assert.equal(resolveMessage(catalogs, 'fr', 'a.b'), 'EN ONLY', 'unsupported locale reads en');
  assert.equal(resolveMessage(catalogs, 'es', 'nope'), undefined);
  assert.equal(resolveMessage(null, 'es', 'a.b'), undefined, 'no catalogs means no message');
});

test('Intl formatters follow the active locale', () => {
  pinLocale('en');
  // Five significant digits: Spanish (CLDR minimumGroupingDigits=2) only
  // groups from five digits up, so a 4-digit value would hide the difference.
  assert.equal(formatNumber(12345.6), '12,345.6');
  assert.equal(formatDate(new Date(Date.UTC(2026, 0, 15)), { year: 'numeric', month: 'long', day: 'numeric' }),
    'January 15, 2026');
  assert.equal(formatRelativeTime(-5, 'minute'), '5 minutes ago');
  pinLocale('es');
  assert.equal(formatNumber(12345.6), '12.345,6');
  assert.equal(formatDate(new Date(Date.UTC(2026, 0, 15)), { year: 'numeric', month: 'long', day: 'numeric' }),
    '15 de enero de 2026');
  assert.equal(formatRelativeTime(-5, 'minute'), 'hace 5 minutos');
  // Formatter cache is keyed per locale: switching back must not leak es forms.
  pinLocale('en');
  assert.equal(formatNumber(12345.6), '12,345.6');
});

test('persistLocaleAndReload stores the choice, keeps the hash exact, strips ?lang', () => {
  const writes = [];
  const navigations = [];
  const storage = { setItem(key, value) { writes.push([key, value]); } };
  const location = {
    href: 'http://localhost:4173/?lang=es&welcome=1#cam=30.2672,-97.7431,alt=2500',
    assign(url) { navigations.push(url); },
  };
  assert.equal(persistLocaleAndReload('es-MX', { location, storage }), true);
  assert.deepEqual(writes, [[LOCALE_STORAGE_KEY, 'es']], 'normalized value under the versioned key');
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0], 'http://localhost:4173/?welcome=1#cam=30.2672,-97.7431,alt=2500');

  // No ?lang present: the URL round-trips unchanged, hash included.
  navigations.length = 0;
  persistLocaleAndReload('en', { location: { href: 'http://localhost:4173/#scene=coast', assign: (u) => navigations.push(u) } });
  assert.deepEqual(navigations, ['http://localhost:4173/#scene=coast']);

  // A blocked store must not block the reload.
  const blocked = { setItem() { throw new Error('SecurityError'); } };
  navigations.length = 0;
  assert.equal(persistLocaleAndReload('es', { location: { href: 'http://x/?lang=es#a', assign: (u) => navigations.push(u) }, storage: blocked }), true);
  assert.deepEqual(navigations, ['http://x/#a']);

  // Nothing navigable injected: no throw, no reload claim.
  assert.equal(persistLocaleAndReload('es', { location: null }), false);
  assert.equal(persistLocaleAndReload('es', { location: {} }), false);

  // Real-browser shape: a reloadable location MUST force the reload — assign()
  // to a byte-identical URL never navigates, which stranded stored-locale
  // switches (no ?lang present, hash unchanged).
  const reloaded = [];
  const assigned = [];
  const replaced = [];
  assert.equal(persistLocaleAndReload('es', {
    location: {
      href: 'http://localhost:4173/#scene=coast',
      assign: (u) => assigned.push(u),
      reload: () => reloaded.push(true),
    },
    history: { replaceState: (_s, _t, u) => replaced.push(u) },
  }), true);
  assert.deepEqual(replaced, ['http://localhost:4173/#scene=coast'], '?lang-free URL passes through replaceState');
  assert.equal(reloaded.length, 1, 'reload is forced');
  assert.equal(assigned.length, 0, 'assign is not used when reload exists');
});

class FakeElement {
  constructor(attributes) {
    this.attributes = new Map(Object.entries(attributes));
    this.textContent = '';
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
}

function fakeDocumentFor(elements) {
  return {
    querySelectorAll(selector) {
      const match = /^\[([a-z0-9-]+)\]$/.exec(selector);
      if (!match) return [];
      return elements.filter((element) => element.getAttribute(match[1]) !== null);
    },
  };
}

test('applyDocumentTranslations writes all four attributes and skips unknown keys', () => {
  pinLocale('en');
  const elements = [
    new FakeElement({ 'data-i18n': 'shell.title.subtitle' }),
    new FakeElement({ 'data-i18n-title': 'shell.actions.clearLayers.title' }),
    new FakeElement({ 'data-i18n-aria-label': 'shell.actions.share.ariaLabel' }),
    new FakeElement({ 'data-i18n-placeholder': 'setup.keySetup.title' }),
    new FakeElement({ 'data-i18n': 'shell.missing.key' }),
    new FakeElement({ 'data-i18n': '' }),
  ];
  const applied = applyDocumentTranslations(fakeDocumentFor(elements));
  assert.equal(applied, 4);
  assert.equal(elements[0].textContent, 'NO PLACE LEFT BEHIND');
  assert.equal(elements[1].getAttribute('title'), 'Turn off all selected data layers');
  assert.equal(elements[2].getAttribute('aria-label'), 'Copy share link');
  assert.equal(elements[3].getAttribute('placeholder'), 'Power up the globe');
  // A key that resolves nowhere leaves the element untouched.
  assert.equal(elements[4].textContent, '');
  assert.equal(elements[5].textContent, '');
  assert.equal(applyDocumentTranslations(null), 0);
  assert.equal(applyDocumentTranslations({}), 0);
});

test('getCatalog exposes the merged, dot-prefixed registry for every shipped locale', () => {
  assert.deepEqual([...CATALOG_LOCALES], ['en', 'es', 'fr', 'ru', 'uk']);
  for (const locale of CATALOG_LOCALES) {
    const catalog = getCatalog(locale);
    assert.ok(catalog, `catalog for ${locale}`);
    assert.ok(Object.keys(catalog).length > 0);
    for (const key of Object.keys(catalog)) {
      assert.match(key, /^(shell|cockpit|layers|setup)\./, `${locale} key ${key}`);
    }
  }
  // fr is fully translated; ru and uk are untranslated seeds — all three are
  // registered and mirror en key-for-key even though the default pair offers
  // only en+es; an unknown locale stays null.
  for (const shipped of ['fr', 'ru', 'uk']) {
    assert.deepEqual(Object.keys(getCatalog(shipped)).sort(), Object.keys(getCatalog('en')).sort());
  }
  assert.equal(getCatalog('de'), null);
  assert.equal(getLocale(), 'en', 'state survived the whole file');
});

test('locale pair: availableLocales dedups [default, secondary, en] in selector order', () => {
  assert.deepEqual([...availableLocales()], ['en', 'es'], 'no config = built-in en+es');
  assert.deepEqual([...availableLocales({ defaultLocale: 'fr', secondaryLocale: 'en' })], ['fr', 'en']);
  // English joins as the always-shipped fallback when not part of the pair.
  assert.deepEqual([...availableLocales({ defaultLocale: 'fr', secondaryLocale: 'es' })], ['fr', 'es', 'en']);
  // Regional spellings normalize before the pair is validated/deduped.
  assert.deepEqual([...availableLocales({ defaultLocale: 'FR-fr', secondaryLocale: 'EN' })], ['fr', 'en']);
  // A blank field means "unset" (empty .env line) and takes its built-in default.
  assert.deepEqual([...availableLocales({ defaultLocale: ' ' })], ['en', 'es']);
  const pair = resolveLocalePair({ defaultLocale: 'fr', secondaryLocale: 'es' });
  assert.equal(pair.defaultLocale, 'fr');
  assert.equal(pair.secondaryLocale, 'es');
  assert.ok(Object.isFrozen(pair) && Object.isFrozen(pair.availableLocales));
});

test('locale pair: a configured default=fr / secondary=en pair reshapes resolution', () => {
  const config = { defaultLocale: 'fr', secondaryLocale: 'en' };
  // Nothing else speaks: the CONFIGURED default wins (not hardcoded en).
  assert.equal(resolveLocale({ location: { search: '' }, storage: null, languages: null, config }), 'fr');
  // ?lang= is accepted for locales inside the pair, regional variants included…
  assert.equal(resolveLocale({ location: { search: '?lang=en' }, storage: { getItem: () => 'fr' }, languages: null, config }), 'en');
  assert.equal(resolveLocale({ location: { search: '?lang=fr-CA' }, storage: null, languages: null, config }), 'fr');
  // …and ignored for a shipped locale outside it (es here).
  assert.equal(resolveLocale({ location: { search: '?lang=es' }, storage: { getItem: () => 'en' }, languages: null, config }), 'en');
  // Navigator matching is pair-scoped too.
  assert.equal(resolveLocale({ location: { search: '' }, storage: null, languages: ['de-DE', 'en-US'], config }), 'en');
});

test('locale pair: ?lang=fr resolves only while fr is in the pair', () => {
  assert.equal(
    resolveLocale({ location: { search: '?lang=fr' }, storage: { getItem: () => 'en' }, languages: null }),
    'en',
    'default pair (en+es): the fr override falls through to the stored pref',
  );
  assert.equal(
    resolveLocale({
      location: { search: '?lang=fr' },
      storage: { getItem: () => 'en' },
      languages: null,
      config: { defaultLocale: 'es', secondaryLocale: 'fr' },
    }),
    'fr',
  );
});

test('locale pair: a stored preference outside the pair falls through', () => {
  const config = { defaultLocale: 'fr', secondaryLocale: 'en' };
  // es was stored under a previous en+es configuration; it is out of pair now,
  // so navigator languages (pair-scoped) decide, then the configured default.
  assert.equal(resolveLocale({ location: { search: '' }, storage: { getItem: () => 'es' }, languages: ['es-MX', 'fr-FR'], config }), 'fr');
  assert.equal(resolveLocale({ location: { search: '' }, storage: { getItem: () => 'es' }, languages: ['en-US'], config }), 'en');
  assert.equal(resolveLocale({ location: { search: '' }, storage: { getItem: () => 'es' }, languages: null, config }), 'fr', '…down to the configured default');
});

test('locale pair: invalid or degenerate values fall back to en+es (dev-warn only)', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const badPairs = [
      { defaultLocale: 'de', secondaryLocale: 'es' }, // unsupported catalog locale
      { defaultLocale: 'fr', secondaryLocale: 'fr' },   // degenerate: same locale twice
      { defaultLocale: 'en', secondaryLocale: 'en' },   // degenerate default pair
      { defaultLocale: 'english', secondaryLocale: 'ES' },
    ];
    for (const bad of badPairs) {
      const pair = resolveLocalePair(bad);
      assert.equal(pair.defaultLocale, 'en', JSON.stringify(bad));
      assert.equal(pair.secondaryLocale, 'es', JSON.stringify(bad));
      assert.deepEqual([...pair.availableLocales], ['en', 'es'], JSON.stringify(bad));
      assert.equal(resolveLocale({ location: { search: '' }, storage: null, languages: null, config: bad }), 'en');
    }
  } finally {
    console.warn = originalWarn;
  }
  // import.meta.env is absent under node:test, so the DEV gate keeps the
  // console quiet here; the warn fires only on the dev server.
  assert.deepEqual(warnings, []);
});
