import { readSource } from '../testSupport/readSource.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { confirmDialog, promptDialog } from './promptDialog.js';

/** Minimal element stub: records children and exposes the surface the
 *  dialog module touches (no real DOM in the test harness). */
function makeEl(tag) {
  const listeners = {};
  return {
    tag,
    children: [],
    className: '',
    id: '',
    textContent: '',
    value: '',
    type: '',
    method: '',
    htmlFor: '',
    autocomplete: '',
    spellcheck: false,
    returnValue: '',
    removed: false,
    clicks: 0,
    setAttribute(name, v) { this[`attr:${name}`] = v; },
    getAttribute(name) { return this[`attr:${name}`] ?? null; },
    append(...els) { this.children.push(...els); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    emit(type, event = {}) { for (const fn of listeners[type] || []) fn(event); },
    click() { this.clicks += 1; },
    showModal() { this.showModalCalled = true; },
    select() { this.selectCalled = true; },
    remove() { this.removed = true; },
  };
}

/** Install a fake document/body for the duration of `run`. The created
 *  elements are exposed on the `els` object the callback receives. */
async function withFakeDocument(run) {
  const els = { created: [], body: makeEl('body') };
  const saved = { document: globalThis.document };
  globalThis.document = {
    createElement: (tag) => {
      const el = makeEl(tag);
      els.created.push(el);
      return el;
    },
    body: els.body,
  };
  try {
    return await run(els);
  } finally {
    globalThis.document = saved.document;
  }
}

const dialogOf = (els) => els.created.find((el) => el.tag === 'dialog');
const CONFIRM = '__gev_confirm__';

test('promptDialog shows a modal, preselects the value, and resolves it on confirm', async () => {
  await withFakeDocument(async (els) => {
    const pending = promptDialog({ title: 'Rename shot', label: 'Shot title', value: 'Shot 1' });
    const dialog = dialogOf(els);
    assert.equal(dialog.showModalCalled, true, 'uses showModal (focus trap + inert page)');
    assert.equal(dialog.getAttribute('aria-labelledby'), 'gev-prompt-dialog-title');

    const heading = dialog.children.find((el) => el.id === 'gev-prompt-dialog-title');
    assert.equal(heading.textContent, 'Rename shot', 'heading carries the title');

    const form = dialog.children.find((el) => el.tag === 'form');
    const label = form.children.find((el) => el.htmlFor === 'gev-prompt-input');
    assert.equal(label.textContent, 'Shot title', 'the field has a visible label');

    const input = form.children.find((el) => el.id === 'gev-prompt-input');
    assert.equal(input.value, 'Shot 1');
    assert.equal(input.getAttribute('autofocus'), '', 'input claims focus on open');
    assert.equal(input.selectCalled, true, 'initial value is preselected like window.prompt');

    // A dialog-method submit sets returnValue from the submitter before the
    // close event fires, which is how the module tells confirm from cancel.
    dialog.returnValue = CONFIRM;
    input.value = '  Renamed  ';
    dialog.emit('close');

    assert.equal(await pending, '  Renamed  ', 'resolves the untrimmed input');
    assert.equal(dialog.removed, true, 'dialog is removed from the DOM');
  });
});

test('promptDialog resolves null on cancel/Esc (returnValue stays empty)', async () => {
  await withFakeDocument(async (els) => {
    const pending = promptDialog({ title: 't', label: 'l', value: 'x' });
    dialogOf(els).emit('close'); // Esc / cancel leave returnValue ''
    assert.equal(await pending, null);
  });
});

test('Enter in the input confirms instead of tripping the first (Cancel) submitter', async () => {
  await withFakeDocument(async (els) => {
    const pending = promptDialog({ title: 't', label: 'l', value: 'x' });
    const dialog = dialogOf(els);
    const form = dialog.children.find((el) => el.tag === 'form');
    const input = form.children.find((el) => el.id === 'gev-prompt-input');
    const confirmBtn = form.children.find((el) => el.className === 'gev-dialog-actions')
      .children.find((el) => el.textContent === 'OK');

    const event = { key: 'Enter', preventDefault() { this.defaultPrevented = true; } };
    input.emit('keydown', event);
    assert.equal(event.defaultPrevented, true, 'implicit submission is suppressed');
    assert.equal(confirmBtn.clicks, 1, 'the confirm button is activated');

    dialog.emit('close'); // the module never resolves off this synthetic path twice
    assert.equal(await pending, null, 'resolution still flows through the close event');
  });
});

test('confirmDialog resolves true only for the confirm button', async () => {
  await withFakeDocument(async (els) => {
    const pending = confirmDialog({ title: 'Delete shot', message: 'Really?' });
    const dialog = dialogOf(els);
    const form = dialog.children.find((el) => el.tag === 'form');
    assert.equal(form.children.find((el) => el.tag === 'p').textContent, 'Really?');

    dialog.returnValue = '';
    dialog.emit('close');
    assert.equal(await pending, false, 'Esc/cancel resolves false like window.confirm');
  });

  await withFakeDocument(async (els) => {
    const pending = confirmDialog({ title: 'Delete shot', message: 'Really?' });
    const dialog = dialogOf(els);
    dialog.returnValue = CONFIRM;
    dialog.emit('close');
    assert.equal(await pending, true);
  });
});

test('the scene director no longer uses blocking dialogs', () => {
  const source = readSource('../scenes/director.js', import.meta.url);
  assert.doesNotMatch(source, /window\.(prompt|confirm)\(/,
    'blocking dialogs freeze the render loop and bypass focus management');
  assert.match(source, /import \{ confirmDialog, promptDialog \} from '\.\.\/ui\/promptDialog\.js';/);
  assert.match(source, /await promptDialog\(/);
  assert.match(source, /await confirmDialog\(/);
});

test('the dialog styles keep a visible keyboard focus ring and labelled surface', () => {
  const css = readSource('../../style.css', import.meta.url);
  assert.match(css, /\.gev-prompt-dialog :focus-visible[\s\S]*?outline: 2px solid var\(--accent\)/);
  assert.match(css, /\.gev-confirm-dialog :focus-visible[\s\S]*?outline: 2px solid var\(--accent\)/);
  assert.match(css, /\.gev-dialog-input \{[\s\S]*?background: var\(--bg-dark\)/,
    'the field is opaque over the translucent panel');
});
