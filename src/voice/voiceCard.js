import {
  initialVoiceCardState,
  reduceVoiceCard,
  voiceCardView,
} from './voiceCardPresentation.js';

/** Hide an idle card this long after its last update. */
const VOICE_CARD_IDLE_MS = 14000;

/**
 * Voice card controls. The card is part of the voice control (`control.js`),
 * beside its help and error trays, so Clean-UI and recording mode hide it with
 * the control. Receives provider-neutral session events through `handle` and
 * annotation outline outcomes through `outline`, and presents the card's view
 * on the control; owns only its listener and idle timer. Captions update
 * silently; the polite live region carries final replies and result titles
 * only.
 */
export class VoiceCardControls {
  /**
   * @param {object} options
   * @param {object} options.ui The voice control presenter.
   * @param {number} [options.idleMs]
   * @param {Function} [options.setTimer]
   * @param {Function} [options.clearTimer]
   */
  constructor({
    ui,
    idleMs = VOICE_CARD_IDLE_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    onRender,
  }) {
    Object.assign(this, { ui, idleMs, setTimer, clearTimer, onRender });
    this.state = initialVoiceCardState();
    this.enabled = true;
    this.presented = true;
    this.announcementRevision = 0;
    this.consumedPresentationAnnouncement = -1;
    this.hideTimer = null;
    this.destroyed = false;
    if (!ui) return;
    // The card's labels are worded again in a new locale.
    this.offLocale = ui.on('locale', () => {
      if (!this.destroyed) this.render();
    });
    this.offDismiss = ui.on('card-dismiss', () =>
      this.handle({ type: 'dismiss' }),
    );
    this.render();
  }

  /** Apply one session event (or `outline`/`dismiss`). */
  handle(event) {
    if (this.destroyed || !this.ui) return;
    const next = reduceVoiceCard(this.state, event);
    if (next === this.state) return;
    if (
      next.announce !== this.state.announce ||
      (next.announce &&
        ((event.type === 'transcript' &&
          event.role === 'assistant' &&
          event.final) ||
          (event.type === 'action-result' &&
            next.result !== this.state.result) ||
          (event.type === 'pointer' &&
            next.pointer &&
            next.pointer !== this.state.pointer)))
    )
      this.announcementRevision++;
    this.state = next;
    this.render();
    if (this.state.visible) this.scheduleIdle();
    else this.cancelIdle();
  }

  /** A local submission allows future output after dismissal; keep its content. */
  rearm() {
    if (this.destroyed || !this.ui) return;
    this.state = { ...this.state, dismissed: false };
  }

  /** An annotation outline resolved or failed after its tool result. */
  outline(event) {
    this.handle({ type: 'outline', id: event?.id, status: event?.status });
  }

  /** Change presentation only; session events and the idle deadline continue. */
  setEnabled(enabled) {
    if (this.destroyed || !this.ui) return;
    this.enabled = Boolean(enabled);
    this.render();
  }

  /** View selection changes presentation without changing the saved preference. */
  setPresented(presented) {
    if (this.destroyed || !this.ui || this.presented === presented) return;
    if (!presented)
      this.consumedPresentationAnnouncement = this.announcementRevision;
    this.presented = presented;
    this.render();
  }

  scheduleIdle() {
    this.cancelIdle();
    this.hideTimer = this.setTimer(() => {
      this.hideTimer = null;
      if (this.destroyed) return;
      // Keep the card while the pointer or focus is inside it.
      if (this.ui.element('card')?.matches?.(':hover, :focus-within')) {
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
    this.ui.replace('card', this.snapshot());
    this.onRender?.();
  }

  /** Test/diagnostic view of what the card shows. */
  snapshot() {
    const view = voiceCardView(this.state);
    return this.enabled && this.presented
      ? {
          ...view,
          announce:
            this.consumedPresentationAnnouncement === this.announcementRevision
              ? ''
              : view.announce,
        }
      : { ...view, visible: false, announce: '' };
  }

  /** Idempotent: removes the listener and the idle timer; the control stays. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelIdle();
    this.offDismiss?.();
    this.offLocale?.();
  }
}
