import test from 'node:test';
import assert from 'node:assert/strict';
import { appClock } from '../../time/clock.js';
import { createReplay } from './replay.js';
function setup() {
  const state = {
    _missionPanel: null,
    _replayCameraLaunchId: 'qa',
    _replayPaused: false,
    _replayPausedAtMs: null,
    _replaySpeed: 1,
    _animationStarts: new Map([['qa', 1000]]),
  };
  const parts = {
    panel: { publishPanel() {} },
    paths: { orbitInsertionOffsetSeconds: () => 600 },
  };
  return {
    state,
    replay: createReplay({ state, services: {}, parts, source: {} }),
  };
}
test('five seconds of tile preparation are followed by the full ten-second countdown', () => {
  const { replay } = setup(),
    launch = { launchTime: '2026-10-15T12:00:00Z' };
  try {
    appClock.freeze(100000);
    assert.equal(
      replay.replayState(launch, 115000, 12, 28, 5400, 4, undefined, 5)
        .preCountdownActive,
      true,
    );
    appClock.freeze(105000);
    const countdown = replay.replayState(
      launch,
      115000,
      12,
      28,
      5400,
      4,
      undefined,
      5,
    );
    assert.equal(countdown.preCountdownActive, false);
    assert.equal(countdown.countdownSeconds, 10);
    appClock.freeze(114000);
    assert.equal(
      replay.replayState(launch, 115000, 12, 28, 5400, 4, undefined, 5)
        .countdownSeconds,
      1,
    );
    appClock.freeze(116000);
    assert.equal(
      replay.replayState(launch, 115000, 12, 28, 5400, 4, undefined, 5)
        .elapsedSinceStart,
      4,
    );
  } finally {
    appClock.reset();
  }
});
test('pause, resume and speed changes use app time without a wall-clock jump', () => {
  const { state, replay } = setup();
  try {
    appClock.freeze(4000);
    assert.equal(replay.pauseMissionReplay(), true);
    appClock.freeze(9500);
    assert.equal(replay.replayClockNow('qa'), 4000);
    assert.equal(replay.resumeMissionReplay(), true);
    assert.equal(state._animationStarts.get('qa'), 6500);
    replay.setReplaySpeed(4);
    assert.equal(state._animationStarts.get('qa'), 8750);
  } finally {
    appClock.reset();
  }
});
