import { PACKED_DEPTH_GLSL } from './shaderChunks.js';
// The depth test of gev's screen overlays on Navara (sprites, points and
// lines drawn after tone mapping, overlay.js): there is no depth buffer in
// the post-processing chain, so each fragment compares its own logarithmic
// depth with the scene's, read from Navara's MRT pass (depth packed to RGBA,
// as the sharpening reads it). Modes: 0 always drawn; 1 hidden where the
// scene is nearer (normal); 2 drawn only where the scene is nearer (a
// line's depth-fail copy). `vGevDepthFree` (set by the vertex shader) lets
// an instance skip the test (disableWithinM). No three imports: GLSL only.

export const OVERLAY_DEPTH_MODES = Object.freeze({
  always: 0,
  normal: 1,
  fail: 2,
});

/** Fragment declarations: uniforms, the varying and gevOverlayHidden(). */
export const OVERLAY_DEPTH_FRAGMENT = /* glsl */ `
${PACKED_DEPTH_GLSL}
uniform sampler2D tGevSceneDepth;
uniform vec2 uGevResolution;
uniform float uGevDepthMode;
uniform float uGevDisplayBlend;
vec4 gevOverlayDisplayColor(vec4 color) {
  return uGevDisplayBlend>0.5 ? sRGBTransferOETF(color) : color;
}
varying float vGevDepthFree;
bool gevOverlayHidden() {
  if (uGevDepthMode < 0.5 || vGevDepthFree > 0.5 || uGevResolution.x < 1.0)
    return false;
  // three's unpackRGBAToDepth (RGBADepthPacking).
  float scene = dot(
    texture2D(tGevSceneDepth, gl_FragCoord.xy / uGevResolution),
    vec4(255.0 / 256.0, 255.0 / 65536.0, 255.0 / 16777216.0, 1.0 / 16777216.0)
  );
  #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  float mine = log2(vFragDepth) * logDepthBufFC * 0.5;
  #else
  float mine = gl_FragCoord.z;
  #endif
  bool occluded = packedDepthOccluded(mine, scene, 2e-6);
  return uGevDepthMode < 1.5 ? occluded : !occluded;
}
`;

/** Vertex declaration of the per-vertex escape from the depth test. */
export const OVERLAY_DEPTH_VERTEX = /* glsl */ `
varying float vGevDepthFree;
`;
