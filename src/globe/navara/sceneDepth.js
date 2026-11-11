import { PACKED_DEPTH_GLSL } from './shaderChunks.js';
// Navara draws its transparent scene after the post effects, into a target
// that does not hold the scene's depth, so a transparent mesh behind a wall,
// terrain or the Earth painted through them. Moving such a mesh into the
// opaque scene (as CCTV did) would also run it through the effects and change
// its look. This test keeps the mesh in the transparent pass and drops every
// fragment that lies behind the depth Navara packs after its opaque pass
// (globe, 3D tiles, MRT and opaque meshes): an unhidden fragment is drawn
// exactly as before.
import { RGBADepthPacking, Vector2 } from 'three';

const KEY = 'gevSceneDepth';

// Log-depth units (about 0.01 % of the distance): a stem's foot or a ground
// overlay on the very surface it stands on is not cut by its own ground.
export const SCENE_DEPTH_BIAS = 5e-6;

const PARS = /* glsl */ `
${PACKED_DEPTH_GLSL}
uniform sampler2D tGevSceneDepth;
uniform vec2 uGevTargetSize;
uniform float uGevSceneDepthOn;
`;

const TEST = /* glsl */ `
if (uGevSceneDepthOn > 0.5) {
  vec2 gevDepthSize = vec2(textureSize(tGevSceneDepth, 0));
  ivec2 gevTexel = ivec2(gl_FragCoord.xy * gevDepthSize / uGevTargetSize);
  float gevScene = unpackRGBAToDepth(texelFetch(tGevSceneDepth, gevTexel, 0));
  #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
    float gevDepth = vIsPerspective == 0.0
      ? gl_FragCoord.z
      : log2(vFragDepth) * logDepthBufFC * 0.5;
  #else
    float gevDepth = gl_FragCoord.z;
  #endif
  if (gevScene < 1.0 && packedDepthOccluded(gevDepth, gevScene, ${SCENE_DEPTH_BIAS.toExponential()}))
    discard;
}
`;

/** Patch a fragment shader source with the scene-depth test. */
export function withSceneDepthTest(fragmentShader) {
  const anchor = '#include <logdepthbuf_fragment>';
  if (!fragmentShader.includes(anchor))
    throw new Error('A scene-depth test needs logdepthbuf_fragment');
  const pars = fragmentShader.includes('#include <packing>')
    ? PARS
    : `#include <packing>\n${PARS}`;
  return fragmentShader
    .replace('void main() {', `${pars}\nvoid main() {`)
    .replace(anchor, `${anchor}\n${TEST}`);
}

/**
 * One scene-depth test for a set of transparent meshes: `material()` patches
 * each material, `object()` binds the depth before each draw, and the mesh
 * descriptor calls `attach(ctx)` with its view context once created.
 */
export function createSceneDepthTest() {
  const uniforms = {
    tGevSceneDepth: { value: null },
    uGevTargetSize: { value: new Vector2(1, 1) },
    uGevSceneDepthOn: { value: 0 },
  };
  let ctx = null;
  const bind = (renderer) => {
    const mrt = ctx?.findEffect?.('mrt');
    const texture =
      mrt?.depthBufferPacking === RGBADepthPacking ? mrt.depthBuffer : null;
    uniforms.tGevSceneDepth.value = texture ?? null;
    uniforms.uGevSceneDepthOn.value = texture ? 1 : 0;
    const target = renderer.getRenderTarget?.();
    if (target) uniforms.uGevTargetSize.value.set(target.width, target.height);
    else renderer.getDrawingBufferSize?.(uniforms.uGevTargetSize.value);
  };
  const test = {
    uniforms,
    material(material) {
      const previousCompile = material.onBeforeCompile;
      const previousKey = material.customProgramCacheKey;
      material.onBeforeCompile = (shader, renderer) => {
        Object.assign(shader.uniforms, uniforms);
        shader.fragmentShader = withSceneDepthTest(shader.fragmentShader);
        previousCompile?.call(material, shader, renderer);
      };
      material.customProgramCacheKey = () =>
        `${previousKey ? previousKey.call(material) : ''}_gevSceneDepth`;
      material.needsUpdate = true;
      return material;
    },
    object(object) {
      const previous = object.onBeforeRender;
      object.onBeforeRender = function onBeforeRender(renderer, ...rest) {
        bind(renderer);
        return previous?.call(this, renderer, ...rest);
      };
      object.userData[KEY] = test;
      return object;
    },
    attach(next) {
      ctx = next ?? null;
    },
  };
  return test;
}

/** Give an object's scene-depth test (if any) its descriptor's context. */
export function attachSceneDepth(object, ctx) {
  object?.userData?.[KEY]?.attach(ctx);
}
