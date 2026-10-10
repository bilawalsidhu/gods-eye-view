import { progressLine } from './speech.js';

/**
 * Timing policy for filling silence while tools run. Tuned against the turn
 * spans' `max_silence_ms`.
 */
export const NARRATION_TIMING = Object.freeze({
  /** Start the earcon when nothing is audible this long after end of speech. */
  earconAfterMs: 700,
  /** First spoken progress line when a tool is still running after this. */
  firstLineMs: 1500,
  /** Minimum spacing between spoken lines. */
  stepGapMs: 3000,
  /** Spoken step lines per turn, not counting the one "still working" line. */
  maxStepLines: 2,
  /** One "still working" line when a tool runs this long. */
  stillWorkingMs: 8000,
  /** The earcon never runs longer than this in one turn. */
  earconMaxMs: 15000,
  /** After the last tool, the earcon waits this long for the reply to start. */
  replyGraceMs: 3000,
});

/**
 * Provider-neutral progress narration for one voice session.
 *
 * Three voices, cheapest last: the model's own preamble (detected, never
 * generated here), code-authored progress lines for the current tool step,
 * and a quiet earcon when nothing else is audible. The adapter supplies how a
 * line is spoken (`speak`) and when speaking is allowed (`canSpeak`: not while
 * the user is talking or holding push-to-talk, and not over another reply).
 *
 * Staleness: every timer re-checks the turn generation and that its tool is
 * still running. The last `toolFinished()` clears pending lines and calls
 * `retract`, which drops a line nobody has heard but lets an audible one
 * finish. `cancel()` (barge-in, new user turn, session stop) is new intent:
 * it calls `stop`, which ends the line even if it is playing.
 */
export function createNarrationScheduler({
  speak,
  retract = () => {},
  stop = retract,
  earcon = null,
  canSpeak = () => true,
  onNarration = () => {},
  now = () => performance.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  timing = NARRATION_TIMING,
} = {}) {
  let generation = 0;
  let tools = new Map();
  let timers = new Set();
  let audibleNow = false;
  let preambleSpoken = false;
  let stepLines = 0;
  let stillSpoken = false;
  let lastLineAt = -Infinity;
  let firstLineScheduled = false;
  let earconOn = false;
  let earconStartedAt = 0;

  function later(ms, fn) {
    const epoch = generation;
    const id = setTimer(
      () => {
        timers.delete(id);
        if (epoch === generation) fn();
      },
      Math.max(0, ms),
    );
    timers.add(id);
    return id;
  }

  function clearTimers() {
    for (const id of timers) clearTimer(id);
    timers = new Set();
  }

  function stopEarcon() {
    if (!earconOn) return;
    earconOn = false;
    try {
      earcon?.stop();
    } catch {
      /* Audio feedback is best effort. */
    }
  }

  function startEarcon() {
    if (earconOn || audibleNow || !earcon) return;
    if (earcon.available && !earcon.available()) return;
    try {
      earcon.start();
      earconOn = true;
      earconStartedAt = now();
      onNarration('earcon');
      later(timing.earconMaxMs, stopEarcon);
    } catch {
      earconOn = false;
    }
  }

  function currentTool() {
    let latest = null;
    for (const tool of tools.values()) if (tool.narrate) latest = tool;
    return latest;
  }

  function trySpeak(line, kind) {
    if (!line || !canSpeak()) return false;
    let spoken = false;
    try {
      spoken = speak(line, { kind }) !== false;
    } catch {
      spoken = false;
    }
    if (!spoken) return false;
    lastLineAt = now();
    stopEarcon();
    onNarration('progress');
    return true;
  }

  function speakStep() {
    const tool = currentTool();
    if (!tool || preambleSpoken || stepLines >= timing.maxStepLines) return;
    if (tool.spokenStep === tool.step) return;
    const line = progressLine(tool.step, tool.stepLabel || tool.label);
    if (trySpeak(line, 'step')) {
      stepLines++;
      tool.spokenStep = tool.step;
    }
  }

  function scheduleStepChange() {
    const wait = lastLineAt + timing.stepGapMs - now();
    if (wait <= 0) speakStep();
    else later(wait, speakStep);
  }

  function reset() {
    generation++;
    clearTimers();
    stopEarcon();
    tools = new Map();
    preambleSpoken = false;
    stepLines = 0;
    stillSpoken = false;
    lastLineAt = -Infinity;
    firstLineScheduled = false;
  }

  return {
    /** End of user speech (or a typed command): a new turn begins. */
    userTurnEnded() {
      reset();
      audibleNow = false;
      later(timing.earconAfterMs, () => {
        if (!audibleNow) startEarcon();
      });
    },

    /** Assistant audio became audible (model reply or a progress line). */
    audible() {
      audibleNow = true;
      stopEarcon();
    },

    /** Assistant audio stopped. */
    quiet() {
      audibleNow = false;
      if (tools.size) {
        later(timing.earconAfterMs, () => {
          if (!audibleNow && tools.size) startEarcon();
        });
      }
    },

    /** The model spoke a preamble before calling its tool. */
    preamble() {
      preambleSpoken = true;
    },

    /**
     * A tool began. `narrate:false` keeps it silent (instant tools, Radio).
     * @param {string} id
     * @param {{name?:string,label?:string,narrate?:boolean}} info
     */
    toolStarted(id, { name = '', label = '', narrate = true } = {}) {
      tools.set(id, {
        name,
        label,
        narrate,
        step: null,
        stepLabel: '',
        spokenStep: null,
        startedAt: now(),
      });
      if (!narrate) return;
      if (!firstLineScheduled) {
        firstLineScheduled = true;
        later(timing.firstLineMs, speakStep);
      }
      later(timing.stillWorkingMs, () => {
        const tool = tools.get(id);
        if (!tool || stillSpoken) return;
        if (trySpeak(progressLine('still', tool.label), 'still'))
          stillSpoken = true;
      });
    },

    /** A tool reported a step. */
    progress(id, { step, label } = {}) {
      const tool = tools.get(id);
      if (!tool || !step || tool.step === step) return;
      tool.step = step;
      tool.stepLabel = label || '';
      // Before the first line is due the timer picks up the latest step.
      if (stepLines > 0 && tool.narrate) scheduleStepChange();
    },

    /** A tool finished; after the last one no progress line may start. */
    toolFinished(id) {
      if (!tools.delete(id)) return;
      if (tools.size) return;
      generation++;
      clearTimers();
      firstLineScheduled = false;
      try {
        retract();
      } catch {
        /* The adapter decides whether an unheard line can be dropped. */
      }
      // Keep the earcon only until the reply starts, and never past a short
      // grace when the reply turns out to be silent.
      if (earconOn) {
        const remaining = timing.earconMaxMs - (now() - earconStartedAt);
        later(Math.min(timing.replyGraceMs, remaining), stopEarcon);
      }
    },

    /**
     * Barge-in, a new user turn, or session stop: new intent, so a line is
     * stopped even if it is already audible (unlike toolFinished).
     */
    cancel() {
      reset();
      audibleNow = false;
      try {
        stop();
      } catch {
        /* no-op */
      }
    },

    /** Test/diagnostic view. */
    state() {
      return {
        tools: tools.size,
        stepLines,
        stillSpoken,
        preambleSpoken,
        earconOn,
        pendingTimers: timers.size,
      };
    },
  };
}
