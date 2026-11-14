import { PostProcessStage, PostProcessStageComposite } from 'cesium';
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
    createComposite = (options) => new PostProcessStageComposite(options),
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
    this.createComposite = createComposite;
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
      const stage = this.createStyleStage(
        `godsEyeView_${name}`,
        shader,
        uniforms,
      );
      stage.enabled = false;
      this.viewer.scene.postProcessStages.add(stage);
      this.stages[name] = stage;
    }
    this.stageEntries = Object.entries(this.stages);
  }

  /**
   * One stage for a single-pass style. A style with `passes` becomes a
   * composite: each pass reads the scene, the main shader reads the scene and
   * each pass's output, and the composite answers to the style's name,
   * `enabled` and `uniforms` as a single stage would.
   *
   * Cesium replaces a stage's `uniforms` object on its first frame, so the
   * composite's uniforms and the passes' read the main stage's current object
   * each time rather than the one it was created with.
   */
  createStyleStage(name, shader, uniforms) {
    if (!shader.passes?.length)
      return this.createStage({
        name,
        fragmentShader: shader.fragmentShader,
        uniforms,
      });
    let main = null;
    const shared = {};
    for (const uniform of Object.keys(uniforms))
      Object.defineProperty(shared, uniform, {
        enumerable: true,
        get: () => main.uniforms[uniform],
        set: (value) => {
          main.uniforms[uniform] = value;
        },
      });
    const passes = shader.passes.map((pass) => {
      const passName = `${name}_${pass.name}`;
      uniforms[pass.texture] = passName;
      return this.createStage({
        name: passName,
        fragmentShader: pass.fragmentShader,
        uniforms: Object.fromEntries(
          pass.uniforms.map((uniform) => [uniform, () => shared[uniform]]),
        ),
      });
    });
    main = this.createStage({
      name: `${name}_main`,
      fragmentShader: shader.fragmentShader,
      uniforms,
    });
    return this.createComposite({
      name,
      stages: [...passes, main],
      inputPreviousStageTexture: false,
      uniforms: shared,
    });
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
    // Anime's bands turn the faint Milky Way into blotches, and depth cannot
    // tell the sky from far geometry, so the glow fades with the style.
    if (
      stage === this.stages.anime &&
      this.viewer.scene.skyBox?.milkyWayVisibility !== undefined
    )
      this.viewer.scene.skyBox.milkyWayVisibility = 1 - value;
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

  /**
   * Sharpen runs only when it is on and its slider is above 0, as the style
   * stages do: the pass costs the same at any amount (~1.5 ms GPU per frame
   * on the Arc, 2026-10-24), and `0.1 + value * 2` still sharpened at 0.
   */
  syncSharpenEnabled() {
    if (this.stopped || !this.sharpenStage) return;
    this.sharpenStage.enabled =
      this.sharpenEnabled && this.sharpenIntensity > 0.001;
  }

  applySharpenIntensity(value) {
    if (this.stopped) return;
    this.sharpenIntensity = value;
    if (this.sharpenStage)
      this.sharpenStage.uniforms.amount = 0.1 + value * 2.0;
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
      // A style with `timeHz` moves its clock in steps and asks for one frame
      // a step; any other animated style is drawn every frame.
      let animatedStageVisible = false;
      let everyFrame = this.transitions.size > 0;
      let stepped = false;
      for (const [name, stage] of this.stageEntries) {
        if (stage.enabled && stage.uniforms.time !== undefined) {
          const hz = STYLES[name].timeHz;
          const time = hz ? Math.floor(elapsedSec * hz) / hz : elapsedSec;
          if (stage.uniforms.intensity > 0.001) {
            animatedStageVisible = true;
            if (!hz) everyFrame = true;
            else if (time !== stage.uniforms.time) stepped = true;
          }
          stage.uniforms.time = time;
        }
      }
      const needed = this.transitions.size > 0 || animatedStageVisible;
      if (everyFrame) this.holdRender('style-anim');
      else {
        this.releaseRender('style-anim');
        if (stepped) this.requestRender('style-anim');
      }
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
