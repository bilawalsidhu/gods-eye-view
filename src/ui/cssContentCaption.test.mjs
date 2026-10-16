// The CCTV "ACQUIRING FRAME" caption lives in CSS `content:` and the
// i18n scanner (scripts/i18n.mjs) never reads CSS, so es/ru show it in English.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STYLES = path.join(HERE, 'styles');
const LOCALES = path.join(HERE, '..', 'i18n', 'locales');
// cyber.css carries decorative theme strings (LOC / GRID, SYS 06 // ...);
// street-level.css ' · ESC' is a key cap. Neither is UI copy.
const DECORATIVE = new Set(['cyber.css', 'street-level.css']);

test('no user-visible text in CSS content: outside decorative themes', () => {
  const hits = [];
  for (const file of readdirSync(STYLES)) {
    if (!file.endsWith('.css') || DECORATIVE.has(file)) continue;
    const css = readFileSync(path.join(STYLES, file), 'utf8');
    css.split('\n').forEach((line, i) => {
      if (/^\s*content:\s*['"][^'"]*[A-Za-z]{2,}/.test(line))
        hits.push(`${file}:${i + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('the CCTV acquisition caption has es and ru translations', () => {
  for (const lang of ['es', 'ru']) {
    const dict = JSON.parse(readFileSync(path.join(LOCALES, `${lang}.json`), 'utf8'));
    assert.ok('ACQUIRING FRAME' in dict, `${lang}.json lacks "ACQUIRING FRAME"`);
  }
});
