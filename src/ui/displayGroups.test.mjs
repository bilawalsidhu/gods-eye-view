// src/ui/displayGroups.test.mjs — added groups reach the Display
// panel's store on the page's Pinia.
import test from 'node:test';
import assert from 'node:assert/strict';
import { publishDisplayGroup } from './displayGroups.js';
import { useDisplayStore } from './stores/display.js';
import { applicationPinia } from './vueRuntime.js';

test('publishDisplayGroup shows a group on the page’s Display panel, and takes it away', () => {
  const store = useDisplayStore(applicationPinia());
  publishDisplayGroup('conditions', {
    rows: [{ kind: 'note', id: 'status', text: 'Nothing here' }],
  });
  assert.deepEqual(
    store.groups.map((g) => [g.id, g.rows.length]),
    [['conditions', 1]],
  );
  publishDisplayGroup('conditions', null);
  assert.deepEqual(store.groups, []);
});
