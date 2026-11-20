import * as picking from '../../data/pickRegistry.js';
import { CCTV_COUNT_CARD_SOURCE_ID } from '../../data/cctvCards.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSelection } from './selection.js';

// Earthquake discs (like fire perimeters and drone airspace) are deliberately
// unowned background fills. A clean tap on a count painted over a disc must
// zoom to the count and be the card on top for every layer, so Earthquakes
// opens no card. An owned scene object (an aircraft) still takes the click.
test('a count over an earthquake disc takes the click', () => {
  let zooms = 0;
  let clicks = 0;
  const selection = createSelection({
    services: { activation: {}, picking },
    state: {
      _enabled: true,
      _counts: { pickedCell: () => ({ key: 'g' }) },
      _cctvOverlayHost: { hitTest: () => null },
    },
    parts: {
      navigation: { zoomToCell: () => zooms++ },
      rendering: {
        extractPickedCameraId: (hit) =>
          hit?.set === 'cctv-icons' ? hit.id : null,
      },
    },
  });
  const click = selection.bindCctvWorldClickGesture(
    { onClick: (fn) => fn },
    () => clicks++,
  );
  const event = (hit) => ({
    screenPosition: { x: 20, y: 26 },
    topHit: hit,
    drawHit: hit,
    hit,
    gesture: { travelPx: 0, durationMs: 20 },
  });
  picking.registerClickClaim('cctv', selection.countClickCard);
  picking.registerPickOwner('flights', (id) => id.startsWith('aircraft:'));
  try {
    const disc = event({ set: 'earthquakes:1:discs', id: 'earthquake:abc' });
    assert.deepEqual(picking.clickCard(disc), {
      sourceId: CCTV_COUNT_CARD_SOURCE_ID,
      entryId: 'g',
    });
    click(disc);
    assert.deepEqual([zooms, clicks], [1, 0]);

    const aircraft = event({ set: 'flights:icons', id: 'aircraft:abc' });
    assert.equal(picking.clickCard(aircraft), null);
    click(aircraft);
    assert.deepEqual([zooms, clicks], [1, 1]);
  } finally {
    picking.unregisterClickClaim('cctv');
    picking.unregisterPickOwner('flights');
  }
});
