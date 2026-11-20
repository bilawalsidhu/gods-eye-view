// Every modal dialog in a Vue view is a UiDialog: no SFC template hand-writes
// `<dialog>`. Panels drawn as `role="dialog"` (key setup, the welcome
// launcher, the CCTV popup, Story Explore's filter, the credits, the Omnibar
// guide's callout) and the render failure's `alertdialog` are other
// controls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPO_ROOT = path.resolve(SRC_ROOT, '..');
const KIT = 'src/ui/kit/UiDialog.vue';

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
const HAND_WRITTEN_DIALOG = new RegExp(String.raw`<dialog\b${ATTRS}>`, 'gi');

/** Hand-written dialogs in an SFC's template. */
function handWrittenDialogs(source) {
  return [...template(source).matchAll(HAND_WRITTEN_DIALOG)].map((m) =>
    m[0].replace(/\s+/g, ' '),
  );
}

test('the scan finds each hand-written dialog', () => {
  for (const markup of [
    '<template><dialog id="x" @cancel.prevent="on"><p /></dialog></template>',
    '<template><dialog\n  :open="a > b"\n  class="x"\n>…</dialog></template>',
  ])
    assert.equal(handWrittenDialogs(markup).length, 1, markup);
  for (const markup of [
    '<template><UiDialog :open="on" @dismiss="off"><p /></UiDialog></template>',
    '<template><div role="dialog" aria-modal="true" /></template>',
    "<script>const html = '<dialog open>';</script><template><p /></template>",
  ])
    assert.equal(handWrittenDialogs(markup).length, 0, markup);
});

test('no SFC hand-writes a dialog; each is a UiDialog', () => {
  const found = [];
  for (const file of sfcFiles()) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    if (relative === KIT) continue;
    for (const markup of handWrittenDialogs(readFileSync(file, 'utf8')))
      found.push(`${relative}: ${markup}`);
  }
  assert.deepEqual(found, []);
});
