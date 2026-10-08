import { countWords, findHedges } from './speechLint.js';

/** Quiet period after the last audio or response before a turn is closed. */
export const TURN_SETTLE_MS = 2500;

/**
 * Per-turn latency and speech spans for one voice session.
 *
 * A turn opens at the user's end of speech (or a typed command) and closes
 * when the next turn starts, the session stops, or everything has been quiet
 * for TURN_SETTLE_MS with no response or tool outstanding. The closed span is
 * handed to `emit` once. Times are monotonic milliseconds from `now`.
 *
 * Span fields: eou_ms (speech start → end of speech), first_text_ms (end of
 * speech → first streamed transcript, i.e. generation), first_audio_ms (end
 * of speech → first playback event), max_silence_ms (longest gap with nothing
 * audible before the final audio), tools[{name, ms, ok}], preamble (assistant
 * speech before a tool call in the same response), progress_lines,
 * spoken_words, answer_words, hedge_hits, interruptions, and deltas
 * {count, first_ms, last_ms} in place of logging every streamed delta.
 *
 * Playback timing comes from `output_audio_buffer.*` events. Only on a
 * transport that never sends them does the first transcript delta stand in
 * for audible speech; once one arrives, a provisional transcript timeline is
 * replaced and later turns ignore transcript timing.
 */
export class TurnMetrics {
  constructor({
    emit,
    now = () => performance.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    settleMs = TURN_SETTLE_MS,
  } = {}) {
    Object.assign(this, { emit, now, setTimer, clearTimer, settleMs });
    this.turn = null;
    this.sequence = 0;
    this.settleTimer = null;
    /** Sticky: this transport reports playback with buffer events. */
    this.playbackEvents = false;
  }

  /** Begin a turn for typed input; the command is its end of speech. */
  userText() {
    this.close('next_turn');
    this.open('text');
    this.turn.eouAt = this.now();
  }

  /** Feed every provider event; unknown types are ignored. */
  serverEvent(payload) {
    const type = payload?.type;
    if (!type) return;
    if (type === 'input_audio_buffer.speech_started') {
      if (this.turn?.audible) this.turn.interruptions++;
      this.close('next_turn');
      this.open('voice');
      this.turn.speechStartAt = this.now();
      return;
    }
    const turn = this.turn;
    if (!turn) return;
    if (type.endsWith('.delta')) {
      const at = this.now();
      turn.deltaCount++;
      if (turn.firstDeltaAt === null) turn.firstDeltaAt = at;
      turn.lastDeltaAt = at;
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      turn.eouAt = this.now();
      return;
    }
    if (type === 'response.created') {
      turn.activeResponses++;
      this.cancelSettle();
      return;
    }
    if (type === 'output_audio_buffer.started') {
      this.audioStarted('buffer');
      return;
    }
    if (
      type === 'output_audio_buffer.stopped' ||
      type === 'output_audio_buffer.cleared'
    ) {
      this.audioStopped();
      return;
    }
    if (type === 'response.output_audio_transcript.delta') {
      if (turn.firstTextAt === null) turn.firstTextAt = this.now();
      // Transports without buffer events: the first transcript delta is the
      // closest available proxy for audible speech.
      if (!this.playbackEvents && !turn.bufferEvents)
        this.audioStarted('transcript');
      return;
    }
    if (type === 'response.done') {
      turn.activeResponses = Math.max(0, turn.activeResponses - 1);
      this.responseDone(payload.response || {});
      if (!turn.bufferEvents && turn.audible) this.audioStopped();
      this.scheduleSettle();
    }
  }

  /** A tool began executing. Returns a token for toolEnd. */
  toolStart(name) {
    if (!this.turn) this.open('tool');
    this.cancelSettle();
    const entry = { name, startedAt: this.now(), ms: null, ok: null };
    this.turn.tools.push(entry);
    return entry;
  }

  /** A tool finished; `ok` mirrors its result. */
  toolEnd(entry, ok) {
    if (!entry || entry.ms !== null) return;
    entry.ms = Math.round(this.now() - entry.startedAt);
    entry.ok = Boolean(ok);
    this.scheduleSettle();
  }

  /** Narration produced a spoken progress line or an earcon. */
  narration(kind) {
    if (!this.turn) return;
    if (kind === 'progress') this.turn.progressLines++;
    if (kind === 'earcon') this.turn.earcons++;
  }

  /** The user cut the assistant off explicitly (Space barge-in). */
  bargeIn() {
    if (!this.turn) return;
    this.turn.interruptions++;
    this.turn.bargeIns++;
  }

  /** Close the current turn now (session stop). */
  flush(reason = 'stop') {
    this.close(reason);
  }

