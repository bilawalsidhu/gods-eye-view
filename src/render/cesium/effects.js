/**
 * @module render/cesium/effects
 * @description The Cesium renderer's effects port
 * (`src/render/contract/effects.d.ts`) over `scene.postProcessStages`: each
 * style the app defines is one full-screen `PostProcessStage` (a
 * `PostProcessStageComposite` when it has passes), bloom is the scene's own
 * bloom stage, sharpen a stage of the port's own.
 *
 * A style's GLSL goes to Cesium as written: Cesium supplies `colorTexture`,
 * `colorTextureDimensions` and `v_textureCoordinates`, and declares
 * `out_FragColor` itself when the shader writes it. The port supplies
 * `intensity`, `time` and one uniform per parameter.
 *
 * Stages run in the order styles were defined, then sharpen. A style draws
 * while it is the style, and the styles it replaced while they fade out
 * (until their intensity goes to 0). An animated style that draws holds the
 * loop continuous and advances `time` each frame; one with `timeHz` instead
 * moves `time` in steps and asks for one frame a step. Nothing else asks
 * for frames but the one each change needs.
 *
 * Building the port changes nothing in the scene; the first `bloom` call
 * takes the scene's bloom stage, and disposal gives it back as it was.
 * `screenModulation` is no stage: it shades each marker in its own shader
 * (`screenModulation.js`), so the map, lines and shapes draw as they are.
 * Like the rest, it changes nothing in the scene until a sector is set.
 */
import * as Cesium from 'cesium';
import { provideUnboundEffects } from '../rendererOf.js';
import { listenerList, uncaught } from './common.js';
import {
  createCesiumScreenModulation,
  screenModulationSupported,
} from './screenModulation.js';

/** Below this a style, bloom or sharpen draws nothing, so it runs no pass. */
const OFF = 0.001;
/** Bloom below this strength runs no pass. */
const BLOOM_FLOOR = 0.06;
/** Uniform names a parameter key or a pass's texture may not take. */
const RESERVED = new Set([
  'colorTexture',
  'colorTextureDimensions',
  'v_textureCoordinates',
  'intensity',
  'time',
]);
const BLOOM_UNIFORMS = [
  'glowOnly',
  'contrast',
  'brightness',
  'delta',
  'sigma',
  'stepSize',
];

/**
 * An unsharp mask over the 3x3 neighbourhood: the centre plus the
 * difference from its box blur, times `amount`.
 */
export const SHARPEN_SHADER = /* glsl */ `
  uniform sampler2D colorTexture;
  uniform vec2 colorTextureDimensions;
  uniform float amount;
  in vec2 v_textureCoordinates;

  void main() {
    vec2 uv = v_textureCoordinates;
    vec2 texel = 1.0 / colorTextureDimensions;
    vec4 center = texture(colorTexture, uv);
    vec4 blur = (
      texture(colorTexture, uv + vec2(-texel.x, -texel.y)) +
      texture(colorTexture, uv + vec2( 0.0,     -texel.y)) +
      texture(colorTexture, uv + vec2( texel.x, -texel.y)) +
      texture(colorTexture, uv + vec2(-texel.x,  0.0))     +
      center +
      texture(colorTexture, uv + vec2( texel.x,  0.0))     +
      texture(colorTexture, uv + vec2(-texel.x,  texel.y)) +
      texture(colorTexture, uv + vec2( 0.0,      texel.y)) +
      texture(colorTexture, uv + vec2( texel.x,  texel.y))
    ) / 9.0;
    vec4 sharpened = center + (center - blur) * amount;
    out_FragColor = vec4(clamp(sharpened.rgb, 0.0, 1.0), center.a);
  }
`;

/**
 * The bloom stage's uniforms for a strength, 0..1: none below
 * `BLOOM_FLOOR`, then eased from a faint glow to a wide one.
 * @param {number} strength
 */
