/**
 * The renderer itself: what a plugin creates and what Core holds.
 *
 * A renderer draws the globe and what Core asks it to draw, owns the camera,
 * and answers queries about what is on screen. Core keeps every record of
 * its own; it never reads a renderer to learn its own state, only what the
 * renderer itself measures (picks, depth, heights, readiness).
 */
import type { Capability, Off, ScreenRect } from './common';
import type { CameraPort } from './camera';
import type { CreditsPort } from './credits';
import type { DrawPort } from './draw';
import type { EffectsPort } from './effects';
import type { FramePort } from './frame';
import type { GlobePort, SkySettings } from './globe';
import type { InputPort } from './input';
import type { QualityPort } from './quality';
import type { QueryPort } from './query';

/** The version of the contract this file describes. */
export type ContractVersion = '0';

/** What Core is given to make a renderer. */
export interface RendererPlugin {
  /** Stable id, recorded with each session (`'cesium'`, ...). */
  id: string;
  create(options: CreateOptions): Promise<Renderer>;
}

export interface CreateOptions {
  /** The element the renderer fills. It creates its own canvas inside. */
  container: HTMLElement;
  /** Google Maps Platform key for photorealistic tiles. */
  googleApiKey?: string;
  /** Short-lived Google session tokens, when the key is held server-side. */
  googleTokens?: () => Promise<string>;
  /**
   * The token for the renderer's world data: `world` terrain and imagery
   * and the photoreal `fallback`. For the default renderer, a Cesium ion
   * token.
   */
  worldDataToken?: string;
  /** Initial multisampling; quality can change it later. */
  msaa?: 0 | 2 | 4 | 8;
  /** Keep the drawing buffer after presenting, for capture. */
  preserveDrawingBuffer?: boolean;
  /** Sky applied before the first frame, so nothing draws in the wrong sky. */
  sky?: Partial<SkySettings>;
  /** Scene time in epoch ms. Core passes its boot time. */
  time?: number;
  /**
   * The clocks the renderer reads, for flights, inertia, tweens and
   * `FrameTime.now`: `now` on the `performance.now()` timeline, `date` in
   * epoch ms. Omitted: the browser's. Tests pass virtual ones.
   */
  clock?: { now(): number; date(): number };
  /** Aborts creation; the renderer cleans up whatever it had built. */
  signal: AbortSignal;
}

export interface CaptureOptions {
  type?: 'png' | 'jpeg';
  /** JPEG quality, 0..1. */
  quality?: number;
  /** Output scale relative to the canvas's CSS size. */
  scale?: number;
  /** Part of the canvas, in CSS pixels. */
  crop?: ScreenRect;
}

export interface SettleResult {
  state: 'settled' | 'timeout' | 'failed';
  blockers: string[];
}

export interface Renderer {
  readonly id: string;
  readonly contractVersion: ContractVersion;
  readonly capabilities: ReadonlySet<Capability>;
  readonly canvas: HTMLCanvasElement;
  readonly frame: FramePort;
  readonly globe: GlobePort;
  readonly draw: DrawPort;
  readonly camera: CameraPort;
  readonly query: QueryPort;
  readonly input: InputPort;
  readonly effects: EffectsPort;
  readonly credits: CreditsPort;
  readonly quality: QualityPort;
  /** The last presented frame as an encoded image. */
  capture(options?: CaptureOptions): Promise<Blob>;
  /**
   * The last presented frame's pixels, synchronously, for loops that render
   * a frame and read it at once (a share clip, a black-frame check). Call it
   * right after `frame.renderNow()`.
   */
  readPixels(options?: { crop?: ScreenRect; scale?: number }): ImageData;
  /**
   * Resolves once what is in view has loaded, or the timeout passes, or a
   * load failed for good. `blockers` names what was still loading or
   * failed (`'tiles'`, `'imagery:<id>'`, `'models'`, ...); empty when settled.
   */
  whenSettled(options?: { timeoutMs?: number }): Promise<SettleResult>;
  /** Follows the container's size. */
  resize(): void;
  /** Frees caches and GPU memory nothing in view uses. */
  releaseUnused(): void;
  on(event: 'error', cb: (error: Error) => void): Off;
  /**
   * The drawing context was lost, or came back. A renderer whose device
   * cannot come back (WebGPU) never sends `contextRestored`; Core then makes
   * a new renderer.
   */
  on(event: 'contextLost' | 'contextRestored', cb: () => void): Off;
  destroy(): void;
}
