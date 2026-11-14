import * as Cesium from 'cesium';

/**
 * @module trackedHologram
 * @description Hologram look for the selected (tracked) aircraft model, shared
 * by the civil and military flight layers. The shader MUST ride the
 * `Cesium.Model.fromGltfAsync` options: assigning `customShader` to an
 * already-ready model is a silent no-op (see `_IR_UNLIT_SHADER`). The tracked
 * model is released on deselect and reloaded on select, so a shader baked at
 * creation is on exactly while the aircraft is selected.
 */

/** Projected diameter below which the hologram starts turning solid. */
export const HOLOGRAM_SOLID_BELOW_PX = 160;
/** Pixel span over which the blend runs from fully holographic to solid. */
export const HOLOGRAM_SOLID_RAMP_PX = 110;
/** u_time wraps here; 0.35 band speed times this is a whole number of bands, so the wrap is seamless. */
const TIME_WRAP_S = 1000;

/**
 * Hologram-to-solid blend for a model of the given projected size, so a plane
 * that has shrunk to a few pixels stays readable instead of dissolving.
 * @param {number} pixelDiameter Projected model diameter in CSS pixels.
 * @returns {number} 0 fully holographic, 1 near-solid.
 */
export function hologramSolidBlend(pixelDiameter) {
  const t = (HOLOGRAM_SOLID_BELOW_PX - pixelDiameter) / HOLOGRAM_SOLID_RAMP_PX;
  return Math.min(1, Math.max(0, t));
}

function createHologramShader(color) {
  return new Cesium.CustomShader({
    uniforms: {
      u_time: { type: Cesium.UniformType.FLOAT, value: 0 },
      u_far: { type: Cesium.UniformType.FLOAT, value: 0 },
      u_col: {
        type: Cesium.UniformType.VEC3,
        value: new Cesium.Cartesian3(color.red, color.green, color.blue),
      },
    },
    lightingModel: Cesium.LightingModel.UNLIT,
    translucencyMode: Cesium.CustomShaderTranslucencyMode.TRANSLUCENT,
    fragmentShaderText: `
    void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
      vec3 n = normalize(fsInput.attributes.normalEC);
      vec3 v = normalize(-fsInput.attributes.positionEC);
      float fres = pow(1.0 - abs(dot(n, v)), 2.2);
      float fine = step(0.5, fract(gl_FragCoord.y * 0.33));
      float h = fsInput.attributes.positionMC.y;
      float band = smoothstep(0.0, 0.08, fract(h * 0.04 - u_time * 0.35)) * (1.0 - smoothstep(0.08, 0.16, fract(h * 0.04 - u_time * 0.35)));
      float flick = 0.88 + 0.12 * step(0.93, fract(sin(floor(u_time * 18.0)) * 43758.5));
      vec3 c = u_col * (0.35 + 1.6 * fres + 1.2 * band) + vec3(0.6) * fres * fres;
      material.diffuse = c * flick * (0.75 + 0.25 * fine);
      material.alpha = clamp(0.12 + 0.85 * fres + 0.5 * band, 0.0, 1.0) * flick * (0.7 + 0.3 * fine);
      material.alpha = mix(material.alpha, 0.95, u_far);
      material.diffuse = mix(material.diffuse, u_col * 1.3, u_far);
    }`,
  });
}

/**
 * One hologram per layer. A layer passes the faction colors it can track and
 * only those shaders are built.
 * @param {{civil?: Cesium.Color, military?: Cesium.Color}} colors
 * @returns {{modelOptions: (military: boolean) => object,
 *   tick: (military: boolean, pixelDiameter: number, nowMs: number) => void}}
 */
export function createTrackedHologram(colors) {
  const shaders = {};
  const outline = {};
  for (const [faction, color] of Object.entries(colors)) {
    shaders[faction] = createHologramShader(color);
    outline[faction] = color.withAlpha(0.9);
  }
  const factionOf = (military) => (military ? 'military' : 'civil');

  return {
    /**
     * Creation options to spread into `Cesium.Model.fromGltfAsync`.
     * Color stays white and the blend at zero so the shader owns the hue.
     */
    modelOptions(military) {
      const faction = factionOf(military);
      return {
        color: Cesium.Color.WHITE,
        colorBlendMode: Cesium.ColorBlendMode.MIX,
        colorBlendAmount: 0,
        customShader: shaders[faction],
        backFaceCulling: false,
        silhouetteColor: outline[faction],
        silhouetteSize: 1.5,
      };
    },
    /** Advance the animation; call once per frame while the model is shown. */
    tick(military, pixelDiameter, nowMs) {
      const shader = shaders[factionOf(military)];
      shader.setUniform('u_time', (nowMs / 1000) % TIME_WRAP_S);
      shader.setUniform('u_far', hologramSolidBlend(pixelDiameter));
    },
  };
}