export function bloomUniforms(strength) {
  const s = strength <= BLOOM_FLOOR ? 0 : (strength - BLOOM_FLOOR) / 0.94;
  const eased = s * s * (3 - 2 * s);
  return {
    contrast: 255 - eased * 168,
    brightness: -0.5 + eased * 0.36,
    sigma: 0.28 + eased * 6.3,
    delta: 0.2 + eased * 2.25,
    stepSize: 1 + eased * 1.25,
  };
}

const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));
const IDENTIFIER = /^[A-Za-z_]\w*$/;

/** A style's `time` at `seconds`: stepped for one with `timeHz`. */
const styleTime = (record, seconds) =>
  record.timeHz ? Math.floor(seconds * record.timeHz) / record.timeHz : seconds;

/**
 * @param {object} scene A Cesium scene.
 * @param {{
 *   capabilities: ReadonlySet<string>,
 *   frame: import('../contract/frame').FramePort,
 *   report: (error: unknown) => void,
 *   createStage?: (options: object) => object,
 *   createComposite?: (options: object) => object,
 * }} options `createStage` makes a `PostProcessStage` and
 *   `createComposite` a `PostProcessStageComposite`; tests pass fakes.
 * @returns {{port: import('../contract/effects').EffectsPort,
 *   dispose: () => void}}
 */
