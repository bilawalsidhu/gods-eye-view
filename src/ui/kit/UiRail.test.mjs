import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../../testSupport/vueDom.mjs';

let mount;
let UiRail;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  ({ mount } = await import('@vue/test-utils'));
  UiRail = (await import('./UiRail.vue')).default;
});
after(() => uninstall());

const items = [
  { id: 'layers', label: 'DATA LAYERS', icon: 'layers' },
  { id: 'scenes', label: 'AUTHORING', icon: 'movie', separatorBefore: true },
  { id: 'cctv', label: 'CCTV', icon: 'videocam', disabled: true, badge: 3 },
];

function mountRail(props = {}) {
  return mount(UiRail, {
    props: { items, side: 'left', label: 'Left panels', ...props },
  });
}

test('the rail is a named nav with one pressed button per item', () => {
  const wrapper = mountRail({ active: 'scenes' });
  const nav = wrapper.get('nav');
  assert.equal(nav.attributes('aria-label'), 'Left panels');
  assert.ok(nav.classes().includes('ui-rail--left'));
  const buttons = wrapper.findAll('button');
  assert.deepEqual(
    buttons.map((button) => button.attributes('data-rail-item')),
    ['layers', 'scenes', 'cctv'],
  );
  assert.deepEqual(
    buttons.map((button) => button.attributes('aria-pressed')),
    ['false', 'true', 'false'],
  );
  assert.equal(buttons[0].attributes('aria-label'), 'DATA LAYERS');
  assert.equal(buttons[0].get('.material-symbols-outlined').text(), 'layers');
  assert.ok(buttons[1].classes().includes('ui-rail__item--on'));
  assert.equal(wrapper.findAll('.ui-rail__sep').length, 1);
  assert.equal(buttons[2].attributes('disabled'), '');
  assert.equal(buttons[2].get('.ui-rail__badge').text(), '3');
});

test('selecting an item emits its id', async () => {
  const wrapper = mountRail();
  await wrapper.get('[data-rail-item="scenes"]').trigger('click');
  assert.deepEqual(wrapper.emitted('select'), [['scenes']]);
});

test('tips open toward the screen, and not for the open panel', async () => {
  const wrapper = mountRail({
    side: 'right',
    active: 'layers',
    panelOpen: true,
  });
  const [open, other] = wrapper.findAll('.ui-tooltip');
  await open.trigger('focusin');
  assert.equal(wrapper.find('[role="tooltip"]').exists(), false);
  await other.trigger('focusin');
  // Over an open panel the other tips wait for the pointer to rest.
  assert.equal(wrapper.find('[role="tooltip"]').exists(), false);
  await new Promise((resolve) => setTimeout(resolve, 450));
  const tip = wrapper.get('[role="tooltip"]');
  assert.equal(tip.text(), 'AUTHORING');
  assert.ok(tip.classes().includes('ui-tooltip__tip--left'));
  await other.trigger('focusout');
  assert.equal(wrapper.find('[role="tooltip"]').exists(), false);
});

test('a collapsible rail shows labelled pills until a panel opens', async () => {
  const wrapper = mountRail({ collapsible: true });
  const nav = wrapper.get('nav');
  assert.ok(nav.classes().includes('ui-rail--collapsible'));
  assert.ok(nav.classes().includes('ui-rail--expanded'));
  assert.deepEqual(
    wrapper.findAll('.ui-rail__label').map((label) => label.text()),
    ['DATA LAYERS', 'AUTHORING', 'CCTV'],
  );
  // The label is on screen, so its tip would only repeat it.
  await wrapper.findAll('.ui-tooltip')[0].trigger('focusin');
  assert.equal(wrapper.find('[role="tooltip"]').exists(), false);
  // The button keeps its own accessible name; the visible label is hidden
  // from assistive technology so the name is not read twice.
  const button = wrapper.get('[data-rail-item="layers"]');
  assert.equal(button.attributes('aria-label'), 'DATA LAYERS');
  assert.equal(button.get('.ui-rail__label').attributes('aria-hidden'), 'true');

  await wrapper.setProps({ active: 'layers', panelOpen: true });
  assert.ok(nav.classes().includes('ui-rail--collapsible'));
  assert.equal(nav.classes().includes('ui-rail--expanded'), false);
  // Collapsed, the other items' tips come back.
  await wrapper.findAll('.ui-tooltip')[1].trigger('focusin');
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(wrapper.get('[role="tooltip"]').text(), 'AUTHORING');
});

test('a label cut short by the pill keeps its tip', async (t) => {
  const observers = [];
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      observers.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    unobserve() {}
    disconnect() {}
  };
  t.after(() => (globalThis.ResizeObserver = original));
  const wrapper = mountRail({ collapsible: true });
  const [observer] = observers;
  const [layers, scenes] = observer.targets;
  Object.defineProperties(layers, {
    scrollWidth: { value: 260 },
    clientWidth: { value: 220 },
  });
  Object.defineProperties(scenes, {
    scrollWidth: { value: 90 },
    clientWidth: { value: 90 },
  });
  observer.callback([{ target: layers }, { target: scenes }]);
  await wrapper.vm.$nextTick();
  await wrapper.findAll('.ui-tooltip')[0].trigger('focusin');
  assert.equal(wrapper.get('[role="tooltip"]').text(), 'DATA LAYERS');
  await wrapper.findAll('.ui-tooltip')[0].trigger('focusout');
  await wrapper.findAll('.ui-tooltip')[1].trigger('focusin');
  assert.equal(wrapper.find('[role="tooltip"]').exists(), false);
});

test('a plain rail has no labels', () => {
  const wrapper = mountRail();
  assert.equal(wrapper.find('.ui-rail__label').exists(), false);
  assert.equal(
    wrapper.get('nav').classes().includes('ui-rail--expanded'),
    false,
  );
});
