import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../../testSupport/vueDom.mjs';

let mount;
let nextTick;
let UiCheckbox;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  ({ mount } = await import('@vue/test-utils'));
  ({ nextTick } = await import('vue'));
  UiCheckbox = (await import('./UiCheckbox.vue')).default;
});
after(() => uninstall());

/** A checkbox whose v-model writes back into its props, as a parent's would. */
function bound(props = {}, attrs = {}) {
  const wrapper = mount(UiCheckbox, {
    attachTo: document.body,
    props: {
      modelValue: false,
      ...props,
      'onUpdate:modelValue': (value) => wrapper.setProps({ modelValue: value }),
    },
    attrs,
    slots: { default: '<span class="words">Scope</span>' },
  });
  return wrapper;
}

/** Tick the box as a person does: flip it, then the change event. */
async function tick(input) {
  input.element.checked = !input.element.checked;
  await input.trigger('change');
}

test('a checkbox is a label wrapping a native box, then its words', () => {
  const wrapper = bound();
  const root = wrapper.get('label');
  assert.ok(root.classes().includes('ui-checkbox'));
  const input = wrapper.get('input');
  assert.equal(input.attributes('type'), 'checkbox');
  assert.ok(input.classes().includes('ui-checkbox__input'));
  assert.equal(input.attributes('id'), undefined);
  const elements = [...root.element.children];
  assert.deepEqual(
    elements.map((el) => el.tagName),
    ['INPUT', 'SPAN'],
  );
  wrapper.unmount();
});

test('trailing puts the box after its words', () => {
  const wrapper = bound({ trailing: true });
  assert.deepEqual(
    [...wrapper.get('label').element.children].map((el) => el.tagName),
    ['SPAN', 'INPUT'],
  );
  wrapper.unmount();
});

test('attributes and classes go to the label; inputId and inputAttrs to the box', () => {
  const wrapper = bound(
    {
      inputId: 'scope-toggle',
      inputAttrs: { 'aria-describedby': 'note', 'data-hook': '' },
    },
    { class: 'pp-scope-toggle', title: 'Scope', id: 'scope-row' },
  );
  const root = wrapper.get('label');
  assert.ok(root.classes().includes('pp-scope-toggle'));
  assert.equal(root.attributes('title'), 'Scope');
  assert.equal(root.attributes('id'), 'scope-row');
  const input = wrapper.get('input');
  assert.equal(input.attributes('id'), 'scope-toggle');
  assert.equal(input.attributes('aria-describedby'), 'note');
  assert.equal(input.attributes('data-hook'), '');
  assert.equal(input.attributes('title'), undefined);
  assert.ok(!input.classes().includes('pp-scope-toggle'));
  wrapper.unmount();
});

test('v-model shows the value and reports each change', async () => {
  const wrapper = bound({ modelValue: true });
  const input = wrapper.get('input');
  assert.equal(input.element.checked, true);
  await tick(input);
  assert.deepEqual(wrapper.emitted('update:modelValue').at(-1), [false]);
  assert.equal(wrapper.emitted('change').at(-1)[0].target, input.element);
  assert.equal(input.element.checked, false);
  await tick(input);
  assert.deepEqual(wrapper.emitted('update:modelValue').at(-1), [true]);
  // A parent that resets its value resets the box.
  await wrapper.setProps({ modelValue: false });
  assert.equal(input.element.checked, false);
  wrapper.unmount();
});

test('without restore a change the owner ignores stays ticked, as :checked did', async () => {
  const wrapper = mount(UiCheckbox, { props: { modelValue: false } });
  const input = wrapper.get('input');
  await tick(input);
  await nextTick();
  assert.deepEqual(wrapper.emitted('update:modelValue'), [[true]]);
  assert.equal(input.element.checked, true);
  wrapper.unmount();
});

test('restore puts a refused change back and keeps an accepted one', async () => {
  // Refused: the owner keeps its value.
  const refused = mount(UiCheckbox, {
    props: { modelValue: true, restore: true },
  });
  const box = refused.get('input');
  await tick(box);
  assert.deepEqual(refused.emitted('update:modelValue'), [[false]]);
  await nextTick();
  assert.equal(box.element.checked, true);
  refused.unmount();
  // Accepted: the owner takes the change before the box is checked again.
  const accepted = bound({ modelValue: true, restore: true });
  const input = accepted.get('input');
  await tick(input);
  await nextTick();
  assert.equal(input.element.checked, false);
  assert.equal(accepted.props('modelValue'), false);
  accepted.unmount();
});

test('without a modelValue the box is the browser’s own', async () => {
  const wrapper = mount(UiCheckbox, {
    props: { inputAttrs: { 'data-first-run-suppress': '' } },
  });
  const input = wrapper.get('input');
  assert.equal(input.element.checked, false);
  await tick(input);
  assert.equal(input.element.checked, true);
  assert.equal(wrapper.emitted('change').length, 1);
  // Rendering again leaves what was ticked alone.
  await wrapper.setProps({ inputId: 'suppress' });
  assert.equal(input.attributes('id'), 'suppress');
  assert.equal(input.element.checked, true);
  wrapper.unmount();
});

test('a change listener sees the box as the event’s current target', async () => {
  let seen = null;
  const wrapper = mount(UiCheckbox, {
    attrs: {
      onChange: (event) => {
        seen = event.currentTarget;
      },
    },
  });
  const input = wrapper.get('input');
  await tick(input);
  assert.equal(seen, input.element);
  // The label itself does not hear the box's change a second time.
  assert.equal(wrapper.emitted('change').length, 1);
  wrapper.unmount();
});
