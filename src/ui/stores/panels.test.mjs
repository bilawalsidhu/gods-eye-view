import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { usePanelStore } from './panels.js';

test('the panel store reports each side’s open panel and keeps unchanged sides', () => {
  const store = usePanelStore(createPinia());
  const left = [
    { id: 'data-panel', open: false, available: true },
    { id: 'scene-panel', open: true, available: true },
  ];
  store.setSide('left', left);
  store.setSide('right', [
    { id: 'weather-panel', open: true, available: false },
  ]);
  assert.equal(store.openPanelId('left'), 'scene-panel');
  // An open panel that is not offered is not the side's open panel.
  assert.equal(store.openPanelId('right'), null);
  assert.equal(store.isOpen('scene-panel'), true);
  assert.equal(store.isOpen('data-panel'), false);
  const published = store.sides.left;
  store.setSide(
    'left',
    left.map((panel) => ({ ...panel })),
  );
  assert.equal(store.sides.left, published);
});
