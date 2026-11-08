// Public depth inputs shared by actual terrain/tiles classifiers.
import { Matrix4, Uniform, RGBADepthPacking } from 'three';
export function groundSurfaceUniforms() {
  return [
    ['tAllDepth', new Uniform(null)],
    ['tSurfaceDepth', new Uniform(null)],
    ['uInverseProjection', new Uniform(new Matrix4())],
    ['uLogDepthFC', new Uniform(1)],
  ];
}
export function updateGroundSurface(effect, camera, context, mrt) {
  if (mrt?.depthBufferPacking !== RGBADepthPacking)
    throw new Error('Ground classification requires packed scene depth');
  const u = effect.uniforms;
  u.get('tAllDepth').value = mrt.depthBuffer;
  u.get('tSurfaceDepth').value = context.getRenderTarget().depthTexture;
  u.get('uInverseProjection').value.copy(camera.projectionMatrixInverse);
  u.get('uLogDepthFC').value = 2 / Math.log2(camera.far + 1);
}
