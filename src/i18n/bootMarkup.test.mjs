import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { LOCALE_STORAGE_KEY } from './browser.js';
import en from './locales/en.js';
import zhCN from './locales/zh-CN.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const indexHtml = readFileSync(`${repoRoot}/index.html`, 'utf8');
const bootScript = readFileSync(`${repoRoot}/public/locale-boot.js`, 'utf8');

test('the pre-paint bootstrap is an external script the CSP allows', () => {
  assert.match(
    indexHtml,
    /<script src="\/locale-boot\.js"><\/script>/,
    'index.html must load the bootstrap from /locale-boot.js (no inline scripts)',
  );
  assert.doesNotMatch(indexHtml, /<script>(?![\s\S]*src=)/);
});

test('the pre-paint bootstrap uses the namespaced storage key', () => {
  assert.ok(
    bootScript.includes(`'${LOCALE_STORAGE_KEY}'`),
    'locale-boot.js must read gods-eye-view.locale',
  );
});

test('the pre-paint bootstrap mirrors the zh-CN loader status string', () => {
  const inline = bootScript.match(/loaderStatus\.textContent = '([^']+)';/)?.[1];
  assert.ok(inline, 'bootstrap paints the loader status');
  assert.equal(inline, zhCN.boot.loader.status);
  assert.notEqual(inline, en.boot.loader.status);
});

test('the bootstrap recognizes both supported locale prefixes', () => {
  assert.ok(bootScript.includes("lower.indexOf('en-') === 0"));
  assert.ok(bootScript.includes("lower.indexOf('zh-') === 0"));
});

test('the bootstrap sets the document language', () => {
  assert.ok(bootScript.includes('document.documentElement.lang = locale'));
});
