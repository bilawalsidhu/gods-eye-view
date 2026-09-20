/**
 * Fire replay clock — pure state transitions shared by the layer's frame
 * loop, its row controls and the (phase-3) context panel. No Cesium, no DOM.
 *
 * The clock runs in EVENT time. `speed` multiplies a base rate of
 * {@link REPLAY_BASE_HOURS_PER_SECOND} event-hours per real second, so a
 * two-week fire plays in about a minute at 1×.
 */
import { eventRangeMs } from './model.js';

export const REPLAY_BASE_HOURS_PER_SECOND = 6;
export const REPLAY_SPEEDS = Object.freeze([0.5, 1, 2, 4]);
/** A detection reads as burning for this long after acquisition. */
export const REPLAY_ACTIVE_WINDOW_MS = 12 * 3600_000;
const HOUR_MS = 3600_000;

/**
 * @typedef {object} ReplayState
 * @property {'idle'|'playing'|'paused'|'ended'} status
 * @property {number} cursorMs Event time shown right now.
 * @property {number} speed One of REPLAY_SPEEDS.
 * @property {number} startMs Event window start.
 * @property {number} endMs Event window end (exclusive).
 */

/**
 * Fresh clock for an event, parked at the window start.
 * @param {object} event - Public or normalized event.
 * @param {number} [speed=1]
 * @returns {?ReplayState} Null when the event has no usable range.
 */
export function createReplayState(event, speed = 1) {
  const { startMs, endMs } = eventRangeMs(event);
  if (!(endMs > startMs)) return null;
  return Object.freeze({
    status: 'idle',
    cursorMs: startMs,
    speed: REPLAY_SPEEDS.includes(speed) ? speed : 1,
    startMs,
    endMs,
  });
}

/**
 * Move the clock by real elapsed time. Only a playing clock moves; reaching
 * the window end parks it as ended.
 * @param {ReplayState} state
 * @param {number} elapsedMs - Real milliseconds since the last frame.
 * @returns {ReplayState}
 */
export function advanceReplay(state, elapsedMs) {
  if (!state || state.status !== 'playing') return state;
  const dt = Math.max(0, Number(elapsedMs) || 0);
  const eventMs =
    (dt / 1000) * REPLAY_BASE_HOURS_PER_SECOND * HOUR_MS * state.speed;
  const cursorMs = state.cursorMs + eventMs;
  if (cursorMs >= state.endMs)
    return { ...state, cursorMs: state.endMs, status: 'ended' };
  return { ...state, cursorMs };
}

/**
 * Play from the current cursor, or from the start when idle or ended.
 * @param {ReplayState} state
 * @returns {ReplayState}
 */
export function playReplay(state) {
  if (!state) return state;
  const restart = state.status === 'idle' || state.status === 'ended';
  return {
    ...state,
    status: 'playing',
    cursorMs: restart ? state.startMs : state.cursorMs,
  };
}

/** @param {ReplayState} state @returns {ReplayState} */
export function pauseReplay(state) {
  return state?.status === 'playing' ? { ...state, status: 'paused' } : state;
}

/** Back to the static (all detections) presentation. */
export function resetReplay(state) {
  return state ? { ...state, status: 'idle', cursorMs: state.startMs } : state;
}

/**
 * Jump to a fraction of the window without changing play state; an idle
 * clock becomes paused so the seek is visible.
 * @param {ReplayState} state
 * @param {number} fraction - 0..1.
 * @returns {ReplayState}
 */
export function seekReplay(state, fraction) {
  if (!state) return state;
  const f = Math.max(0, Math.min(1, Number(fraction) || 0));
  const cursorMs = state.startMs + (state.endMs - state.startMs) * f;
  const status =
    state.status === 'idle' || state.status === 'ended'
      ? 'paused'
      : state.status;
  return { ...state, cursorMs, status };
}

/**
 * Next speed in the cycle (wraps).
 * @param {number} speed
 * @returns {number}
 */
export function cycleReplaySpeed(speed) {
  const index = REPLAY_SPEEDS.indexOf(speed);
  return REPLAY_SPEEDS[(index + 1) % REPLAY_SPEEDS.length];
}

/** @param {ReplayState} state @param {number} speed @returns {ReplayState} */
export function setReplaySpeed(state, speed) {
  if (!state || !REPLAY_SPEEDS.includes(speed)) return state;
  return { ...state, speed };
}

/**
 * Whether the clock is driving the presentation (anything but idle).
 * @param {?ReplayState} state
 * @returns {boolean}
 */
export function replayActive(state) {
  return Boolean(state) && state.status !== 'idle';
}

/**
 * How a detection reads at the cursor.
 * @param {{acqMs: number}} fire
 * @param {number} cursorMs
 * @param {number} [activeMs]
 * @returns {'pending'|'active'|'cooled'}
 */
export function detectionPhase(
  fire,
  cursorMs,
  activeMs = REPLAY_ACTIVE_WINDOW_MS,
) {
  if (!(fire?.acqMs <= cursorMs)) return 'pending';
  return cursorMs - fire.acqMs < activeMs ? 'active' : 'cooled';
}

/**
 * Detection counts at the cursor, for the row readout and the panel.
 * @param {Array<{acqMs: number}>} fires - Sorted by acqMs.
 * @param {number} cursorMs
 * @param {number} [activeMs]
 * @returns {{shown: number, active: number}}
 */
export function replayCounts(
  fires,
  cursorMs,
  activeMs = REPLAY_ACTIVE_WINDOW_MS,
) {
  let shown = 0;
  let active = 0;
  for (const fire of fires || []) {
    if (fire.acqMs > cursorMs) break; // sorted input
    shown += 1;
    if (cursorMs - fire.acqMs < activeMs) active += 1;
  }
  return { shown, active };
}

/**
 * `YYYY-MM-DD HH:MMZ` readout of the cursor.
 * @param {number} ms
 * @returns {string}
 */
export function formatReplayClock(ms) {
  if (!Number.isFinite(ms)) return '';
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
}

/**
 * Human status line for the layer row while the clock is engaged.
 * @param {ReplayState} state
 * @returns {string}
 */
export function replayLabel(state) {
  if (!replayActive(state)) return '';
  const verb =
    state.status === 'playing'
      ? 'REPLAY'
      : state.status === 'paused'
        ? 'PAUSED'
        : 'REPLAY END';
  return `${verb} · ${formatReplayClock(state.cursorMs)} · ${state.speed}×`;
}

/**
 * Transport chips appended after the event chips.
 * @param {?ReplayState} state
 * @param {{onToggle: Function, onReset: Function, onSpeed: Function}} handlers
 * @param {boolean} [ready=true] - Detections are loaded.
 * @returns {Array<object>}
 */
export function replayRowChips(state, handlers, ready = true) {
  if (!state) return [];
  const playing = state.status === 'playing';
  return [
    {
      id: 'replay-toggle',
      label: playing ? '❚❚ PAUSE' : '▶ REPLAY',
      title: playing
        ? 'Pause the spread replay'
        : 'Replay detections in event time',
      active: playing,
      disabled: !ready,
      onClick: handlers.onToggle,
    },
    {
      id: 'replay-reset',
      label: '↺ ALL',
      title: 'Show every detection again',
      active: false,
      disabled: !ready || state.status === 'idle',
      onClick: handlers.onReset,
    },
    {
      id: 'replay-speed',
      label: `${state.speed}×`,
      title: 'Cycle replay speed',
      active: false,
      disabled: !ready,
      onClick: handlers.onSpeed,
    },
  ];
}
