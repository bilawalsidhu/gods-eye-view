// The app's visual styles on Navara (CRT, NVG, FLIR, Anime, Noir): each
// style's own Cesium post-process shader (src/styles/*.js) drawn as a
// full-screen pass of the Navara pipeline, through the public EffectDesc API.
//
// The shaders use only Cesium's post-stage names (colorTexture,
// colorTextureDimensions, v_textureCoordinates, out_FragColor) plus their
// own uniforms, no czm_ built-ins and no depth. A GLSL prelude maps those
// names onto a three RawShaderMaterial and wraps the style's main().
//
// Colour: Cesium's styles filter encoded display RGB. Navara buffers stay
// linear, so, as the sharpening does (sharpen.js), every read of the input
// goes through the exact sRGB transfer and the style's result through its
// inverse (a gamma-2.2 approximation shifts dark FLIR bands visibly).
//
// One pass holds every style. A crossfade draws the outgoing and incoming
// styles in Cesium's stage order, one after the other (a scratch target
// between them); a frame with no style showing skips the pass (disabled).
// The pass runs after everything the scene draws (tone mapping, the layers'
// ground fields, the sharpening, anti-aliasing and the screen overlays):
// Cesium's stages filter its whole frame, billboards included. Bloom, when
// on, runs just before it (bloom.js), as Cesium's bloom precedes its stages.

import { Pass } from 'postprocessing';
import {
  GLSL3,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  RawShaderMaterial,
  SRGBColorSpace,
  Vector2,
  WebGLRenderTarget,
} from 'three';

export const STYLES_EFFECT_KEY = 'gevStyles';
/** Intensity under which a style draws nothing (as Cesium disables a stage). */
const STYLE_VISIBLE_INTENSITY = 0.001;

const VERTEX_SHADER = /* glsl */ `precision highp float;
in vec3 position;
in vec2 uv;
out vec2 v_textureCoordinates;
void main() {
  v_textureCoordinates = uv;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const PRELUDE = /* glsl */ `precision highp float;
