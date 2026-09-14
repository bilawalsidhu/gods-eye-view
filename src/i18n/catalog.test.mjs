// Catalog parity gates: every shipped non-English locale (es, fr, ru, uk, …)
// is checked against en — it may never LEAD en (no extra keys), every shared
// key must keep identical placeholder names, and plural entries must carry
// every en variant plus only categories Intl.PluralRules reports valid for
// that locale (see assertVariantSuperset below); the strict gate demands
// exact key-set equality so a forgotten translation cannot ship silently
// behind the English fallback.
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

/*
 * PLURAL-SHAPE PARITY, GENERALIZED FOR MULTI-CATEGORY LOCALES
 * ─────────────────────────────────────────────────────────────────────────────
 * en plural entries carry { one, other } — the only cardinal categories
 * Intl.PluralRules reports for English. Slavic locales such as ru/uk select
 * one/few/many/other, so exact-shape equality with en would forbid their
 * grammars. The rule is now, per locale and shared key:
 *   (a) the entry must carry EVERY variant en has (they are mandatory — the
 *       runtime reads entry.<category> ?? entry.other, so dropping an en
 *       variant strands the fallback), and
 *   (b) every variant added beyond en's must be a cardinal category
 *       Intl.PluralRules reports VALID for that locale
 *       (resolvedOptions().validCategories, spelled pluralCategories on
 *       older runtimes; e.g. 'few'/'many' are valid for ru/uk but not en).
 * en itself can never grow a variant (English's valid set is exactly
 * one/other), and a typo'd variant like 'xother' fails loudly for any
 * locale. The runtime degrades gracefully the other way: an entry lacking a
 * category its locale would select renders entry.other (selectPluralPattern
 * in src/i18n/index.js; pinned in i18n.test.mjs).
 */

/** Cardinal plural categories Intl may select for a locale. */
function validPluralCategories(locale) {
  const { validCategories, pluralCategories } = new Intl.PluralRules(locale).resolvedOptions();
  // The property was renamed pluralCategories → validCategories in newer
  // ECMAScript drafts; read whichever the running ICU exposes.
  const categories = validCategories ?? pluralCategories;
  assert.ok(Array.isArray(categories), `Intl.PluralRules(${locale}) exposes no category set`);
  return new Set(categories);
}

/** Assert the plural-shape rule for one locale entry against its en twin. */
function assertVariantSuperset(localeEntry, enEntry, locale, key) {
  assert.equal(
    typeof localeEntry,
    typeof enEntry,
    `variant-shape drift on ${locale}:${key}: string ↔ plural-object mismatch`,
  );
  if (typeof enEntry === 'string') return;
  const enVariants = Object.keys(enEntry);
  const variants = Object.keys(localeEntry);
  const missing = enVariants.filter((variant) => !variants.includes(variant));
  assert.deepEqual(
    missing,
    [],
    `${locale}:${key} must keep every en variant (${enVariants.join(',')})`,
  );
  const valid = validPluralCategories(locale);
  const invalid = variants.filter((variant) => !enVariants.includes(variant) && !valid.has(variant));
  assert.deepEqual(
    invalid,
    [],
    `${locale}:${key} adds categories Intl.PluralRules(${locale}) never selects: ${invalid.join(',')}`,
  );
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

test('placeholder names match en; plural variants form an en-superset of Intl-valid categories', () => {
  const enCatalog = getCatalog('en');
  for (const [locale, keys] of localeKeys) {
    const catalog = getCatalog(locale);
    for (const key of keys) {
      assert.deepEqual(
        [...placeholdersOf(catalog[key])].sort(),
        [...placeholdersOf(enCatalog[key])].sort(),
        `placeholder drift on ${locale}:${key}: a renamed {name} would break interpolation at runtime`,
      );
      assertVariantSuperset(catalog[key], enCatalog[key], locale, key);
    }
  }
});

test('plural-shape rule: ru accepts its full Intl category set and rejects categories it never selects', () => {
  const enEntry = { one: 'Cleared {count} layer', other: 'Cleared {count} layers' };
  // ru selects one/few/many/other, so the full four-variant translation of
  // an en { one, other } twin is a legal superset (adds only valid ru
  // categories) — exactly what stage-B translators must produce…
  assert.doesNotThrow(() => assertVariantSuperset(
    { one: '…', few: '…', many: '…', other: '…' },
    enEntry,
    'ru',
    'layers.clear.toast.cleared',
  ));
  // …while a variant Intl never selects for ru (a typo like 'xother') fails.
  assert.throws(
    () => assertVariantSuperset({ one: '…', other: '…', xother: '…' }, enEntry, 'ru', 'demo.key'),
    /xother/,
  );
  // Dropping a mandatory en variant fails even when all additions are valid.
  assert.throws(
    () => assertVariantSuperset({ few: '…', many: '…', other: '…' }, enEntry, 'ru', 'demo.key'),
    /every en variant/,
  );
  // String ↔ plural-object drift still fails exactly as before.
  assert.throws(
    () => assertVariantSuperset('plain string', enEntry, 'ru', 'demo.key'),
    /string ↔ plural-object/,
  );
  // The gate stays honest about what the runtime can select: validCategories
  // is read from Intl, not hardcoded per locale.
  assert.deepEqual([...validPluralCategories('en')].sort(), ['one', 'other']);
  assert.deepEqual([...validPluralCategories('ru')].sort(), ['few', 'many', 'one', 'other']);
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
