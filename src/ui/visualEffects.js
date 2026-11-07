import {
  bloomStrengthFromIntensity,
  clampBloomIntensity,
  BLOOM_INTENSITY_DEFAULT,
} from '../bloom.js';
import { registerStyleStages } from '../styles/styleStages.js';
import { STYLES, TRANSITION_DURATION_MS } from './visualPresets.js';

/** Below this a style draws nothing, so it runs no pass. */
const OFF = 0.001;

/**
 * A style as the renderer contract defines it
 * (`src/render/contract/effects.d.ts`).
 * @param {string} name
 * @param {{fragmentShader: string, uniforms?: Record<string, {default: number, min: number, max: number}>}} shader
 */
export function styleDefinition(name, shader) {
  return {
    id: name,
    params: Object.entries(shader.uniforms || {}).map(([key, meta]) => ({
      key,
      min: meta.min,
      max: meta.max,
      default: meta.default,
    })),
    animated: shader.fragmentShader.includes('uniform float time'),
    shader: { glsl: shader.fragmentShader },
  };
}

/**
 * Core's records of the visual styles, bloom and sharpen, and their
 * crossfades, driven onto the renderer's effects port. Each style's record
 * (`stages[name]`) holds its intensity and parameter values in `uniforms`,
 * written through to the renderer, and `enabled`, whether it draws. The
 * renderer animates `time` for an animated style; this keeps only the
 * crossfades' frames. No DOM dependencies.
 */
export class VisualEffects {
  /**
   * @param {object} options - The renderer's effects port (null: records
   *   only), the viewer whose sky the anime style dims, render ownership
   *   callbacks and optional clocks. Construction is inert;
   *   initStyles/initPostProcess retain startup ordering.
   */
  constructor({
    effects = null,
    viewer,
    requestRender,
    holdRender,
    releaseRender,
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (id) => cancelAnimationFrame(id),
    now = () => performance.now(),
  }) {
    this.effects = effects;
    this.viewer = viewer;
    this.requestRender = requestRender;
    this.holdRender = holdRender;
    this.releaseRender = releaseRender;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.now = now;
    this.stages = {};
    this.transitions = new Map();
    this.bloomEnabled = false;
    this.sharpenEnabled = false;
    this.bloomIntensity = BLOOM_INTENSITY_DEFAULT;
    this.sharpenIntensity = 0.49;
    this.postProcessReady = false;
    this.frameId = null;
    this.stopped = false;
    this.destroyed = false;
    this.stageEntries = [];
    // What the renderer draws: its style, and the styles it replaced while
    // they fade out (`EffectsPort.setStyle`).
    this.rendererStyle = null;
    this.drawn = new Set();
    this.offs = [];
    this.forgetStages = () => {};
  }

  initStyles() {
    if (this.stopped || this.stageEntries.length) return;
    for (const [name, shader] of Object.entries(STYLES)) {
      const definition = styleDefinition(name, shader);
      const off = this.effects?.defineStyle(definition);
      if (off) this.offs.push(off);
      this.effects?.setStyleIntensity(name, 0);
      this.stages[name] = this.styleRecord(name, definition);
    }
    this.stageEntries = Object.entries(this.stages);
    this.forgetStages = registerStyleStages(this.viewer?.scene, this.stages);
  }

  /** A style's record, its uniforms written through to the renderer. */
  styleRecord(name, definition) {
    let intensity = 0;
    const values = Object.fromEntries(
      definition.params.map((p) => [p.key, p.default]),
    );
    const uniforms = {};
    Object.defineProperty(uniforms, 'intensity', {
      enumerable: true,
      get: () => intensity,
      set: (value) => {
        intensity = value;
        this.pushIntensity(name, value);
      },
    });
    for (const { key } of definition.params)
      Object.defineProperty(uniforms, key, {
        enumerable: true,
        get: () => values[key],
        set: (value) => {
          values[key] = value;
          if (!this.destroyed)
            this.effects?.setStyleParams(name, { [key]: value });
        },
      });
    return { name, enabled: false, uniforms };
  }

  /**
   * A style's intensity on the renderer. Raised from nothing, it becomes
   * the renderer's style, so it draws; the style it replaces fades out
   * there at the intensity this keeps writing, as every stage with an
   * intensity drew before.
   */
  pushIntensity(name, value) {
    if (this.destroyed || !this.effects) return;
    this.effects.setStyleIntensity(name, value);
    // Once stopped, a write only tunes what already draws.
    if (this.stopped) return;
    if (value > OFF) {
      if (!this.drawn.has(name)) {
        const previous = this.rendererStyle;
        if (previous && !(this.stages[previous]?.uniforms.intensity > OFF))
          this.drawn.delete(previous);
        this.effects.setStyle(name);
        this.rendererStyle = name;
        this.drawn.add(name);
      }
    } else if (name !== this.rendererStyle) {
      this.drawn.delete(name);
    }
  }

