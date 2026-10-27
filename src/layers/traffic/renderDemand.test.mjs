import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnimation } from './animation.js';

test('traffic render demand follows animated population and jam lines across empty, disable and re-enable', () => {
  const calls = [];
  const state = { _enabled: true, _dots: [], _motion: { rebuilds: 0 } };
  const animation = createAnimation({
    state,
    services: {
      render: {
        holdContinuousRender: (id) => calls.push(['hold', id]),
        releaseContinuousRender: (id) => calls.push(['release', id]),
      },
    },
    parts: {
      retention: { clear() {} },
      rendering: {
        removeHeatLines() {
          state._heatJamPrim = null;
        },
      },
    },
  });
  animation.syncRenderDemand();
  assert.deepEqual(calls, []);
  state._dots.push({});
  animation.syncRenderDemand();
  animation.syncRenderDemand();
  assert.deepEqual(calls, [['hold', 'traffic']]);
  animation.clearDots();
  assert.deepEqual(calls.at(-1), ['release', 'traffic']);
  state._heatJamPrim = {};
  animation.syncRenderDemand();
  assert.deepEqual(calls.at(-1), ['hold', 'traffic']);
  state._enabled = false;
  animation.syncRenderDemand();
  assert.deepEqual(calls.at(-1), ['release', 'traffic']);
  state._enabled = true;
  animation.clearDots();
  assert.equal(state._renderHeld, false);
  state._dots.push({});
  animation.syncRenderDemand();
  assert.equal(state._renderHeld, true);
});