precision highp int;
out vec4 gevFragColor;
// What the style writes, in Cesium's name; resolved in main() below.
vec4 out_FragColor;
vec3 gevEncodeSrgb(vec3 color) {
  return mix(12.92*color,1.055*pow(max(color,vec3(0.0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),color));
}
vec3 gevDecodeSrgb(vec3 color) {
  return mix(color/12.92,pow(max((color+0.055)/1.055,vec3(0.0)),vec3(2.4)),step(vec3(0.04045),color));
}
// Every texture read the style makes is of colorTexture: hand it display RGB.
vec4 gevStyleTexture(sampler2D image, vec2 uv) {
  vec4 color = texture(image, uv);
  return vec4(gevEncodeSrgb(color.rgb), color.a);
}
`;

const EPILOGUE = /* glsl */ `
void main() {
  out_FragColor = vec4(0.0);
  gevStyleMain();
  vec3 display = clamp(out_FragColor.rgb, 0.0, 1.0);
#if GEV_DISPLAY_OUTPUT
  gevFragColor = vec4(display, out_FragColor.a);
#else
  gevFragColor = vec4(gevDecodeSrgb(display), out_FragColor.a);
#endif
}
`;

const MAIN = /void\s+main\s*\(\s*\)/g;
const TEXTURE_CALL = /\btexture\s*\(/g;

/**
 * The fragment shader a Cesium style shader runs as on Navara (GLSL ES 3):
 * its texture() reads go through the sRGB encode, its main() becomes
 * gevStyleMain(), and the prelude's main() decodes what it wrote.
 */
export function navaraStyleFragmentShader(source) {
  if (typeof source !== 'string' || (source.match(MAIN) ?? []).length !== 1)
    throw new TypeError('A style shader needs one main()');
  if (/\bczm_/.test(source))
    throw new TypeError('A Navara style shader cannot use Cesium built-ins');
  const body = source
    .replace(MAIN, 'void gevStyleMain()')
    .replace(TEXTURE_CALL, 'gevStyleTexture(');
  return `${PRELUDE}\n${body}\n${EPILOGUE}`;
}

/** Uniform names a style takes besides intensity: its own, and `time` when it animates. */
export function styleUniformNames(shader) {
  const names = Object.keys(shader.uniforms ?? {});
  if (/uniform\s+float\s+time\s*;/.test(shader.fragmentShader))
    names.push('time');
  return names;
}

/** A style's uniforms at their defaults (time 0). */
export function styleUniformDefaults(shader) {
  const values = {};
  for (const name of styleUniformNames(shader))
    values[name] = name === 'time' ? 0 : shader.uniforms[name].default;
  return values;
}

/**
 * The styles drawn this frame, in draw order (the order of `shaders`, which
 * is Cesium's stage order): [name, state] for each visible one.
 */
export function visibleStyles(order, states) {
  const drawn = [];
  for (const name of order) {
    const state = states.get(name);
    if (state && state.intensity > STYLE_VISIBLE_INTENSITY)
      drawn.push([name, state]);
  }
  return drawn;
}

function styleMaterial(shader) {
  const uniforms = {
    colorTexture: { value: null },
    colorTextureDimensions: { value: new Vector2(1, 1) },
    intensity: { value: 0 },
  };
  for (const [name, value] of Object.entries(styleUniformDefaults(shader)))
    uniforms[name] = { value };
  return new RawShaderMaterial({
    name: `GevStyle_${shader.name}`,
    glslVersion: GLSL3,
    vertexShader: VERTEX_SHADER,
    fragmentShader: navaraStyleFragmentShader(shader.fragmentShader),
    uniforms,
    defines: { GEV_DISPLAY_OUTPUT: 0 },
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

/** Draws the visible styles from the input buffer into the output buffer. */
export class GevStylesPass extends Pass {
  constructor(controller) {
    super('GevStylesPass');
    this.controller = controller;
    this.materials = new Map();
    this.scratch = null;
    this.needsSwap = true;
  }

  material(name) {
    let material = this.materials.get(name);
    if (!material) {
      material = styleMaterial(this.controller.shaders[name]);
      this.materials.set(name, material);
    }
    return material;
  }

  scratchLike(buffer) {
    if (!this.scratch) {
      this.scratch = new WebGLRenderTarget(buffer.width, buffer.height, {
        type: buffer.texture?.type ?? HalfFloatType,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
      this.scratch.texture.colorSpace = NoColorSpace;
    }
    if (
      this.scratch.width !== buffer.width ||
      this.scratch.height !== buffer.height
    )
      this.scratch.setSize(buffer.width, buffer.height);
    return this.scratch;
  }

  render(renderer, inputBuffer, outputBuffer) {
    const drawn = this.controller.visible();
    this.needsSwap = drawn.length > 0;
    if (!drawn.length) return;
    let source = inputBuffer;
    for (let index = 0; index < drawn.length; index++) {
      const [name, state] = drawn[index];
      const last = index === drawn.length - 1;
      // Ping-pong through one scratch target; the input is free once read.
      const target = last
        ? this.renderToScreen
          ? null
          : outputBuffer
        : source === inputBuffer
          ? this.scratchLike(inputBuffer)
          : inputBuffer;
      const material = this.material(name);
      const uniforms = material.uniforms;
      uniforms.colorTexture.value = source.texture;
      uniforms.colorTextureDimensions.value.set(source.width, source.height);
      uniforms.intensity.value = state.intensity;
      for (const [key, value] of Object.entries(state.uniforms))
        if (uniforms[key]) uniforms[key].value = value;
      // To the screen the final copy would have encoded: keep display RGB.
      const display =
        target === null && renderer.outputColorSpace === SRGBColorSpace ? 1 : 0;
      if (material.defines.GEV_DISPLAY_OUTPUT !== display) {
        material.defines.GEV_DISPLAY_OUTPUT = display;
        material.needsUpdate = true;
      }
      this.fullscreenMaterial = material;
      renderer.setRenderTarget(target);
      renderer.render(this.scene, this.camera);
      source = target;
    }
  }

  dispose() {
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this.scratch?.dispose();
    this.scratch = null;
    super.dispose?.();
  }
}

/**
 * The styles port createNavaraEngine takes: `names` (the styles it draws),
 * `set(name, state)` shows a style's state ({ intensity, uniforms }, already
 * checked). The pass is added the first time a style shows, so a view that
 * never filters has none; with every style at 0 it is hidden (skipped).
 * `onStarsDimmed(amount)` hears Anime's intensity: its bands turn the faint
 * starfield into blotches, so the stars fade with the style (Cesium fades
 * its Milky Way the same way).
 * The caller registers the effect (stylePasses.js createNavaraStyles).
 * @param {object} view an initialised ThreeView
 * @param {{ shaders: Record<string, { name: string, uniforms?: object, fragmentShader: string }>, onStarsDimmed?: (amount: number) => void }} options
 */
export function createStylesPort(view, { shaders, onStarsDimmed = null }) {
  const order = Object.keys(shaders);
  for (const name of order)
    navaraStyleFragmentShader(shaders[name].fragmentShader);
  const states = new Map();
  const controller = {
    shaders,
    visible: () => visibleStyles(order, states),
  };
  let handle = null;
  let shown = false;
  return {
    names: Object.freeze([...order]),
    uniformNames: (name) => styleUniformNames(shaders[name]),
    defaults: (name) => styleUniformDefaults(shaders[name]),
    set(name, state) {
      states.set(name, {
        intensity: state.intensity,
        uniforms: { ...state.uniforms },
      });
      if (name === 'anime') onStarsDimmed?.(state.intensity);
      const next = controller.visible().length > 0;
      if (!handle) {
        if (!next) return;
        handle = view.addEffect({
          [STYLES_EFFECT_KEY]: { controller },
          visible: true,
        });
        shown = true;
        return;
      }
      if (next !== shown) {
        shown = next;
        handle.update({ visible: next });
      }
    },
    /** Navara only (QA): whether the pass is in the pipeline and shown. */
    passShown: () => Boolean(handle) && shown,
    controller,
    destroy() {
      handle?.delete();
      handle = null;
      shown = false;
      if (states.get('anime')?.intensity) onStarsDimmed?.(0);
      states.clear();
    },
  };
}
