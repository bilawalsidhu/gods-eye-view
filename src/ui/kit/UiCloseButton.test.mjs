import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../../testSupport/vueDom.mjs';

let mount;
let UiCloseButton;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  ({ mount } = await import('@vue/test-utils'));
  UiCloseButton = (await import('./UiCloseButton.vue')).default;
});
after(() => uninstall());

function mountClose(props = {}, attrs = {}) {
  return mount(UiCloseButton, {
    attachTo: document.body,
    props: { label: 'Close card', ...props },
    attrs,
  });
}

test('a close button is a button named by its label, with no tip of its own', () => {
  const wrapper = mountClose();
  const button = wrapper.get('button');
  assert.equal(button.attributes('type'), 'button');
  assert.equal(button.attributes('aria-label'), 'Close card');
  assert.equal(button.attributes('title'), undefined);
  assert.ok(button.classes().includes('ui-close-button'));
  wrapper.unmount();
});

test('glyph="times" draws the × character', () => {
  const wrapper = mountClose();
  const button = wrapper.get('button');
  assert.equal(button.element.innerHTML, '×');
  wrapper.unmount();
});

test('glyph="icon" draws the Material close symbol, sized by the stylesheet', () => {
  const wrapper = mountClose({ glyph: 'icon' });
  const icon = wrapper.get('button > span');
  assert.equal(wrapper.get('button').element.children.length, 1);
  assert.equal(icon.text(), 'close');
  assert.ok(icon.classes().includes('material-symbols-outlined'));
  assert.equal(icon.attributes('aria-hidden'), 'true');
  assert.equal(icon.attributes('style'), undefined);
  wrapper.unmount();
});

test('attributes and classes pass through to the button', () => {
  const wrapper = mountClose(
    {},
    {
      id: 'gev-chat-close',
      class: 'data-toggle-chip',
      title: 'Clear reading',
      'data-action-id': 'clear',
      'aria-hidden': 'true',
      disabled: true,
      hidden: true,
    },
  );
  const button = wrapper.get('button');
  assert.equal(button.attributes('id'), 'gev-chat-close');
  assert.ok(button.classes().includes('data-toggle-chip'));
  assert.ok(button.classes().includes('ui-close-button'));
  assert.equal(button.attributes('title'), 'Clear reading');
  assert.equal(button.attributes('data-action-id'), 'clear');
  assert.equal(button.attributes('aria-hidden'), 'true');
  assert.equal(button.element.disabled, true);
  assert.equal(button.element.hidden, true);
  wrapper.unmount();
});

test('bare leaves the kit look off', () => {
  const wrapper = mountClose({ bare: true }, { class: 'sl-viewer-x' });
  const classes = wrapper.get('button').classes();
  assert.ok(classes.includes('sl-viewer-x'));
  assert.equal(classes.includes('ui-close-button'), false);
  wrapper.unmount();
});

test('a click is emitted with its event', async () => {
  const wrapper = mountClose();
  await wrapper.get('button').trigger('click');
  const clicks = wrapper.emitted('click');
  assert.equal(clicks.length, 1);
  assert.ok(clicks[0][0] instanceof Event);
  wrapper.unmount();
});

test('a disabled close button emits no click', async () => {
  const wrapper = mountClose({}, { disabled: true });
  await wrapper.get('button').trigger('click');
  assert.equal(wrapper.emitted('click'), undefined);
  wrapper.unmount();
});
