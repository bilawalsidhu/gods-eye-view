/**
 * Adaptive quality. A governor above the contract decides a level; each
 * renderer reports its frame signals, lists the settings it supports and
 * applies them. Nothing here is engine-specific.
 */
import type { Off } from './common';

export interface QualitySettings {
  /** Absolute device pixel ratio for the scene; 0 = browser recommended. */
  pixelRatio: number;
  /** Pixel ratio of screen-space overlays. */
  overlayPixelRatio: number;
  msaa: 0 | 2 | 4 | 8;
  /** 0..1: 3D tile detail (screen-space error, both directions). */
  tiles3dDetail: number;
  terrainDetail: number;
  imageryDetail: number;
  tilesCacheBytes: number;
  clouds: 'off' | 'low' | 'medium' | 'high' | 'ultra';
  shadows: boolean;
  water: 'off' | 'low' | 'high';
  atmosphere: 'off' | 'low' | 'high';
  milkyWay: 'low' | 'high';
  /** 0..1 density of particle fields (wind, weather). */
  particles: number;
  models: { maxInstances: number; maxDistance: number };
  postFx: { bloom: boolean; sharpen: boolean; style: 'low' | 'high' };
  /** Frame rate of animated styles. */
  animatedStyleFps: number;
  /** Updates per second of a screen modulation sweep. */
  sonarCadenceHz: number;
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

export interface BenchResult {
  frames: number;
  cpuMs: { median: number; p95: number };
  gpuMs?: { median: number; p95: number };
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
  /** `benchmark`: the renderer's own; the governor has a default. */
  benchmark?(options: {
    durationMs: number;
    scene?: 'standard';
  }): Promise<BenchResult>;
}
