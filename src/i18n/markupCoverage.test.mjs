// Markup coverage gate (phase 2): every data-i18n* attribute in index.html
// must name a key that resolves in BOTH the en and es catalogs via the real
// catalog builder — a renamed or dropped catalog key can no longer strand a
// static extraction silently behind the key-itself fallback. Regex parsing is
// deliberate: no DOM dependency in unit tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getCatalog } from './index.js';

const INDEX_HTML = new URL('../../index.html', import.meta.url);

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

test('every data-i18n* attribute value resolves in both the en and es catalogs', () => {
  const enCatalog = getCatalog('en');
  const esCatalog = getCatalog('es');
  assert.ok(enCatalog && esCatalog, 'catalog builder produced both locales');
  const missing = references.filter((key) => !(key in enCatalog) || !(key in esCatalog));
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

test('the dock language selector stays wired to shell.locale keys', () => {
  const selector = html.match(/<div class="dock-locale-switch"[\s\S]*?<\/div>/);
  assert.ok(selector, 'the EN|ES selector is missing from the control-panel tray');
  assert.match(selector[0], /data-locale="en"[^>]*aria-pressed="true"/, 'English is the default locale');
  assert.match(selector[0], /data-locale="es"[^>]*aria-pressed="false"/);
  assert.match(selector[0], /data-i18n-aria-label="shell\.locale\.groupAriaLabel"/);
  assert.match(selector[0], /data-i18n-aria-label="shell\.locale\.english\.ariaLabel"/);
  assert.match(selector[0], /data-i18n-aria-label="shell\.locale\.spanish\.ariaLabel"/);
  // Phase-2 contract: markup only — no listener may attach before phase 3.
  assert.doesNotMatch(selector[0], / onclick| onsubmit| javascript:/i);
});
