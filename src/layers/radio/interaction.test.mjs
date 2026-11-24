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

// Another layer's card or label painted on top takes the click: no station
// under it acts, whether radio found it through its window, as the tap's touch
// contact or as the exact pick. Radio's own card on top is radio's click.
test("a station under another layer's card does not act", () => {
  let top = null;
  const radio = createInteraction({
    state: {
      _stationById: new Map([
        ['kexp', {}],
        ['kuow', {}],
      ]),
    },
    services: {
      picking: {
        resolvePickId: (picked) => picked?.id ?? null,
        isOwnedByOtherLayer: () => false,
        // The card on top at a click, as the registry answers from the host.
        isUnderOtherCard: (_click, own = []) =>
          Boolean(top) && !own.includes(top.sourceId),
        registerPickOwner() {},
        unregisterPickOwner() {},
      },
      overlays: { setOverlaySourceVisible() {} },
    },
    parts: { rendering: { radioStationIdFromPick } },
  });
  const station = hit('radio:kexp');
  const tap = (contact = null, pick = null) => ({
    ...clickEvent({ pick, windowHits: [station] }),
    hit: contact,
    screenPosition: { x: 5, y: 5 },
  });
  assert.equal(radio.pickedRadioStationAt(tap()), 'kexp', 'open map');
  top = { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' };
  assert.equal(radio.pickedRadioStationAt(tap()), null, 'window only');
  assert.equal(radio.pickedRadioStationAt(tap(station)), null, 'contact');
  assert.equal(
    radio.pickedRadioStationAt(tap(hit('radio:kuow'))),
    null,
    'another contact station',
  );
  assert.equal(radio.pickedRadioStationAt(tap(null, station)), null, 'exact');
  top = { sourceId: 'radio', entryId: 'radio:kexp' };
  assert.equal(radio.pickedRadioStationAt(tap()), 'kexp', 'our own card');
});
