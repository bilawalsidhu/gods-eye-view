import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../../testSupport/vueDom.mjs';

let mount;
let UiSlider;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  ({ mount } = await import('@vue/test-utils'));
  UiSlider = (await import('./UiSlider.js')).default;
});
after(() => uninstall());

function mountSlider(props = {}, attrs = {}) {
  return mount(UiSlider, {
    attachTo: document.body,
    props: { min: 0, max: 100, modelValue: 40, ...props },
    attrs,
  });
}

test('a native range input with Core’s class beside the caller’s', () => {
  const wrapper = mountSlider(
    { step: 5 },
    { id: 'vol', class: 'pp-slider', 'aria-label': 'Volume' },
  );
  const input = wrapper.get('input');
  assert.equal(input.attributes('type'), 'range');
  assert.equal(input.attributes('class'), 'gev-quantitative-slider pp-slider');
  assert.equal(input.attributes('id'), 'vol');
  assert.equal(input.attributes('aria-label'), 'Volume');
  assert.equal(input.attributes('step'), '5');
  assert.equal(input.attributes('value'), undefined);
  assert.equal(input.element.value, '40');
  wrapper.unmount();
});

test('no step attribute unless one is given, and disabled reaches the input', () => {
  const wrapper = mountSlider({ disabled: true });
  const input = wrapper.get('input');
  assert.equal(input.attributes('step'), undefined);
  assert.equal(input.element.disabled, true);
  wrapper.unmount();
});

test('a drag emits the value as a number', async () => {
  const wrapper = mountSlider({ min: 0.25, max: 4, step: 0.25, modelValue: 1 });
  const input = wrapper.get('input');
  input.element.value = '2.5';
  await input.trigger('input');
  assert.deepEqual(wrapper.emitted('update:modelValue'), [[2.5]]);
  wrapper.unmount();
});

test('the model moves the handle, even while focused, unless it holds', async () => {
  const live = mountSlider();
  live.element.focus();
  await live.setProps({ modelValue: 70 });
  assert.equal(live.element.value, '70');
  live.unmount();

  const held = mountSlider({ hold: true });
  held.element.focus();
  held.element.value = '55';
  await held.setProps({ modelValue: 70 });
  assert.equal(held.element.value, '55');
  held.element.blur();
  await held.setProps({ modelValue: 80 });
  assert.equal(held.element.value, '80');
  held.unmount();
});

test('a held slider with no model keeps its value', async () => {
  const wrapper = mountSlider({ hold: true, modelValue: 30 });
  await wrapper.setProps({ modelValue: null });
  assert.equal(wrapper.element.value, '30');
  wrapper.unmount();
});

test('a held handle takes the model back when it loses focus', async () => {
  const wrapper = mountSlider({ hold: true, modelValue: 60 });
  const input = wrapper.get('input');
  input.element.focus();
  input.element.value = '35';
  await input.trigger('input');
  await wrapper.setProps({ modelValue: 60 });
  assert.equal(input.element.value, '35');
  input.element.blur();
  await input.trigger('blur');
  assert.equal(input.element.value, '60');
  wrapper.unmount();
});

test('an input stays until the owner answers, however late', async () => {
  for (const hold of [false, true]) {
    const wrapper = mountSlider({ hold, modelValue: 40 });
    const input = wrapper.get('input');
    input.element.value = '70';
    await input.trigger('input');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(input.element.value, '70', `hold: ${hold}`);
    await wrapper.setProps({ modelValue: 70 });
    assert.equal(input.element.value, '70', `hold: ${hold}`);
    wrapper.unmount();
  }
});

test('a caller’s own input, change and blur handlers still run', async () => {
  const seen = [];
  const wrapper = mountSlider(
    {},
    {
      onInput: (event) => seen.push(['input', event.target.value]),
      onChange: () => seen.push(['change']),
      onBlur: () => seen.push(['blur']),
    },
  );
  const input = wrapper.get('input');
  input.element.value = '55';
  await input.trigger('input');
  await input.trigger('change');
  await input.trigger('blur');
  assert.deepEqual(seen, [['input', '55'], ['change'], ['blur']]);
  assert.deepEqual(wrapper.emitted('update:modelValue'), [[55]]);
  wrapper.unmount();
});

test('a null model leaves the input, and unstyled leaves Core’s class off', async () => {
  const wrapper = mountSlider({ modelValue: null, unstyled: true });
  const input = wrapper.get('input');
  assert.equal(input.attributes('class'), undefined);
  input.element.value = '12';
  await wrapper.setProps({ disabled: true });
  assert.equal(input.element.value, '12');
  await wrapper.setProps({ unstyled: false });
  assert.equal(input.attributes('class'), 'gev-quantitative-slider');
  wrapper.unmount();
});
