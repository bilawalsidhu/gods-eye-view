// Shader functions shared by the surface passes and depth tests.
export const DISPLAY_COLOR_GLSL = /* glsl */ `
vec3 toDisplay(vec3 c) {
  return mix(12.92*c,1.055*pow(max(c,vec3(0.0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));
}
vec3 toLinear(vec3 c) {
  return mix(c/12.92,pow(max((c+0.055)/1.055,vec3(0.0)),vec3(2.4)),step(vec3(0.04045),c));
}
`;

export const VIEW_POSITION_GLSL = /* glsl */ `
vec3 viewPosition(vec4 ray, float distance) {
  return ray.xyz * (distance / -ray.z);
}
float viewDistance(float depth, float logDepthFC) {
  return exp2(2.0 * depth / logDepthFC) - 1.0;
}
`;

export const PACKED_DEPTH_GLSL = /* glsl */ `
bool packedDepthOccluded(float mine, float scene, float bias) {
  return mine > scene + bias;
}
`;
