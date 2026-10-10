import assert from 'node:assert/strict';
import test from 'node:test';

import en from './en.js';
import zhCN from './zh-CN.js';

function flatten(node, prefix = '') {
  const entries = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') entries.push(...flatten(value, path));
    else entries.push([path, value]);
  }
  return entries;
}

function placeholderNames(value) {
  const text = typeof value === 'string' ? value : '';
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

test('both packs ship the same key sets', () => {
  const enKeys = flatten(en).map(([key]) => key);
  const zhKeys = new Set(flatten(zhCN).map(([key]) => key));
  const missingInZh = enKeys.filter((key) => !zhKeys.has(key));
  assert.deepEqual(
    missingInZh,
    [],
    `zh-CN pack is missing keys: ${missingInZh.join(', ')}`,
  );
  const enKeySet = new Set(enKeys);
  const extraInZh = [...zhKeys].filter((key) => !enKeySet.has(key));
  assert.deepEqual(
    extraInZh,
    [],
    `zh-CN pack defines keys absent from en: ${extraInZh.join(', ')}`,
  );
});

test('both packs interpolate the same placeholder names per key', () => {
  const enMap = new Map(flatten(en));
  for (const [key, value] of flatten(zhCN)) {
    assert.deepEqual(
      placeholderNames(value),
      placeholderNames(enMap.get(key)),
      `placeholder mismatch for ${key}`,
    );
  }
});

test('plural entries that define "one" also define "other" in both packs', () => {
  function scanPlurals(node, prefix, pack) {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if ('one' in value) {
          assert.ok(
            'other' in value,
            `${pack} pack: plural entry ${path} lacks an "other" category`,
          );
        }
        scanPlurals(value, path, pack);
      }
    }
  }
  scanPlurals(en, '', 'en');
  scanPlurals(zhCN, '', 'zh-CN');
});
