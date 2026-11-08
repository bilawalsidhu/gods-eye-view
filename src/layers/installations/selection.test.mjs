import test from 'node:test';
import assert from 'node:assert/strict';
import * as context from '../../data/contextStore.js';
import { SELECTION_FILL_SET_ID } from './render/display.js';
import { createDisplayHarness } from './render/displayHarness.mjs';
import { GROUND_HARNESSES } from '../../testSupport/groundDisplayEngines.mjs';

function harness(t, makeHarness = GROUND_HARNESSES[0]) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  const record = {
    id: 'base',
    name: 'Base',
    class: 'base',
    namedArea: true,
    latitude: 0,
    longitude: 0,
    footprints: [
      [
        [
          [0, 0],
          [0.01, 0],
          [0.01, 0.01],
          [0, 0],
        ],
      ],
    ],
  };
  let labels = [];
  const h = createDisplayHarness(makeHarness, {
    overlayHost: {
      setEntries(_id, entries) {
        labels = entries;
      },
      clearSource() {},
      setVisible() {},
    },
  });
  h.setRecords([record]);
  h.setPhotoreal(true);
  h.start();
  const selection = h.parts.display;
  t.after(() => {
    h.destroy();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  const assertSelected = (selected) => {
    assert.equal(h.state.selectedId, selected ? record.id : null);
    assert.equal(labels[0].selected, selected);
    assert.equal(labels[0].variant, selected ? 'selected' : 'card');
    assert.equal(
      h.set(SELECTION_FILL_SET_ID)?.items.length ?? 0,
      selected ? 1 : 0,
    );
  };
  assert.equal(selection.selectRecord(record.id), true);
  assertSelected(true);
  return { state: h.state, selection, assertSelected };
}

for (const layerId of ['flights', 'military', 'satellites']) {
  for (const publishBeforeEvent of [false, true]) {
    test(`${layerId} programmatic selection clears the installation card and fill (context first: ${publishBeforeEvent})`, (t) => {
      const h = harness(t);
      const subject = { id: 'other', layerId, origin: 'programmatic' };
      if (publishBeforeEvent) context.selectTrackedSubjectContext(subject);
      window.dispatchEvent(
        new CustomEvent('gev:awareness-subject-selected', { detail: subject }),
      );
      h.assertSelected(false);
      if (!publishBeforeEvent) context.selectTrackedSubjectContext(subject);
      assert.equal(context.getSelectedEntityContext().id, 'other');
      assert.equal(context.getSelectedEntityContext().layerId, layerId);
    });
  }
}

test('entity selection and clear still release the installation card and fill', (t) => {
  const h = harness(t);
  const other = {};
  context.registerEntityContext(other, { id: 'other', layerId: 'vessels' });
  context.selectEntityContext(other);
  h.assertSelected(false);
  h.selection.selectRecord('base');
  context.clearSelectedEntityContextForLayer('military-installations');
  h.assertSelected(false);
});

test('destroy removes all installation context listeners', (t) => {
  const h = harness(t);
  h.selection.destroyInteraction();
  context.selectTrackedSubjectContext({ id: 'other', layerId: 'flights' });
  for (const type of [
    'gev:entity-selected',
    'gev:entity-selection-cleared',
    'gev:awareness-subject-selected',
  ]) {
    window.dispatchEvent(
      new CustomEvent(type, { detail: { id: 'other', layerId: 'flights' } }),
    );
    h.assertSelected(true);
  }
});
