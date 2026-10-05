import { PostProcessStage } from 'cesium';
import {
  bloomStrengthFromIntensity,
  clampBloomIntensity,
  BLOOM_INTENSITY_DEFAULT,
} from '../bloom.js';
import {
  STYLES,
  SHARPEN_SHADER,
  TRANSITION_DURATION_MS,
} from './visualPresets.js';

/** Own the post-process stages and their animation, without DOM dependencies. */
export class VisualEffects {
  /**
   * @param {object} options - Viewer, render ownership callbacks and optional clocks.
   * Construction is inert; initStyles/initPostProcess retain startup ordering.
   */
  constructor({
    viewer,
    requestRender,
    holdRender,
    releaseRender,
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (id) => cancelAnimationFrame(id),
    now = () => performance.now(),
    wallNow = () => Date.now(),
    createStage = (options) => new PostProcessStage(options),
  }) {
    this.viewer = viewer;
    this.requestRender = requestRender;
    this.holdRender = holdRender;
    this.releaseRender = releaseRender;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.now = now;
    this.wallNow = wallNow;
    this.createStage = createStage;
    this.stages = {};
    this.transitions = new Map();
    this.startTime = wallNow();
    this.bloomEnabled = false;
    this.sharpenEnabled = false;
    this.bloomIntensity = BLOOM_INTENSITY_DEFAULT;
    this.sharpenIntensity = 0.49;
    this.bloomStage = null;
    this.sharpenStage = null;
    this.frameId = null;
    this.stopped = false;
    this.destroyed = false;
    this.stageEntries = [];
    this.previousBloom = null;
  }

  initStyles() {
    if (this.stopped || this.stageEntries.length) return;
    for (const [name, shader] of Object.entries(STYLES)) {
      const uniforms = { intensity: 0.0 };
      if (shader.fragmentShader.includes('uniform float time'))
        uniforms.time = 0.0;
      for (const [name, meta] of Object.entries(shader.uniforms || {}))
        uniforms[name] = meta.default;
      const stage = this.createStage({
        name: `godsEyeView_${name}`,
        fragmentShader: shader.fragmentShader,
        uniforms,
      });
      stage.enabled = false;
      this.viewer.scene.postProcessStages.add(stage);
      this.stages[name] = stage;
    }
    this.stageEntries = Object.entries(this.stages);
  }

  initPostProcess(sharpenIntensity = this.sharpenIntensity) {
    if (this.stopped || this.sharpenStage) return;
    this.bloomStage = this.viewer.scene.postProcessStages.bloom;
    const names = [
      'glowOnly',
      'contrast',
      'brightness',
      'delta',
      'sigma',
      'stepSize',
    ];
    this.previousBloom = {
      enabled: this.bloomStage.enabled,
      uniforms: Object.fromEntries(
        names.map((name) => [name, this.bloomStage.uniforms[name]]),
      ),
    };
    this.bloomStage.enabled = false;
    Object.assign(this.bloomStage.uniforms, {
      glowOnly: false,
      contrast: 256.0,
      brightness: -0.35,
      delta: 0.25,
      sigma: 0.35,
      stepSize: 1.0,
    });
    this.sharpenStage = this.createStage({
      name: 'godsEyeView_sharpen',
      fragmentShader: SHARPEN_SHADER,
      uniforms: { amount: 1.3 },
    });
    this.sharpenStage.enabled = false;
    this.viewer.scene.postProcessStages.add(this.sharpenStage);
    this.applySharpenIntensity(sharpenIntensity);
  }

  setStageIntensity(stage, value) {
    if (this.stopped || !stage) return;
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

  syncBloomEnabled() {
    if (this.stopped || !this.bloomStage) return;
    this.bloomStage.enabled =
      this.bloomEnabled &&
      bloomStrengthFromIntensity(this.bloomIntensity) > 0.06;
  }

  applyBloomIntensity(intensity) {
    if (this.stopped) return;
    this.bloomIntensity = clampBloomIntensity(intensity);
    this.requestRender('bloom');
    if (!this.bloomStage) return;
    const rawStrength = bloomStrengthFromIntensity(this.bloomIntensity);
    const strength = rawStrength <= 0.06 ? 0.0 : (rawStrength - 0.06) / 0.94;
    const eased = strength * strength * (3.0 - 2.0 * strength);
    this.bloomStage.uniforms.contrast = 255.0 - eased * 168.0;
    this.bloomStage.uniforms.brightness = -0.5 + eased * 0.36;
    this.bloomStage.uniforms.sigma = 0.28 + eased * 6.3;
    this.bloomStage.uniforms.delta = 0.2 + eased * 2.25;
    this.bloomStage.uniforms.stepSize = 1.0 + eased * 1.25;
    this.syncBloomEnabled();
  }

  setBloomEnabled(enabled) {
    if (this.stopped) return;
    this.bloomEnabled = !!enabled;
    this.syncBloomEnabled();
    this.requestRender('bloom');
  }

  applySharpenIntensity(value) {
    if (this.stopped) return;
    this.sharpenIntensity = value;
    if (this.sharpenStage)
      this.sharpenStage.uniforms.amount = 0.1 + value * 2.0;
    this.requestRender('sharpen');
  }

  setSharpenEnabled(enabled) {
    if (this.stopped) return;
    this.sharpenEnabled = !!enabled;
    if (this.sharpenStage) this.sharpenStage.enabled = this.sharpenEnabled;
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

  /** Remove owned stages and restore the borrowed bloom stage after callers release it. */
  destroy() {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
    const stages = this.viewer.scene.postProcessStages;
    for (const [, stage] of this.stageEntries) stages.remove(stage);
    if (this.sharpenStage) stages.remove(this.sharpenStage);
    if (this.bloomStage && this.previousBloom) {
      Object.assign(this.bloomStage.uniforms, this.previousBloom.uniforms);
      this.bloomStage.enabled = this.previousBloom.enabled;
    }
  }
}
