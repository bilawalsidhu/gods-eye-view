import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { installVueDom } from '../../testSupport/vueDom.mjs';

let mount;
let RowRange;
let uninstall;
before(async () => {
  uninstall = installVueDom();
  ({ mount } = await import('@vue/test-utils'));
  RowRange = (await import('./RowRange.vue')).default;
});
after(() => uninstall());

const range = (from, to) => ({
  id: 'period',
  label: 'Period',
  valueText: `${from}–${to}`,
  from: { label: 'From', value: from },
  to: { label: 'To', value: to },
  options: [1900, 1950, 1960, 2000].map((value) => ({
    value,
    label: String(value),
  })),
});

test('a range end keeps a pick until the owner repaints, then shows the owner’s ends', async () => {
  const picks = [];
  const wrapper = mount(RowRange, {
    attachTo: document.body,
    props: {
      range: range(1900, 1950),
      onSelect: (end, value) => picks.push([end, value]),
    },
  });
  const [from, to] = wrapper.findAll('select').map((w) => w.element);
  assert.equal(from.value, '1900');
  assert.equal(to.value, '1950');
  // A start picked after the end: the owner swaps the ends on a later frame.
  from.focus();
  from.value = '1960';
  from.dispatchEvent(new Event('change'));
  assert.deepEqual(picks, [['from', '1960']]);
  await wrapper.vm.$nextTick();
  assert.equal(from.value, '1960');
  await wrapper.setProps({ range: range(1950, 1960) });
  assert.equal(document.activeElement, from);
  assert.equal(from.value, '1950');
  assert.equal(to.value, '1960');
  wrapper.unmount();
});
