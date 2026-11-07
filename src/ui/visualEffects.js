import {
  bloomStrengthFromIntensity,
  clampBloomIntensity,
  BLOOM_INTENSITY_DEFAULT,
} from '../bloom.js';
import {
  STYLES,
  TRANSITION_DURATION_MS,
  sharpenAmount,
} from './visualPresets.js';

/**
 * A style stage drawn by the globe engine (render.setStyle), in a Cesium
 * post stage's { uniforms, enabled } shape, so the owner of the stages
 * writes its uniforms as it wrote a stage's; each write reaches the engine.
 * A value the engine refuses (NaN from an old link, say) stays here and is
 * reported.
 */
function engineStyleStage(render, name, shader) {
  const values = { intensity: 0 };
  if (shader.fragmentShader.includes('uniform float time')) values.time = 0;
  for (const [uniform, meta] of Object.entries(shader.uniforms || {}))
    values[uniform] = meta.default;
  const { intensity, ...uniforms } = values;
  render.setStyle(name, { intensity, uniforms });
  const forward = (key, value) => {
    try {
      if (key === 'intensity') render.setStyle(name, { intensity: value });
      else render.setStyle(name, { uniforms: { [key]: value } });
    } catch (error) {
      console.warn(`The ${name} style refused ${key}=${value}:`, error);
    }
  };
  return {
    name: `godsEyeView_${name}`,
    enabled: false,
    uniforms: new Proxy(values, {
      set(target, key, value) {
        target[key] = value;
        if (typeof key === 'string' && Object.hasOwn(values, key))
          forward(key, value);
        return true;
      },
    }),
  };
}

/**
 * Own the visual styles, bloom and sharpening and their animation, without
 * DOM dependencies, on the globe engine that draws them (render.setStyle,
 * render.setBloom, render.setSharpen: Cesium through its post stages,
 * Navara in its pipeline).
 */
export class VisualEffects {
  /**
   * @param {object} options - The globe engine, render ownership callbacks
   * and optional clocks. The styles and bloom reach the engine when it has
   * them (the visualStyles and bloom capabilities); without an engine the
   * controls change nothing. Construction is inert; initStyles and
   * initPostProcess retain startup ordering.
   */
  constructor({
    engine = null,
    requestRender,
    holdRender,
    releaseRender,
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (id) => cancelAnimationFrame(id),
    now = () => performance.now(),
    wallNow = () => Date.now(),
  }) {
    this.engine = engine;
    const render = engine?.render;
    this.engineRender =
      typeof render?.setSharpen === 'function' ? render : null;
    // The visualStyles and bloom capabilities of src/globe/contract.js
    // engineCapabilities, read by member: this package stays engine-free.
    this.engineStyles =
      Array.isArray(render?.visualStyles) &&
      typeof render.setStyle === 'function' &&
      typeof render.style === 'function'
        ? render
        : null;
    this.engineBloom =
      typeof render?.setBloom === 'function' &&
      typeof render.bloom === 'function'
        ? render
        : null;
    this.requestRender = requestRender;
    this.holdRender = holdRender;
    this.releaseRender = releaseRender;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.now = now;
    this.wallNow = wallNow;
    this.stages = {};
    this.transitions = new Map();
    this.startTime = wallNow();
    this.bloomEnabled = false;
    this.sharpenEnabled = false;
    this.bloomIntensity = BLOOM_INTENSITY_DEFAULT;
    this.sharpenIntensity = 0.49;
    this.postProcessReady = false;
    // What the engine was last told about the sharpening: it starts off.
    this.sharpenShown = false;
    this.frameId = null;
    this.stopped = false;
    this.destroyed = false;
    this.stageEntries = [];
  }

  // The styles the engine draws get stand-in stages (engineStyleStage),
  // which start every style at 0 on it; an engine without them gets none
  // and the style controls change nothing.
  initStyles() {
    if (this.stopped || this.stageEntries.length || !this.engineStyles) return;
    const drawn = this.engineStyles.visualStyles;
    for (const [name, shader] of Object.entries(STYLES))
      if (drawn.includes(name))
        this.stages[name] = engineStyleStage(this.engineStyles, name, shader);
    this.stageEntries = Object.entries(this.stages);
  }

