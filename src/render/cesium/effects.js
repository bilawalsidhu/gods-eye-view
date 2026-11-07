/**
 * @module render/cesium/effects
 * @description The Cesium renderer's effects port
 * (`src/render/contract/effects.d.ts`) over `scene.postProcessStages`: each
 * style Core defines is one full-screen `PostProcessStage`, bloom is the
 * scene's own bloom stage, sharpen a stage of the port's own.
 *
 * A style's GLSL goes to Cesium as written: Cesium supplies `colorTexture`,
 * `colorTextureDimensions` and `v_textureCoordinates`, and declares
 * `out_FragColor` itself when the shader writes it. The port supplies
 * `intensity`, `time` and one uniform per parameter.
 *
 * Stages run in the order styles were defined, then sharpen. A style draws
 * while it is the style, and the styles it replaced while they fade out
 * (until their intensity goes to 0). An animated style that draws holds the
 * loop continuous and advances `time` each frame; nothing else asks for
 * frames but the one each change needs.
 *
 * Building the port changes nothing in the scene; the first `bloom` call
 * takes the scene's bloom stage, and disposal gives it back as it was.
 * There is no `screenModulation`: GEV's sweep shades each icon and label
 * in its own shader, not the frame.
 */
import * as Cesium from 'cesium';
import { provideUnboundEffects } from '../rendererOf.js';
import { listenerList, uncaught } from './common.js';

/** Below this a style, bloom or sharpen draws nothing, so it runs no pass. */
const OFF = 0.001;
/** Bloom below this strength runs no pass. */
const BLOOM_FLOOR = 0.06;
/** Uniform names a parameter key may not take. */
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

/**
 * @param {object} scene A Cesium scene.
 * @param {{
 *   capabilities: ReadonlySet<string>,
 *   frame: import('../contract/frame').FramePort,
 *   report: (error: unknown) => void,
 *   createStage?: (options: object) => object,
 * }} options `createStage` makes a `PostProcessStage`; tests pass fakes.
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

  // The animation clock: running while an animated style draws.
  let release = null;
  let offFrame = null;
  let disposed = false;
  const started = performance.now();

  // Disposed, or the scene went first and took its stages with it.
  const gone = () => disposed || scene.isDestroyed?.() === true;

  const drawing = (record) =>
    (record.id === current || fading.has(record.id)) && record.intensity > OFF;

  function makeStage(record) {
    const uniforms = { intensity: record.intensity, time: 0 };
    for (const p of record.params) uniforms[p.key] = record.values[p.key];
    const stage = createStage({
      name: `effects_style_${record.id}`,
      fragmentShader: record.glsl,
      uniforms,
    });
    stage.enabled = false;
    stages.add(stage);
    return stage;
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
    let animated = false;
    for (const record of styles.values()) {
      const on = drawing(record);
      record.stage.enabled = on;
      record.stage.uniforms.intensity = record.intensity;
      if (on && record.animated) animated = true;
    }
    if (bloomTaken)
      scene.postProcessStages.bloom.enabled =
        bloomEnabled && bloomStrength > BLOOM_FLOOR;
    if (sharpenStage)
      sharpenStage.enabled = sharpenEnabled && sharpenAmount > OFF;
    if (animated && !release) {
      offFrame = frame.on('preRender', tick);
      release = frame.holdContinuous('effects:animated');
    } else if (!animated && release) {
      stopClock();
    }
  }

  function tick(t) {
    const seconds = ((t?.now ?? performance.now()) - started) / 1000;
    for (const record of styles.values())
      if (record.animated) record.stage.uniforms.time = seconds;
  }

  function stopClock() {
    offFrame?.();
    offFrame = null;
    release?.();
    release = null;
  }

  function changed(reason) {
    if (gone()) return;
    apply();
    frame.requestRender(reason);
    listeners.fire(port.diagnostics());
  }

  /** Whether `id` names a style; changes to unknown ones are ignored. */
  const known = (id) => capabilities.has('styles') && styles.has(id);

  const port = {
    styles: () =>
      capabilities.has('styles')
        ? [...styles.values()].map(({ id, params, animated }) => ({
            id,
            params: params.map((p) => ({ ...p })),
            animated,
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
        if (RESERVED.has(p.key) || !/^[A-Za-z_]\w*$/.test(p.key))
          throw new TypeError(`Style parameter name not allowed: ${p.key}`);
      const previous = styles.get(id);
      const record = {
        id,
        params,
        animated: Boolean(definition.animated),
        glsl: definition.shader.glsl,
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
      ],
    }),
    on(event, cb) {
      if (event !== 'change') return () => {};
      return listeners.on(cb);
    },
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

// A Cesium viewer of a consumer's own, with no renderer bound to it, gets an
// effects port over its scene when code first asks `findEffects` for one.
provideUnboundEffects((viewer) => {
  const scene = viewer.scene;
  // By shape, not `instanceof`: a consumer's viewer may come from another
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
    capabilities: new Set(['styles', 'bloom', 'sharpen']),
    frame: sceneFrame(scene),
    report: uncaught,
  });
});
