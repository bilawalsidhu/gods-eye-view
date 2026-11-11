import test from 'node:test';
import assert from 'node:assert/strict';
import { createAircraftIcons } from './aircraftIconLayer.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';

const WORLD_MS = Date.UTC(2026, 10, 1, 12, 0);

test('following the world clock, contacts draw at the world’s time on the scene clock', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: WORLD_MS + 86_400_000 });
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  let following = false;
  const state = {
    _viewer: viewer,
    now: () => (following ? WORLD_MS : Date.now()),
  };
  const icons = createAircraftIcons({
    state,
    services: { focus: { focusPassIsNeeded: () => false } },
    parts: {},
    layerId: 'flights',
    renderDelaySec: 30,
    followsClock: () => following,
    courseMaxDps: 3,
    cockpitContactSizePx: 8,
  });
  icons._createIcons(viewer);
  const set = draw.find('flights-icons:');
  // Live: a poll interval behind real time, on the delayed live clock.
  assert.deepEqual(set.spec.motionClock, { kind: 'live', delayMs: 30_000 });
  assert.equal(icons._displayMs(), Date.now() - 30_000);
  following = true;
  assert.equal(icons._displayMs(), WORLD_MS, 'the world’s time, no delay');
  icons._syncMotionClock();
  assert.deepEqual(set.spec.motionClock, { kind: 'scene' });
  following = false;
  icons._syncMotionClock();
  assert.deepEqual(set.spec.motionClock, { kind: 'live', delayMs: 30_000 });
  icons._disposeIcons();
});
