// Public depth inputs shared by actual terrain/tiles classifiers.
import {
  DataTexture,
  FloatType,
  RGBAFormat,
  NearestFilter,
  Matrix4,
  Uniform,
  RGBADepthPacking,
} from 'three';
export function createGroundTexture(data, width, height) {
  const texture = new DataTexture(data, width, height, RGBAFormat, FloatType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}
export function createGroundStorage(texels) {
  const width = Math.min(1024, Math.max(1, texels));
  const height = Math.max(1, Math.ceil(texels / width));
  const data = new Float32Array(width * height * 4);
  return {
    data,
    width,
    height,
    texture: createGroundTexture(data, width, height),
  };
}
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
