// The kit's every-control claims in docs/VUE-MIGRATION.md, read from every
// SFC outside the kit: every select is a UiSelect, every pressed toggle a
// UiButton with `pressed` (no template hand-writes `aria-pressed` on any
// element, as an attribute or inside a `v-bind` object, apart from the
// exceptions below), and every close, dismiss and clear button a
// UiCloseButton.
// Controls built in script are not read here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const KIT_ROOT = fileURLToPath(new URL('./', import.meta.url));
const REPO_ROOT = path.resolve(SRC_ROOT, '..');

// The pressed toggles that still hand-write `aria-pressed`, by file: each
// pattern matches exactly one of the file's tags, and no other tag may.
const HAND_WRITTEN_PRESSED = {
  // Explore's story cards are `role="button"` elements, not buttons.
  'src/ui/views/stories/ExploreScreen.vue': [
    /^<div class="card" role="button"/,
  ],
};

/** Every SFC under src, outside the kit. */
function sfcFiles(directory = SRC_ROOT) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (path.relative(KIT_ROOT, absolute) !== '')
        files.push(...sfcFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith('.vue'))
      files.push(absolute);
  }
  return files.sort();
}

/** The template block: everything outside script, style and comments. */
function template(source) {
  return source
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

// An opening tag's attributes, quoted values may hold `>` (`() => x`).
const ATTRS = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;
const RAW_SELECT = /<select\b/gi;
const ANY_TAG = new RegExp(String.raw`<[A-Za-z][\w-]*\b(${ATTRS})>`, 'g');
// An attribute's name, outside the quoted values.
const names = (attrs) => attrs.replace(/"[^"]*"|'[^']*'/g, '""');
const PRESSED = /(?:^|\s)(?::|v-bind:)?aria-pressed(?=[\s=/]|$)/;
// A `v-bind` object that names aria-pressed.
const BOUND_PRESSED =
  /(?:^|\s)(?:v-bind|:)=(?:"[^"]*aria-?pressed[^"]*"|'[^']*aria-?pressed[^']*')/i;
const TIMES = String.raw`×|&times;|&#215;|&#xd7;`;
const CLOSE_GLYPH = [
  TIMES,
  String.raw`<span\b${ATTRS}>\s*(?:${TIMES})\s*</span\s*>`,
  String.raw`<span\b[^>]*\bmaterial-symbols-outlined\b[^>]*>\s*close\s*</span\s*>`,
  String.raw`<UiIcon${ATTRS}\bname="close"${ATTRS}/>`,
].join('|');
const HAND_WRITTEN_CLOSE = new RegExp(
  String.raw`<(button|UiButton)\b${ATTRS}>\s*(?:${CLOSE_GLYPH})\s*</\1\s*>`,
  'gi',
);

const tidy = (markup) => markup.replace(/\s+/g, ' ');

/** Raw selects in an SFC's template. */
const rawSelects = (source) =>
  [...template(source).matchAll(RAW_SELECT)].map((m) => m[0]);

/** Tags that hand-write aria-pressed. */
function handWrittenPressed(source) {
  const found = [];
  for (const m of template(source).matchAll(ANY_TAG))
    if (PRESSED.test(names(m[1])) || BOUND_PRESSED.test(m[1]))
      found.push(tidy(m[0]));
  return found;
}

/** Hand-written close buttons in an SFC's template. */
const handWrittenCloses = (source) =>
  [...template(source).matchAll(HAND_WRITTEN_CLOSE)].map((m) => tidy(m[0]));

const views = sfcFiles().map((file) => ({
  file: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
  source: readFileSync(file, 'utf8'),
}));

test('the scans find each hand-written control', () => {
  for (const markup of [
    '<template><select id="x" v-model="a"><option>1</option></select></template>',
    '<template><SELECT\n  class="x"></SELECT></template>',
  ])
    assert.equal(rawSelects(markup).length, 1, markup);
  for (const markup of [
    '<template><UiSelect id="x" v-model="a" /></template>',
    '<script>const html = "<select>";</script><template><p /></template>',
    '<template><!-- a <select> once sat here --><p /></template>',
  ])
    assert.equal(rawSelects(markup).length, 0, markup);

  for (const markup of [
    '<template><button type="button" :aria-pressed="String(on)">A</button></template>',
    '<template><UiButton\n  class="x"\n  :title="a > b ? 1 : 2"\n  aria-pressed="true"\n>A</UiButton></template>',
    '<template><button v-bind:aria-pressed="on">A</button></template>',
    '<template><div class="card" role="button" tabindex="0" :aria-pressed="on" /></template>',
    '<template><li role="option" :aria-pressed="on" /></template>',
    '<template><a :role="\'button\'" :aria-pressed="on">A</a></template>',
    '<template><UiButton v-bind="{ \'aria-pressed\': on }">A</UiButton></template>',
  ])
    assert.equal(handWrittenPressed(markup).length, 1, markup);
  for (const markup of [
    '<template><UiButton :pressed="Boolean(on)" pressed-class="active">A</UiButton></template>',
    '<template><button :title="\'aria-pressed\'" @click="q(\'[aria-pressed=true]\')">A</button></template>',
    '<template><li role="option" :aria-selected="on" /></template>',
  ])
    assert.equal(handWrittenPressed(markup).length, 0, markup);

  for (const markup of [
    '<template><button type="button" @click="close">×</button></template>',
    '<template><button type="button" :aria-label="l"><span aria-hidden="true">×</span></button></template>',
    '<template><UiButton class="x"><UiIcon name="close" :size="null" /></UiButton></template>',
  ])
    assert.equal(handWrittenCloses(markup).length, 1, markup);
  for (const markup of [
    '<template><UiCloseButton class="x" :label="l" /></template>',
    '<template><UiButton :label="l"><UiIcon :name="item.icon" :size="null" /></UiButton></template>',
  ])
    assert.equal(handWrittenCloses(markup).length, 0, markup);
});

test('the views are read: the scan reaches the views and skips the kit', () => {
  const files = views.map((view) => view.file);
  assert.ok(files.includes('src/ui/views/panels/ChatPanel.vue'));
  assert.ok(files.includes('src/ui/layerPanel/RowRange.vue'));
  assert.ok(!files.some((file) => file.startsWith('src/ui/kit/')));
});

test('every select in the views is a UiSelect', () => {
  const found = [];
  for (const { file, source } of views)
    for (const markup of rawSelects(source)) found.push(`${file}: ${markup}`);
  assert.deepEqual(found, []);
});

test('no view hand-writes aria-pressed on a button outside the documented exceptions', () => {
  const unexpected = [];
  for (const { file, source } of views) {
    const allowed = [...(HAND_WRITTEN_PRESSED[file] ?? [])];
    for (const markup of handWrittenPressed(source)) {
      const at = allowed.findIndex((pattern) => pattern.test(markup));
      if (at === -1) unexpected.push(`${file}: ${markup}`);
      else allowed.splice(at, 1);
    }
    assert.deepEqual(allowed, [], `${file}: an exception no longer matches`);
  }
  assert.deepEqual(unexpected, []);
});

test('no view hand-writes a close button; each is a UiCloseButton', () => {
  const found = [];
  for (const { file, source } of views)
    for (const markup of handWrittenCloses(source))
      found.push(`${file}: ${markup}`);
  assert.deepEqual(found, []);
});
