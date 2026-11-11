// The app's full-frame effects on Cesium (GlobeRender's visualStyles,
// bloom and setSharpen), through the scene's post-process stages: one stage
// per visual style, each the style's own shader (src/styles), then the
// sharpening; the bloom is the scene's own stage, borrowed. Cesium draws its
// stages in the order they were added, so the six join the scene together,
// styles first, at the first style or sharpen call (creating the engine
// changes nothing), and each is enabled only while it draws. Anime fades the
// sky box's Milky Way with its intensity (starrySky.js). destroy() removes
// the stages and gives the bloom stage back as it was borrowed.

import { PostProcessStage } from 'cesium';
import {
  BLOOM_INITIAL,
  SHARPEN_INITIAL,
  STYLE_INITIAL,
  mergeBloom,
  mergeSharpen,
  mergeStyle,
} from '../contract.js';
import { retroShader } from '../../styles/retro.js';
import { nightVisionShader } from '../../styles/surveillance.js';
import { thermalShader } from '../../styles/thermal.js';
import { animeShader } from '../../styles/anime.js';
import { noirShader } from '../../styles/noir.js';

// The app's styles by their names, in their stage order
// (src/ui/visualPresets.js STYLES).
const STYLE_SHADERS = Object.freeze({
  retro: retroShader,
  surveillance: nightVisionShader,
  thermal: thermalShader,
  anime: animeShader,
  noir: noirShader,
});

/** Intensity under which a style draws nothing (its stage is disabled). */
const STYLE_VISIBLE_INTENSITY = 0.001;
/** Strength at or under which the bloom draws nothing. */
const BLOOM_DEAD_ZONE = 0.06;
// The bloom stage's uniforms the engine sets, given back on destroy.
const BLOOM_UNIFORMS = [
  'glowOnly',
  'contrast',
  'brightness',
  'delta',
  'sigma',
  'stepSize',
];

/**
 * GLSL fragment shader implementing an unsharp-mask sharpening filter.
 * Samples a 3x3 neighborhood, computes box blur, then adds the
 * difference (center - blur) scaled by `amount` for edge enhancement.
 */
