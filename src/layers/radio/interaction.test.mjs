import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteraction } from './interaction.js';
import { RADIO_PICK_WINDOW_PX } from './policy.js';
import { radioStationIdFromPick } from './rendering.js';

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
    parts: { rendering: { radioStationIdFromPick } },
  });
}

/** A draw-set item's hit. */
const hit = (id, set = 'radio:1:stations') => ({ set, id, surface: false });

/** A click event whose drill answers only with the window it is asked for. */
function clickEvent({ pick, windowHits = [] }) {
  const drills = [];
  return {
    drills,
    topHit: pick ?? null,
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
    windowHits: [hit('notes:1', 'notes:1'), hit('radio:kexp')],
  });
  assert.equal(pickedRadioStationAt(event), 'kexp');
  assert.deepEqual(event.drills, [
    [16, RADIO_PICK_WINDOW_PX, RADIO_PICK_WINDOW_PX],
  ]);
});

test('a direct hit needs no drill, and another layer’s contact keeps its click', () => {
  const { pickedRadioStationAt } = interaction();
  const direct = clickEvent({ pick: hit('radio:kexp') });
  assert.equal(pickedRadioStationAt(direct), 'kexp');
  assert.deepEqual(direct.drills, []);
  const other = clickEvent({
    pick: hit('flight-1', 'flights:1'),
    windowHits: [hit('radio:kexp')],
  });
  assert.equal(pickedRadioStationAt(other), null);
});

// A station found only through radio's wider window, not as the tap's own
// pick or its touch contact, sits under another layer's card or label: that
// layer acts and never sees this window, so radio leaves the click.
test('a window-only station yields to a card painted over it', () => {
  let top = null;
  const radio = createInteraction({
    state: { _stationById: new Map([['kexp', {}]]) },
    services: {
      picking: {
        resolvePickId: (picked) => picked?.id ?? null,
        isOwnedByOtherLayer: () => false,
        registerPickOwner() {},
        unregisterPickOwner() {},
      },
      overlays: {
        setOverlaySourceVisible() {},
        hitTestWorldOverlay: () => top,
      },
    },
    parts: { rendering: { radioStationIdFromPick } },
  });
  const station = hit('radio:kexp');
  const near = (contact = null) => ({
    ...clickEvent({ windowHits: [station] }),
    hit: contact,
    screenPosition: { x: 5, y: 5 },
  });
  assert.equal(radio.pickedRadioStationAt(near()), 'kexp', 'open map');
  top = { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' };
  assert.equal(radio.pickedRadioStationAt(near()), null, 'under a quake card');
  assert.equal(
    radio.pickedRadioStationAt(near(station)),
    'kexp',
    'the touch contact: the card yielded to the station',
  );
  top = { sourceId: 'radio', entryId: 'radio:kexp' };
  assert.equal(radio.pickedRadioStationAt(near()), 'kexp', 'our own card');
});

// Under another layer's card, radio's window can name a different station
// from the tap's touch contact. The card yields to that contact, a station of
// ours, so radio acts on it instead of leaving the click dead.
test('under a card, the touch contact station is ours even when the window names another', () => {
  const radio = createInteraction({
    state: { _stationById: new Map([['kexp', {}], ['kuow', {}]]) },
    services: {
      picking: {
        resolvePickId: (picked) => picked?.id ?? null,
        isOwnedByOtherLayer: () => false,
        registerPickOwner() {},
        unregisterPickOwner() {},
      },
      overlays: {
        setOverlaySourceVisible() {},
        hitTestWorldOverlay: () => ({
          sourceId: 'earthquake-card',
          entryId: 'earthquake-card:ak1',
        }),
      },
    },
    parts: { rendering: { radioStationIdFromPick } },
  });
  const tap = (contact) => ({
    ...clickEvent({ windowHits: [hit('radio:kexp')] }),
    hit: contact,
    screenPosition: { x: 5, y: 5 },
  });
  assert.equal(radio.pickedRadioStationAt(tap(hit('radio:kuow'))), 'kuow');
  assert.equal(radio.pickedRadioStationAt(tap(null)), null, 'no contact');
});
