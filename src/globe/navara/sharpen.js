// The app's Sharpen control on Navara: an unsharp mask as a Navara custom
// effect (public EffectDesc API), with the maths of the Cesium sharpen stage
// (src/ui/visualPresets.js SHARPEN_SHADER): a 3×3 box blur, then
// center + (center − blur) × amount, clamped to [0, 1].
//
// Where it sits: right after tone mapping (after gev's overlay of sprites,
// points and lines, which Cesium's sharpen stage also sharpens) and before
// SMAA or FXAA (before `final` in a look without them), as Cesium runs its
// custom stages after
// its tone mapping and before FXAA. After tone mapping the colours are the
// display's [0, 1] range, so highlights do not blow up; anti-aliasing after
// it smooths the stair steps sharpening brings out. Cesium sharpens
// gamma-encoded colours (its tone mapping ends with czm_inverseGamma) while
// Navara's buffers stay linear until the final copy, so the mask encodes
// with Cesium's gamma 2.2 and decodes after: the same amount sharpens the
// same.
//
// The sky is left alone: Navara's clouds are dithered (a fine grain at the
// `low` quality the look uses), and the mask turned that grain into visible
// noise. A pixel whose scene depth (the MRT pass's packed depth buffer, as
// the S1 drape reads it) is the far plane is sky or cloud; it keeps its
// colour, and costs one texture read instead of nine.
//
// Its own pass: a convolution reads the pass input, so merged into the tone
// mapping pass it would blur colours not yet tone mapped; Navara 0.2.1 also
// has no public call to merge effects. A disabled pass is skipped: off costs
// nothing.

import { Effect as NavaraEffect, EffectDesc } from '@navaramap/three';
import { Effect, EffectAttribute } from 'postprocessing';
import { RGBADepthPacking, Uniform } from 'three';

export const SHARPEN_EFFECT_KEY = 'gevSharpen';

const fragmentShader = /* glsl */ `
uniform float amount;
uniform sampler2D tSceneDepth;
uniform bool uSkipSky;
const float SKY_DEPTH = 0.99999;

vec3 encodeGamma(vec3 color) {
  return pow(max(color, vec3(0.0)), vec3(1.0 / 2.2));
}

vec3 sampleGamma(vec2 uv) {
  return encodeGamma(texture2D(inputBuffer, uv).rgb);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // The far plane, with a margin: packing to RGBA8 rounds near 1.0.
  if (uSkipSky && unpackRGBAToDepth(texture2D(tSceneDepth, uv)) > SKY_DEPTH) {
    outputColor = inputColor;
    return;
  }
  vec2 texel = texelSize;
  vec3 center = encodeGamma(inputColor.rgb);
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
  outputColor = vec4(pow(sharpened, vec3(2.2)), inputColor.a);
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
export class SharpenEffectDesc extends EffectDesc {
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
  update() {
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