  open(kind) {
    this.cancelSettle();
    this.turn = {
      id: ++this.sequence,
      kind,
      openedAt: this.now(),
      speechStartAt: null,
      eouAt: null,
      firstAudioAt: null,
      firstAudioSource: null,
      audible: false,
      audibleSince: null,
      lastAudioStop: null,
      gaps: [],
      bufferEvents: false,
      activeResponses: 0,
      tools: [],
      firstTextAt: null,
      deltaCount: 0,
      firstDeltaAt: null,
      lastDeltaAt: null,
      preamble: false,
      preambleText: '',
      progressLines: 0,
      earcons: 0,
      answerText: [],
      progressText: [],
      interruptions: 0,
      bargeIns: 0,
      responses: 0,
    };
  }

  audioStarted(source) {
    const turn = this.turn;
    if (source === 'buffer') {
      turn.bufferEvents = true;
      this.playbackEvents = true;
      // Authoritative playback replaces a provisional transcript timeline.
      if (turn.firstAudioSource === 'transcript') {
        turn.firstAudioAt = null;
        turn.firstAudioSource = null;
        turn.gaps = [];
        turn.audible = false;
        turn.lastAudioStop = null;
      }
    }
    if (turn.audible) return;
    const at = this.now();
    this.cancelSettle();
    if (turn.firstAudioAt === null) {
      turn.firstAudioAt = at;
      turn.firstAudioSource = source;
      if (turn.eouAt !== null) turn.gaps.push(at - turn.eouAt);
    } else if (turn.lastAudioStop !== null) {
      turn.gaps.push(at - turn.lastAudioStop);
    }
    turn.audible = true;
    turn.audibleSince = at;
  }

  audioStopped() {
    const turn = this.turn;
    if (!turn?.audible) return;
    turn.audible = false;
    turn.lastAudioStop = this.now();
    this.scheduleSettle();
  }

  responseDone(response) {
    const turn = this.turn;
    turn.responses++;
    const output = Array.isArray(response.output) ? response.output : [];
    const isProgress = response.metadata?.gev === 'progress';
    let sawCall = false;
    for (const item of output) {
      if (item?.type === 'function_call') {
        sawCall = true;
        continue;
      }
      if (item?.type !== 'message') continue;
      const text = messageText(item);
      if (!text) continue;
      if (isProgress) {
        turn.progressText.push(text);
      } else if (
        !sawCall &&
        output.some((other) => other?.type === 'function_call')
      ) {
        turn.preamble = true;
        turn.preambleText = [turn.preambleText, text].filter(Boolean).join(' ');
      } else {
        turn.answerText.push(text);
      }
    }
  }

  scheduleSettle() {
    const turn = this.turn;
    if (!turn || turn.audible || turn.activeResponses > 0) return;
    if (turn.tools.some((tool) => tool.ms === null)) return;
    this.cancelSettle();
    this.settleTimer = this.setTimer(() => {
      this.settleTimer = null;
      this.close('settled');
    }, this.settleMs);
  }

  cancelSettle() {
    if (this.settleTimer === null) return;
    this.clearTimer(this.settleTimer);
    this.settleTimer = null;
  }

  close(reason) {
    this.cancelSettle();
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    if (turn.audible) turn.lastAudioStop = this.now();
    const round = (value) => (value === null ? null : Math.round(value));
    const answer = turn.answerText.join(' ');
    const allText = [turn.preambleText, ...turn.progressText, answer].join(' ');
    const sinceEou = (at) =>
      at === null || turn.eouAt === null ? null : round(at - turn.eouAt);
    const span = {
      turn: turn.id,
      kind: turn.kind,
      reason,
      eou_ms:
        turn.speechStartAt !== null && turn.eouAt !== null
          ? round(turn.eouAt - turn.speechStartAt)
          : null,
      first_audio_ms:
        turn.eouAt !== null && turn.firstAudioAt !== null
          ? round(turn.firstAudioAt - turn.eouAt)
          : null,
      first_audio_source: turn.firstAudioSource,
      first_text_ms: sinceEou(turn.firstTextAt),
      deltas: {
        count: turn.deltaCount,
        first_ms: sinceEou(turn.firstDeltaAt),
        last_ms: sinceEou(turn.lastDeltaAt),
      },
      max_silence_ms: turn.gaps.length ? round(Math.max(...turn.gaps)) : null,
      no_audio: turn.firstAudioAt === null,
      tools: turn.tools.map(({ name, ms, ok }) => ({ name, ms, ok })),
      preamble: turn.preamble,
      preamble_text: turn.preambleText || null,
      progress_lines: turn.progressLines,
      earcons: turn.earcons,
      responses: turn.responses,
      spoken_words: countWords(allText),
      answer_words: countWords(answer),
      answer_text: answer || null,
      hedge_hits: findHedges(allText),
      interruptions: turn.interruptions,
      barge_ins: turn.bargeIns,
    };
    try {
      this.emit?.(span);
    } catch {
      /* Metrics never interrupt voice. */
    }
  }
}

function messageText(item) {
  return (Array.isArray(item.content) ? item.content : [])
    .map((part) => part?.transcript ?? part?.text ?? '')
    .filter(Boolean)
    .join(' ')
    .trim();
}
