// The kit's every-control claims in docs/VUE-MIGRATION.md, read from every
// SFC outside the kit: every button is a kit button, every select a
// UiSelect, every checkbox a UiCheckbox, every range a UiSlider apart from
// the two named below, and every Material Symbols glyph a UiIcon; every
// pressed toggle is a UiButton with `pressed` (no template hand-writes
// `aria-pressed` on any element, as an attribute or inside a `v-bind`
// object, apart from the exceptions below), and every close, dismiss and
// clear button a UiCloseButton. Outside the kit, no module (nor an SFC's
// script) builds a button, select, field or Material glyph in script, or
// writes one as markup in a string, apart from the globe panel's standalone
// page named below.
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

// The two ranges that stay native, by file (docs/VUE-MIGRATION.md says why).
const NATIVE_RANGES = {
  'src/ui/views/panels/RadioTuner.vue': 1,
  'src/ui/views/panels/WorldTimeline.vue': 1,
};
const RAW_BUTTON = /<button\b/gi;
// A tag whose class, static or bound (alone or in a `v-bind` object), names
// a Material Symbols style.
const MATERIAL_CLASS =
  /(?:^|\s)(?:(?::|v-bind:)?class|v-bind|:)=(?:"[^"]*material-symbols[^"]*"|'[^']*material-symbols[^']*')/i;
const INPUT_TAG = new RegExp(String.raw`<input\b(${ATTRS})>`, 'gi');
// An attribute and its value, read from the tag rather than other values.
const ATTRIBUTE = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'/>]+)))?/g;
/**
 * A tag's `type`: written, bound to a quoted literal (`:type="'checkbox'"`),
 * or named in a `v-bind` object; null when it is bound to anything else.
 */
function inputType(attrs) {
  for (const m of attrs.matchAll(ATTRIBUTE)) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (name === 'type') return value.toLowerCase();
    if (name === ':type' || name === 'v-bind:type') {
      const literal = /^\s*(['`])([^'`]*)\1\s*$/.exec(value);
      if (literal) return literal[2].toLowerCase();
    }
    if (name === 'v-bind' || name === ':') {
      const named = /\btype\s*:\s*(['`])([^'`]*)\1/.exec(value);
      if (named) return named[2].toLowerCase();
    }
  }
  return null;
}

/** Hand-written buttons in an SFC's template. */
const rawButtons = (source) =>
  [...template(source).matchAll(RAW_BUTTON)].map((m) => m[0]);

/** Tags in an SFC's template that draw a Material glyph by hand. */
function materialGlyphs(source) {
  const found = [];
  for (const m of template(source).matchAll(ANY_TAG))
    if (!/^<UiIcon\b/.test(m[0]) && MATERIAL_CLASS.test(m[1]))
      found.push(tidy(m[0]));
  return found;
}

/** Native inputs of a type in an SFC's template. */
const nativeInputs = (source, type) =>
  [...template(source).matchAll(INPUT_TAG)]
    .filter((m) => inputType(m[1]) === type)
    .map((m) => tidy(m[0]));

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

test('the scans find each hand-written button, glyph, checkbox and range', () => {
  for (const markup of [
    '<template><button type="button">A</button></template>',
    '<template><BUTTON\n  class="x">A</BUTTON></template>',
  ])
    assert.equal(rawButtons(markup).length, 1, markup);
  for (const markup of [
    '<template><UiButton>A</UiButton></template>',
    '<script>const html = "<button>";</script><template><p /></template>',
    '<template><!-- a <button> once sat here --><p /></template>',
  ])
    assert.equal(rawButtons(markup).length, 0, markup);

  for (const markup of [
    '<template><span class="material-symbols-outlined">search</span></template>',
    '<template><i class="pp-icon material-symbols-rounded" aria-hidden="true">add</i></template>',
    '<template><span :class="\'material-symbols-outlined \' + extra">add</span></template>',
    '<template><span\n  class="x material-symbols-sharp"\n  :title="a > b ? 1 : 2"\n>add</span></template>',
  ])
    assert.equal(materialGlyphs(markup).length, 1, markup);
  for (const markup of [
    '<template><UiIcon name="search" class="material-symbols-outlined" :size="null" /></template>',
    '<template><span class="x">search</span></template>',
    '<template><p /></template><style>.x .material-symbols-outlined { color: red; }</style>',
  ])
    assert.equal(materialGlyphs(markup).length, 0, markup);

  assert.equal(
    nativeInputs(
      '<template><input type="checkbox" v-model="a" /></template>',
      'checkbox',
    ).length,
    1,
  );
  assert.equal(
    nativeInputs(
      '<template><input\n  class="x"\n  type="range"\n  :max="a > b ? 1 : 2"\n/></template>',
      'range',
    ).length,
    1,
  );
  assert.equal(
    nativeInputs(
      '<template><input type="text" :title="\'type=checkbox\'" /></template>',
      'checkbox',
    ).length,
    0,
  );
  assert.equal(
    nativeInputs(
      '<template><UiCheckbox v-model="a">A</UiCheckbox></template>',
      'checkbox',
    ).length,
    0,
  );
  for (const markup of [
    `<template><input :type="'checkbox'" /></template>`,
    `<template><input v-bind:type="'checkbox'" /></template>`,
    `<template><input v-bind="{ type: 'checkbox' }" /></template>`,
    '<template><input TYPE="checkbox" /></template>',
    '<template><input type=checkbox/></template>',
  ])
    assert.equal(nativeInputs(markup, 'checkbox').length, 1, markup);
  assert.equal(
    nativeInputs('<template><input :type="item.type" /></template>', 'checkbox')
      .length,
    0,
  );
  assert.equal(
    materialGlyphs(
      `<template><span v-bind="{ class: 'material-symbols-outlined' }">add</span></template>`,
    ).length,
    1,
  );
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

test('every button in the views is a kit button', () => {
  const found = [];
  for (const { file, source } of views)
    for (const markup of rawButtons(source)) found.push(`${file}: ${markup}`);
  assert.deepEqual(found, []);
});

test('every Material Symbols glyph in the views is a UiIcon', () => {
  const found = [];
  for (const { file, source } of views)
    for (const markup of materialGlyphs(source))
      found.push(`${file}: ${markup}`);
  assert.deepEqual(found, []);
});

test('every checkbox in the views is a UiCheckbox', () => {
  const found = [];
  for (const { file, source } of views)
    for (const markup of nativeInputs(source, 'checkbox'))
      found.push(`${file}: ${markup}`);
  assert.deepEqual(found, []);
});

test('every range in the views is a UiSlider apart from the two named', () => {
  const counts = {};
  for (const { file, source } of views) {
    const n = nativeInputs(source, 'range').length;
    if (n) counts[file] = n;
  }
  assert.deepEqual(counts, NATIVE_RANGES);
});

// The globe panel's standalone page: plain HTML a host serves, with no Vue
// and no kit, so its two buttons are written as markup.
const STRING_MARKUP_PAGES = new Set(['src/tools/globePanel.js']);

/**
 * Every module under src outside the kit, tests and test support, and every
 * SFC's script blocks, as `{ file, source }`.
 */
function scriptSources(directory = SRC_ROOT) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const file = path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (
        path.relative(KIT_ROOT, absolute) !== '' &&
        entry.name !== 'testSupport'
      )
        found.push(...scriptSources(absolute));
    } else if (
      !entry.isFile() ||
      /\.test\.(?:js|mjs|ts)$|Fixture\.mjs$/.test(entry.name)
    ) {
      continue;
    } else if (/\.(?:js|mjs|ts)$/.test(entry.name)) {
      found.push({ file, source: readFileSync(absolute, 'utf8') });
    } else if (entry.name.endsWith('.vue')) {
      const blocks = [
        ...readFileSync(absolute, 'utf8').matchAll(
          /<script\b[^>]*>([\s\S]*?)<\/script\s*>/g,
        ),
      ];
      found.push({ file, source: blocks.map((m) => m[1]).join('\n') });
    }
  }
  return found;
}

