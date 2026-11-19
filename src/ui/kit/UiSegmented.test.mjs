import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../../testSupport/vueDom.mjs';

let mount;
let UiSegmented;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  ({ mount } = await import('@vue/test-utils'));
  UiSegmented = (await import('./UiSegmented.vue')).default;
});
after(() => uninstall());

const options = [
  { value: 'a', label: 'Alpha', attrs: { id: 'seg-a', 'data-v': 'a' } },
  { value: 'b', label: 'Beta', disabled: true },
  { value: 'c', label: 'Gamma' },
];

function mountGroup(props = {}) {
  return mount(UiSegmented, {
    attachTo: document.body,
    props: { options, label: 'Pick', modelValue: 'a', ...props },
  });
}
const tabStops = (wrapper) =>
  wrapper.findAll('button').map((b) => b.attributes('tabindex') ?? null);

test('a named radio group with Core and kit classes on every option', () => {
  const wrapper = mountGroup({ itemClass: 'pp-mode-btn' });
  const group = wrapper.get('[role="radiogroup"]');
  assert.equal(group.attributes('aria-label'), 'Pick');
  assert.ok(group.classes().includes('gev-segmented'));
  const [a, b, c] = wrapper.findAll('button');
  assert.equal(a.text(), 'Alpha');
  assert.equal(a.attributes('id'), 'seg-a');
  assert.equal(a.attributes('data-v'), 'a');
  assert.equal(a.attributes('type'), 'button');
  assert.equal(a.attributes('aria-checked'), 'true');
  assert.ok(a.classes().includes('active'));
  assert.ok(a.classes().includes('ui-segmented__item--on'));
  assert.ok(a.classes().includes('gev-segment'));
  assert.ok(a.classes().includes('pp-mode-btn'));
  assert.equal(b.attributes('disabled'), '');
  assert.equal(a.attributes('disabled'), undefined);
  assert.equal(c.attributes('aria-checked'), 'false');
  assert.equal(c.classes().includes('active'), false);
  wrapper.unmount();
});

test('a click asks for its option; a disabled one asks for nothing', async () => {
  const wrapper = mountGroup();
  const [, b, c] = wrapper.findAll('button');
  await c.trigger('click');
  await b.trigger('click');
  assert.deepEqual(wrapper.emitted('update:modelValue'), [['c']]);
  wrapper.unmount();
});

test('keyboard none: every option is a tab stop and arrows do nothing', async () => {
  const wrapper = mountGroup({ keyboard: 'none', activeClass: 'is-active' });
  assert.deepEqual(tabStops(wrapper), [null, null, null]);
  assert.ok(wrapper.get('#seg-a').classes().includes('is-active'));
  await wrapper.get('#seg-a').trigger('keydown', { key: 'ArrowRight' });
  assert.equal(wrapper.emitted('update:modelValue'), undefined);
  wrapper.unmount();
});

test('keyboard arrows: one roving stop, arrows skip disabled options and wrap', async () => {
  const wrapper = mountGroup();
  assert.deepEqual(tabStops(wrapper), ['0', '-1', '-1']);
  await wrapper.get('#seg-a').trigger('keydown', { key: 'ArrowRight' });
  await wrapper.get('#seg-a').trigger('keydown', { key: 'ArrowLeft' });
  await wrapper.get('#seg-a').trigger('keydown', { key: 'Home' });
  assert.deepEqual(wrapper.emitted('update:modelValue'), [['c'], ['c']]);
  await wrapper.setProps({ modelValue: 'c' });
  assert.deepEqual(tabStops(wrapper), ['-1', '-1', '0']);
  wrapper.unmount();
});

test('keyboard radio: Home and End reach the ends', async () => {
  const wrapper = mountGroup({ keyboard: 'radio', modelValue: 'c' });
  const [a, , c] = wrapper.findAll('button');
  await c.trigger('keydown', { key: 'Home' });
  await wrapper.setProps({ modelValue: 'a' });
  await a.trigger('keydown', { key: 'End' });
  assert.deepEqual(wrapper.emitted('update:modelValue'), [['a'], ['c']]);
  wrapper.unmount();
});

test('a key that lands where it started moves focus without a change', async () => {
  const wrapper = mountGroup({ keyboard: 'radio', modelValue: 'a' });
  await wrapper.get('#seg-a').trigger('keydown', { key: 'Home' });
  assert.equal(wrapper.emitted('update:modelValue'), undefined);
  assert.ok(document.activeElement === wrapper.get('#seg-a').element);
  wrapper.unmount();
});

test('a disabled group answers nothing and leaves the tab order', async () => {
  const wrapper = mountGroup({ disabled: true });
  assert.deepEqual(tabStops(wrapper), ['-1', '-1', '-1']);
  await wrapper.get('#seg-a').trigger('click');
  await wrapper.get('#seg-a').trigger('keydown', { key: 'ArrowRight' });
  assert.equal(wrapper.emitted('update:modelValue'), undefined);
  wrapper.unmount();
});

test('a radio group moves from the focused option, an arrows group from the selection', async () => {
  // The selection was restored to c while a keeps focus.
  const radio = mountGroup({ keyboard: 'radio', modelValue: 'c' });
  await radio.get('#seg-a').trigger('keydown', { key: 'ArrowLeft' });
  assert.deepEqual(radio.emitted('update:modelValue'), [['c']]);
  radio.unmount();
  const arrows = mountGroup({ keyboard: 'arrows', modelValue: 'c' });
  await arrows.get('#seg-a').trigger('keydown', { key: 'ArrowLeft' });
  assert.deepEqual(arrows.emitted('update:modelValue'), [['a']]);
  arrows.unmount();
});

test("an option's own tip wins; an icon option without one is titled by its label", () => {
  const wrapper = mountGroup({
    options: [
      { value: 'a', label: 'Alpha', attrs: { title: 'Alpha tip' } },
      { value: 'b', label: 'Beta', icon: 'star' },
      { value: 'c', label: 'Gamma' },
    ],
  });
  const titles = wrapper
    .findAll('button')
    .map((b) => b.attributes('title') ?? null);
  assert.deepEqual(titles, ['Alpha tip', 'Beta', null]);
  wrapper.unmount();
});
