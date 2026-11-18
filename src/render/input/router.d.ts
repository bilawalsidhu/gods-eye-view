/**
 * Who hears each pointer event: the contract's input rules, shared by the
 * Cesium port and the stub
 * (`router.js`).
 */
import type { InputPort, Lease, PointerEv } from '../contract/index';

/** Who an event went to: one lease's listeners, everyone else, or both. */
export interface Recipients {
  lease: Lease | null;
  ambient: boolean;
}

export interface InputRouter {
  /** The input port the router keeps. */
  port: InputPort;
  /**
   * Delivers one event to the listeners it belongs to. `before` runs first
   * with who it goes to (a renderer's stock behaviours); its error is
   * reported. A `move` or `up` always reads as going to both.
   */
  dispatch(ev: PointerEv, before?: (to: Recipients) => void): Recipients;
  /** Live listeners, for leak checks. */
  listenerCount(): number;
  /** Ends delivery: no listener runs again, even for the event under way. */
  dispose(): void;
}

export function createInputRouter(options: {
  /** Where a listener's or a `grab`'s error goes. */
  report: (error: unknown) => void;
  /** The renderer's counted camera-input hold. */
  suspendCamera: (reason: string) => () => void;
  /** Stock behaviours beyond `select` and `dblclickFollow`. */
  behaviours?: string[];
  /** Told when a behaviour turns off (first hold) or on (last release). */
  onBehaviour?: (name: string, enabled: boolean) => void;
  /** Behaviours the renderer cannot do, as `false`: listed, reported disabled. */
  supported?: Record<string, boolean>;
}): InputRouter;
