// src/ui/sceneSharingView.test.mjs — scene sharing's authoring bar and its
// dialog render from the scene sharing store, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useSceneSharingStore } from './stores/sceneSharing.js';
import { createSceneDialog, mountSceneSharing } from './sceneSharing.js';
import LayerPanelsView from './views/LayerPanelsView.vue';

// happy-dom may lack the modal methods; record what the view asks for.
const opened = [];
HTMLDialogElement.prototype.showModal ??= function () {
  this.open = true;
};
const showModal = HTMLDialogElement.prototype.showModal;
HTMLDialogElement.prototype.showModal = function () {
  opened.push(this.getAttribute('aria-label'));
  return showModal.call(this);
};

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(LayerPanelsView).use(pinia);
  app.mount(host);
  t.after(() => app.unmount());
  return { store: useSceneSharingStore(pinia) };
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const labels = (nodes) => nodes.map((node) => node.textContent);

test('the authoring bar sits under SAVE & SHARE, after the file row, while offered', async (t) => {
  const { store } = fixture(t);
  assert.equal($('[data-director-authoring]'), null);
  const calls = [];
  const withdraw = mountSceneSharing(
    { edit: () => calls.push('edit'), share: () => calls.push('share') },
    store,
  );
  await nextTick();
  const bar = $('[data-director-authoring]');
  assert.equal(
    bar.previousElementSibling.classList.contains('scene-file-controls'),
    true,
  );
  assert.equal(bar.className, 'scene-controls');
  const buttons = $$('[data-director-authoring] button');
  assert.deepEqual(labels(buttons), ['EDIT DETAILS', 'SHARE SCENE']);
  assert.ok(buttons.every((button) => button.title));
  assert.ok(
    buttons.every((button) => button.classList.contains('gev-action-button')),
  );
  buttons[0].click();
  buttons[1].click();
  assert.deepEqual(calls, ['edit', 'share']);

  // A newer offer survives the older one's withdrawal.
  const newer = mountSceneSharing({ edit() {}, share() {} }, store);
  withdraw();
  await nextTick();
  assert.ok($('[data-director-authoring]'));
  newer();
  await nextTick();
  assert.equal($('[data-director-authoring]'), null);
});

test('a dialog draws its lines, fields and buttons in order and opens modal', async (t) => {
  const { store } = fixture(t);
  opened.length = 0;
  const clicks = [];
  const dialog = createSceneDialog('Edit scene details', () => {}, store);
  dialog.text('Drafts are validated.');
  const details = dialog.input('Anchors', '{"a":1}', { multiline: true });
  const anchor = dialog.input('New anchor ID', 'anchor-1');
  dialog.button('Capture', () => clicks.push('capture'), { place: 'body' });
  const apply = dialog.button('Apply details', () => clicks.push('apply'), {
    hook: 'data-director-apply-details',
  });
  await nextTick();
  const root = $('dialog[data-director-dialog]');
  assert.equal(root.parentElement, document.body);
  assert.equal(root.getAttribute('aria-label'), 'Edit scene details');
  assert.equal(root.classList.contains('director-sharing-dialog'), true);
  assert.deepEqual(opened, ['Edit scene details']);
  assert.equal($('dialog h2').textContent, 'Edit scene details');
  const [body, status, footer] = [...root.children].slice(1);
  assert.equal(status.getAttribute('role'), 'status');
  assert.deepEqual(
    [...body.children].map((node) => node.tagName),
    ['P', 'LABEL', 'LABEL', 'BUTTON'],
  );
  // Cancel comes first in the footer and takes the opening focus.
  assert.deepEqual(labels([...footer.children]), ['Cancel', 'Apply details']);
  assert.equal(footer.children[0].hasAttribute('autofocus'), true);
  assert.equal(footer.children[1].hasAttribute('autofocus'), false);
  assert.equal(
    footer.children[1].hasAttribute('data-director-apply-details'),
    true,
  );

  const textarea = $('dialog textarea');
  assert.equal(textarea.value, '{"a":1}');
  assert.equal(textarea.getAttribute('aria-label'), 'Anchors');
  assert.equal($('dialog input').value, 'anchor-1');
  textarea.value = '{"b":2}';
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(details.value, '{"b":2}');
  anchor.value = 'anchor-2';
  await nextTick();
  assert.equal($('dialog input').value, 'anchor-2');

  body.children[3].click();
  footer.children[1].click();
  assert.deepEqual(clicks, ['capture', 'apply']);
  apply.disabled = true;
  await nextTick();
  assert.equal(footer.children[1].disabled, true);
  assert.equal(apply.disabled, true);
  // A disabled action does not run, even when asked directly.
  store.controls.click(
    store.dialog.items.find((item) => item.label === 'Apply details').id,
  );
  footer.children[1].click();
  assert.deepEqual(clicks, ['capture', 'apply']);

  // The owner's write reaches a focused field; typing is kept on republish.
  textarea.focus();
  details.value = '{"c":3}';
  await nextTick();
  assert.equal(textarea.value, '{"c":3}');
  textarea.value = '{"d":4}';
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  dialog.setStatus('Anchor added to draft');
  await nextTick();
  assert.equal(textarea.value, '{"d":4}');
  assert.equal(details.value, '{"d":4}');
});

