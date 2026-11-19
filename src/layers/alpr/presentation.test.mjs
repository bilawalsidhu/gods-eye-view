import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlprPresentation } from './presentation.js';
import { fakeInput } from '../../input/testDoubles.mjs';
import { setClickCardHitTest } from '../../data/pickRegistry.js';

// The card or label painted on top takes the click: ALPR does not even pick
// under another layer's card, so no camera is selected or released there.
test("another layer's card over an ALPR camera keeps the click", (t) => {
  let picks = 0;
  const viewer = {
    scene: {
      canvas: new EventTarget(),
      pick: () => {
        picks++;
        return null;
      },
    },
  };
  const input = fakeInput(viewer);
  const noop = () => {};
  const state = {
    enabled: true,
    viewer,
    clickSubscription: null,
    markers: { icons: null },
    recordById: new Map(),
    selectedId: null,
  };
  const presentation = createAlprPresentation({
    state,
    services: {
      render: { governorRequestRender: noop },
      context: {
        clearSelectedEntityContextForLayer: noop,
        getSelectedEntityContext: () => null,
        registerEntityContext: noop,
        removeEntityContextsForLayer: noop,
        selectEntityContext: noop,
      },
      groundFloor: { cachedGroundFloor: () => null },
    },
  });
  presentation.installInteraction(viewer);
  let top = { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' };
  setClickCardHitTest(() => top);
  t.after(() => {
    setClickCardHitTest(null);
    state.clickSubscription?.();
    input.destroy();
  });
  input.tap({ x: 10, y: 10 });
  assert.equal(picks, 0, 'covered: the scene under the card is not picked');
  top = null;
  input.tap({ x: 10, y: 10 });
  assert.ok(picks > 0, 'open map: the click reaches the scene');
});