export function createCesiumEffects(
  scene,
  {
    capabilities,
    frame,
    report,
    createStage = (options) => new Cesium.PostProcessStage(options),
    createComposite = (options) =>
      new Cesium.PostProcessStageComposite(options),
  },
) {
  const stages = scene.postProcessStages;
  /** Defined styles in definition order: id → record. */
  const styles = new Map();
  /** The style, and those it replaced still fading out. */
  let current = null;
  const fading = new Set();
  const listeners = listenerList(report);

  let bloomTaken = null;
  let bloomEnabled = false;
  let bloomStrength = 0;
  let sharpenStage = null;
  let sharpenEnabled = false;
  let sharpenAmount = 0;

  // The animation clock: running while an animated style draws, holding
  // the loop continuous for one without `timeHz`.
  let release = null;
  let offFrame = null;
  let offStep = null;
  let disposed = false;
  const started = performance.now();

  /** Whether the modulation pass drew when listeners last heard. */
  let modulationListed = false;
  const modulation = capabilities.has('screenModulation')
    ? createCesiumScreenModulation(scene, {
        frame,
        // The pass stopped drawing on its own (a shader it cannot take).
        onChange: () => {
          if (gone() || modulation.draws() === modulationListed) return;
          modulationListed = modulation.draws();
          if (listeners.size) listeners.fire(port.diagnostics());
        },
      })
    : null;

  // Disposed, or the scene went first and took its stages with it.
  const gone = () => disposed || scene.isDestroyed?.() === true;

  const drawing = (record) =>
    (record.id === current || fading.has(record.id)) && record.intensity > OFF;

  function makeStage(record) {
    const uniforms = { intensity: record.intensity, time: 0 };
    for (const p of record.params) uniforms[p.key] = record.values[p.key];
    const name = `effects_style_${record.id}`;
    const stage = record.passes.length
      ? makeComposite(name, record, uniforms)
      : createStage({ name, fragmentShader: record.glsl, uniforms });
    stage.enabled = false;
    stages.add(stage);
    return stage;
  }

  /**
   * A style with passes: each pass reads the frame's colour, the style's
   * own shader reads the frame's colour and each pass's output, and the
   * composite answers to `enabled` and `uniforms` as a single stage would.
   *
   * Cesium replaces a stage's `uniforms` object on its first frame, so the
   * composite's uniforms and the passes' read the main stage's current
   * object each time rather than the one it was created with.
   */
  function makeComposite(name, record, uniforms) {
    let main = null;
    const shared = {};
    for (const key of Object.keys(uniforms))
      Object.defineProperty(shared, key, {
        enumerable: true,
        get: () => main.uniforms[key],
        set: (value) => {
          main.uniforms[key] = value;
        },
      });
    const passes = record.passes.map((pass) => {
      const passName = `${name}_${pass.name}`;
      uniforms[pass.texture] = passName;
      return createStage({
        name: passName,
        fragmentShader: pass.glsl,
        uniforms: Object.fromEntries(
          pass.params.map((key) => [key, () => shared[key]]),
        ),
      });
    });
    main = createStage({
      name: `${name}_main`,
      fragmentShader: record.glsl,
      uniforms,
    });
    return createComposite({
      name,
      stages: [...passes, main],
      inputPreviousStageTexture: false,
      uniforms: shared,
    });
  }

  function makeSharpen() {
    sharpenStage = createStage({
      name: 'effects_sharpen',
      fragmentShader: SHARPEN_SHADER,
      uniforms: { amount: 0.1 + sharpenAmount * 2 },
    });
    sharpenStage.enabled = false;
    stages.add(sharpenStage);
  }

  /** Puts each stage's enabled flag and the clock in step with the state. */
  function apply() {
    let continuous = false;
    let stepped = false;
    for (const record of styles.values()) {
      const on = drawing(record);
      record.stage.enabled = on;
      record.stage.uniforms.intensity = record.intensity;
      if (on && record.animated) {
        if (record.timeHz) stepped = true;
        else continuous = true;
      }
    }
    if (bloomTaken)
      scene.postProcessStages.bloom.enabled =
        bloomEnabled && bloomStrength > BLOOM_FLOOR;
    if (sharpenStage)
      sharpenStage.enabled = sharpenEnabled && sharpenAmount > OFF;
    if (continuous && !release) {
      offFrame = frame.on('preRender', tick);
      release = frame.holdContinuous('effects:animated');
    } else if (!continuous && release) {
      stopContinuous();
    }
    // `preUpdate` comes on every tick, drawn or not, so a step is seen in
    // time to ask for its frame.
    if (stepped && !offStep) offStep = frame.on('preUpdate', step);
    else if (!stepped && offStep) stopStep();
  }

  const secondsAt = (t) => ((t?.now ?? performance.now()) - started) / 1000;

  function tick(t) {
    const seconds = secondsAt(t);
    for (const record of styles.values())
      if (record.animated)
        record.stage.uniforms.time = styleTime(record, seconds);
  }

  /** Moves each stepped style's clock, and asks for a frame on a step. */
  function step(t) {
    const seconds = secondsAt(t);
    let moved = false;
    for (const record of styles.values()) {
      if (!record.animated || !record.timeHz) continue;
      const time = styleTime(record, seconds);
      if (time === record.stage.uniforms.time) continue;
      record.stage.uniforms.time = time;
      if (drawing(record)) moved = true;
    }
    if (moved) frame.requestRender('effects:animated');
  }

  function stopContinuous() {
    offFrame?.();
    offFrame = null;
    release?.();
    release = null;
  }

  function stopStep() {
    offStep?.();
    offStep = null;
  }

  function stopClock() {
    stopContinuous();
    stopStep();
  }

  function changed(reason) {
    if (gone()) return;
    apply();
    frame.requestRender(reason);
    // A fade changes every frame: its diagnostics are listed only for ears.
    if (listeners.size) listeners.fire(port.diagnostics());
  }

  /** Whether `id` names a style; changes to unknown ones are ignored. */
  const known = (id) => capabilities.has('styles') && styles.has(id);

  const port = {
    styles: () =>
      capabilities.has('styles')
        ? [...styles.values()].map(({ id, params, animated, timeHz }) => ({
            id,
            params: params.map((p) => ({ ...p })),
            animated,
            ...(timeHz ? { timeHz } : {}),
          }))
        : [],
    defineStyle(definition) {
      if (
        gone() ||
        !capabilities.has('styles') ||
        typeof definition?.shader?.glsl !== 'string'
      )
        return null;
      const id = String(definition.id);
      const params = (definition.params ?? []).map((p) => ({ ...p }));
      for (const p of params)
        if (RESERVED.has(p.key) || !IDENTIFIER.test(p.key))
          throw new TypeError(`Style parameter name not allowed: ${p.key}`);
      const passes = (definition.shader.passes ?? []).map((pass) => ({
        name: String(pass.name),
        texture: String(pass.texture),
        params: [...(pass.params ?? [])],
        glsl: pass.glsl,
      }));
      const keys = new Set(params.map((p) => p.key));
      for (const pass of passes) {
        if (!IDENTIFIER.test(pass.name) || typeof pass.glsl !== 'string')
          throw new TypeError(`Style pass not allowed: ${pass.name}`);
        if (
          RESERVED.has(pass.texture) ||
          keys.has(pass.texture) ||
          !IDENTIFIER.test(pass.texture)
        )
          throw new TypeError(
            `Style pass texture not allowed: ${pass.texture}`,
          );
        for (const key of pass.params)
          if (!keys.has(key))
            throw new TypeError(`Style pass parameter unknown: ${key}`);
      }
      const timeHz = Number(definition.timeHz);
      const previous = styles.get(id);
      const record = {
        id,
        params,
        animated: Boolean(definition.animated),
        timeHz: timeHz > 0 && Number.isFinite(timeHz) ? timeHz : 0,
        glsl: definition.shader.glsl,
        passes,
        intensity: previous?.intensity ?? 1,
        values: Object.fromEntries(
          params.map((p) => [
            p.key,
            previous && p.key in previous.values
              ? previous.values[p.key]
              : p.default,
          ]),
        ),
        stage: null,
      };
      if (previous) {
        stages.remove(previous.stage);
        styles.delete(id);
      }
      record.stage = makeStage(record);
      styles.set(id, record);
      // Sharpen runs after every style, so it moves behind a new one.
      if (sharpenStage) {
        stages.remove(sharpenStage);
        makeSharpen();
      }
      changed('effects-style');
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        if (gone() || styles.get(id) !== record) return;
        styles.delete(id);
        stages.remove(record.stage);
        fading.delete(id);
        if (current === id) current = null;
        changed('effects-style');
      };
    },
    setStyle(id, params) {
      if (gone() || !capabilities.has('styles')) return;
      const next = id === null || id === undefined ? null : String(id);
      if (next !== null && !styles.has(next)) return;
      if (next !== current) {
        if (current !== null && styles.get(current)?.intensity > OFF)
          fading.add(current);
        if (next !== null) fading.delete(next);
        current = next;
      }
      if (next !== null && params) assignParams(styles.get(next), params);
      changed('effects-style');
    },
    setStyleIntensity(id, intensity) {
      if (gone() || !known(id)) return;
      const record = styles.get(id);
      record.intensity = clamp01(intensity);
      if (record.intensity <= OFF) fading.delete(id);
      changed('effects-style');
    },
    setStyleParams(id, params) {
      if (gone() || !known(id)) return;
      assignParams(styles.get(id), params);
      changed('effects-style');
    },
    bloom({ enabled, strength } = {}) {
      if (gone() || !capabilities.has('bloom')) return;
      const bloom = scene.postProcessStages.bloom;
      if (!bloomTaken) {
        bloomTaken = {
          enabled: bloom.enabled,
          uniforms: Object.fromEntries(
            BLOOM_UNIFORMS.map((name) => [name, bloom.uniforms[name]]),
          ),
        };
        bloom.uniforms.glowOnly = false;
      }
      bloomEnabled = Boolean(enabled);
      if (strength !== undefined) bloomStrength = clamp01(strength);
      Object.assign(bloom.uniforms, bloomUniforms(bloomStrength));
      changed('effects-bloom');
    },
    sharpen({ enabled, amount } = {}) {
      if (gone() || !capabilities.has('sharpen')) return;
      sharpenEnabled = Boolean(enabled);
      if (amount !== undefined) sharpenAmount = clamp01(amount);
      if (!sharpenStage) makeSharpen();
      sharpenStage.uniforms.amount = 0.1 + sharpenAmount * 2;
      changed('effects-sharpen');
    },
    diagnostics: () => ({
      style: current,
      passes: [
        ...[...styles.values()]
          .filter((record) => record.stage.enabled)
          .map((record) => `style:${record.id}`),
        ...(bloomTaken && scene.postProcessStages.bloom.enabled
          ? ['bloom']
          : []),
        ...(sharpenStage?.enabled ? ['sharpen'] : []),
        ...(modulation?.draws() ? ['screenModulation'] : []),
      ],
    }),
    on(event, cb) {
      if (event !== 'change') return () => {};
      return listeners.on(cb);
    },
  };

  if (modulation)
    port.screenModulation = (sector) => {
      if (gone()) return;
      modulation.set(sector ?? null);
      // Its own render demand: a sweep moving where nothing is shaded asks
      // for no frame. Listeners hear when the pass starts or stops.
      if (modulation.draws() === modulationListed) return;
      modulationListed = modulation.draws();
      listeners.fire(port.diagnostics());
    };

  function assignParams(record, params) {
    for (const [key, value] of Object.entries(params ?? {})) {
      if (!(key in record.values)) continue;
      record.values[key] = Number(value);
      record.stage.uniforms[key] = Number(value);
    }
  }

  return {
    port,
    /** Removes the port's stages and gives the scene's bloom back. */
    dispose() {
      if (disposed) return;
      disposed = true;
      stopClock();
      listeners.clear();
      modulation?.dispose();
      // A destroyed scene took its stages with it.
      if (scene.isDestroyed?.()) {
        styles.clear();
        sharpenStage = null;
        bloomTaken = null;
        return;
      }
      for (const record of styles.values()) stages.remove(record.stage);
      styles.clear();
      if (sharpenStage) stages.remove(sharpenStage);
      sharpenStage = null;
      if (bloomTaken) {
        const bloom = scene.postProcessStages.bloom;
        Object.assign(bloom.uniforms, bloomTaken.uniforms);
        bloom.enabled = bloomTaken.enabled;
        bloomTaken = null;
      }
    },
  };
}

