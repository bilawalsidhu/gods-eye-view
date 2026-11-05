/**
 * Full-screen effects: visual styles, bloom, sharpen and screen modulation.
 * Each style is a plain full-screen pass over the frame's colour. Core owns
 * the styles and defines them on every renderer (`defineStyle`), so each
 * renderer runs the same set; a renderer's own styles are extra ones.
 */
import type { Off } from './common';

export interface StyleDescriptor {
  id: string;
  /** Parameters and their ranges. */
  params: Array<{ key: string; min: number; max: number; default: number }>;
  /** Animates, so it needs frames while on. */
  animated: boolean;
}

/**
 * A style's shader. `glsl` is a GLSL ES 3.00 fragment shader with its
 * `main()`, as GEV's styles are written, without `#version`, `precision`
 * or an `out` declaration: the renderer declares `out_FragColor`, which it
 * writes. It declares what it reads of `uniform sampler2D colorTexture`,
 * `uniform vec2 colorTextureDimensions` (pixels),
 * `in vec2 v_textureCoordinates`, `uniform float intensity` (0..1),
 * `uniform float time` (seconds, for an animated style) and one
 * `uniform float` per parameter under its key. Parameter keys are GLSL
 * identifiers and never one of those names.
 * `wgsl`, for a renderer that runs WGSL, is the same pass: a fragment entry
 * `fs_main` taking `@location(0) uv: vec2f` and returning the colour at
 * `@location(0)`. Group 0 binds `colorTexture` (`texture_2d<f32>`) at 0,
 * `colorSampler` at 1 and, at 2, a uniform struct the shader declares as
 * `params`: `intensity: f32`, `time: f32`, `dimensions: vec2f`, then one
 * `f32` per parameter in the order `params` lists them.
 */
export interface StyleShader {
  glsl: string;
  wgsl?: string;
}

export interface StyleDefinition extends StyleDescriptor {
  shader: StyleShader;
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
  /** `styles`: every style, defined by Core or the renderer's own. */
  styles(): StyleDescriptor[];
  /**
   * `styles`: add a style, replacing one with the same id. Null without
   * the capability, or when the renderer runs none of the shader's
   * languages; the Off removes it (turning it off when it is the style).
   */
  defineStyle(definition: StyleDefinition): Off | null;
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