  initPostProcess(sharpenIntensity = this.sharpenIntensity) {
    if (this.stopped || this.postProcessReady) return;
    this.postProcessReady = true;
    // The engine starts from this owner's bloom and sharpening (off),
    // whatever a previous owner left on it.
    this.engineBloom?.setBloom({
      enabled: false,
      strength: bloomStrengthFromIntensity(this.bloomIntensity),
    });
    this.sharpenShown = false;
    this.engineRender?.setSharpen({ enabled: false });
    this.applySharpenIntensity(sharpenIntensity);
  }

  setStageIntensity(stage, value) {
    if (this.stopped || !stage) return;
    // The engine fades its stars with Anime (render.setStyle).
    stage.uniforms.intensity = value;
    stage.enabled = value > 0.001;
    if (stage.enabled && stage.uniforms.time !== undefined)
      this.startAnimationLoop();
    this.requestRender('style-stage');
  }

  syncStagesEnabledFromIntensity() {
    for (const [, stage] of this.stageEntries)
      this.setStageIntensity(stage, stage.uniforms.intensity);
  }

  // The engine eases the strength above its 0.06 dead zone (Cesium's bloom
  // stage); under it, nothing glows with the toggle on.
  syncBloomEnabled() {
    if (this.stopped) return;
    const enabled =
      this.bloomEnabled &&
      bloomStrengthFromIntensity(this.bloomIntensity) > 0.06;
    this.engineBloom?.setBloom({ enabled });
  }

  applyBloomIntensity(intensity) {
    if (this.stopped) return;
    this.bloomIntensity = clampBloomIntensity(intensity);
    this.requestRender('bloom');
    if (!this.engineBloom) return;
    this.engineBloom.setBloom({
      strength: bloomStrengthFromIntensity(this.bloomIntensity),
    });
    this.syncBloomEnabled();
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
   * on the Arc, 2026-10-24), and `0.1 + value * 2` still sharpened at 0.
   */
  syncSharpenEnabled() {
    if (this.stopped) return;
    const enabled = this.sharpenEnabled && this.sharpenIntensity > 0.001;
    if (enabled === this.sharpenShown) return;
    this.sharpenShown = enabled;
    this.engineRender?.setSharpen({ enabled });
  }

  applySharpenIntensity(value) {
    if (this.stopped) return;
    this.sharpenIntensity = value;
    this.engineRender?.setSharpen({ amount: sharpenAmount(value) });
    this.syncSharpenEnabled();
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

  startAnimationLoop() {
    if (this.stopped || this.frameId !== null) return;
    const update = () => {
      if (this.stopped) return;
      const now = this.now();
      const elapsedSec = (this.wallNow() - this.startTime) / 1000.0;
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
      let animatedStageVisible = false;
      for (const [, stage] of this.stageEntries) {
        if (stage.enabled && stage.uniforms.time !== undefined) {
          stage.uniforms.time = elapsedSec;
          if (stage.uniforms.intensity > 0.001) animatedStageVisible = true;
        }
      }
      const needed = this.transitions.size > 0 || animatedStageVisible;
      if (needed) this.holdRender('style-anim');
      else this.releaseRender('style-anim');
      this.frameId = needed ? this.requestFrame(update) : null;
    };
    this.frameId = this.requestFrame(update);
  }

  /** Revoke animation synchronously while callers finish releasing the stages. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.frameId !== null) this.cancelFrame(this.frameId);
    this.frameId = null;
    this.releaseRender('style-anim');
    this.transitions.clear();
  }

  /**
   * Turn every style, the bloom and the sharpening off on the engine after
   * callers release them, as removing Cesium's stages did: the engine keeps
   * the frame of a later owner, which starts them again (initStyles,
   * initPostProcess).
   */
  destroy() {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
    if (!this.engine || this.engine.isDestroyed?.()) return;
    for (const [name, stage] of this.stageEntries)
      if (stage.uniforms.intensity !== 0) {
        try {
          this.engineStyles.setStyle(name, { intensity: 0 });
        } catch {
          // The engine went with its scene.
        }
      }
    if (this.postProcessReady) this.engineBloom?.setBloom({ enabled: false });
    if (this.sharpenShown) this.engineRender?.setSharpen({ enabled: false });
  }
}
