/**
 * The frame loop, render on demand and scene time.
 *
 * A renderer draws on demand: a frame is drawn when something asks for one
 * (`requestRender`), while any continuous hold is out, or every frame on an
 * engine that cannot idle (it then reports `mode()` as `'continuous'`).
 *
 * One frame runs in this order, and every renderer keeps it:
 * camera flight → input → camera `changed` → follow → `preUpdate` →
 * move detection (`moveStart` / `moveEnd`) → `preRender` → render →
 * `postRender`. `preUpdate` fires on every frame the loop ticks, including
 * frames that end up drawing nothing, so owners that write the camera there
 * (a cockpit, a follow clamp) see each one. This is the default renderer's
 * own order. `changed` is measured before follow and `preUpdate` move the
 * camera, so a move made there is reported by `changed` on the next frame;
 * move detection runs after them and sees it in the same frame. The
 * default renderer's `postUpdate` has no place here: Core does not use it.
 */
import type { Off, Release } from './common';

export type FramePhase = 'preUpdate' | 'preRender' | 'postRender';

/** The order the phases (and the steps between them) run in one frame. */
export type FrameStep =
  | 'flight'
  | 'input'
  | 'changed'
  | 'follow'
  | 'preUpdate'
  | 'moveDetection'
  | 'preRender'
  | 'render'
  | 'postRender';

export interface FrameTime {
  /** Frames ticked since creation. */
  frame: number;
  /** Scene time, epoch ms: what sun, stars and lighting show. */
  time: number;
  /** The loop's clock, ms (virtual under a test clock). */
  now: number;
  /** Seconds since the previous tick. */
  dt: number;
  /**
   * Whether this tick draws. Read during `preUpdate` it counts what has been
   * asked so far; a request or hold made later in `preUpdate` draws this
   * tick or the next, as the engine decides, and readers after it see
   * which. Once the tick is over it keeps its answer.
   */
  rendering: boolean;
}

export interface FrameDiagnostics {
  mode: 'demand' | 'continuous';
  frames: number;
  rendered: number;
  /** Reasons given to `requestRender` since the last frame drawn. */
  pendingReasons: string[];
  /** Reasons of the holds now out. */
  holds: string[];
  suspended: boolean;
  targetFps: number;
}

export interface FramePort {
  on(phase: FramePhase, cb: (t: FrameTime) => void): Off;
  /** Ask for one frame. The reason shows in diagnostics and signals. */
  requestRender(reason: string): void;
  /** Keep drawing every frame until released. Holds are counted. */
  holdContinuous(reason: string): Release;
  mode(): 'demand' | 'continuous';
  diagnostics(): FrameDiagnostics;
  /** Stop ticking while the page is hidden; resume on `false`. */
  suspend(hidden: boolean): void;
  /** Draw a frame now, synchronously. */
  renderNow(): void;
  /** Resolves after the next frame has been drawn and presented. */
  renderOnce(options?: { timeoutMs?: number }): Promise<void>;
  /** Cap the loop's rate; 0 is the display's rate. */
  setTargetFps(fps: number): void;
  /** Set scene time, epoch ms. */
  setTime(ms: number): void;
  /** Scene time, epoch ms. */
  time(): number;
}
