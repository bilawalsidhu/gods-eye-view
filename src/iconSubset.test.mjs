import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

/**
 * Icon-font subset contract (Batch 6).
 *
 * index.html requests Material Symbols Outlined with `icon_names=…` — a
 * ~4 KB subset instead of the ~330 KB variable font (measured 2026-09-13).
 * The failure mode this guards against is silent and ugly: a glyph that is
 * rendered but not listed in `icon_names` displays as its literal word
 * (e.g. "rocket_launch" as body text mid-cockpit), because the subset font
 * has no ligature for it.
 *
 * The extraction below is deliberately BROAD: every `material-symbols`
 * anchor contributes a 400-character window, and every lowercase snake_case
 * string literal inside that window is treated as a candidate glyph. Markup
 * text (`<span class="material-symbols-outlined">radar</span>`) is matched
 * exactly. Over-inclusion is safe — Google Fonts ignores unknown names in
 * `icon_names` (verified: the CSS still returns 200) — while under-
 * inclusion breaks the UI, so the test only fails when something is MISSING.
 * When it fails, add the new glyph to the URL in index.html.
 */

const SOURCE_GLOBS = ['src/**/*.js', 'src/**/*.mjs', 'index.html'];
const files = globSync(SOURCE_GLOBS.length === 1 ? SOURCE_GLOBS[0] : SOURCE_GLOBS, {
  exclude: (f) => f.includes('.test.mjs'),
});

const ANCHOR = /material-symbols/g;
const STR_LIT = /'([a-z][a-z0-9_]{1,40})'/g;
const TAG_TEXT = /class="[^"]*material-symbols[^"]*"[^>]*>\s*([a-z][a-z0-9_]*)\s*</g;
const WINDOW = 400;

function usedGlyphCandidates() {
  const found = new Set();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(TAG_TEXT)) found.add(m[1]);
    for (const m of source.matchAll(ANCHOR)) {
      const window = source.slice(m.index, m.index + WINDOW);
      for (const lit of window.matchAll(STR_LIT)) found.add(lit[1]);
    }
  }
  return found;
}

function declaredGlyphs() {
  const html = readFileSync('index.html', 'utf8');
  const link = html.match(/<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Material\+Symbols\+Outlined[^"]*"/);
  assert.ok(link, 'the Material Symbols Outlined stylesheet link is present');
  // link[0] includes the closing quote of the href attribute — strip it.
  const href = link[0].slice('<link href="'.length, -1);
  const names = new URL(href).searchParams.get('icon_names');
  assert.ok(names, 'the icon stylesheet must request a subset via icon_names');
  return new Set(names.split(','));
}

test('every rendered icon glyph is declared in the Material Symbols subset', () => {
  const used = usedGlyphCandidates();
  assert.ok(used.size > 10, `glyph extraction still finds usage (found ${used.size})`);
  const declared = declaredGlyphs();
  const missing = [...used].filter((g) => !declared.has(g));
  assert.deepEqual(
    missing,
    [],
    `glyphs rendered by the source but missing from index.html icon_names ` +
      `(they would display as literal words): ${missing.join(', ')}`,
  );
});

test('the unused second icon family is not fetched', () => {
  const html = readFileSync('index.html', 'utf8');
  assert.doesNotMatch(html, /Material\+Icons\+Round|family=Material\+Icons/,
    'no stylesheet may load an icon family nothing uses');
});
