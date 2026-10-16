import { planStepLabel, progressStepLabel, spokenLabel } from './speech.js';
import { presentResult } from './resultDisplay.js';
import { MAX_DISPLAYED_REFERENTS, normalizeReferents } from './referents.js';

/**
 * Pure presentation of the voice card nested in the voice control: captions,
 * the current plan, the latest result and its numbered referents.
 *
 * `reduceVoiceCard` folds provider-neutral session events (`state`,
 * `interruption`, `transcript`, `action-call`, `progress`, `action-result`)
 * plus the card's own `outline` and `dismiss` events into a snapshot;
 * `voiceCardView` derives what each element shows.
 */

const MAX_STEPS = 6;
const MAX_LINES = 6;
const MAX_NOTES = 6;
const MAX_CAPTION = 220;

const STATUS_TEXT = Object.freeze({
  running: 'in progress',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
});

/** An empty, hidden card. */
export function initialVoiceCardState() {
  return {
    visible: false,
    dismissed: false,
    user: null,
    pointer: null,
    assistant: null,
    assistantResponse: null,
    steps: [],
    stepSeq: 0,
    result: null,
    announce: '',
  };
}

function caption(text) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > MAX_CAPTION
    ? `…${clean.slice(-(MAX_CAPTION - 1))}`
    : clean;
}

function newTurn(state) {
  return {
    ...state,
    visible: true,
    dismissed: false,
    user: '',
    pointer: null,
    assistant: null,
    assistantResponse: null,
    steps: [],
    result: null,
  };
}

function reveal(state) {
  return state.dismissed ? state : { ...state, visible: true };
}

/**
 * Patch the step an event belongs to: the step with the event's call id, or,
 * for adapters without call ids, the latest matching step of that tool.
 * Returns the same snapshot when nothing matches, so stale or unmatched
 * events never re-render or reveal the card.
 */
function patchStep(state, event, match, patch) {
  for (let index = state.steps.length - 1; index >= 0; index--) {
    const step = state.steps[index];
    const sameCall = event.callId
      ? step.callId === event.callId
      : !step.callId && step.name === event.name;
    if (!sameCall || !match(step)) continue;
    const steps = state.steps.slice();
    steps[index] = { ...step, ...patch(step) };
    return { ...state, steps };
  }
  return state;
}

function annotationIds(result) {
  return (Array.isArray(result.items) ? result.items : [])
    .filter((item) => item?.ok && item.outlinePending && item.id)
    .map((item) => String(item.id));
}

/**
 * Fold one event into the card snapshot. Unknown, stale or unmatched events
 * return the same snapshot, so callers can skip rendering.
 */
