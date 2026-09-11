// Markup coverage gate (phase 2): every data-i18n* attribute in index.html
// must name a key that resolves in EVERY shipped catalog via the real
// catalog builder — a renamed or dropped catalog key can no longer strand a
// static extraction silently behind the key-itself fallback. Regex parsing is
// deliberate: no DOM dependency in unit tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getCatalog } from './index.js';
import { CATALOG_LOCALES, availableLocales } from './locale.js';

const INDEX_HTML = new URL('../../index.html', import.meta.url);
const UI_JS = new URL('../../src/ui.js', import.meta.url);

// The four spellings applyDocumentTranslations() knows about. Anything else
// (a typo like data-i18n-lable) must fail here, not silently never apply.
const I18N_ATTRIBUTE_PATTERN = /data-i18n(?:-title|-aria-label|-placeholder)?="([^"]+)"/g;
const KNOWN_ATTRIBUTE_NAMES = new Set([
  'data-i18n',
  'data-i18n-title',
  'data-i18n-aria-label',
  'data-i18n-placeholder',
]);

const html = readFileSync(INDEX_HTML, 'utf8');

const references = [...html.matchAll(I18N_ATTRIBUTE_PATTERN)].map((match) => match[1]);

test('index.html carries static i18n references', () => {
  assert.ok(references.length > 0, 'no data-i18n* attributes found — extraction missing?');
});

test('every data-i18n* attribute value resolves in every shipped catalog', () => {
  const catalogs = Object.fromEntries(CATALOG_LOCALES.map((locale) => [locale, getCatalog(locale)]));
  for (const locale of CATALOG_LOCALES) {
    assert.ok(catalogs[locale], `catalog builder produced the ${locale} locale`);
  }
  const missing = references.filter((key) => (
    CATALOG_LOCALES.some((locale) => !(key in catalogs[locale]))
  ));
  assert.deepEqual(
    [...new Set(missing)],
    [],
    'static markup references keys absent from a catalog (translation would fall back or render the key)',
  );
});

test('no unknown data-i18n* attribute spelling sneaks past the application pass', () => {
  const stray = [...html.matchAll(/(data-i18n[a-z-]*)="/g)]
    .map((match) => match[1])
    .filter((name) => !KNOWN_ATTRIBUTE_NAMES.has(name));
  assert.deepEqual(
    [...new Set(stray)],
    [],
    'applyDocumentTranslations() only applies the four known attributes; a fifth spelling is dead markup',
  );
});

test('attribute values are well-formed catalog keys', () => {
  for (const key of references) {
    assert.match(key, /^(shell|cockpit|layers|setup)\.[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)*$/, `malformed key: ${key}`);
  }
});

test('the dock language switch keeps a static group container with runtime-rendered buttons', () => {
  const selector = html.match(/<div class="dock-locale-switch"[\s\S]*?<\/div>/);
  assert.ok(selector, 'the locale switch group is missing from the control-panel tray');
  assert.match(selector[0], /data-i18n-aria-label="shell\.locale\.groupAriaLabel"/);
  // Buttons are no longer static: ui.js _initLocaleSelector() renders one per
  // locale in the configured pair (GEV_DEFAULT_LOCALE / GEV_SECONDARY_LOCALE).
  assert.doesNotMatch(
    selector[0],
    /dock-locale-btn/,
    'static selector buttons must move to the runtime renderer so the configured pair shapes the switch',
  );
  // Markup-only contract: no listener may attach from markup.
  assert.doesNotMatch(selector[0], / onclick| onsubmit| javascript:/i);
});

test('every offered locale has a shell.locale.<code>.ariaLabel in every catalog; the replaced family stays deleted', () => {
  // The runtime renderer reads shell.locale.<code>.ariaLabel for every locale
  // availableLocales() can yield under any configuration — i.e. every shipped
  // catalog locale — and it must exist in every catalog.
  for (const catalogLocale of CATALOG_LOCALES) {
    const catalog = getCatalog(catalogLocale);
    for (const code of CATALOG_LOCALES) {
      assert.ok(
        catalog[`shell.locale.${code}.ariaLabel`],
        `${catalogLocale} catalog is missing shell.locale.${code}.ariaLabel for the runtime selector`,
      );
    }
    assert.equal(catalog['shell.locale.english.ariaLabel'], undefined,
      'the replaced phase-2 english.ariaLabel key stays deleted');
    assert.equal(catalog['shell.locale.spanish.ariaLabel'], undefined,
      'the replaced phase-2 spanish.ariaLabel key stays deleted');
  }
  // Default configuration pins the pair the shipped build offers.
  assert.deepEqual([...availableLocales()], ['en', 'es']);
});

test('ui.js _initLocaleSelector renders the configured pair (runtime contract)', () => {
  const source = readFileSync(UI_JS, 'utf8');
  const start = source.indexOf('_initLocaleSelector() {');
  assert.ok(start >= 0, '_initLocaleSelector method not found in src/ui.js');
  const body = source.slice(start, source.indexOf('\n  }\n', start));
  assert.ok(body.length > 0, '_initLocaleSelector body not extracted');
  assert.match(body, /availableLocales\(\)/, 'iterates the resolved pair, not a hardcoded EN|ES');
  assert.match(body, /shell\.locale\.\$\{locale\}\.ariaLabel/, 'aria-labels come from the locale key family');
  assert.match(body, /toUpperCase\(\)/, 'labels are uppercase locale codes');
  assert.match(body, /aria-pressed/, 'pressed state is synced');
  assert.match(body, /persistLocaleAndReload/, 'clicks persist and reload');
  assert.match(body, /dock-locale-switch/, 'renders into the static group container');
});
