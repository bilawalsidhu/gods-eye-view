import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteraction } from './interaction.js';
import { fakeInput } from '../../input/testDoubles.mjs';
import * as picking from '../../data/pickRegistry.js';

// The card or label painted on top takes the click: a satellite under another
// layer's card is neither tracked nor let go.
test("another layer's card over a satellite keeps the click", (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget();
  let picked = null;
  const viewer = { scene: { canvas: new EventTarget(), pick: () => picked } };
  const input = fakeInput(viewer);
  const calls = [];
  const state = {
    _enabled: true,
    _trackedNorad: null,
    _clickSubscription: null,
    _trackedEntityChangedRemove: () => {},
    _catalog: new Map([[25544, {}]]),
  };
  const interaction = createInteraction({
    state,
    services: { picking },
    parts: {
      rendering: {
        _hitIsTracked: () => false,
        _hitPointId: (hit) =>
          hit?.set === 'satellites:dots' ? Number(hit.id) : null,
      },
      tracking: {
        _cancelPendingTrackingRestore() {},
        _trackSatellite: (id) => calls.push(['track', id]),
        _clearTracking: () => calls.push(['clear']),
      },
    },
  });
  interaction._installClickHandler(viewer);
  let top = { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' };
  picking.setClickCardHitTest(() => top);
  t.after(() => {
    picking.setClickCardHitTest(null);
    state._clickSubscription?.();
    input.destroy();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  const click = (hit) => {
    picked = hit ? { id: hit } : null;
    input.tap({ x: 10, y: 10 });
  };
  const dot = { set: 'satellites:dots', id: '25544' };
  click(dot);
  assert.deepEqual(calls, [], 'covered: not tracked');
  state._trackedNorad = 1;
  click(null);
  assert.deepEqual(calls, [], 'covered: tracking kept');
  top = null;
  click(null);
  assert.deepEqual(calls, [['clear']], 'open map lets it go');
  state._trackedNorad = null;
  click(dot);
  assert.deepEqual(calls.at(-1), ['track', 25544]);
});
