import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../../testSupport/vueDom.mjs';

let mount;
let UiSearchField;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  ({ mount } = await import('@vue/test-utils'));
  UiSearchField = (await import('./UiSearchField.vue')).default;
});
after(() => uninstall());

/** A field whose v-model writes back into its props, as a parent's would. */
function bound(props = {}, attrs = {}) {
  const wrapper = mount(UiSearchField, {
    attachTo: document.body,
    props: {
      label: 'Search layers',
      modelValue: '',
      ...props,
      'onUpdate:modelValue': (value) => wrapper.setProps({ modelValue: value }),
    },
    attrs,
  });
  return wrapper;
}

test('a search field is the search glyph and a search input named by its label', () => {
  const wrapper = bound({ placeholder: 'Search layers…' });
  const root = wrapper.get('div');
  assert.ok(root.classes().includes('ui-search-field'));
  const icon = wrapper.get('span');
  assert.equal(icon.text(), 'search');
  assert.ok(icon.classes().includes('material-symbols-outlined'));
  assert.equal(icon.attributes('aria-hidden'), 'true');
  const input = wrapper.get('input');
  assert.equal(input.attributes('type'), 'search');
  assert.ok(input.classes().includes('ui-search-field__input'));
  assert.equal(input.attributes('aria-label'), 'Search layers');
  assert.equal(input.attributes('placeholder'), 'Search layers…');
  for (const name of ['id', 'autocomplete', 'spellcheck'])
    assert.equal(input.attributes(name), undefined, name);
  assert.equal(wrapper.find('button').exists(), false);
  wrapper.unmount();
});

test('v-model shows the text and updates it as typed', async () => {
  const wrapper = bound({ modelValue: 'radar' });
  const input = wrapper.get('input');
  assert.equal(input.element.value, 'radar');
  await input.setValue('rain');
  assert.deepEqual(wrapper.emitted('update:modelValue').at(-1), ['rain']);
  assert.equal(wrapper.props('modelValue'), 'rain');
  // A parent that empties its value, as closing a search does, empties the input.
  await wrapper.setProps({ modelValue: '' });
  assert.equal(input.element.value, '');
  wrapper.unmount();
});

test('the clear button shows only while text is typed, clears and refocuses', async () => {
  const wrapper = bound({
    clearLabel: 'Clear search',
    clearClass: 'context-search__clear',
  });
  assert.equal(wrapper.find('button').exists(), false);
  await wrapper.setProps({ modelValue: 'rain' });
  const clear = wrapper.get('button');
  assert.equal(clear.attributes('aria-label'), 'Clear search');
  assert.equal(clear.attributes('title'), 'Clear search');
  assert.ok(clear.classes().includes('context-search__clear'));
  assert.ok(clear.classes().includes('ui-close-button'));
  assert.equal(clear.get('span').text(), 'close');
  await clear.trigger('click');
  assert.deepEqual(wrapper.emitted('update:modelValue').at(-1), ['']);
  assert.equal(document.activeElement, wrapper.get('input').element);
  assert.equal(wrapper.find('button').exists(), false);
  wrapper.unmount();
});

test('Escape is emitted with its event and stops at the input', async () => {
  const wrapper = bound();
  let bubbled = 0;
  const onKey = () => bubbled++;
  wrapper.element.addEventListener('keydown', onKey);
  await wrapper.get('input').trigger('keydown', { key: 'Escape' });
  const escapes = wrapper.emitted('escape');
  assert.equal(escapes.length, 1);
  assert.ok(escapes[0][0] instanceof Event);
  assert.equal(escapes[0][0].defaultPrevented, false);
  assert.equal(bubbled, 0);
  await wrapper.get('input').trigger('keydown', { key: 'a' });
  assert.equal(wrapper.emitted('escape').length, 1);
  assert.equal(bubbled, 1);
  wrapper.unmount();
});

test('tag="label" frames the input in a label', () => {
  const wrapper = bound({ tag: 'label' });
  assert.equal(wrapper.element.tagName, 'LABEL');
  assert.ok(wrapper.element.contains(wrapper.get('input').element));
  wrapper.unmount();
});

test('attributes and classes pass through to the frame; the input takes its own', () => {
  const wrapper = bound(
    {
      inputId: 'layer-finder-input',
      inputClass: 'context-search__input',
      autocomplete: 'off',
      spellcheck: 'false',
    },
    { class: 'context-search', role: 'search', 'data-x': '1' },
  );
  const root = wrapper.get('div');
  assert.ok(root.classes().includes('context-search'));
  assert.ok(root.classes().includes('ui-search-field'));
  assert.equal(root.attributes('role'), 'search');
  assert.equal(root.attributes('data-x'), '1');
  const input = wrapper.get('input');
  assert.equal(input.attributes('id'), 'layer-finder-input');
  assert.ok(input.classes().includes('context-search__input'));
  assert.ok(input.classes().includes('ui-search-field__input'));
  assert.equal(input.attributes('autocomplete'), 'off');
  assert.equal(input.attributes('spellcheck'), 'false');
  assert.equal(input.attributes('role'), undefined);
  wrapper.unmount();
});

test('focus() focuses the input', () => {
  const wrapper = bound();
  wrapper.vm.focus();
  assert.equal(document.activeElement, wrapper.get('input').element);
  wrapper.unmount();
});
