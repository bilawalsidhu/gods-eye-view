import test from 'node:test';
import assert from 'node:assert/strict';
import { syncChipGroup } from './chipGroup.js';
import { railFixture } from './railTestFixture.mjs';

test('keyed chips retain focus, reflect state, reorder and remove without redundant writes', () => {
  let writes = 0;
  const f = railFixture(() => writes++);
  const a = { id: 'a', label: 'GFS', active: true };
  const b = { id: 'b', label: 'ECMWF' };
  const legend = f.document.createElement('span');
  f.container.appendChild(legend);
  syncChipGroup(f.container, [a, b], { before: legend });
  const first = f.container.children[0];
  first.focus();
  const next = [{ ...a, label: 'Changed', busy: true, disabled: true }, b];
  syncChipGroup(f.container, next);
  assert.equal(f.container.children[0], first);
  assert.equal(f.document.activeElement, first);
  assert.equal(first.disabled, true);
  assert.equal(first.getAttribute('aria-busy'), 'true');
  assert.equal(first.getAttribute('aria-pressed'), 'true');
  writes = 0;
  syncChipGroup(f.container, next);
  assert.equal(writes, 0);
  syncChipGroup(f.container, [b, a]);
  assert.equal(f.container.children[1], first);
  assert.equal(f.container.children[2], legend);
  syncChipGroup(f.container, [a]);
  assert.deepEqual(f.container.children, [first, legend]);
  syncChipGroup(f.container, []);
  assert.deepEqual(f.container.children, [legend]);
});

test('a chip colour is set once, changed, and cleared through a CSS variable', () => {
  const f = railFixture(() => {});
  const calls = [];
  syncChipGroup(f.container, [{ id: 'm', label: 'M' }]);
  const chip = f.container.children[0];
  chip.style.setProperty = (name, value) => calls.push(['set', name, value]);
  chip.style.removeProperty = (name) => calls.push(['remove', name]);
  syncChipGroup(f.container, [{ id: 'm', label: 'M' }]);
  assert.deepEqual(calls, [], 'a chip without a colour never touches style');
  syncChipGroup(f.container, [{ id: 'm', label: 'M', color: '#05cb63' }]);
  syncChipGroup(f.container, [{ id: 'm', label: 'M', color: '#05cb63' }]);
  syncChipGroup(f.container, [{ id: 'm', label: 'M', color: '#a66bff' }]);
  syncChipGroup(f.container, [{ id: 'm', label: 'M' }]);
  assert.deepEqual(calls, [
    ['set', '--chip-color', '#05cb63'],
    ['set', '--chip-color', '#a66bff'],
    ['remove', '--chip-color'],
  ]);
  assert.equal(chip.dataset.chipColor, undefined);
});
