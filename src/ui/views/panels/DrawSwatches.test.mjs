// src/ui/views/panels/DrawSwatches.test.mjs — Draw's colour swatches are one
// radio group: chosen with aria-checked and `active`, never aria-pressed, and
// only the checked colour is a tab stop.
import '../../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, h } from 'vue';
import { DRAW_COLORS } from '../../../annotations/drawMarks.js';
import DrawSwatches from './DrawSwatches.vue';

test('the colour swatches are one radio group: the checked one is the only tab stop', () => {
  const updates = [];
  const chosen = [];
  const root = document.body.appendChild(document.createElement('div'));
  const app = createApp({
    render: () =>
      h(DrawSwatches, {
        modelValue: 'amber',
        label: 'Colour',
        'onUpdate:modelValue': (value) => updates.push(value),
        onChoose: (value) => chosen.push(value),
      }),
  });
  app.mount(root);
  try {
    const group = root.querySelector('[role="radiogroup"]');
    assert.ok(group);
    assert.equal(group.getAttribute('aria-label'), 'Colour');
    const buttons = [...group.querySelectorAll('button')];
    assert.equal(buttons.length, DRAW_COLORS.length);
    for (const button of buttons) {
      assert.equal(button.getAttribute('role'), 'radio');
      assert.equal(button.hasAttribute('aria-pressed'), false);
      const checked = button.dataset.color === 'amber';
      assert.equal(button.getAttribute('aria-checked'), String(checked), button.dataset.color);
      assert.equal(button.classList.contains('active'), checked, button.dataset.color);
      assert.equal(button.getAttribute('tabindex'), checked ? '0' : '-1', button.dataset.color);
    }
    group.querySelector('[data-color="cyan"]').click();
    assert.deepEqual(updates, ['cyan']);
    assert.deepEqual(chosen, ['cyan']);
  } finally {
    app.unmount();
    root.remove();
  }
});
