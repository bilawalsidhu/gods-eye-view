import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../../testSupport/vueDom.mjs';

let mount;
let nextTick;
let UiDialog;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  ({ mount } = await import('@vue/test-utils'));
  ({ nextTick } = await import('vue'));
  UiDialog = (await import('./UiDialog.vue')).default;
});
after(() => uninstall());

/**
 * A dialog that records what it emits, each with whether the dialog was open
 * then; its content is a paragraph. One is mounted at a time.
 */
function dialog(props = {}, attrs = {}) {
  const events = [];
  const record = (name) => () =>
    events.push(
      name,
      document.querySelector('dialog').open ? 'shown' : 'hidden',
    );
  const wrapper = mount(UiDialog, {
    attachTo: document.body,
    props: {
      ...props,
      onDismiss: record('dismiss'),
      onBrowserClose: record('browserClose'),
      onOpened: record('opened'),
      onClosed: record('closed'),
    },
    attrs,
    slots: { default: '<p class="content">Words</p>' },
  });
  return { wrapper, events };
}

test('a dialog mounted closed stays closed until open', async () => {
  const { wrapper, events } = dialog();
  const element = wrapper.element;
  assert.equal(element.tagName, 'DIALOG');
  assert.equal(element.open, false);
  assert.equal(wrapper.vm.element, element, 'element is exposed');
  await wrapper.setProps({ open: true });
  assert.equal(element.open, true);
  assert.deepEqual(events, ['opened', 'shown']);
  await wrapper.setProps({ open: false });
  assert.equal(element.open, false);
  assert.deepEqual(events, ['opened', 'shown', 'closed', 'hidden']);
  wrapper.unmount();
});

test('a dialog mounted open opens modal on mount; unmounting closes it', async () => {
  const modal = [];
  const showModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function () {
    modal.push(this);
    return showModal.call(this);
  };
  try {
    const { wrapper, events } = dialog({ open: true });
    const element = wrapper.element;
    assert.deepEqual(modal, [element]);
    assert.equal(element.open, true);
    assert.deepEqual(events, ['opened', 'shown']);
    wrapper.unmount();
    assert.equal(element.open, false);
    assert.deepEqual(events, ['opened', 'shown'], 'no dismiss on unmount');
  } finally {
    HTMLDialogElement.prototype.showModal = showModal;
  }
});

test('the open state follows the content: opened comes after it renders', async () => {
  // The content changes in the same update that opens the dialog, so an
  // opened emitted before that update renders would see the old words.
  const { h } = await import('vue');
  let seen;
  const Host = {
    props: { open: Boolean, words: String },
    setup(props) {
      return () =>
        h(
          UiDialog,
          {
            open: props.open,
            onOpened: () => {
              seen = document.querySelector('dialog .content')?.textContent;
            },
          },
          () => h('p', { class: 'content' }, props.words),
        );
    },
  };
  const wrapper = mount(Host, {
    attachTo: document.body,
    props: { open: false, words: 'Before' },
  });
  await wrapper.setProps({ open: true, words: 'After' });
  assert.equal(seen, 'After');
  wrapper.unmount();
});

test('Escape is prevented and emitted as dismiss; the owner decides', async () => {
  const { wrapper, events } = dialog({ open: true });
  events.length = 0;
  const cancel = new Event('cancel', { cancelable: true });
  wrapper.element.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(wrapper.element.open, true);
  assert.deepEqual(events, ['dismiss', 'shown']);
  wrapper.unmount();
});

test('a close the browser made while open is reported once; the owner’s is not', async () => {
  const { wrapper, events } = dialog({ open: true });
  events.length = 0;
  wrapper.element.close();
  assert.deepEqual(events, ['browserClose', 'hidden']);
  events.length = 0;
  // The owner then closes it too: nothing to close, closed is still emitted.
  await wrapper.setProps({ open: false });
  assert.deepEqual(events, ['closed', 'hidden']);
  await wrapper.setProps({ open: true });
  events.length = 0;
  await wrapper.setProps({ open: false });
  assert.deepEqual(events, ['closed', 'hidden'], 'no browserClose');
  wrapper.unmount();
});

test('a late close event from an earlier close is not reported once open again', async () => {
  const { wrapper, events } = dialog({ open: true });
  await wrapper.setProps({ open: false });
  await wrapper.setProps({ open: true });
  events.length = 0;
  // The browser's queued close event from the first close lands now.
  wrapper.element.dispatchEvent(new Event('close'));
  assert.deepEqual(events, [], 'no browserClose');
  wrapper.unmount();
});

test('a backdrop click dismisses only when asked, and only on the dialog', async () => {
  const plain = dialog({ open: true });
  plain.events.length = 0;
  plain.wrapper.element.click();
  assert.deepEqual(plain.events, []);
  plain.wrapper.unmount();

  const backdrop = dialog({ open: true, backdropDismiss: true });
  backdrop.events.length = 0;
  backdrop.wrapper.get('.content').element.click();
  assert.deepEqual(backdrop.events, [], 'a click inside is content');
  backdrop.wrapper.element.click();
  assert.deepEqual(backdrop.events, ['dismiss', 'shown']);
  backdrop.wrapper.unmount();
});

test('attributes, classes, styles and listeners pass through to the dialog', async () => {
  const clicks = [];
  const { wrapper } = dialog(
    {},
    {
      id: 'library',
      class: 'library-dialog',
      style: { width: '40px' },
      'aria-label': 'Library',
      'data-panel-surface': '',
      onClick: () => clicks.push('click'),
    },
  );
  const element = wrapper.element;
  assert.equal(element.id, 'library');
  assert.ok(element.classList.contains('library-dialog'));
  assert.equal(element.style.width, '40px');
  assert.equal(element.getAttribute('aria-label'), 'Library');
  assert.equal(element.getAttribute('data-panel-surface'), '');
  element.click();
  assert.deepEqual(clicks, ['click']);
  wrapper.unmount();
});

test('a DOM without showModal leaves the dialog closed rather than failing', async () => {
  const showModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = undefined;
  try {
    const { wrapper, events } = dialog({ open: true });
    assert.equal(wrapper.element.open, false);
    assert.deepEqual(events, ['opened', 'hidden']);
    await wrapper.setProps({ open: false });
    await nextTick();
    wrapper.unmount();
  } finally {
    HTMLDialogElement.prototype.showModal = showModal;
  }
});
