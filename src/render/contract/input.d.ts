/**
 * Pointer input over the scene, through one dispatcher.
 *
 * A tool takes the pointer with a lease; while a lease is out, ambient
 * subscribers (those without a lease) get only `move` and `up`: no presses,
 * clicks, double-clicks, wheel or pinch. A lease with `grab` takes only the
 * presses it grabs: `grab` is asked on each `down`, and a grabbed press (its
 * `down`, and the `click` and `dblclick` it ends in) goes to the lease's
 * listeners alone. Every other press, and wheel and pinch, go to ambient
 * subscribers and the camera as if the pointer were free; `move` and `up`
 * go to both.
 *
 * Every event of a press goes where its `down` went, even when the lease
 * ends or changes before the press is over (an ended lease's to no one), so
 * a claim never takes a press already under way. Each button's presses
 * are separate. A press runs from its `down` through its `up`, the `click`
 * straight after it where it went up, and a `dblclick` straight after that
 * at the same spot;
 * any other event after its `up` ends it. A click or double-click with no
 * press of its own is decided as a press, `grab` seeing it as a `down`
 * (without `pick`, `drill` or `ground`).
 *
 * Suspending camera input is separate and counted, and takes effect on the
 * same pointerdown that asked for it, so a tool that grabs a press suspends
 * the camera in its `down` listener.
 *
 * A click is delivered with its pick already made, once, and shared by
 * every subscriber (`PointerEv.pick`). A renderer whose picks answer a frame
 * or two late delivers the click that much later rather than answering
 * without them; `query.pick` stays synchronous for everything else.
 *
 * The engine's stock behaviours (select on click, follow on double-click)
 * are explicit and removable here, never implicit.
 */
import type { Hit, PickWindow } from './query';
import type { Ecef, Off, Release, ScreenXY } from './common';

export type PointerEventType =
  'down' | 'move' | 'up' | 'click' | 'dblclick' | 'wheel' | 'pinch';

export interface Modifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

export interface PointerEv {
  type: PointerEventType;
  position: ScreenXY;
  /** For `move`: where the pointer is now (`position` is where it was). */
  endPosition?: ScreenXY;
  button: 0 | 1 | 2;
  modifiers: Modifiers;
  /** Event time, ms (`performance.now()` timeline). */
  timestamp: number;
  pointerType: 'mouse' | 'touch' | 'pen';
  /** `click`: how far the pointer travelled and how long the press lasted. */
  gesture?: { travelPx: number; durationMs: number };
  /** `wheel`: lines scrolled; `pinch`: scale since the last event. */
  delta?: number;
  /** `click` and `dblclick`: the hit under the pointer, picked once for every subscriber. */
  pick?(): Hit | null;
  /** `click` and `dblclick`: every hit under the pointer, from the same pick. */
  drill?(options?: PickWindow & { limit?: number }): Hit[];
  /** `click` and `dblclick`: the surface position under the pointer. */
  ground?(): Ecef | null;
}

/** A tool's hold on the pointer. */
export interface Lease {
  readonly owner: string;
  readonly current: boolean;
  release(): void;
}

/** A stock behaviour, on until suppressed. */
export interface StockBehaviour {
  readonly enabled: boolean;
  /** Turn it off until released. Holds are counted. */
  suppress(): Release;
}

export interface InputPort {
  on(
    type: PointerEventType,
    cb: (ev: PointerEv) => void,
    options?: { lease?: Lease | (() => Lease | null) },
  ): Off;
  /**
   * Take the pointer for a tool. A new claim ends the previous lease.
   * `grab` decides each press from its `down` event, synchronously: true
   * makes it the tool's, anything else leaves it. A `down` carries no pick,
   * so `grab` decides from the position, button and modifiers (and the
   * tool's own hit test, through `query`). Omitted, every press is the
   * tool's. A `grab` that throws is reported and leaves the press to the
   * others.
   */
  claimPointer(
    owner: string,
    options?: { grab?: (down: PointerEv) => boolean },
  ): Lease;
  isPointerFree(): boolean;
  /** Suspend user camera input until released. Holds are counted. */
  suspendCameraControls(reason: string): Release;
  /**
   * Every behaviour the renderer does on its own in answer to input, each
   * suppressible. `select` and `dblclickFollow` are always listed (a
   * renderer without one reports it disabled); any other built-in one (a
   * double-click zoom) is listed under its own name.
   */
  readonly behaviours: {
    /** Select the item under a click. */
    readonly select: StockBehaviour;
    /** Follow the item under a double-click. */
    readonly dblclickFollow: StockBehaviour;
    readonly [name: string]: StockBehaviour;
  };
  /** Ctrl+wheel zooms (rather than the page). */
  ctrlWheelZoom: boolean;
}
