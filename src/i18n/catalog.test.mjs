// Catalog parity gates: while es is an untranslated seed it may LAG en (a
// subset), it may never LEAD en (no extra keys), and every shared key must
// keep identical placeholder names and plural-variant shape so stage-4
// translation can fill values without schema surprises.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCatalog, mergeNamespace } from './index.js';
import { CATALOG_LOCALES } from './locale.js';

/*
 * PARITY FLIP — how this gate tightens once stage-4 translation completes.
 * ─────────────────────────────────────────────────────────────────────────────
 * While es is seeded/lagging, REQUIRE_FULL_ES_PARITY stays false and only the
 * subset rules below run. When the Spanish catalog is complete, flip this
 * default to `true` (one line) — or run CI with
 * GEV_I18N_REQUIRE_FULL_ES_PARITY=1 to preview the strict gate — and the
 * "exact key parity" test starts failing on any key present in en but missing
 * in es, so a forgotten translation can no longer ship behind the English
 * fallback. The flip is recorded in ai_docs/i18n-ownership.md.
 */
// Flipped to strict by the integrator on stage-3 completion: all four es
// catalogs are fully translated (shell/cockpit/layers/setup).
const REQUIRE_FULL_ES_PARITY = process.env.GEV_I18N_REQUIRE_FULL_ES_PARITY !== '0';

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
const esKeys = Object.keys(getCatalog('es')).sort();

test('every shipped locale ships a merged catalog', () => {
  assert.deepEqual([...CATALOG_LOCALES].sort(), ['en', 'es', 'fr']);
  for (const locale of CATALOG_LOCALES) {
    assert.ok(getCatalog(locale), `merged catalog for ${locale}`);
  }
});

test('es never carries keys that en does not have', () => {
  const extras = esKeys.filter((key) => !enKeys.includes(key));
  assert.deepEqual(extras, [], `extra es keys leak untranslated-only surfaces: ${extras.join(', ')}`);
});

test('es placeholder names and plural-variant shapes match en for every shared key', () => {
  const enCatalog = getCatalog('en');
  const esCatalog = getCatalog('es');
  for (const key of esKeys) {
    const enEntry = enCatalog[key];
    const esEntry = esCatalog[key];
    assert.deepEqual(
      [...placeholdersOf(esEntry)].sort(),
      [...placeholdersOf(enEntry)].sort(),
      `placeholder drift on ${key}: a renamed {name} would break interpolation at runtime`,
    );
    assert.equal(shapeOf(esEntry), shapeOf(enEntry), `variant-shape drift on ${key}`);
  }
});

test('exact key parity once the Spanish translation is complete (parity flip)', () => {
  if (!REQUIRE_FULL_ES_PARITY) {
    // Subset mode: every es key resolves; en-only keys fall back silently.
    for (const key of esKeys) assert.ok(enKeys.includes(key));
    return;
  }
  assert.deepEqual(esKeys, enKeys, 'stage-4 flip is on: es must be complete');
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
