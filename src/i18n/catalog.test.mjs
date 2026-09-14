// Catalog parity gates: every shipped non-English locale (es, fr, ru, uk, …)
// is checked against en — it may never LEAD en (no extra keys), every shared
// key must keep identical placeholder names and plural-variant shape, and the
// strict gate demands exact key-set equality so a forgotten translation
// cannot ship silently behind the English fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCatalog, mergeNamespace } from './index.js';
import { CATALOG_LOCALES } from './locale.js';

/*
 * PARITY FLIP — how the strict gate is previewed or relaxed.
 * ─────────────────────────────────────────────────────────────────────────────
 * REQUIRE_FULL_PARITY is on by default: every shipped locale must hold the
 * exact en key set. While a NEW catalog is still an untranslated seed that
 * lags en, run CI with GEV_I18N_REQUIRE_FULL_LOCALE_PARITY=0 to drop back to
 * the subset rules (a locale may be a subset of en, never a superset). The
 * pre-generalization name GEV_I18N_REQUIRE_FULL_ES_PARITY is still honored as
 * an alias. The Spanish flip was recorded in docs/TRANSLATORS.md
 * (commit c91a923); the fr seed ships key-complete, so it already passes the
 * strict gate with English values until stage-B translation lands.
 */
const PARITY_OPT_OUT = process.env.GEV_I18N_REQUIRE_FULL_LOCALE_PARITY
  ?? process.env.GEV_I18N_REQUIRE_FULL_ES_PARITY;
const REQUIRE_FULL_PARITY = PARITY_OPT_OUT !== '0';

const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/g;

/** Placeholder names used by one catalog entry (string or plural variants). */
function placeholdersOf(entry) {
  const patterns = typeof entry === 'string' ? [entry] : Object.values(entry || {});
  const names = new Set();
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    for (const match of pattern.matchAll(PLACEHOLDER_PATTERN)) names.add(match[1]);
  }
  return names;
}

/** Shape of one entry: 'string' or the sorted plural-variant names. */
function shapeOf(entry) {
  if (typeof entry === 'string') return 'string';
  assert.ok(entry && typeof entry === 'object', `entry must be a string or variant object`);
  return Object.keys(entry).sort().join(',');
}

const enKeys = Object.keys(getCatalog('en')).sort();
// Every shipped non-en locale with its sorted key list.
const localeKeys = new Map(
  CATALOG_LOCALES
    .filter((locale) => locale !== 'en')
    .map((locale) => [locale, Object.keys(getCatalog(locale)).sort()]),
);

test('every shipped locale ships a merged catalog', () => {
  assert.deepEqual([...CATALOG_LOCALES].sort(), ['en', 'es', 'fr', 'ru', 'uk']);
  for (const locale of CATALOG_LOCALES) {
    assert.ok(getCatalog(locale), `merged catalog for ${locale}`);
  }
});

test('no locale carries keys that en does not have', () => {
  for (const [locale, keys] of localeKeys) {
    const extras = keys.filter((key) => !enKeys.includes(key));
    assert.deepEqual(
      extras,
      [],
      `extra ${locale} keys leak untranslated-only surfaces: ${extras.join(', ')}`,
    );
  }
});

test('placeholder names and plural-variant shapes match en for every shared key', () => {
  const enCatalog = getCatalog('en');
  for (const [locale, keys] of localeKeys) {
    const catalog = getCatalog(locale);
    for (const key of keys) {
      assert.deepEqual(
        [...placeholdersOf(catalog[key])].sort(),
        [...placeholdersOf(enCatalog[key])].sort(),
        `placeholder drift on ${locale}:${key}: a renamed {name} would break interpolation at runtime`,
      );
      assert.equal(
        shapeOf(catalog[key]),
        shapeOf(enCatalog[key]),
        `variant-shape drift on ${locale}:${key}`,
      );
    }
  }
});

test('exact key parity for every shipped locale once translation is complete (parity flip)', () => {
  if (!REQUIRE_FULL_PARITY) {
    // Subset mode: every locale key resolves; en-only keys fall back silently.
    for (const [locale, keys] of localeKeys) {
      for (const key of keys) assert.ok(enKeys.includes(key), `${locale}:${key}`);
    }
    return;
  }
  for (const [locale, keys] of localeKeys) {
    assert.deepEqual(keys, enKeys, `strict gate is on: ${locale} must be key-complete`);
  }
});

test('mergeNamespace prefixes relative keys and rejects malformed namespaces', () => {
  const merged = mergeNamespace({ NAMESPACE: 'demo', default: { 'a.b': 'x', plain: 'y' } });
  assert.deepEqual({ ...merged }, { 'demo.a.b': 'x', 'demo.plain': 'y' });
  assert.throws(() => mergeNamespace({}), /must export a lowercase NAMESPACE/);
  assert.throws(() => mergeNamespace({ NAMESPACE: 'Nope' }), /must export a lowercase NAMESPACE/);
  assert.throws(() => mergeNamespace({ NAMESPACE: '' }), /must export a lowercase NAMESPACE/);
  assert.deepEqual({ ...mergeNamespace({ NAMESPACE: 'empty' }) }, {});
});

test('registered namespaces produce the documented dot prefixes', () => {
  const prefixes = new Set(enKeys.map((key) => key.split('.')[0]));
  assert.deepEqual([...prefixes].sort(), ['cockpit', 'layers', 'setup', 'shell']);
});
