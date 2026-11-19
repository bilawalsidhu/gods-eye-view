import test from 'node:test';
import assert from 'node:assert/strict';
import { FIRMS_OVERLAY_SOURCE_ID } from '../../data/firmsLabels.js';
import { clickCard, resolvePickId } from '../../data/pickRegistry.js';
import { fakeInputUnderLabel } from '../../input/testDoubles.mjs';
import { createSelection } from './selection.js';

/** The fire selection over a viewer whose clicks a Space Missions label may
 *  take, with a fire's card under every click. */
function selectionHarness(t) {
  const viewer = { scene: { canvas: {}, pick: () => null } };
  const fake = fakeInputUnderLabel(viewer, {
    beneath: () => ({
      sourceId: FIRMS_OVERLAY_SOURCE_ID,
      entryId: 'firms-card:1',
    }),
  });
  t.after(() => fake.destroy());
  const fire = { lat: 1, lon: 2, acqMs: 3, frp: 40, satellite: 'N' };
  const focused = [];
  const cleared = [];
  const layerState = {
    _viewer: viewer,
    _icons: { id: 'firms:icons' },
    _pickIndexById: new Map(),
    _fireByCardId: new Map([['firms-card:1', fire]]),
    _selectedFire: null,
    _contextIds: new Set(),
  };
  const selection = createSelection({
    layerState,
    services: {
      picking: { resolvePickId, isOwnedByOtherLayer: () => false, clickCard },
      focus: { requestWorldFocus: (request) => focused.push(request.kind) },
      context: {
        selectEntityContext() {},
        clearSelectedEntityContextForLayer: (id) => cleared.push(id),
        getContextStore() {},
        registerEntityContext() {},
      },
    },
    components: {
      model: {
        firePosition: () => ({ x: 0, y: 0, z: 0 }),
        formatFrp: String,
        confidenceBucket: String,
      },
      cards: { rebuildAmbientLabels() {} },
    },
    config: {
      id: 'firms',
      name: 'Fires',
    },
  });
  selection.installClickHandler();
  t.after(() => selection.removeClickHandler());
  return { fake, layerState, fire, focused, cleared };
}

test("a click on a mission label over a fire's card never selects or focuses the fire", (t) => {
  const h = selectionHarness(t);
  h.fake.label.over = true;
  h.fake.click();
  assert.equal(h.layerState._selectedFire, null);
  assert.deepEqual(h.focused, [], 'the camera is not sent to the fire');
});

test('a click on a mission label keeps the selected fire', (t) => {
  const h = selectionHarness(t);
  // Off the label, a click on the card selects and focuses its fire.
  h.fake.click();
  assert.equal(h.layerState._selectedFire, h.fire);
  assert.deepEqual(h.focused, ['fire']);
  // The label on top is its own click: the fire stays selected.
  h.fake.label.over = true;
  h.fake.click();
  assert.equal(h.layerState._selectedFire, h.fire);
  assert.deepEqual(h.cleared, []);
  assert.deepEqual(h.focused, ['fire']);
});
