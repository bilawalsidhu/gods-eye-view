// Public depth inputs shared by actual terrain/tiles classifiers.
import { Matrix4, Uniform, RGBADepthPacking } from 'three';

export const GROUND_SURFACE_GLSL = /* glsl */ `
float groundSurfaceType(float depth, float surface, float globeDepth) {
  if (depth >= 1.0) return 0.0;
  // The scene target can be cleared after the globe is saved. Classify
  // the visible depth, not a difference between the two source buffers.
  if (globeDepth < 1.0 && abs(depth - globeDepth) <= 2e-7) return 1.0;
  if (surface < 1.0 && abs(depth - surface) <= 2e-7) return 2.0;
  // A forward mesh has depth in neither ground buffer.
  return 0.0;
}
`;

export function groundSurfaceUniforms({ surface = true } = {}) {
  return [
    ['tAllDepth', new Uniform(null)],
    ...(surface ? [['tSurfaceDepth', new Uniform(null)]] : []),
    ['uInverseProjection', new Uniform(new Matrix4())],
    ['uLogDepthFC', new Uniform(1)],
  ];
}
export function updateGroundSurface(effect, camera, context, mrt) {
  if (mrt?.depthBufferPacking !== RGBADepthPacking)
    throw new Error('Ground classification requires packed scene depth');
  const u = effect.uniforms;
  u.get('tAllDepth').value = mrt.depthBuffer;
  if (u.has('tSurfaceDepth'))
    u.get('tSurfaceDepth').value = context.getRenderTarget().depthTexture;
  if (u.has('tGlobeDepth')) {
    if (mrt.globeDepthBufferPacking !== RGBADepthPacking)
      throw new Error('Ground classification requires packed globe depth');
    u.get('tGlobeDepth').value = mrt.globeDepthBuffer;
  }
  u.get('uInverseProjection').value.copy(camera.projectionMatrixInverse);
  u.get('uLogDepthFC').value = 2 / Math.log2(camera.far + 1);
}