const SHARPEN_SHADER = /* glsl */ `
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

/** A style's uniforms before it is first set: `time` if it animates, then its parameters' defaults. */
function styleDefaults(shader) {
  const uniforms = {};
  if (shader.fragmentShader.includes('uniform float time')) uniforms.time = 0;
  for (const [name, meta] of Object.entries(shader.uniforms || {}))
    uniforms[name] = meta.default;
  return uniforms;
}

/**
 * Cesium's bloom stage uniforms for a strength (0..1): above the dead zone
 * the strength eases (smoothstep) into a lower contrast, a brighter offset
 * and a wider blur, so more of the frame glows, further out.
 */
export function bloomUniforms(strength) {
  const raw =
    strength <= BLOOM_DEAD_ZONE
      ? 0
      : (strength - BLOOM_DEAD_ZONE) / (1 - BLOOM_DEAD_ZONE);
  const eased = raw * raw * (3 - 2 * raw);
  return {
    contrast: 255 - eased * 168,
    brightness: -0.5 + eased * 0.36,
    sigma: 0.28 + eased * 6.3,
    delta: 0.2 + eased * 2.25,
    stepSize: 1 + eased * 1.25,
  };
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ requestRender: (reason: string) => void,
 *   createStage?: (options: object) => object }} options `createStage` is
 *   a test seam (Cesium's PostProcessStage).
 * @returns {{ render: object, destroy: () => void }} `render`: the
 *   GlobeRender members (visualStyles, setStyle, style, setBloom, bloom,
 *   setSharpen, sharpen).
 */
export function createCesiumPostStages(
  viewer,
  { requestRender, createStage = (options) => new PostProcessStage(options) },
) {
  const { scene } = viewer;
  const styles = new Map(
    Object.entries(STYLE_SHADERS).map(([name, shader]) => {
      const uniforms = styleDefaults(shader);
      return [
        name,
        {
          shader,
          names: Object.keys(uniforms),
          state: { ...STYLE_INITIAL, uniforms },
          stage: null,
        },
      ];
    }),
  );
  let sharpen = { ...SHARPEN_INITIAL };
  let sharpenStage = null;
  let bloom = { ...BLOOM_INITIAL };
  let borrowed = null;
  let destroyed = false;

  // Every stage at once, in draw order: the styles, then the sharpening.
  const ensureStages = () => {
    if (sharpenStage || destroyed) return;
    for (const [name, style] of styles) {
      style.stage = createStage({
        name: `godsEyeView_${name}`,
        fragmentShader: style.shader.fragmentShader,
        uniforms: { intensity: 0, ...style.state.uniforms },
      });
      style.stage.enabled = false;
      scene.postProcessStages.add(style.stage);
    }
    sharpenStage = createStage({
      name: 'godsEyeView_sharpen',
      fragmentShader: SHARPEN_SHADER,
      uniforms: { amount: sharpen.amount },
    });
    sharpenStage.enabled = false;
    scene.postProcessStages.add(sharpenStage);
  };
  const knownStyle = (name) => {
    const style = styles.get(name);
    if (!style) throw new TypeError(`Unknown visual style: ${name}`);
    return style;
  };
  const showStyle = (name, { stage, state }) => {
    Object.assign(stage.uniforms, state.uniforms);
    stage.uniforms.intensity = state.intensity;
    stage.enabled = state.intensity > STYLE_VISIBLE_INTENSITY;
    // Anime's bands turn the faint Milky Way into blotches, and depth
    // cannot tell the sky from far geometry, so the glow fades with it.
    if (name === 'anime' && scene.skyBox?.milkyWayVisibility !== undefined)
      scene.skyBox.milkyWayVisibility = 1 - state.intensity;
  };
  // The scene's bloom stage, set up for the app's bloom the first time.
  const bloomStage = () => {
    const stage = scene.postProcessStages.bloom;
    if (!borrowed) {
      borrowed = {
        enabled: stage.enabled,
        uniforms: Object.fromEntries(
          BLOOM_UNIFORMS.map((name) => [name, stage.uniforms[name]]),
        ),
      };
      stage.uniforms.glowOnly = false;
    }
    return stage;
  };

  const render = {
    visualStyles: Object.freeze([...styles.keys()]),
    setStyle(name, options) {
      const style = knownStyle(name);
      style.state = mergeStyle(style.state, options, style.names);
      if (destroyed) return;
      ensureStages();
      showStyle(name, style);
      requestRender('style-stage');
    },
    style(name) {
      const { intensity, uniforms } = knownStyle(name).state;
      return { intensity, uniforms: { ...uniforms } };
    },
    setBloom(options) {
      bloom = mergeBloom(bloom, options);
      if (destroyed) return;
      const stage = bloomStage();
      Object.assign(stage.uniforms, bloomUniforms(bloom.strength));
      stage.enabled = bloom.enabled && bloom.strength > BLOOM_DEAD_ZONE;
      requestRender('bloom');
    },
    bloom: () => ({ ...bloom }),
    setSharpen(options) {
      sharpen = mergeSharpen(sharpen, options);
      if (destroyed) return;
      ensureStages();
      sharpenStage.uniforms.amount = sharpen.amount;
      sharpenStage.enabled = sharpen.enabled;
      requestRender('sharpen');
    },
    sharpen: () => ({ ...sharpen }),
  };
  return {
    render,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      const collection = scene.postProcessStages;
      if (!collection || collection.isDestroyed?.()) return;
      if (sharpenStage) {
        for (const { stage } of styles.values()) collection.remove(stage);
        collection.remove(sharpenStage);
      }
      if (borrowed) {
        const stage = collection.bloom;
        Object.assign(stage.uniforms, borrowed.uniforms);
        stage.enabled = borrowed.enabled;
      }
    },
  };
}
