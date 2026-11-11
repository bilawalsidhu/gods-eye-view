import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../../testSupport/vueDom.mjs';

let mount;
let vue;
let UiSelect;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  ({ mount } = await import('@vue/test-utils'));
  vue = await import('vue');
  UiSelect = (await import('./UiSelect.js')).default;
});
after(() => uninstall());

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
  { value: 'c', label: 'Charlie' },
];

function mountSelect(props = {}, attrs = {}) {
  return mount(UiSelect, {
    attachTo: document.body,
    props: { options: OPTIONS, modelValue: 'b', ...props },
    attrs,
  });
}

test('a bare select with the caller’s attributes and the model chosen', () => {
  const wrapper = mountSelect(
    {},
    { id: 'pick', class: 'gev-field', 'aria-label': 'Pick' },
  );
  const select = wrapper.get('select');
  assert.equal(select.attributes('class'), 'gev-field');
  assert.equal(select.attributes('id'), 'pick');
  assert.equal(select.attributes('aria-label'), 'Pick');
  assert.equal(select.attributes('value'), undefined);
  assert.deepEqual(
    [...select.element.options].map((o) => [o.value, o.textContent]),
    [
      ['a', 'Alpha'],
      ['b', 'Bravo'],
      ['c', 'Charlie'],
    ],
  );
  assert.equal(select.element.value, 'b');
  assert.equal(select.element.disabled, false);
  wrapper.unmount();
});

test('a change emits the value, and a caller’s own change still runs', async () => {
  const seen = [];
  const wrapper = mountSelect(
    {},
    { onChange: (event) => seen.push(event.target.value) },
  );
  const select = wrapper.get('select');
  select.element.value = 'c';
  await select.trigger('change');
  assert.deepEqual(wrapper.emitted('update:modelValue'), [['c']]);
  assert.deepEqual(seen, ['c']);
  wrapper.unmount();
});

test('a refused pick goes back to the model', async () => {
  const { nextTick } = vue;
  const wrapper = mountSelect();
  const select = wrapper.get('select');
  select.element.value = 'c';
  await select.trigger('change');
  await nextTick();
  assert.equal(select.element.value, 'b');
  wrapper.unmount();
});

test('the model picks the option, and a null model leaves the select', async () => {
  const wrapper = mountSelect();
  const select = wrapper.get('select').element;
  await wrapper.setProps({ modelValue: 'c' });
  assert.equal(select.value, 'c');
  select.value = 'a';
  await wrapper.setProps({ modelValue: null, disabled: true });
  assert.equal(select.value, 'a');
  assert.equal(select.disabled, true);
  wrapper.unmount();
});

test('a held select keeps a focused pick and takes the model back on blur', async () => {
  const wrapper = mountSelect({ hold: true });
  const select = wrapper.get('select').element;
  select.focus();
  select.value = 'a';
  await wrapper.setProps({ modelValue: 'c' });
  assert.equal(select.value, 'a');
  select.blur();
  await wrapper.get('select').trigger('blur');
  assert.equal(select.value, 'c');
  wrapper.unmount();
});

test('slotted options render, and the model applies once they arrive', async () => {
  const { defineComponent, h, ref, nextTick } = vue;
  const options = ref(['x']);
  const model = ref('x');
  const wrapper = mount(
    defineComponent({
      setup: () => () =>
        h(
          UiSelect,
          { modelValue: model.value },
          {
            default: () =>
              options.value.map((value) =>
                h('option', { key: value, value, 'data-i18n': '' }, value),
              ),
          },
        ),
    }),
    { attachTo: document.body },
  );
  const select = wrapper.get('select').element;
  assert.equal(select.options[0].hasAttribute('data-i18n'), true);
  options.value = ['x', 'y'];
  model.value = 'y';
  await nextTick();
  assert.equal(select.options.length, 2);
  assert.equal(select.value, 'y');
  wrapper.unmount();
});
