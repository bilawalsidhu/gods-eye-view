/**
 * The renderer conformance suite (`index.js`): every check run against the
 * Cesium renderer or the stub through the contract alone, in Node or in a browser page.
 */
import type {
  CameraPose,
  Ecef,
  Flight,
  Renderer,
  ScreenXY,
} from '../contract/index';

export interface ConformanceTolerance {
  /** Positions and heights. */
  metres: number;
  /** Unit vectors (direction, up, right). */
  unit: number;
  /** Heading, pitch and roll. */
  radians: number;
  /** Screen positions. */
  pixels: number;
  /** `changed` events per script. */
  changedCount: number;
}

/** How to make the renderer under test and drive its clock. */
export interface ConformanceHarness {
  name: string;
  /** Null when it cannot make a renderer with fewer capabilities. */
  create(options: {
    viewport: { width: number; height: number };
    capabilities?: string[];
  }): Promise<Renderer | null>;
  frame(r: Renderer): void | Promise<void>;
  now(r: Renderer): number;
  toEcef(p: { lon: number; lat: number; height?: number }): Ecef;
  tolerance: ConformanceTolerance;
  /** Flight paths compared frame by frame, or only where flights end. */
  flightPaths: 'trace' | 'endpoints';
  /** Synthetic input. */
  pointer?(
    r: Renderer,
    type: string,
    x: number,
    y: number,
    extra?: object,
  ): void | Promise<void>;
  /** False when the renderer draws only models into its pixels. */
  pixels?: boolean;
  /** The camera moves on pointer input sent through `pointer`. */
  cameraInput?: boolean;
  scriptHeights?(
    r: Renderer,
    fn: (
      point: { lon: number; lat: number },
      against?: string,
    ) => number | null,
  ): void;
  /** Epoch ms a `live` motion clock reads. */
  wallTime?(r: Renderer): number;
  /**
   * Sizes the element the renderer fills, in CSS pixels, for the check that
   * `resize` follows it. Without it, that check is skipped.
   */
  resizeContainer?(
    r: Renderer,
    size: { width: number; height: number },
  ): void | Promise<void>;
  assets?: {
    model?: string;
    missingModel?: string;
    modelBytes?: () => Promise<Uint8Array>;
  };
}

export interface ConformanceCheck {
  id: string;
  port: string;
  title: string;
  run(h: ConformanceHarness): Promise<{ skip: string } | void>;
}

export interface ConformanceResult {
  id: string;
  port: string;
  title: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
  ms: number;
}

export interface ConformanceReport {
  harness: string;
  passed: number;
  failed: number;
  skipped: number;
  results: ConformanceResult[];
}

/** A camera script: the steps a trace check runs. */
export interface CameraScript {
  name: string;
  steps: object[];
}

/** A camera script's pointer event. */
export interface ScriptPointer {
  type: 'down' | 'move' | 'up' | 'wheel';
  position: ScreenXY;
  endPosition?: ScreenXY;
  button: 0 | 1 | 2;
  modifiers: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };
  wheel?: { deltaY: number; deltaMode: number };
}

/** What a camera script drives. */
export interface CameraDriver {
  command(name: string, args: unknown[]): Flight | void;
  frame(): void | Promise<void>;
  /** Counts `changed`; returns a reader. */
  listen(threshold: number): () => number;
  pose(): CameraPose;
  project(position: Ecef): ScreenXY | null;
  pickEllipsoid(screen: ScreenXY): Ecef | null;
  pickRay(screen: ScreenXY): object;
  occluded(position: Ecef): boolean;
  flying(): boolean;
  toEcef(position: object): Ecef;
  pointer?(ev: ScriptPointer): void | Promise<void>;
}

/** A reference scene, built from contract calls only. */
export interface ReferenceScene {
  id: string;
  family: string;
  capability: string | null;
  needs?: string[];
  build(r: Renderer, ctx: object): Promise<() => void>;
  views: Array<{ name: string; view: object }>;
}

export const DEFAULT_TOLERANCE: Readonly<ConformanceTolerance>;
/** Every check, in run order. */
export function conformanceChecks(): ConformanceCheck[];
export function runConformance(
  harness: ConformanceHarness,
  options?: { only?: (id: string) => boolean },
): Promise<ConformanceReport>;

export const CAMERA_SCRIPTS: ReadonlyArray<CameraScript>;
/** The viewport every script runs in, CSS pixels. */
export const SCRIPT_VIEWPORT: Readonly<{ width: number; height: number }>;
/** Whether a script moves the camera by user input. */
export function usesInput(script: CameraScript): boolean;

export const REFERENCE_SCENES: ReadonlyArray<ReferenceScene>;
/** The city scene's poses from orbit down to the street. */
export const CALIBRATION_PATH: Readonly<{
  scene: string;
  poses: ReadonlyArray<object>;
}>;
/** Why a renderer and context cannot draw a scene; null when they can. */
export function sceneSupport(
  scene: ReferenceScene,
  renderer: Renderer,
  ctx?: { assets?: Record<string, unknown> },
): string | null;

export const VISUAL_TOLERANCE: Readonly<{
  threshold: number;
  maxSolidPixels: number;
  maxMismatchedPixels: number;
}>;
type Pixels = { width: number; height: number; data: Uint8ClampedArray };
export function compareImages(
  actual: Pixels,
  expected: Pixels,
  options?: {
    threshold?: number;
    maxSolidPixels?: number;
    maxMismatchedPixels?: number;
    diff?: Uint8ClampedArray;
  },
): {
  match: boolean;
  diffPixels: number;
  diffFraction: number;
  solidPixels: number;
  mismatchedPixels: number;
  reason?: string;
};
/** Draws a scene, then each of its views once the renderer has settled. */
export function drawScene(
  renderer: Renderer,
  scene: ReferenceScene,
  ctx: { toEcef: Function; assets?: object },
  onView: (
    view: { name: string },
    capture: Blob,
    settle: { state: string; blockers: string[] },
  ) => void | Promise<void>,
): Promise<void>;
/** The file a view's reference image is stored under. */
export function referenceName(sceneId: string, viewName: string): string;

export function contractDriver(
  renderer: Renderer,
  hooks: {
    frame: () => void | Promise<void>;
    toEcef: (p: object) => Ecef;
    pointer?: (
      type: string,
      x: number,
      y: number,
      extra: object,
    ) => void | Promise<void>;
  },
): CameraDriver;
export function runCameraScript(
  driver: CameraDriver,
  script: CameraScript,
): Promise<{ records: object[]; flights: object[] }>;
/** The parts of a pose a trace keeps. */
export function tracePose(pose: CameraPose): object;

/** The suite's assertions. */
export namespace expect {
  class ConformanceError extends Error {}
  function ok(value: unknown, message: string): void;
  function equal(actual: unknown, expected: unknown, message: string): void;
  function deepEqual(actual: unknown, expected: unknown, message: string): void;
  function near(
    actual: number,
    expected: number,
    tolerance: number,
    message: string,
  ): void;
  function nearAngle(
    actual: number,
    expected: number,
    tolerance: number,
    message: string,
  ): void;
  function nearVec(
    actual: { x: number; y: number; z: number },
    expected: { x: number; y: number; z: number },
    tolerance: number,
    message: string,
  ): void;
  function rejects(
    promiseOrFn: Promise<unknown> | (() => Promise<unknown>),
    message: string,
  ): Promise<void>;
  function throws(fn: () => unknown, message: string): void;
}
