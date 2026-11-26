/**
 * Adaptive quality. A governor above the contract decides a level; each
 * renderer reports its frame signals, lists the settings it supports and
 * applies them. Nothing here is engine-specific. Quality sets only how
 * detailed a thing is drawn; switching it on or off is the port's that
 * draws it (`globe.sky`, `effects`).
 */
import type { Off } from './common';

export interface QualitySettings {
  /** Absolute device pixel ratio for the scene; 0 = browser recommended. */
  pixelRatio: number;
  msaa: 0 | 2 | 4 | 8;
  /** 0..1: 3D tile detail (screen-space error, both directions). */
  tiles3dDetail: number;
  terrainDetail: number;
  imageryDetail: number;
  tilesCacheBytes: number;
  shadows: boolean;
  /** Detail of the atmosphere; whether it shows is `globe.sky`'s. */
  atmosphere: 'low' | 'high';
  /** Detail of the Milky Way; its brightness is `globe.sky`'s. */
  milkyWay: 'low' | 'high';
  /** 0..1 density of particle fields (wind, weather). */
  particles: number;
  models: { maxInstances: number; maxDistance: number };
  /** Detail of the post-processing passes; bloom and sharpen are switched in `effects`. */
  postFx: 'low' | 'high';
  targetFps: number;
}

export type QualityKey = keyof QualitySettings;

export interface KnobDescriptor {
  key: QualityKey;
  kind: 'number' | 'boolean' | 'enum' | 'object';
  min?: number;
  max?: number;
  options?: readonly string[] | readonly number[];
  default: unknown;
  /** Relative cost, 0 (free) to 1 (the heaviest knob). */
  cost: number;
  /** Changing it recreates the drawing context. */
  recreates?: boolean;
  /** What else changing it affects (lower tile detail lowers height accuracy). */
  couples?: string[];
}

export interface FrameSignals {
  cpuMs: number;
  /** `gpuTiming`. */
  gpuMs?: number;
  passes?: Record<string, number>;
  drawCalls?: number;
  commands?: number;
  tilesInFlight?: number;
  memory?: { gpuBytes?: number; tilesBytes?: number };
  pixelRatio: number;
  width: number;
  height: number;
  mode: 'demand' | 'continuous';
  /** This frame was asked for (not continuous). */
  requested: boolean;
  holds: string[];
  /** Spread of present intervals over the last second, ms. */
  presentJitterMs?: number;
}

export interface DeviceFacts {
  backend: 'webgl1' | 'webgl2' | 'webgpu';
  gpuVendor?: string;
  gpuRenderer?: string;
  maxTextureSize: number;
  msaaSamples: number[];
  gpuTimer: boolean;
}

export interface ProbeResult {
  device: DeviceFacts;
  browser: {
    devicePixelRatio: number;
    screen: { width: number; height: number };
    hardwareConcurrency?: number;
    deviceMemory?: number;
    touchOnly: boolean;
  };
  knobs: KnobDescriptor[];
}

export interface QualityPort {
  /** The settings this renderer supports, with ranges, defaults and costs. */
  knobs(): KnobDescriptor[];
  get(): Partial<QualitySettings>;
  /** Applied at the next frame; returns the keys it ignored as unsupported. */
  set(settings: Partial<QualitySettings>): QualityKey[];
  device(): DeviceFacts;
  probe(): ProbeResult;
  readonly signals: {
    readonly gpuTiming: 'none' | 'frame' | 'perPass';
    on(event: 'frame', cb: (signals: FrameSignals) => void): Off;
  };
}