/**
 * The frame port's members the effects port uses, straight over a scene no
 * renderer drives: a hold asks for the next frame after each one drawn.
 * @param {object} scene
 */
function sceneFrame(scene) {
  return {
    on: (phase, cb) =>
      scene[phase].addEventListener(() => cb({ now: performance.now() })),
    requestRender: () => scene.requestRender(),
    holdContinuous() {
      const off = scene.postRender.addEventListener(() =>
        scene.requestRender(),
      );
      scene.requestRender();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        off();
        if (!scene.isDestroyed?.()) scene.requestRender();
      };
    },
  };
}

// A Cesium viewer with no renderer bound to it gets an
// effects port over its scene when code first asks `findEffects` for one.
provideUnboundEffects((viewer) => {
  const scene = viewer.scene;
  // By shape, not `instanceof`: the viewer may come from another
  // copy of Cesium.
  if (
    typeof scene?.postProcessStages?.add !== 'function' ||
    typeof scene.postProcessStages.remove !== 'function' ||
    !scene.postProcessStages.bloom ||
    typeof scene.preRender?.addEventListener !== 'function' ||
    typeof scene.postRender?.addEventListener !== 'function' ||
    typeof scene.requestRender !== 'function'
  )
    return null;
  return createCesiumEffects(scene, {
    capabilities: new Set([
      'styles',
      'bloom',
      'sharpen',
      ...(screenModulationSupported() ? ['screenModulation'] : []),
    ]),
    frame: sceneFrame(scene),
    report: uncaught,
  });
});
