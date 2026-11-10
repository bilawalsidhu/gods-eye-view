import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../../testSupport/vueDom.mjs';

let mount;
let UiChip;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  ({ mount } = await import('@vue/test-utils'));
  UiChip = (await import('./UiChip.vue')).default;
});
after(() => uninstall());

test('a chip is a span with the kit classes and Core’s', async () => {
  const wrapper = mount(UiChip, {
    attrs: { class: 'gev-voice-card-chip', 'data-tone': 'ok' },
    slots: { default: 'ok' },
  });
  const chip = wrapper.get('span');
  assert.deepEqual(chip.classes(), ['ui-chip', 'gev-voice-card-chip']);
  assert.equal(chip.attributes('data-tone'), 'ok');
  assert.equal(chip.text(), 'ok');
  await wrapper.setProps({ selected: true, mono: true });
  assert.ok(chip.classes().includes('ui-chip--selected'));
  assert.ok(chip.classes().includes('ui-mono'));
  wrapper.unmount();
});
