/**
 * The renderer itself: what a plugin creates and what the application holds.
 *
 * A renderer draws the globe and what the application asks it to draw, owns the camera,
 * and answers queries about what is on screen. The application keeps every record of
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

/** What the application is given to make a renderer. */
export interface RendererPlugin {
  /** Stable id, recorded with each session (`'cesium'`, ...). */
  id: string;
  create(options: CreateOptions): Promise<Renderer>;
  /**
   * What the plugin hands the application beside the contract for a
   * renderer it made, asked once, right after `create` resolves. Omitted:
   * none.
   */
  applicationHooks?(renderer: Renderer): ApplicationHooks;
}

/**
 * What the renderer's plugin hands the application beside the contract; the
 * application uses each where given and does without where not. None is a
 * contract member: what the renderer should do is in the ports.
 */
export interface ApplicationHooks {
  /**
   * The renderer's own map engine, which the map stacks switch through in
   * place of the globe port (`src/maps/engine.js`).
   */
  mapEngine?: unknown;
  /**
   * True when the renderer shows its credits in a display of its own;
   * otherwise the application shows what the credits port lists.
   */
  ownCreditDisplay?: boolean;
  /**
   * Drop the draw commands the renderer keeps for a while after it stops
   * drawing them; run after a layer turns off.
   */
  trimStaleCommands?(): void;
  /** Whether an entity is one the renderer draws itself. */
  viewerDrawsEntity?(entity: unknown): boolean;
  /** Values QA scripts read from the page's debug handle. */
  qaHandles?: Readonly<Record<string, unknown>>;
  /**
   * The renderer's own engine, for an application that draws with it
   * directly beside the contract: `kind` names the engine (`'cesium'` for
   * Cesium, whose `Cesium.Viewer` is `viewer`) and the rest is that engine's
   * own. An application draws only with engines whose kind it knows, and
   * whatever it draws there is its own to add, update and remove.
   */
  engine?: Readonly<{ kind: string; [key: string]: unknown }>;
  /**
   * Show a recoverable notice when the renderer stops drawing (an error, a
   * lost context), with Retry and, if `allowReload`, Reset, by publishing it
   * to `store`. Returns its removal.
   */
  renderFailureNotice?(options: {
    allowReload: boolean;
    store: RenderFailureStore;
  }): () => void;
  /** The Context card's previews of a picked aircraft. */
  cardPreviews?: CardPreviews;
}

/**
 * Previews the Context card draws into an element of its own. Each returns
 * at once; one that cannot be made calls its `onFailed`.
 */
export interface CardPreviews {
  /**
   * A model turning on its own, from its GLB's bytes, starting to face
   * `heading` (degrees); `viewRange` is the camera's distance in bounding
   * radii. `onPhase` says when it turns to wire for its scan and back;
   * `onCycle` when a look and its scan end, with the drawing time they took.
   */
  model(
    container: HTMLElement,
    model: {
      gltf: Uint8Array | ArrayBuffer;
      basePath?: string;
      heading?: number;
      viewRange?: number;
    },
    events?: {
      onPhase?(phase: 'plain' | 'scan'): void;
      onCycle?(ms: number): void;
      onReady?(): void;
      onFailed?(): void;
    },
  ): CardPreview<void>;
  /** A flight's route from `from` to `to` on a small globe, the craft `at`. */
  route(
    container: HTMLElement,
    route: CardRoute,
    events?: { onFailed?(): void; onReady?(): void },
  ): CardPreview<CardRoute>;
  /** The view ahead from an aircraft's position, height and heading. */
  cockpit(
    container: HTMLElement,
    craft: CardCraft,
    events?: { onFailed?(): void; onReady?(): void },
  ): CardPreview<CardCraft>;
}

/** A place on a card's route: an airport's code and position, degrees. */
export interface CardPlace {
  code?: string;
  lat: number;
  lon: number;
}

export interface CardRoute {
  from: CardPlace;
  to: CardPlace;
  at?: { lat: number; lon: number } | null;
}

/** An aircraft's position (degrees), height (metres) and heading (degrees). */
export interface CardCraft {
  lat: number;
  lon: number;
  altitudeM?: number | null;
  heading?: number | null;
}

/** One preview: hidden, it rests on its last frame. */
export interface CardPreview<Values> {
  /** A shown, paused preview redraws its still when its data changes. */
  setShown?(shown: boolean): void;
  setActive(active: boolean): void;
  update(values: Values): void;
  destroy(): void;
}

/** Where a renderer's failure notice is published for the application to show. */
export interface RenderFailureStore {
  /** The notice shown now, or null. */
  readonly renderFailure: RenderFailureNotice | null;
  /** Show a notice, or none with null. */
  publishRenderFailure(next: RenderFailureNotice | null): void;
}

/** A notice that the renderer stopped drawing. */
export interface RenderFailureNotice {
  /** Why: an error in a frame, or a lost graphics context. */
  reason: 'render-error' | 'context-lost';
  /** The error's description, or empty. */
  detail: string;
  /** Draw again; after a lost context, reload the page. */
  retry(): void;
  /** Open the application's root address, or null where it must not. */
  reset: (() => void) | null;
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
  /** Sky applied before the first frame, so nothing draws in the wrong sky. */
  sky?: Partial<SkySettings>;
  /** Scene time in epoch ms. The application passes its boot time. */
  time?: number;
  /**
   * The clocks the renderer reads, for `FrameTime.now`, the camera's
   * `moveEnd` wait, input, flights and tweens, and for inertia where it
   * times that itself (Cesium's keeps Cesium's own timing): `now` on the
   * `performance.now()` timeline, `date` in epoch ms. Omitted: the
   * browser's. Tests pass virtual ones.
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
  /**
   * The last presented frame as an encoded image. Once the renderer is
   * destroyed it rejects with a "renderer destroyed" error.
   */
  capture(options?: CaptureOptions): Promise<Blob>;
  /**
   * The last presented frame's pixels, synchronously, for loops that render
   * a frame and read it at once (a share clip, a black-frame check). Call it
   * right after `frame.renderNow()`.
   */
  readPixels(options?: { crop?: ScreenRect; scale?: number }): ImageData;
  /**
   * Resolves once what is in view has loaded and the last presented frame
   * shows it (no redraw of the renderer's own is pending), or the timeout
   * passes, or a load failed for good. `blockers` names what was still loading or
   * failed (`'tiles'`, `'imagery:<id>'`, `'models'`, ...); empty when settled.
   */
  whenSettled(options?: { timeoutMs?: number }): Promise<SettleResult>;
  /** Follows the container's size. */
  resize(): void;
  /** Frees caches and GPU memory nothing in view uses. */
  releaseUnused(): void;
  on(event: 'error', cb: (error: Error) => void): Off;
  /**
   * The drawing context was lost, or came back. Where the renderer cannot
   * restore its context it never sends `contextRestored`; the application
   * then makes a new renderer.
   */
  on(event: 'contextLost' | 'contextRestored', cb: () => void): Off;
  /**
   * Lets go of everything. Afterwards handles do nothing (`Handle`), and
   * `frame.renderOnce` and `capture` reject with a "renderer destroyed"
   * error, as does a `renderOnce` still waiting.
   */
  destroy(): void;
}
