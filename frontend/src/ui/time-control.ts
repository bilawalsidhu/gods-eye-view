/**
 * The time slider: one range input, one readout, one way back to the present.
 *
 * It sits along the bottom of the globe rather than in the left dock, because a range input
 * needs width and the dock is a 24rem column. It is the only control on screen that changes
 * what every layer is showing at once, so it is also the only one that carries its own notice
 * panel: the wording in `state/time.ts` is what stops a viewer reading an empty aircraft layer
 * as a broken renderer.
 *
 * **The slider runs the natural way round.** Right is now, left is the past, and it opens hard
 * right. A control whose rest position is at one end and whose value counts down from there
 * would be backwards to everyone who has used a video scrubber.
 *
 * Everything numeric is in `state/time.ts` and everything here is DOM. The three pure
 * functions below are exported because they are the ones with an off-by-one in them.
 */

import {
  MAX_REWIND_MS,
  REWIND_STEPS,
  REWIND_STEP_MS,
  clampRewind,
  describeInstant,
  describeRewind,
  historyNotices,
  isLive,
} from '../state/time';

/**
 * Slider position to milliseconds behind the present.
 *
 * The input counts up to the right and time counts back to the left, so this is the flip. A
 * value at the maximum is exactly zero rather than nearly zero, which matters because zero is
 * what every other module tests for to mean "live".
 */
export function rewindFromSlider(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const steps = Math.min(Math.max(Math.round(value), 0), REWIND_STEPS);
  return clampRewind((REWIND_STEPS - steps) * REWIND_STEP_MS);
}

/** Milliseconds behind the present to a slider position. The inverse of the above. */
export function sliderFromRewind(rewindMs: number): number {
  return REWIND_STEPS - Math.round(clampRewind(rewindMs) / REWIND_STEP_MS);
}

/**
 * The line beside the slider: the instant being drawn, and how far back that is.
 *
 * Both, always, because neither is enough on its own. "2 hours back" does not say what time it
 * was, and a bare timestamp does not say it is not now.
 */
export function readoutText(rewindMs: number, nowMs: number): string {
  const atMs = nowMs - clampRewind(rewindMs);
  if (isLive(rewindMs)) {
    return `Live · ${describeInstant(atMs)}`;
  }
  return `${describeInstant(atMs)} · ${describeRewind(rewindMs)}`;
}

export interface TimeControlOptions {
  /** Called with the new offset in milliseconds behind the present. Zero means live. */
  onChange: (rewindMs: number) => void;
  /** Injected so a test can drive the clock. Defaults to the real one. */
  now?: () => number;
}

const SLIDER_ID = 'time-slider';

export class TimeControl {
  private readonly options: TimeControlOptions;
  private readonly slider: HTMLInputElement;
  private readonly readout: HTMLElement;
  private readonly nowButton: HTMLButtonElement;
  private readonly notices: HTMLElement;
  private rewind = 0;

  constructor(root: HTMLElement, options: TimeControlOptions) {
    this.options = options;
    root.classList.add('timeline');

    const head = document.createElement('div');
    head.className = 'timeline-head';

    const label = document.createElement('label');
    label.className = 'timeline-label';
    label.htmlFor = SLIDER_ID;
    label.textContent = 'Time';

    this.readout = document.createElement('p');
    this.readout.className = 'timeline-readout';

    this.nowButton = document.createElement('button');
    this.nowButton.type = 'button';
    this.nowButton.className = 'timeline-now';
    this.nowButton.textContent = 'Now';
    this.nowButton.addEventListener('click', () => {
      this.set(0);
    });

    head.append(label, this.readout, this.nowButton);

    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.className = 'timeline-slider';
    this.slider.id = SLIDER_ID;
    this.slider.min = '0';
    this.slider.max = String(REWIND_STEPS);
    this.slider.step = '1';
    this.slider.value = String(REWIND_STEPS);
    // The range is a fact about the propagator rather than a UI choice, so it is announced:
    // the elements stop supporting a position 3.5 days either side of their own epoch.
    this.slider.setAttribute(
      'aria-label',
      `How far back the globe is showing, up to ${Math.round(MAX_REWIND_MS / 86_400_000)} and a half days`,
    );
    this.slider.addEventListener('input', () => {
      this.set(rewindFromSlider(Number(this.slider.value)));
    });

    this.notices = document.createElement('div');
    this.notices.className = 'timeline-notices';
    this.notices.hidden = true;

    root.append(head, this.slider, this.notices);
    this.paint();
  }

  /** Milliseconds behind the present. Zero means live. */
  get rewindMs(): number {
    return this.rewind;
  }

  /**
   * Move the control, from a click on "Now" or from a caller.
   *
   * Announces only on a real change, so dragging the slider across a step it is already on
   * does not put a fresh render request in front of every layer.
   */
  set(rewindMs: number): void {
    const next = clampRewind(rewindMs);
    if (next === this.rewind) {
      // Still repaint: the readout is an instant and it has moved even when the offset has not.
      this.paint();
      return;
    }
    this.rewind = next;
    this.paint();
    this.options.onChange(next);
  }

  /**
   * Repaint the readout without changing anything.
   *
   * Needed because the state is an offset: the instant on screen advances once a minute on its
   * own, and a readout that only updated when the slider moved would be wrong within a minute
   * of the user letting go of it.
   */
  refresh(): void {
    this.paint();
  }

  private paint(): void {
    const nowMs = this.options.now?.() ?? Date.now();
    const text = readoutText(this.rewind, nowMs);
    this.readout.textContent = text;
    this.slider.value = String(sliderFromRewind(this.rewind));
    // The slider's own value is a step count, which says nothing out loud. This is what a
    // screen reader actually announces as it moves.
    this.slider.setAttribute('aria-valuetext', text);
    const live = isLive(this.rewind);
    this.nowButton.disabled = live;
    this.readout.dataset['live'] = live ? 'true' : 'false';
    const notices = historyNotices(this.rewind);
    this.notices.hidden = notices.length === 0;
    this.notices.replaceChildren(
      ...notices.map((notice) => {
        const line = document.createElement('p');
        line.className = 'timeline-notice';
        line.textContent = notice;
        return line;
      }),
    );
  }
}
