/**
 * The water material: a Cesium fabric with three scrolling samples of
 * Cesium's tileable water normal map, a Fresnel blend between the water body
 * and the sky, and the scene light's specular glint through `czm_phong`.
 *
 * Cesium is injected so the pure parts (uniform mapping, the GLSL text) run
 * under Node; the registration helper only touches the material cache.
 * @module layers/water/material
 */

export const WATER_MATERIAL_TYPE = 'GevWaterSurface';

/** Path of Cesium's own tileable water normal map inside its asset bundle. */
export const WATER_NORMAL_MAP_ASSET = 'Assets/Textures/waterNormals.jpg';

/** Resting wave relief at `waveScale` 1. */
const BASE_AMPLITUDE = 0.9;

export const WATER_MATERIAL_SOURCE = `
czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec2 uv = materialInput.st * repeat;
  // Three layers: two short ripple fields moving against each other and one
  // long swell, all sampled from the same tileable normal map.
  vec2 uvA = uv + vec2(time * 0.037, time * 0.021);
  vec2 uvB = uv * 1.9 + vec2(-time * 0.023, time * 0.031);
  vec2 uvC = uv * 0.23 + vec2(time * 0.006, -time * 0.004);
  vec3 nA = texture(normalMap, fract(uvA)).rgb * 2.0 - 1.0;
  vec3 nB = texture(normalMap, fract(uvB)).rgb * 2.0 - 1.0;
  vec3 nC = texture(normalMap, fract(uvC)).rgb * 2.0 - 1.0;
  // Ripples fade with distance so the unmipped texture cannot shimmer far away.
  float viewDistance = length(materialInput.positionToEyeEC);
  float detail = 1.0 - smoothstep(4000.0, 30000.0, viewDistance);
  vec2 ripple = (nA.xy * 0.5 + nB.xy * 0.3 + nC.xy * 0.7) * amplitude * detail;
  vec3 normalTangent = normalize(vec3(ripple, 1.0));
  vec3 normalEC = normalize(materialInput.tangentToEyeMatrix * normalTangent);
  vec3 toEye = normalize(materialInput.positionToEyeEC);
  float facing = clamp(dot(normalEC, toEye), 0.0, 1.0);
  float fresnel = 0.03 + 0.97 * pow(1.0 - facing, 4.0);
  float swell = 0.5 + 0.5 * clamp(nC.z, 0.0, 1.0);
  vec3 body = mix(deepColor.rgb, shallowColor.rgb, swell * 0.5);
  material.diffuse = mix(body, skyColor.rgb, fresnel);
  material.normal = normalEC;
  material.specular = specularIntensity * (0.55 + 0.45 * detail);
  material.shininess = 160.0;
  material.alpha = alpha * (0.9 + 0.1 * fresnel);
  return material;
}
`;

/**
 * Material uniform values for the layer params.
 * @param {{opacity:number, waveScale:number}} params
 * @returns {{alpha:number, amplitude:number}}
 */
export function waterUniformsForParams(params) {
  return {
    alpha: params.opacity,
    amplitude: BASE_AMPLITUDE * params.waveScale,
  };
}

/**
 * URL of the water normal map, served from Cesium's asset bundle
 * (`CESIUM_BASE_URL`), so no copy of it lives in this repository.
 * @param {typeof import('cesium')} cesium
 * @returns {string}
 */
export function waterNormalMapUrl(cesium) {
  return cesium.buildModuleUrl(WATER_NORMAL_MAP_ASSET);
}

/**
 * Register the fabric once in Cesium's material cache. A plain template, not a
 * built instance, so the cache never pins a live texture.
 * @param {typeof import('cesium')} cesium
 */
export function registerWaterMaterial(cesium) {
  const cache = cesium.Material._materialCache;
  if (cache.getMaterial(WATER_MATERIAL_TYPE)) return;
  cache.addMaterial(WATER_MATERIAL_TYPE, {
    fabric: {
      type: WATER_MATERIAL_TYPE,
      uniforms: {
        normalMap: cesium.Material.DefaultImageId,
        deepColor: new cesium.Color(0.043, 0.165, 0.247, 1),
        shallowColor: new cesium.Color(0.118, 0.353, 0.42, 1),
        skyColor: new cesium.Color(0.62, 0.74, 0.84, 1),
        repeat: new cesium.Cartesian2(1, 1),
        time: 0,
        amplitude: BASE_AMPLITUDE,
        alpha: 1,
        specularIntensity: 1.6,
      },
      source: WATER_MATERIAL_SOURCE,
    },
    translucent: true,
  });
}

/**
 * One material instance for a surface rectangle.
 * @param {typeof import('cesium')} cesium
 * @param {{repeat:{s:number,t:number}, params:{opacity:number, waveScale:number}}} options
 * @returns {import('cesium').Material}
 */
export function createWaterMaterial(cesium, { repeat, params }) {
  registerWaterMaterial(cesium);
  return cesium.Material.fromType(WATER_MATERIAL_TYPE, {
    normalMap: waterNormalMapUrl(cesium),
    repeat: new cesium.Cartesian2(repeat.s, repeat.t),
    ...waterUniformsForParams(params),
  });
}
