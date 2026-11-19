import test from 'node:test';
import assert from 'node:assert/strict';
import { VESSEL_OVERLAY_SOURCE_ID } from '../../data/vesselLabels.js';
import { fakeInputUnderLabel } from '../../input/testDoubles.mjs';
import { createSelection } from './selection.js';

/** Calls on any member are recorded by name and do nothing else. */
function recorder(calls) {
  return new Proxy(
    {},
    {
      get:
        (_target, name) =>
        (...args) =>
          calls.push([name, ...args]),
    },
  );
}

/** The vessel selection over a viewer whose clicks a label may take. */
function selectionHarness(t) {
  const viewer = { scene: { canvas: {}, pick: () => null } };
  const fake = fakeInputUnderLabel(viewer);
  t.after(() => fake.destroy());
  const vessel = { id: 'v1', name: 'NORTHERN STAR', lat: 0, lon: 0 };
  const focused = [];
  const calls = [];
  const state = {
    feed: { enabled: true },
    records: { byId: new Map([[vessel.id, vessel]]) },
    icons: { setId: 'vessels:icons', has: () => false },
    selectedRecord: null,
    interactionKeyTarget: new EventTarget(),
  };
  const vesselState = {
    state,
    // The vessel's card lies under the click.
    _vesselOverlayHost: {
      hitTest: (_x, _y, { sourceId } = {}) =>
        sourceId === VESSEL_OVERLAY_SOURCE_ID
          ? { sourceId, entryId: `vessel:${vessel.id}` }
          : null,
    },
  };
  const selection = createSelection({
    vesselState,
    services: {
      picking: { isOwnedByOtherLayer: () => false },
      worldFocus: { requestWorldFocus: (request) => focused.push(request.id) },
      context: recorder(calls),
    },
    parts: {
      queries: {
        reduceVesselSelection: ({ selectedId, pickedId }) =>
          pickedId
            ? { action: pickedId === selectedId ? 'none' : 'select' }
            : { action: selectedId ? 'deselect' : 'none' },
      },
      rendering: recorder(calls),
      cards: recorder(calls),
      photos: recorder(calls),
      tracking: recorder(calls),
    },
    layer: { source: 'AIS' },
  });
  selection.installInteraction(viewer);
  t.after(() => selection.removeVesselInteraction());
  return { fake, state, vessel, focused };
}

test("a click a label painted over a vessel's card takes never selects or focuses the vessel", (t) => {
  const h = selectionHarness(t);
  h.fake.label.over = true;
  h.fake.click();
  assert.equal(h.state.selectedRecord, null);
  assert.deepEqual(h.focused, [], 'the camera is not sent to the vessel');
});

test('a click a label painted over the map takes lets go of the selected vessel', (t) => {
  const h = selectionHarness(t);
  // Off the label, a click on the card selects and focuses its vessel.
  h.fake.click();
  assert.equal(h.state.selectedRecord, h.vessel);
  assert.deepEqual(h.focused, ['v1']);
  h.fake.label.over = true;
  h.fake.click();
  assert.equal(h.state.selectedRecord, null);
  assert.deepEqual(h.focused, ['v1']);
});
