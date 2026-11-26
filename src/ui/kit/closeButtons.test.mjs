// Every close, dismiss and clear button in a Vue view is a UiCloseButton: no
// SFC template hand-writes a button whose only content is × (bare or in a
// span) or the Material `close` symbol. Buttons built in script are not read
// here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPO_ROOT = path.resolve(SRC_ROOT, '..');

/** Every SFC under src. */
function sfcFiles(directory = SRC_ROOT) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sfcFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.vue'))
      files.push(absolute);
  }
  return files.sort();
}

/** The template block: everything outside script and style. */
function template(source) {
  return source.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/g, '');
}

// An opening tag's attributes, quoted values may hold `>` (`() => x`).
const ATTRS = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;
const BUTTON = String.raw`(button|UiButton)`;
const TIMES = String.raw`×|&times;|&#215;|&#xd7;`;
const CLOSE_GLYPH = [
  TIMES,
  String.raw`<span\b${ATTRS}>\s*(?:${TIMES})\s*</span\s*>`,
  String.raw`<span\b[^>]*\bmaterial-symbols-outlined\b[^>]*>\s*close\s*</span\s*>`,
  String.raw`<UiIcon${ATTRS}\bname="close"${ATTRS}/>`,
].join('|');
const HAND_WRITTEN_CLOSE = new RegExp(
  String.raw`<${BUTTON}\b${ATTRS}>\s*(?:${CLOSE_GLYPH})\s*</\1\s*>`,
  'gi',
);

/** Hand-written close buttons in an SFC's template. */
function handWrittenCloses(source) {
  return [...template(source).matchAll(HAND_WRITTEN_CLOSE)].map((m) =>
    m[0].replace(/\s+/g, ' '),
  );
}

test('the scan finds each hand-written close glyph', () => {
  for (const markup of [
    '<template><button type="button" @click="emit(\'close\')">×</button></template>',
    '<template><button\n  class="x"\n  :title="a > b ? 1 : 2"\n  >×</button\n></template>',
    '<template><UiButton class="x" :label="l">&times;</UiButton></template>',
    '<template><button type="button" class="x">\n  <span class="material-symbols-outlined" aria-hidden="true">close</span>\n</button></template>',
    '<template><UiButton class="x"><UiIcon name="close" :size="14" /></UiButton></template>',
    '<template><button type="button" :aria-label="l"><span aria-hidden="true">×</span></button></template>',
    '<template><UiButton class="x">\n  <span class="glyph">&times;</span>\n</UiButton></template>',
  ])
    assert.equal(handWrittenCloses(markup).length, 1, markup);
  for (const markup of [
    '<template><UiCloseButton class="x" :label="l" /></template>',
    '<template><button type="button">{{ name }} ×</button></template>',
    '<template><button type="button"><span>{{ name }}</span> ×</button></template>',
    '<template><button type="button">On<span class="material-symbols-outlined">close</span></button></template>',
    '<template><button type="button"><span class="material-symbols-outlined">close_fullscreen</span></button></template>',
  ])
    assert.equal(handWrittenCloses(markup).length, 0, markup);
});

test('no SFC hand-writes a close button; each is a UiCloseButton', () => {
  const found = [];
  for (const file of sfcFiles()) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    for (const markup of handWrittenCloses(readFileSync(file, 'utf8')))
      found.push(`${relative}: ${markup}`);
  }
  assert.deepEqual(found, []);
});
