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
import {
  PERIMETER_LABEL_RANGE_M,
  PERIMETER_LABEL_SOURCE_ID,
  PERIMETER_MARKER_FROM_M,
} from './index.js';

/** The layer with an overlay host and clicks, its label entries kept. */
function withOverlay(read) {
  const published = new Map();
  let onClick = null;
  let cardHit = null;
  const h = harness(read, {
    overlayHost: {
      setEntries: (sourceId, list) => published.set(sourceId, list),
      setVisible() {},
      clearSource: (sourceId) => published.delete(sourceId),
    },
    inputFor: () => ({
      onClick(handler) {
        onClick = handler;
        return () => {};
      },
    }),
    picking: {
      clickCard: () => cardHit,
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: () => false,
    },
  });
  const click = (hit) => onClick(hit);
  return {
    ...h,
    published,
    labels: () => published.get(PERIMETER_LABEL_SOURCE_ID) ?? [],
    card: () => published.get('fire-perimeters')?.[0] ?? null,
    click,
    clickLabel(entryId) {
      cardHit = { sourceId: PERIMETER_LABEL_SOURCE_ID, entryId };
      onClick({ topHit: null, drawHit: null });
      cardHit = null;
    },
  };
}

const markersOf = (h) => {
  const id = h.renderer.testing.sets().find((set) => set.endsWith(':markers'));
  return id ? h.renderer.testing.setRecord(id).items : new Map();
};

test('each fire has a flame marker at its card anchor for far zoom, sized by acres', async () => {
  const fires = [
    { ...fireAt('small', -120, 38), acres: 100 },
    { ...fireAt('big', -119, 39), acres: 1_000_000 },
    fireAt('unsized', -118, 40),
  ];
  let list = fires;
  const h = withOverlay(() =>
    snapshot(list, [piece('small', 's1', AT - HOUR)]),
  );
  await h.layer.update();
  const markers = markersOf(h);
  assert.deepEqual(
    [...markers.keys()],
    [
      'fire-perimeter:small:marker',
      'fire-perimeter:big:marker',
      'fire-perimeter:unsized:marker',
    ],
    'a fire without pieces has its marker too',
  );
  const small = markers.get('fire-perimeter:small:marker');
  const big = markers.get('fire-perimeter:big:marker');
  assert.ok(big.size[0] > small.size[0], 'a bigger fire, a bigger flame');
  assert.deepEqual(small.meta, { fireId: 'small' });
  assert.deepEqual(small.displayRange, [PERIMETER_MARKER_FROM_M, Infinity]);
  assert.equal(small.height, 'clampGround');
  assert.match(small.image, /^data:image\/svg\+xml/);
  // Nothing about the fires changed: the markers are not written.
  const record = () =>
    h.renderer.testing.setRecord(
      h.renderer.testing.sets().find((set) => set.endsWith(':markers')),
    );
  const items = record().items;
  await h.layer.update();
  assert.equal(record().items, items);
  list = fires.slice(1);
  await h.layer.update();
  assert.deepEqual(
    [...markersOf(h).keys()],
    ['fire-perimeter:big:marker', 'fire-perimeter:unsized:marker'],
  );
  h.layer.disable();
  const id = h.renderer.testing.sets().find((set) => set.endsWith(':markers'));
  assert.equal(h.renderer.testing.setRecord(id).show, false);
  h.layer.destroy();
  assert.deepEqual(
    h.renderer.testing.sets().filter((set) => set.startsWith('fire')),
    [],
  );
});

test('a fire has a "name · acres" label at middle zoom; a click on it selects the fire', async () => {
  const fires = [
    { ...fireAt('a', -120, 38), name: 'Alder', acres: 1234.4 },
    { ...fireAt('b', -119, 39), name: 'Birch', acres: 50_000 },
  ];
  const h = withOverlay(() => snapshot(fires, []));
  await h.layer.update();
  const labels = h.labels();
  assert.deepEqual(
    labels.map(({ id, title }) => [id, title]),
    [
      ['fire-perimeter-label:b', 'Birch · 50,000 ac'],
      ['fire-perimeter-label:a', 'Alder · 1,234 ac'],
    ],
    'biggest first',
  );
  const [label] = labels;
  assert.equal(label.minDistance, PERIMETER_LABEL_RANGE_M[0]);
  assert.equal(label.maxDistance, PERIMETER_LABEL_RANGE_M[1]);
  assert.equal(label.minDistance, PERIMETER_MARKER_FROM_M);
  assert.ok(Number.isFinite(label.position.x));
  assert.equal(label.interactive, true);
  h.clickLabel('fire-perimeter-label:a');
  assert.equal(h.card()?.id, 'fire-perimeter-card:a');
  // The selected fire's card stands in for its label.
  assert.deepEqual(
    h.labels().map(({ id }) => id),
    ['fire-perimeter-label:b'],
  );
  // Keyboard activation selects as a click does.
  h.labels()[0].activate();
  assert.equal(h.card()?.id, 'fire-perimeter-card:b');
  h.layer.disable();
  assert.equal(h.published.has(PERIMETER_LABEL_SOURCE_ID), false);
  h.layer.destroy();
});
