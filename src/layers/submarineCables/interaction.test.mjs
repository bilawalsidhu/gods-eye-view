import assert from 'node:assert/strict';
import test from 'node:test';
import { createInteraction } from './interaction.js';
import * as picking from '../../data/pickRegistry.js';

/** The cable click handler, with its click and overlay seams faked. */
function harness({ overlayTop = null, info = null } = {}) {
  let onClick = null;
  const picked = [];
  const selected = [];
  let top = overlayTop;
  const interaction = createInteraction({
    state: { _enabled: true, _clickSubscription: null },
    parts: {
      rendering: {
        pickInfo: (hit) => {
          picked.push(hit);
          return info;
        },
        select: (record) => selected.push(record),
      },
    },
    inputFor: () => ({
      onClick: (fn) => {
        onClick = fn;
        return () => (onClick = null);
      },
    }),
    overlayHost: { hitTest: () => top },
    // The card on top at a click, as the registry answers from the host.
    picking: { clickCard: () => top },
  });
  interaction.beginInteraction({});
  return {
    picked,
    selected,
    setTop: (next) => {
      top = next;
    },
    click: () =>
      onClick({
        screenPosition: { x: 5, y: 5 },
        drawHit: { set: 'c', id: 'x' },
      }),
  };
}

// Cable labels are not interactive: an overlay entry under the pointer is
// another layer's card or label painted over the cable (a quake card), and
// that layer takes the click, so the cable does not also fly the camera.
test('a card painted over a cable keeps its click; with none the cable reads the pick', () => {
  const h = harness({
    overlayTop: { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' },
  });
  h.click();
  assert.equal(h.picked.length, 0, 'the cable stands aside');
  h.setTop(null);
  h.click();
  assert.equal(
    h.picked.length,
    1,
    'with no card on top, the cable reads its pick',
  );
});

// A hit names its cable (and flies to it): the real-layer test in
// src/data/telegeographySubmarineCables.test.mjs covers it.
test('a click on nothing clears the name; a card on top leaves it as is', () => {
  const empty = harness();
  empty.click();
  assert.deepEqual(empty.selected, [null], 'a click on nothing clears it');

  const covered = harness({
    overlayTop: { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' },
  });
  covered.click();
  assert.deepEqual(covered.selected, [], "another layer's card keeps it as is");
});
