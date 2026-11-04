import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteraction } from './interaction.js';
import { RADIO_PICK_WINDOW_PX } from './policy.js';

function interaction() {
  const state = { _stationById: new Map([['kexp', {}]]) };
  return createInteraction({
    state,
    services: {
      picking: {
        resolvePickId: (picked) => picked?.id ?? null,
        isOwnedByOtherLayer: (layer, id) => id === 'flight-1',
        registerPickOwner() {},
        unregisterPickOwner() {},
      },
      overlays: { setOverlaySourceVisible() {} },
    },
    parts: {},
  });
}

/** A click event whose drill answers only with the window it is asked for. */
function clickEvent({ pick, windowHits = [] }) {
  const drills = [];
  return {
    drills,
    pick,
    drill(limit, width, height) {
      drills.push([limit, width, height]);
      return width === RADIO_PICK_WINDOW_PX && height === RADIO_PICK_WINDOW_PX
        ? windowHits
        : [];
    },
  };
}

test('a near miss finds the station through one windowed drill', () => {
  const { pickedRadioStationAt } = interaction();
  const event = clickEvent({
    pick: undefined,
    windowHits: [{ id: 'tile' }, { id: 'radio:kexp' }],
  });
  assert.equal(pickedRadioStationAt(event), 'kexp');
  assert.deepEqual(event.drills, [
    [16, RADIO_PICK_WINDOW_PX, RADIO_PICK_WINDOW_PX],
  ]);
});

test('a direct hit needs no drill, and another layer’s contact keeps its click', () => {
  const { pickedRadioStationAt } = interaction();
  const direct = clickEvent({ pick: { id: 'radio:kexp' } });
  assert.equal(pickedRadioStationAt(direct), 'kexp');
  assert.deepEqual(direct.drills, []);
  const other = clickEvent({
    pick: { id: 'flight-1' },
    windowHits: [{ id: 'radio:kexp' }],
  });
  assert.equal(pickedRadioStationAt(other), null);
});
