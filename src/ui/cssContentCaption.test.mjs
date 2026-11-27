// The i18n scanner (scripts/i18n.mjs) never reads CSS, so text in CSS
// `content:` would stay English in every language.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STYLES = path.join(HERE, 'styles');
// street-level.css ' · ESC' is a key cap, not UI copy.
const DECORATIVE = new Set(['street-level.css']);

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