test('the status line re-announces a repeated message', async (t) => {
  const { store } = fixture(t);
  const dialog = createSceneDialog('Review scene import', () => {}, store);
  await nextTick();
  const status = $('dialog [role=status]');
  assert.equal(status.textContent, '');
  const writes = [];
  const text = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
  Object.defineProperty(status, 'textContent', {
    configurable: true,
    get: () => text.get.call(status),
    set(value) {
      writes.push(value);
      text.set.call(status, value);
    },
  });
  dialog.setStatus('Ready to import');
  await nextTick();
  dialog.setStatus('Ready to import');
  await nextTick();
  assert.deepEqual(writes, ['Ready to import', 'Ready to import']);
});

test('Cancel and Escape close through the owner; dispose removes the dialog', async (t) => {
  const { store } = fixture(t);
  let closes = 0;
  const dialog = createSceneDialog(
    'Share selected scene',
    () => closes++,
    store,
  );
  await nextTick();
  $('dialog div:last-of-type button').click();
  const cancel = new Event('cancel', { cancelable: true });
  $('dialog').dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(closes, 2);
  dialog.dispose();
  await nextTick();
  assert.equal($('dialog'), null);
  assert.equal(store.controls, null);
});

test('a replaced dialog opens fresh and its late dispose leaves the new one', async (t) => {
  const { store } = fixture(t);
  opened.length = 0;
  const first = createSceneDialog('Review scene import', () => {}, store);
  await nextTick();
  const firstRoot = $('dialog');
  const second = createSceneDialog('Edit scene details', () => {}, store);
  first.dispose();
  first.text('stale');
  await nextTick();
  assert.equal($$('dialog').length, 1);
  assert.equal($('dialog') === firstRoot, false);
  assert.equal($('dialog').getAttribute('aria-label'), 'Edit scene details');
  assert.deepEqual(opened, ['Review scene import', 'Edit scene details']);
  assert.equal(
    $$('dialog p').some((p) => p.textContent === 'stale'),
    false,
  );
  second.dispose();
});

test('a file field draws translated chooser text over a native input', async (t) => {
  const { store } = fixture(t);
  const dialog = createSceneDialog('Share selected scene', () => {}, store);
  const files = dialog.input('Choose data-pack files', '', {
    type: 'file',
    multiple: true,
  });
  dialog.input('Or choose a data-pack folder', '', {
    type: 'file',
    multiple: true,
    directory: true,
  });
  await nextTick();
  const [pick, folder] = $$('dialog input[type=file]');
  assert.equal(pick.multiple, true);
  assert.equal(pick.hasAttribute('webkitdirectory'), false);
  assert.equal(folder.hasAttribute('webkitdirectory'), true);
  assert.equal(pick.style.opacity, '0');
  const chosen = () =>
    pick.parentElement.querySelector('[aria-hidden] span:last-child')
      .textContent;
  assert.equal(chosen(), 'No file chosen');

  const one = new File(['x'], 'pack.json');
  Object.defineProperty(pick, 'files', { configurable: true, value: [one] });
  pick.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  assert.equal(chosen(), 'pack.json');
  assert.equal(files.files[0] === one, true);
  Object.defineProperty(pick, 'files', {
    configurable: true,
    value: [one, new File(['y'], 'b.json')],
  });
  pick.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  assert.equal(chosen(), '2 files selected');
  assert.equal(files.files.length, 2);

  const chooser = pick.parentElement.querySelector('[aria-hidden] span');
  pick.dispatchEvent(new FocusEvent('focus'));
  await nextTick();
  assert.notEqual(chooser.style.outline, '');
  pick.dispatchEvent(new FocusEvent('blur'));
  await nextTick();
  assert.equal(chooser.style.outline, '');
  dialog.dispose();
});
