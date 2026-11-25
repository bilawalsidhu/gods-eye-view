import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AT,
  HOUR,
  fireAt,
  piece,
  snapshot,
  harness,
} from '../../testSupport/perimeterLayerHarness.mjs';

// On Cesium a rebuilt set keeps drawing (and picking) its old ground
// primitives until the new ones are ready (draw.js replaceHost; drawHit.js:
// "a ground swap can pick a retiring primitive"). A click in that window
// hits the item as it was drawn before the read.
test('a click on a fill still drawn from before a version change selects its fire', async () => {
  const fires = [fireAt('a', -120, 38)];
  let pieces = [
    piece('a', 'v1/0', AT - HOUR),
    piece('a', 'other', AT - HOUR, { lon: -120.5 }),
  ];
  let onClick = null;
  const entries = [];
  const h = harness(() => snapshot(fires, pieces), {
    overlayHost: {
      setEntries: (sourceId, list) => entries.push(...list),
      setVisible() {},
      clearSource() {},
    },
    inputFor: () => ({
      onClick(handler) {
        onClick = handler;
        return () => {};
      },
    }),
    picking: {
      clickCard: () => null,
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: () => false,
    },
  });
  await h.layer.update();
  // The hit Cesium makes on the first piece's fill, as drawn now.
  const item = [...h.items('fills').values()].find(({ id }) =>
    id.includes(':v1%2F0:'),
  );
  const oldHit = {
    set: item.set,
    id: item.id,
    ...(item.meta === undefined ? {} : { meta: item.meta }),
    surface: false,
  };
  onClick({ topHit: oldHit, drawHit: oldHit });
  assert.equal(entries.at(-1)?.id, 'fire-perimeter-card:a');
  // A WFIGS edit: the fire's pieces come back with a new version id.
  pieces = [
    piece('a', 'v2/0', AT - HOUR),
    piece('a', 'other', AT - HOUR, { lon: -120.5 }),
  ];
  await h.layer.update();
  entries.length = 0;
  onClick({ topHit: oldHit, drawHit: oldHit });
  assert.equal(entries.length, 1, 'the still-drawn old fill opens its card');
  assert.equal(entries[0].id, 'fire-perimeter-card:a');
  h.layer.destroy();
});
