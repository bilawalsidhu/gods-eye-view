import {
  CLASS_MODEL_REAL,
  CLASS_MODEL_URL,
  CLASS_SCALE_3D,
} from '../../data/aircraftClass.js';
import {
  trailAnchorForModel,
  visualCenterForModel,
} from '../../data/modelVisualAnchor.js';
import {
  MODEL_BELLY_OFFSET_NATIVE,
  MODEL_COLOR_BLEND_AMOUNT,
  MODEL_NATIVE_RADIUS_M,
  MODEL_SCALE,
  PLANE_MODEL_URL,
} from './policy.js';

/**
 * The glTF asset, scale and measured geometry a civil aircraft class renders
 * with. Real per-class GLBs are baked to real-world meters (scale 1, measured
 * belly and radius); classes without one share airplane.glb at the class's
 * 3D scale. Shared by the Flights layer and the Local ADS-B layer so both draw
 * the same model for the same class.
 * @param {string} klass Aircraft class from `classifyAircraft`.
 * @returns {{url:string, scale:number, nativeRadiusM:number, bellyM:number,
 *   blendAmount:number, visualCenterNative:object, trailAnchorNative:object}}
 */
export function civilAircraftModelSpec(klass) {
  const real = CLASS_MODEL_REAL[klass];
  if (real) {
    return {
      url: real.url,
      scale: 1,
      nativeRadiusM: real.radiusM,
      bellyM: real.bellyM,
      blendAmount: MODEL_COLOR_BLEND_AMOUNT,
      visualCenterNative: visualCenterForModel(real.url),
      trailAnchorNative: trailAnchorForModel(real.url),
    };
  }
  const scale = MODEL_SCALE * (CLASS_SCALE_3D[klass] || 1);
  const url = CLASS_MODEL_URL[klass] || PLANE_MODEL_URL;
  return {
    url,
    scale,
    nativeRadiusM: MODEL_NATIVE_RADIUS_M,
    bellyM: MODEL_BELLY_OFFSET_NATIVE * scale,
    blendAmount: MODEL_COLOR_BLEND_AMOUNT,
    visualCenterNative: visualCenterForModel(url),
    trailAnchorNative: trailAnchorForModel(url),
  };
}