const SCRIPT_CONTROL =
  /\bcreateElement(?:NS)?\(\s*(?:[^,)]*,\s*)?['"`](?:button|select|input|textarea)['"`]/gi;
const SCRIPT_GLYPH =
  /['"`][^'"`]*\bmaterial-symbols-(?:outlined|rounded|sharp|\$\{)/g;
const STRING_MARKUP = /<(?:button|select|input|textarea)\b/gi;

/** A source with its comments blanked, line numbers kept. */
const uncommented = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

/** Each match in a source, as `file:line: text`. */
function hits(file, source, pattern) {
  return [...source.matchAll(pattern)].map((m) => {
    const line = source.slice(0, m.index).split('\n').length;
    return `${file}:${line}: ${source.split('\n')[line - 1].trim()}`;
  });
}

test('no module outside the kit builds a control or Material glyph in script', () => {
  const sees = (pattern, text) => [...text.matchAll(pattern)].length > 0;
  assert.ok(
    sees(SCRIPT_CONTROL, "const b = document.createElement('button');"),
  );
  assert.ok(sees(SCRIPT_CONTROL, 'doc.createElement("INPUT")'));
  assert.ok(
    sees(SCRIPT_CONTROL, "someDocument.createElement(\n  'button',\n);"),
  );
  assert.ok(!sees(SCRIPT_CONTROL, "document.createElement('div')"));
  assert.ok(
    sees(SCRIPT_GLYPH, "span.className = 'material-symbols-outlined';"),
  );
  assert.ok(sees(SCRIPT_GLYPH, 'el.className = `material-symbols-${style}`;'));
  assert.ok(
    !sees(SCRIPT_GLYPH, 'ctx.font = \'24px "Material Symbols Outlined"\';'),
  );
  assert.ok(sees(STRING_MARKUP, "host.innerHTML = '<button>x</button>';"));
  assert.ok(
    !sees(STRING_MARKUP, "'<button-row>'".replace('<button-row>', '<buttons>')),
  );

  const sources = scriptSources();
  assert.ok(
    sources.some(({ file }) => file === 'src/ui/views/panels/ChatPanel.vue'),
  );
  const found = [];
  for (const { file, source } of sources) {
    found.push(
      ...hits(file, source, SCRIPT_CONTROL),
      ...hits(file, source, SCRIPT_GLYPH),
    );
    if (!STRING_MARKUP_PAGES.has(file))
      found.push(...hits(file, uncommented(source), STRING_MARKUP));
  }
  assert.deepEqual(found, []);
  for (const file of STRING_MARKUP_PAGES) {
    const page = sources.find((s) => s.file === file);
    assert.ok(
      page && hits(file, page.source, STRING_MARKUP).length,
      `${file} no longer writes markup`,
    );
  }
});
