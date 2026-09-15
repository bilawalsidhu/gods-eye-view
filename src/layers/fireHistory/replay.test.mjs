import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPLAY_ACTIVE_WINDOW_MS,
  REPLAY_BASE_HOURS_PER_SECOND,
  advanceReplay,
  createReplayState,
  cycleReplaySpeed,
  detectionPhase,
  formatReplayClock,
  pauseReplay,
  playReplay,
  replayActive,
  replayCounts,
  replayLabel,
  replayRowChips,
  resetReplay,
  seekReplay,
  setReplaySpeed,
} from './replay.js';

const EVENT = { startDate: '2018-11-08', endDate: '2018-11-09' }; // 2 days
const START = Date.UTC(2018, 10, 8);
const END = Date.UTC(2018, 10, 10);
const HOUR = 3600_000;

test('createReplayState parks idle at the window start and validates speed', () => {
  const state = createReplayState(EVENT, 2);
  assert.deepEqual(state, { status: 'idle', cursorMs: START, speed: 2, startMs: START, endMs: END });
  assert.equal(createReplayState(EVENT, 3).speed, 1);
  assert.equal(createReplayState({ startDate: 'x' }), null);
});

test('advanceReplay moves only while playing, in event time, and parks at the end', () => {
  const idle = createReplayState(EVENT);
  assert.equal(advanceReplay(idle, 1000), idle);
  const playing = playReplay(idle);
  const after1s = advanceReplay(playing, 1000);
  assert.equal(after1s.cursorMs, START + REPLAY_BASE_HOURS_PER_SECOND * HOUR);
  const fast = advanceReplay(setReplaySpeed(playing, 4), 1000);
  assert.equal(fast.cursorMs, START + 4 * REPLAY_BASE_HOURS_PER_SECOND * HOUR);
  const ended = advanceReplay(playing, 3_600_000);
  assert.equal(ended.status, 'ended');
  assert.equal(ended.cursorMs, END);
  assert.equal(advanceReplay(playing, -50).cursorMs, START);
});

test('play restarts from idle or ended, resumes from paused', () => {
  const mid = { ...playReplay(createReplayState(EVENT)), cursorMs: START + 5 * HOUR };
  assert.equal(playReplay(pauseReplay(mid)).cursorMs, START + 5 * HOUR);
  assert.equal(playReplay({ ...mid, status: 'ended', cursorMs: END }).cursorMs, START);
  assert.equal(pauseReplay(createReplayState(EVENT)).status, 'idle');
  assert.deepEqual(resetReplay(mid), { ...mid, status: 'idle', cursorMs: START });
});

test('seek clamps and makes an idle clock visible as paused', () => {
  const state = createReplayState(EVENT);
  const half = seekReplay(state, 0.5);
  assert.equal(half.cursorMs, START + 24 * HOUR);
  assert.equal(half.status, 'paused');
  assert.equal(seekReplay(playReplay(state), 2).status, 'playing');
  assert.equal(seekReplay(state, -1).cursorMs, START);
});

test('speed cycles through the fixed list', () => {
  assert.equal(cycleReplaySpeed(0.5), 1);
  assert.equal(cycleReplaySpeed(4), 0.5);
  assert.equal(cycleReplaySpeed(99), 0.5);
  assert.equal(setReplaySpeed(createReplayState(EVENT), 7).speed, 1);
});

test('detectionPhase and replayCounts follow the active window on sorted input', () => {
  const fires = [
    { acqMs: START + 1 * HOUR },
    { acqMs: START + 3 * HOUR },
    { acqMs: START + 20 * HOUR },
  ];
  const cursor = START + 14 * HOUR;
  assert.equal(detectionPhase(fires[0], cursor), 'cooled');
  assert.equal(detectionPhase(fires[1], cursor), 'active');
  assert.equal(detectionPhase(fires[2], cursor), 'pending');
  assert.equal(detectionPhase({ acqMs: NaN }, cursor), 'pending');
  assert.deepEqual(replayCounts(fires, cursor), { shown: 2, active: 1 });
  assert.deepEqual(replayCounts(fires, START - 1), { shown: 0, active: 0 });
  assert.equal(REPLAY_ACTIVE_WINDOW_MS, 12 * HOUR);
});

test('labels and chips reflect transport state', () => {
  const idle = createReplayState(EVENT);
  assert.equal(replayActive(idle), false);
  assert.equal(replayLabel(idle), '');
  const playing = advanceReplay(playReplay(idle), 1000);
  assert.equal(replayLabel(playing), 'REPLAY · 2018-11-08 06:00Z · 1×');
  assert.equal(replayLabel(pauseReplay(playing)), 'PAUSED · 2018-11-08 06:00Z · 1×');
  assert.equal(replayLabel({ ...playing, status: 'ended', cursorMs: END }), 'REPLAY END · 2018-11-10 00:00Z · 1×');
  assert.equal(formatReplayClock(NaN), '');

  const calls = [];
  const handlers = { onToggle: () => calls.push('t'), onReset: () => calls.push('r'), onSpeed: () => calls.push('s') };
  const idleChips = replayRowChips(idle, handlers);
  assert.deepEqual(idleChips.map((c) => [c.id, c.label, c.disabled, c.active]), [
    ['replay-toggle', '▶ REPLAY', false, false],
    ['replay-reset', '↺ ALL', true, false],
    ['replay-speed', '1×', false, false],
  ]);
  const playingChips = replayRowChips(playing, handlers);
  assert.equal(playingChips[0].label, '❚❚ PAUSE');
  assert.equal(playingChips[0].active, true);
  assert.equal(playingChips[1].disabled, false);
  for (const chip of playingChips) chip.onClick();
  assert.deepEqual(calls, ['t', 'r', 's']);
  assert.ok(replayRowChips(idle, handlers, false).every((c) => c.disabled));
  assert.deepEqual(replayRowChips(null, handlers), []);
});
