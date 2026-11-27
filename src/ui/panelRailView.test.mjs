// src/ui/panelRailView.test.mjs — a rail whose only entry's panel is open
// hides; with more entries, or its panel folded, it shows.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../testSupport/vueDom.mjs';

let mount;
let PanelRailView;
let createPinia;
let usePanelStore;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  ({ mount } = await import('@vue/test-utils'));
  ({ createPinia } = await import('pinia'));
  PanelRailView = (await import('./PanelRailView.vue')).default;
  ({ usePanelStore } = await import('./stores/panels.js'));
});
after(() => uninstall());

const context = (open) => ({
  id: 'global-context-panel',
  title: 'CONTEXT',
  open,
  available: true,
});

function mountRail(side, panels) {
  const pinia = createPinia();
  const store = usePanelStore(pinia);
  store.setSide(side, panels);
  const wrapper = mount(PanelRailView, {
    props: { side, onSelect: () => {} },
    global: { plugins: [pinia] },
  });
  return { wrapper, store };
}

test('the right rail hides while its one panel, Context, is open', async () => {
  const { wrapper, store } = mountRail('right', [context(true)]);
  assert.ok(wrapper.get('nav').classes().includes('ui-rail--sole-open'));
  store.setSide('right', [context(false)]);
  await wrapper.vm.$nextTick();
  assert.equal(
    wrapper.get('nav').classes().includes('ui-rail--sole-open'),
    false,
    'folded, its icon shows again',
  );
});

test('a rail with more than one entry shows while a panel is open', () => {
  const { wrapper } = mountRail('left', [
    { id: 'data-panel', title: 'DATA LAYERS', open: true, available: true },
    { id: 'utilities-panel', title: 'UTILITIES', open: false, available: true },
  ]);
  assert.equal(
    wrapper.get('nav').classes().includes('ui-rail--sole-open'),
    false,
  );
});
