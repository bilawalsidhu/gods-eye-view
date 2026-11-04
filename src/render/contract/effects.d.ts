/**
 * Full-screen effects: visual styles, bloom, sharpen and screen modulation.
 * Each style is a plain full-screen pass over the frame's colour, so every
 * renderer can provide the same set.
 */
import type { Off } from './common';

export interface StyleDescriptor {
  id: string;
  /** Parameters and their ranges. */
  params: Array<{ key: string; min: number; max: number; default: number }>;
  /** Animates, so it needs frames while on. */
  animated: boolean;
}

/** A sweeping sector drawn over the frame (a sonar band), or null. */
export interface ModulationSector {
  /** Centre of the sweep, CSS pixels. */
  center: { x: number; y: number };
  /** Current angle, radians clockwise from up. */
  angle: number;
  /** Width of the band, radians. */
  width: number;
  /** 0..1. */
  strength: number;
  color: string;
}

export interface EffectsDiagnostics {
  style: string | null;
  passes: string[];
}

export interface EffectsPort {
  /** `styles`. */
  styles(): StyleDescriptor[];
  setStyle(id: string | null, params?: Record<string, number>): void;
  setStyleIntensity(id: string, intensity: number): void;
  setStyleParams(id: string, params: Record<string, number>): void;
  /** `bloom`. */
  bloom(settings: { enabled: boolean; strength?: number }): void;
  /** `sharpen`. */
  sharpen(settings: { enabled: boolean; amount?: number }): void;
  /** `screenModulation`. */
  screenModulation?(sector: ModulationSector | null): void;
  diagnostics(): EffectsDiagnostics;
  on(event: 'change', cb: (diagnostics: EffectsDiagnostics) => void): Off;
}
