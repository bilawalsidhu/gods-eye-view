import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrackedReadout } from './trackedReadout.js';

test('followed aircraft card anchors to the model the person sees (gevVisualPosition)', () => {
  const display = { x: 1, y: 0, z: 0 };
  const visual = { x: 1, y: 0, z: 100 };
  const native = {
    gevTrackedId: 'flight:abc',
    gevLabelModel: { title: 'ABC123' },
    gevDisplayPosition: () => display,
    gevVisualPosition: () => visual,
  };
  const handle = {
    native,
    label: {
      id: 'flight:abc',
      model: () => native.gevLabelModel,
      position: () => native.gevDisplayPosition(),
    },
  };
  const listeners = [];
  const engine = {
    camera: {
      following: () => handle,
      followChanged: {
        addEventListener: (f) => {
          listeners.push(f);
          return () => {};
        },
      },
    },
  };
  let entries = null;
  const overlay = {
    setEntries(_id, e) {
      entries = e;
    },
    setVisible() {},
    clearSource() {
      entries = null;
    },
  };
  const readout = createTrackedReadout(engine, {
    overlay,
    events: new EventTarget(),
    selectedContext: () => null,
  });
  readout.init();
  assert.ok(entries?.length === 1, 'card published');
  assert.deepEqual(entries[0].position(), visual);
});
