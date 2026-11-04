/**
 * Pointer input over the scene, through one dispatcher.
 *
 * A tool takes the pointer with a lease; while a lease is out, ambient
 * subscribers (those without a lease) get only `move` and `up`: no presses,
 * clicks, double-clicks, wheel or pinch. Suspending camera
 * input is separate and counted, and takes effect on the same pointerdown
 * that asked for it.
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
  /** Take the pointer for a tool. A new claim ends the previous lease. */
  claimPointer(owner: string): Lease;
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
