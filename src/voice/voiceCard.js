import {
  initialVoiceCardState,
  reduceVoiceCard,
  voiceCardView,
} from './voiceCardPresentation.js';

/** Hide an idle card this long after its last update. */
export const VOICE_CARD_IDLE_MS = 14000;

const ELEMENT_IDS = Object.freeze({
  card: 'gev-voice-card',
  phase: 'gev-voice-card-phase',
  dismiss: 'gev-voice-card-dismiss',
  user: 'gev-voice-card-user',
  userText: 'gev-voice-card-user-text',
  pointer: 'gev-voice-card-pointer',
  pointerKind: 'gev-voice-card-pointer-kind',
  pointerText: 'gev-voice-card-pointer-text',
  assistant: 'gev-voice-card-assistant',
  assistantText: 'gev-voice-card-assistant-text',
  plan: 'gev-voice-card-plan',
  result: 'gev-voice-card-result',
  resultTitle: 'gev-voice-card-result-title',
  chips: 'gev-voice-card-chips',
  lines: 'gev-voice-card-lines',
  referents: 'gev-voice-card-referents',
  notes: 'gev-voice-card-notes',
  noteList: 'gev-voice-card-note-list',
  live: 'gev-voice-card-live',
});

function setText(element, text) {
  if (element && element.textContent !== text) element.textContent = text;
}

function setHidden(element, hidden) {
  if (element && element.hidden !== hidden) element.hidden = hidden;
}

function fillList(list, items, render) {
  if (!list) return;
  const doc = list.ownerDocument;
  list.replaceChildren(
    ...items.map((item) => {
      const node = doc.createElement('li');
      render(node, item, doc);
      return node;
    }),
  );
}

/**
 * Voice card controls, nested in the voice control's markup (`control.js`)
 * beside its help and error trays, so Clean-UI and recording mode hide it with
 * the control. Receives provider-neutral session events through `handle` and
 * annotation outline outcomes through `outline`; owns only its listeners and
 * idle timer. All text is set through textContent. Captions update silently;
 * the polite live region carries final replies and result titles only.
 */
export class VoiceCardControls {
  /**
   * @param {object} options
   * @param {HTMLElement} options.root Voice control root containing the card.
   * @param {number} [options.idleMs]
   * @param {Function} [options.setTimer]
   * @param {Function} [options.clearTimer]
   */
  constructor({
    root,
    idleMs = VOICE_CARD_IDLE_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
  }) {
    Object.assign(this, { idleMs, setTimer, clearTimer });
    this.elements = Object.fromEntries(
      Object.entries(ELEMENT_IDS).map(([key, id]) => [
        key,
        root?.querySelector?.(`#${id}`) || null,
      ]),
    );
    this.state = initialVoiceCardState();
    this.hideTimer = null;
    this.destroyed = false;
    this.listeners = new AbortController();
    if (!this.elements.card) return;
    this.elements.dismiss?.addEventListener(
      'click',
      () => this.handle({ type: 'dismiss' }),
      { signal: this.listeners.signal },
    );
    this.render();
  }

  /** Apply one session event (or `outline`/`dismiss`). */
  handle(event) {
    if (this.destroyed || !this.elements.card) return;
    const next = reduceVoiceCard(this.state, event);
    if (next === this.state) return;
    this.state = next;
    this.render();
    if (this.state.visible) this.scheduleIdle();
    else this.cancelIdle();
  }

  /** An annotation outline resolved or failed after its tool result. */
  outline(event) {
    this.handle({ type: 'outline', id: event?.id, status: event?.status });
  }

  scheduleIdle() {
    this.cancelIdle();
    this.hideTimer = this.setTimer(() => {
      this.hideTimer = null;
      if (this.destroyed) return;
      // Keep the card while the pointer or focus is inside it.
      if (this.elements.card.matches?.(':hover, :focus-within')) {
        this.scheduleIdle();
        return;
      }
      this.handle({ type: 'idle' });
    }, this.idleMs);
  }

  cancelIdle() {
    if (this.hideTimer === null) return;
    this.clearTimer(this.hideTimer);
    this.hideTimer = null;
  }

  render() {
    const el = this.elements;
    const view = voiceCardView(this.state);
    setHidden(el.card, !view.visible);
    el.card.dataset.busy = String(view.busy);
    setText(el.phase, view.phase);
    setHidden(el.user, !view.user.visible);
    setText(el.userText, view.user.text);
    setHidden(el.pointer, !view.pointer.visible);
    setText(el.pointerKind, view.pointer.kind);
    setText(el.pointerText, view.pointer.text);
    setHidden(el.assistant, !view.assistant.visible);
    setText(el.assistantText, view.assistant.text);
    setHidden(el.plan, view.steps.length === 0);
    fillList(el.plan, view.steps, (node, step, doc) => {
      node.className = 'gev-voice-card-step';
      node.dataset.status = step.status;
      const label = doc.createElement('span');
      label.className = 'gev-voice-card-step-label';
      label.textContent = step.label;
      const status = doc.createElement('span');
      status.className = 'gev-voice-card-sr';
      status.textContent = step.statusText ? `, ${step.statusText}` : '';
      node.append(label, status);
      if (step.detail) {
        const detail = doc.createElement('span');
        detail.className = 'gev-voice-card-step-detail';
        detail.textContent = step.detail;
        node.append(detail);
      }
    });
    setHidden(el.result, !view.result.visible);
    setText(el.resultTitle, view.result.title);
    setHidden(el.chips, view.result.chips.length === 0);
    if (el.chips) {
      const doc = el.chips.ownerDocument;
      el.chips.replaceChildren(
        ...view.result.chips.map((text) => {
          const chip = doc.createElement('span');
          chip.className = 'gev-voice-card-chip';
          chip.dataset.tone = text;
          chip.textContent = text;
          return chip;
        }),
      );
    }
    fillList(el.lines, view.result.lines, (node, line) => {
      node.textContent = line;
    });
    setHidden(el.referents, view.result.referents.length === 0);
    fillList(el.referents, view.result.referents, (node, ref) => {
      node.value = ref.n;
      node.textContent = ref.label;
    });
    setHidden(el.notes, view.result.notes.length === 0);
    fillList(el.noteList, view.result.notes, (node, note) => {
      node.textContent = note;
    });
    setText(el.live, view.announce);
  }

  /** Test/diagnostic view of what the card shows. */
  snapshot() {
    return voiceCardView(this.state);
  }

  /** Idempotent: removes listeners and the idle timer; markup stays owned by the control. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelIdle();
    this.listeners.abort();
  }
}