export function reduceVoiceCard(state, event) {
  if (!event?.type) return state;
  switch (event.type) {
    case 'state':
      return ['idle', 'error'].includes(event.state)
        ? initialVoiceCardState()
        : state;
    case 'interruption':
      return newTurn(state);
    case 'dismiss':
      return { ...state, visible: false, dismissed: true };
    case 'idle':
      return { ...state, visible: false };
    case 'pointer': {
      // What "this"/"here" resolved to; a stale pointer clears the chip.
      const pointer =
        event.pointer?.label && ['this', 'here'].includes(event.pointer.kind)
          ? { kind: event.pointer.kind, label: event.pointer.label }
          : null;
      if (!pointer && !state.pointer) return state;
      if (!pointer) return { ...state, pointer };
      // The live region says what "this" meant, as the chip does.
      const kind = pointer.kind === 'here' ? 'Here' : 'This';
      return reveal({
        ...state,
        pointer,
        announce: `${kind}: ${spokenLabel(pointer.label, 32)}`,
      });
    }
    case 'transcript': {
      const text = event.text || '';
      if (event.role === 'user') {
        return text ? reveal({ ...state, user: caption(text) }) : state;
      }
      if (event.role !== 'assistant' || !text) return state;
      const sameResponse =
        (event.responseId || null) === state.assistantResponse &&
        state.assistant !== null;
      // Deltas accumulate raw (their spacing is significant); only a final
      // transcript is normalized.
      const running = `${sameResponse ? state.assistant : ''}${text}`;
      const assistant = event.final
        ? caption(text)
        : running.length > MAX_CAPTION
          ? `…${running.slice(-(MAX_CAPTION - 1))}`
          : running;
      return reveal({
        ...state,
        assistant,
        assistantResponse: event.responseId || null,
        announce: event.final ? caption(text) : state.announce,
      });
    }
    case 'action-call': {
      const stepSeq = state.stepSeq + 1;
      return reveal({
        ...state,
        stepSeq,
        steps: [
          ...state.steps,
          {
            id: stepSeq,
            callId: event.callId || null,
            name: event.name,
            label: planStepLabel(event.name, event.arguments || {}),
            status: 'running',
            detail: '',
            annotationIds: [],
          },
        ].slice(-MAX_STEPS),
      });
    }
    case 'progress': {
      const next = patchStep(
        state,
        event,
        (step) => step.status === 'running',
        () => ({ detail: progressStepLabel(event.step, event.label) }),
      );
      return next === state ? state : reveal(next);
    }
    case 'action-result': {
      const result = event.result || {};
      const next = patchStep(
        state,
        event,
        (step) => step.status === 'running',
        () => ({
          status: result.cancelled
            ? 'cancelled'
            : result.ok
              ? 'done'
              : 'failed',
          detail: result.outlinePending ? 'Tracing outline' : '',
          annotationIds: result.outlinePending ? annotationIds(result) : [],
        }),
      );
      // A result for a call this turn never showed is stale.
      if (next === state) return state;
      // One adapter decides what a result shows; a silent lookup or a
      // refusal informs the model and leaves the card.
      const shown = presentResult(event.name, result);
      if (!shown) return reveal(next);
      return reveal({
        ...next,
        result: {
          display: shown.display,
          referents: normalizeReferents(
            shown.referents,
            MAX_DISPLAYED_REFERENTS,
          ),
        },
        announce: spokenLabel(shown.display.title, 64),
      });
    }
    case 'outline': {
      const id = event.id == null ? null : String(event.id);
      if (!id) return state;
      for (let index = state.steps.length - 1; index >= 0; index--) {
        const step = state.steps[index];
        if (!step.annotationIds?.includes(id)) continue;
        const remaining = step.annotationIds.filter((other) => other !== id);
        const steps = state.steps.slice();
        steps[index] = {
          ...step,
          annotationIds: remaining,
          detail: remaining.length
            ? 'Tracing outline'
            : event.status === 'resolved'
              ? 'Outline traced'
              : 'Outline unavailable',
        };
        return reveal({ ...state, steps });
      }
      return state;
    }
    default:
      return state;
  }
}

/** Derive element content from a card snapshot. */
export function voiceCardView(state) {
  const running = state.steps.some((step) => step.status === 'running');
  const display = state.result?.display || null;
  const allNotes = [
    ...(display?.notes || []),
    ...(display?.sources || []).map((source) => `Source: ${source.label}`),
  ];
  // Analyst notes carry count/scope/provenance qualifications. Preserve their
  // full sanitized text in at most six existing rows, joining overflow into
  // the last row. Other tool cards retain their compact note contract.
  const completeNotes = display?.preserveNotes
    ? [
        ...new Set(
          allNotes.map((note) => spokenLabel(note, Infinity)).filter(Boolean),
        ),
      ]
    : null;
  const notes = completeNotes
    ? completeNotes.length > MAX_NOTES
      ? [
          ...completeNotes.slice(0, MAX_NOTES - 1),
          completeNotes.slice(MAX_NOTES - 1).join('; '),
        ]
      : completeNotes
    : allNotes.map((note) => spokenLabel(note, 96)).slice(0, MAX_NOTES);
  return {
    visible: Boolean(state.visible),
    busy: running,
    phase: running ? 'WORKING' : state.steps.length ? 'DONE' : '',
    user: {
      visible: state.user !== null,
      text: state.user || '…',
    },
    pointer: {
      visible: Boolean(state.pointer),
      kind: state.pointer?.kind === 'here' ? 'HERE' : 'THIS',
      text: spokenLabel(state.pointer?.label || '', 32),
    },
    assistant: {
      visible: Boolean(state.assistant),
      text: state.assistant || '',
    },
    steps: state.steps.map((step) => ({
      key: String(step.id),
      label: step.label,
      status: step.status,
      statusText: STATUS_TEXT[step.status] || '',
      detail: step.detail || '',
    })),
    result: {
      visible: Boolean(display?.title),
      title: spokenLabel(display?.title || '', 64),
      chips: (display?.chips || []).map((chip) => spokenLabel(chip.label, 24)),
      lines: (display?.lines || [])
        .map((line) => spokenLabel(line, 80))
        .slice(0, MAX_LINES),
      referents: (state.result?.referents || [])
        .slice(0, MAX_DISPLAYED_REFERENTS)
        .map((ref) => ({ n: ref.n, label: spokenLabel(ref.label, 48) })),
      notes,
    },
    announce: state.announce || '',
  };
}
