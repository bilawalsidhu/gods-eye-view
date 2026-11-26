import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../../testSupport/vueDom.mjs';

let mount;
let UiSwitch;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  ({ mount } = await import('@vue/test-utils'));
  UiSwitch = (await import('./UiSwitch.vue')).default;
});
after(() => uninstall());

/** A switch whose v-model writes back into its props, as a parent's would. */
function bound(props = {}, attrs = {}) {
  const wrapper = mount(UiSwitch, {
    attachTo: document.body,
    props: {
      label: 'Stations',
      modelValue: false,
      ...props,
      'onUpdate:modelValue': (value) => wrapper.setProps({ modelValue: value }),
    },
    attrs,
  });
  return wrapper;
}

test('a switch is a role=switch button with its name and a knob', () => {
  const wrapper = bound();
  const button = wrapper.get('button');
  assert.equal(button.attributes('type'), 'button');
  assert.equal(button.attributes('role'), 'switch');
  assert.equal(button.attributes('aria-checked'), 'false');
  assert.equal(button.attributes('aria-label'), 'Stations');
  assert.ok(button.classes().includes('ui-switch'));
  assert.ok(button.classes().includes('ui-focus'));
  const knob = button.get('i');
  assert.ok(knob.classes().includes('ui-switch__knob'));
  assert.equal(knob.attributes('aria-hidden'), 'true');
  assert.equal(button.text(), '');
  wrapper.unmount();
});

test('v-model shows the value and flips it on each click', async () => {
  const wrapper = bound({ modelValue: true });
  const button = wrapper.get('button');
  assert.equal(button.attributes('aria-checked'), 'true');
  await button.trigger('click');
  assert.deepEqual(wrapper.emitted('update:modelValue'), [[false]]);
  assert.deepEqual(wrapper.emitted('change'), [[false]]);
  assert.equal(button.attributes('aria-checked'), 'false');
  await button.trigger('click');
  assert.deepEqual(wrapper.emitted('update:modelValue').at(-1), [true]);
  assert.equal(button.attributes('aria-checked'), 'true');
  wrapper.unmount();
});

test('checked shows the owner’s state until the owner passes a new one', async () => {
  const wrapper = mount(UiSwitch, {
    props: { label: 'Stations', checked: true },
  });
  const button = wrapper.get('button');
  assert.equal(button.attributes('aria-checked'), 'true');
  await button.trigger('click');
  assert.deepEqual(wrapper.emitted('change'), [[false]]);
  // Not yet applied: the switch still shows the owner's state.
  assert.equal(button.attributes('aria-checked'), 'true');
  await wrapper.setProps({ checked: false });
  assert.equal(button.attributes('aria-checked'), 'false');
  await button.trigger('click');
  assert.deepEqual(wrapper.emitted('change').at(-1), [true]);
  wrapper.unmount();
});

test('without a state the switch is off', () => {
  const wrapper = mount(UiSwitch, { props: { label: 'Stations' } });
  assert.equal(wrapper.get('button').attributes('aria-checked'), 'false');
  wrapper.unmount();
});

test('a disabled switch is a disabled button and asks for nothing', async () => {
  const wrapper = bound({ disabled: true });
  const button = wrapper.get('button');
  assert.equal(button.attributes('disabled'), '');
  button.element.dispatchEvent(new Event('click'));
  await wrapper.vm.$nextTick();
  assert.equal(wrapper.emitted('update:modelValue'), undefined);
  assert.equal(wrapper.emitted('change'), undefined);
  wrapper.unmount();
});

test('attributes and classes pass through to the button', () => {
  const wrapper = bound(
    {},
    { class: 'card-switch', 'data-toggle-id': 'stations', title: 'Tip' },
  );
  const button = wrapper.get('button');
  assert.ok(button.classes().includes('card-switch'));
  assert.ok(button.classes().includes('ui-switch'));
  assert.equal(button.attributes('data-toggle-id'), 'stations');
  assert.equal(button.attributes('title'), 'Tip');
  wrapper.unmount();
});
