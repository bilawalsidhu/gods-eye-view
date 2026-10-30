import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from './state.js';
import { createReplay } from './replay.js';
import { createPaths } from './paths.js';

const noop = () => {};

function replayRig() {
  const state = createState({
    services: {
      overlays: {
        setOverlayEntries: noop,
        setOverlaySourceVisible: noop,
        clearOverlaySource: noop,
      },
    },
  });
  const parts = {};
  parts.paths = createPaths({ state, parts });
  return { state, replay: createReplay({ state, parts }) };
}

test('changing replay speed during the countdown keeps its real-time liftoff', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { state, replay } = replayRig();
  const launch = { launchTime: '2026-07-20T10:00:00Z', timeline: [] };
  state._animationStarts.set('countdown', 1_008_000); // T-8
  state._animationStarts.set('flying', 990_000); // 10 s into the mission

  replay.setReplaySpeed(0.25);

  const startedAt = state._animationStarts.get('countdown');
  assert.equal(startedAt, 1_008_000);
  const countdown = replay.replayState(
    launch,
    startedAt,
    12,
    28,
    5400,
    state._replaySpeed,
    Date.now(),
  );
  assert.equal(countdown.countdownSeconds, 8);
  // Mission time already flown is still preserved across the change.
  assert.equal(state._animationStarts.get('flying'), 960_000);
});