  initPostProcess(sharpenIntensity = this.sharpenIntensity) {
    if (this.stopped || this.postProcessReady) return;
    this.postProcessReady = true;
    this.effects?.bloom({
      enabled: false,
      strength: bloomStrengthFromIntensity(this.bloomIntensity),
    });
    this.effects?.sharpen({ enabled: false, amount: sharpenIntensity });
    this.applySharpenIntensity(sharpenIntensity);
  }

  setStageIntensity(stage, value) {
    if (this.stopped || !stage) return;
    stage.uniforms.intensity = value;
    stage.enabled = value > OFF;
    // Anime's bands turn the faint Milky Way into blotches, and depth cannot
    // tell the sky from far geometry, so the glow fades with the style.
    if (
      stage === this.stages.anime &&
      this.viewer?.scene?.skyBox?.milkyWayVisibility !== undefined
    )
      this.viewer.scene.skyBox.milkyWayVisibility = 1 - value;
    this.requestRender('style-stage');
  }

  syncStagesEnabledFromIntensity() {
    for (const [, stage] of this.stageEntries)
      this.setStageIntensity(stage, stage.uniforms.intensity);
  }

  syncBloomEnabled() {
    if (this.stopped || !this.postProcessReady) return;
    this.effects?.bloom({ enabled: this.bloomEnabled });
  }

  applyBloomIntensity(intensity) {
    if (this.stopped) return;
    this.bloomIntensity = clampBloomIntensity(intensity);
    this.requestRender('bloom');
    if (!this.postProcessReady) return;
    this.effects?.bloom({
      enabled: this.bloomEnabled,
      strength: bloomStrengthFromIntensity(this.bloomIntensity),
    });
  }

  setBloomEnabled(enabled) {
    if (this.stopped) return;
    this.bloomEnabled = !!enabled;
    this.syncBloomEnabled();
    this.requestRender('bloom');
  }

  /**
   * Sharpen runs only when it is on and its slider is above 0, as the style
   * stages do: the pass costs the same at any amount (~1.5 ms GPU per frame
   * on the Arc, 2026-10-24), and its gain still sharpened at 0.
   */
  syncSharpenEnabled() {
    if (this.stopped || !this.postProcessReady) return;
    this.effects?.sharpen({ enabled: this.sharpenEnabled });
  }

  applySharpenIntensity(value) {
    if (this.stopped) return;
    this.sharpenIntensity = value;
    if (this.postProcessReady)
      this.effects?.sharpen({ enabled: this.sharpenEnabled, amount: value });
    this.requestRender('sharpen');
  }

  setSharpenEnabled(enabled) {
    if (this.stopped) return;
    this.sharpenEnabled = !!enabled;
    this.syncSharpenEnabled();
    this.requestRender('sharpen');
  }

  startTransition(styleName, from, to) {
    if (this.stopped) return;
    this.transitions.set(styleName, { start: this.now(), from, to });
    this.startAnimationLoop();
  }

  /** Steps the crossfades each frame, holding frames while one runs. */
  startAnimationLoop() {
    if (this.stopped || this.frameId !== null) return;
    const update = () => {
      if (this.stopped) return;
      const now = this.now();
      for (const [name, transition] of this.transitions) {
        const t = Math.min(
          (now - transition.start) / TRANSITION_DURATION_MS,
          1.0,
        );
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        this.setStageIntensity(
          this.stages[name],
          transition.from + (transition.to - transition.from) * eased,
        );
        if (t >= 1.0) {
          this.setStageIntensity(this.stages[name], transition.to);
          this.transitions.delete(name);
        }
      }
      const needed = this.transitions.size > 0;
      if (needed) this.holdRender('style-anim');
      else this.releaseRender('style-anim');
      this.frameId = needed ? this.requestFrame(update) : null;
    };
    this.frameId = this.requestFrame(update);
  }

  /** Revoke animation synchronously while callers finish releasing the styles. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.frameId !== null) this.cancelFrame(this.frameId);
    this.frameId = null;
    this.releaseRender('style-anim');
    this.transitions.clear();
  }

  /** Remove the styles from the renderer and turn bloom and sharpen off. */
  destroy() {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
    this.forgetStages();
    for (const off of this.offs) off();
    this.offs = [];
    if (this.postProcessReady) {
      this.effects?.bloom({ enabled: false });
      this.effects?.sharpen({ enabled: false });
    }
  }
}
