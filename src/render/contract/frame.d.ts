/**
 * The frame loop, render on demand and scene time.
 *
 * A renderer draws on demand: a frame is drawn when something asks for one
 * (`requestRender`), while any continuous hold is out, or every frame on an
 * engine that cannot idle (it then reports `mode()` as `'continuous'`).
 *
 * One frame runs in this order, and the renderer keeps it:
 * camera flight → input → camera `changed` → follow → `preUpdate` →
 * move detection (`moveStart` / `moveEnd`) → `preRender` → render →
 * `postRender`. `preUpdate` fires on every frame the loop ticks, including
 * frames that end up drawing nothing, so owners that write the camera there
 * (a cockpit, a follow clamp) see each one. This is the default renderer's
 * own order. `changed` is measured before follow and `preUpdate` move the
 * camera, so a move made there is reported by `changed` on the next frame;
 * move detection runs after them and sees it in the same frame. The
 * default renderer's `postUpdate` has no place here: the application does not use it.
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
  /**
   * The loop stopped after a frame failed, until the application starts it
   * again (a retry). Absent where the loop never stops so.
   */
  stopped?: boolean;
  targetFps: number;
}

export interface FramePort {
  on(phase: FramePhase, cb: (t: FrameTime) => void): Off;
  /** Ask for one frame. The reason shows in diagnostics and signals. */
  requestRender(reason: string): void;
  /** Keep drawing every frame until released. Holds are counted. */
  holdContinuous(reason: string): Release;
  /**
   * Hear the loop start drawing every frame (its first hold, whoever took
   * it) and stop (its last released): `true` held, `false` not.
   */
  onHeldChange(cb: (held: boolean) => void): Off;
  mode(): 'demand' | 'continuous';
  diagnostics(): FrameDiagnostics;
  /** Stop ticking while the page is hidden; resume on `false`. */
  suspend(hidden: boolean): void;
  /**
   * Draw a frame now, synchronously; throws when the frame fails to draw.
   * `ifDue`: run one tick of the loop now as its own would (camera flight,
   * input, clock), drawing only if a frame is due, for a host that stops
   * the animation frames the loop runs on.
   */
  renderNow(options?: { ifDue?: boolean }): void;
  /**
   * Resolves after the next frame has been drawn and presented. Once the
   * renderer is destroyed it rejects with a "renderer destroyed" error, and
   * so does one still waiting when the renderer is destroyed.
   */
  renderOnce(options?: { timeoutMs?: number }): Promise<void>;
  /** Cap the loop's rate; 0 is the display's rate. */
  setTargetFps(fps: number): void;
  /**
   * Set scene time, epoch ms. Set in `preUpdate`, it is the time that frame
   * draws at; set between frames to a new time, it asks for a frame.
   */
  setTime(ms: number): void;
  /** Scene time, epoch ms. */
  time(): number;
}
