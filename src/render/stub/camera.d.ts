/**
 * The stub renderer's camera (`camera.js`): the reference camera's poses,
 * views, flights and events in plain maths, which a camera port can be
 * built on.
 */
import type { CameraPort, Ecef, GeoRect, Vec3 } from '../contract/index';

/** The eye in world (ECEF) terms. */
export interface StubEye {
  position: Ecef;
  direction: Vec3;
  up: Vec3;
  right: Vec3;
  /** Vertical field of view, radians. */
  fovy: number;
  aspectRatio: number;
  near: number;
}

export interface StubCamera {
  port: CameraPort;
  /** Ends a flight in progress as cancelled, without announcing a command. */
  endFlight(): void;
  /** One frame's camera steps, run in the contract's order. */
  steps: {
    stepFlight(): void;
    stepChanged(): void;
    stepFollow(): void;
    stepMoveDetection(): void;
  };
  eye(): StubEye;
  /** The reasons camera controls are held for. */
  holds(): string[];
  /** The frame the eye is in, column-major from it to the world. */
  eyeFrame(): Float64Array;
  /** Puts `viewRectangle` on the port. */
  setViewRectangle(fn: () => GeoRect | null): void;
}

export function createStubCamera(options: {
  /** CSS size. */
  viewport: () => { width: number; height: number };
  /** The clock, ms. */
  now: () => number;
  /** Scene time, epoch ms. */
  sceneTime: () => number;
  requestRender: (reason: string) => void;
  report: (error: Error) => void;
  /** Where a drawn item is, `aheadMs` on, for a follow of it. */
  drawnPosition?: (
    item: { set: string; id: string },
    aheadMs: number,
  ) => Ecef | null;
  /** `cameraChangeThreshold` (default true). */
  thresholds?: boolean;
  /** `keepEarthFramed` (default false). */
  framing?: boolean;
}): StubCamera;
