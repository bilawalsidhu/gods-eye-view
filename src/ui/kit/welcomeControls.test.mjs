// The welcome card's buttons and Material glyphs are the kit's: its template
// hand-writes no <button> and no Material Symbols span, and its one box is a
// UiCheckbox. Its two inline SVGs (Default mode's globe and its callouts) are
// drawings, not glyphs, and its outbound links stay links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../views/WelcomeView.vue', import.meta.url),
  'utf8',
);
/** The template block: everything outside script and style. */
const template = source.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/g, '');

test('the welcome card hand-writes no button; each is a UiButton', () => {
  assert.deepEqual(template.match(/<button\b/gi) ?? [], []);
  // SKIP, the three start tiles, BROWSE STORIES, BACK and the main action.
  assert.equal(template.match(/<UiButton\b/g)?.length, 7);
  assert.equal(template.match(/<UiCheckbox\b/g)?.length, 1);
});

test('the welcome card hand-writes no Material glyph; each is a UiIcon', () => {
  assert.deepEqual(template.match(/material-symbols-outlined/g) ?? [], []);
  const icons = template.match(/<UiIcon\b[^>]*>/g) ?? [];
  // The three tiles, the three tips, the Stories card and the main arrow.
  assert.equal(icons.length, 8);
  // Without it the kit writes an 18px size that beats first-run.css's rules.
  for (const icon of icons) assert.match(icon, /:size="null"/);
});

test('the only inline SVGs are Default mode preview drawings', () => {
  const svgs = [...template.matchAll(/<svg\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(svgs.length, 2);
  assert.match(svgs[0], /class="first-run-globe"/);
  assert.match(svgs[1], /class="first-run-callouts"/);
});
