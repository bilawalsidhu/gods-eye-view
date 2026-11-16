import assert from 'node:assert/strict';
import test from 'node:test';
import { createInteraction } from './interaction.js';
import * as picking from '../../data/pickRegistry.js';

/** The cable click handler, with its click and overlay seams faked. */
function harness({ overlayTop = null } = {}) {
  let onClick = null;
  const picked = [];
  let top = overlayTop;
  const interaction = createInteraction({
    state: { _enabled: true, _clickSubscription: null },
    parts: {
      rendering: {
        pickInfo: (hit) => {
          picked.push(hit);
          return null;
        },
      },
    },
    inputFor: () => ({
      onClick: (fn) => {
        onClick = fn;
        return () => (onClick = null);
      },
    }),
    overlayHost: { hitTest: () => top },
  });
  interaction.beginInteraction({});
  return {
    picked,
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

// So a card on top (a live CCTV card) may act over the cable instead.
test('while it takes clicks, a drawn cable registers as card background', () => {
  const state = { _enabled: true, _clickSubscription: null };
  const interaction = createInteraction({
    state,
    parts: {
      rendering: {
        pickInfo: (hit) =>
          hit?.set === 'cables:1' ? { reference: { lon: 1, lat: 2 } } : null,
      },
    },
    inputFor: () => ({ onClick: () => () => {} }),
    overlayHost: { hitTest: () => null },
    picking,
  });
  interaction.beginInteraction({});
  const cable = { set: 'cables:1', id: 'cable:0' };
  try {
    assert.equal(picking.isCardBackground(cable), true);
    assert.equal(picking.isCardBackground({ set: 'other:1', id: 'x' }), false);
    state._enabled = false;
    assert.equal(picking.isCardBackground(cable), false);
    state._enabled = true;
    state._clickSubscription();
    assert.equal(picking.isCardBackground(cable), false);
  } finally {
    state._clickSubscription?.();
  }
});
