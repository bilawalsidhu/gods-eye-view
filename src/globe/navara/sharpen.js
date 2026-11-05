// The app's Sharpen control on Navara: an unsharp mask as a Navara custom
// effect (public EffectDesc API), with the maths of the Cesium sharpen stage
// (src/ui/visualPresets.js SHARPEN_SHADER): a 3×3 box blur, then
// center + (center − blur) × amount, clamped to [0, 1].
//
// After tone mapping and native-stage fields such as FIRMS, before AA and
// the ordinary display overlay (overlay.js). Native SHARPEN_SHADER filters
// encoded display RGB. Navara buffers stay linear, so use the exact sRGB
// transfer before the box mask and its inverse afterward. A gamma-2.2
// approximation changes the colors of small, high-contrast glows even at the
// same amount.
//
// The sky is left alone: Navara's clouds are dithered (a fine grain at the
// `low` quality the look uses), and the mask turned that grain into visible
// noise. A pixel whose scene depth (the MRT pass's packed depth buffer, as
// the drape reads it) is the far plane is sky or cloud; it keeps its
// colour, and costs one texture read instead of nine.
//
// Its own pass: a convolution reads the pass input, so merged into the tone
// mapping pass it would blur colours not yet tone mapped; Navara 0.2.1 also
// has no public call to merge effects. A disabled pass is skipped: off costs
// nothing.

import { withFrameUpdates, withPassDisposal } from './frameDescriptor.js';
import { Effect as NavaraEffect, EffectDesc } from '@navaramap/three';
import { Effect, EffectAttribute } from 'postprocessing';
import { RGBADepthPacking, Uniform } from 'three';

const SHARPEN_EFFECT_KEY = 'gevSharpen';

const fragmentShader = /* glsl */ `
uniform float amount;
uniform sampler2D tSceneDepth;
uniform bool uSkipSky;
const float SKY_DEPTH = 0.99999;

vec3 encodeGamma(vec3 color) {
  return mix(12.92*color,1.055*pow(max(color,vec3(0.0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),color));
}

vec3 decodeGamma(vec3 color) {
  return mix(color/12.92,pow(max((color+0.055)/1.055,vec3(0.0)),vec3(2.4)),step(vec3(0.04045),color));
}

vec3 encoded8(vec3 color) {
  return floor(clamp(color, 0.0, 1.0) * 255.0 + 0.5) / 255.0;
}

vec3 sampleGamma(vec2 uv) {
  return encoded8(encodeGamma(texture2D(inputBuffer, uv).rgb));
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // The far plane, with a margin: packing to RGBA8 rounds near 1.0.
  if (uSkipSky && unpackRGBAToDepth(texture2D(tSceneDepth, uv)) > SKY_DEPTH) {
    outputColor = inputColor;
    return;
  }
  vec2 texel = texelSize;
  vec3 center = encoded8(encodeGamma(inputColor.rgb));
  vec3 blur = (
    sampleGamma(uv + vec2(-texel.x, -texel.y)) +
    sampleGamma(uv + vec2( 0.0,     -texel.y)) +
    sampleGamma(uv + vec2( texel.x, -texel.y)) +
    sampleGamma(uv + vec2(-texel.x,  0.0))     +
    center +
    sampleGamma(uv + vec2( texel.x,  0.0))     +
    sampleGamma(uv + vec2(-texel.x,  texel.y)) +
    sampleGamma(uv + vec2( 0.0,      texel.y)) +
    sampleGamma(uv + vec2( texel.x,  texel.y))
  ) / 9.0;
  vec3 sharpened = clamp(center + (center - blur) * amount, 0.0, 1.0);
  outputColor = vec4(decodeGamma(sharpened), inputColor.a);
}
`;

class UnsharpMaskEffect extends Effect {
  constructor(amount) {
    super('GevUnsharpMaskEffect', fragmentShader, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([
        ['amount', new Uniform(amount)],
        ['tSceneDepth', new Uniform(null)],
        ['uSkipSky', new Uniform(false)],
      ]),
    });
  }
}

/** config.gevSharpen: { amount } (Cesium's `amount` uniform). */
class SharpenEffectDesc extends withPassDisposal(withFrameUpdates(EffectDesc)) {
  static key = SHARPEN_EFFECT_KEY;
  static insertAfter = ['toneMapping'];
  static insertBefore = ['smaa', 'fxaa', 'gevOverlay', 'final'];

  constructor(view, ctx, config) {
    super(view, ctx, config);
    this.amount = config?.[SHARPEN_EFFECT_KEY]?.amount ?? 1;
  }

  createPass() {
    const camera = this.view.camera.raw;
    if (!camera) throw new Error('Camera not available for the sharpening');
    this.effect = new UnsharpMaskEffect(this.amount);
    return new NavaraEffect(camera, this.effect);
  }

  // Each frame: the scene depth for the sky mask, when Navara packs it as
  // RGBA (0.2.1 does); otherwise the whole frame is sharpened.
  updateFrame() {
    if (!this.effect) return;
    const mrt = this.find('mrt');
    const depth =
      mrt?.depthBufferPacking === RGBADepthPacking ? mrt.depthBuffer : null;
    const uniforms = this.effect.uniforms;
    uniforms.get('tSceneDepth').value = depth ?? null;
    uniforms.get('uSkipSky').value = Boolean(depth);
  }

  onUpdateConfig(updates) {
    super.onUpdateConfig(updates);
    const amount = updates?.[SHARPEN_EFFECT_KEY]?.amount;
    if (amount === undefined) return;
    this.amount = amount;
    if (this.effect) this.effect.uniforms.get('amount').value = amount;
  }
}

/**
 * The sharpening port createNavaraEngine takes: `set` shows a state
 * ({ enabled, amount }, already checked). The pass is added the first time
 * the sharpening is on, so a view that never sharpens has none.
 * @param {object} view an initialised ThreeView
 */
export function createNavaraSharpen(view) {
  view.registerEffect(SHARPEN_EFFECT_KEY, SharpenEffectDesc);
  let handle = null;
  return {
    set({ enabled, amount }) {
      if (!handle) {
        if (!enabled) return;
        handle = view.addEffect({
          [SHARPEN_EFFECT_KEY]: { amount },
          visible: true,
        });
        return;
      }
      handle.update({ [SHARPEN_EFFECT_KEY]: { amount }, visible: enabled });
    },
    destroy() {
      handle?.delete();
      handle = null;
    },
  };
}
