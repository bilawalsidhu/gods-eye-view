import {
  ISS_COMPANION_COARSE_M,
  ISS_COMPANION_RADIUS_M,
  ISS_COMPANION_SCAN_MS,
  ISS_MODEL_LOCAL_AXES,
  ISS_MODEL_MAX_DISTANCE_M,
  ISS_MODEL_MIN_PX,
  ISS_ORBIT_HIDE_M,
  TIANGONG_CARD_CLEAR_M,
  TIANGONG_MODEL_URL,
  TIANGONG_NORAD,
} from './policy.js';
import { createStationModel } from './stationModel.js';
import { createTiangongArticulation } from './tiangongArticulation.js';
import { tiangongCockpitMount } from './tiangongMounts.js';

/**
 * Whether a catalog entry at Tiangong is one of the station's own modules
 * (CelesTrak lists them as "CSS (TIANHE)", "CSS (WENTIAN)", "CSS (MENGTIAN)")
 * rather than a visiting Shenzhou or Tianzhou. A missing entry counts as a
 * module.
 * @param {number} noradId
 * @param {{name?: string}|undefined} entry
 * @returns {boolean}
 */
export function tiangongIsModule(noradId, entry) {
  return (
    noradId === TIANGONG_NORAD || /^CSS\s*\(/i.test(entry?.name ?? 'CSS (')
  );
}

/**
 * Tiangong as the station model factory describes it. The file is in meters
 * (scale 1) and in the ISS file's frame, so it takes the ISS's local-axes
 * mapping: the station is assumed to fly like the ISS, Tianhe along the
 * velocity with the node (forward port) forward, the labs across the orbit,
 * nadir to the Earth. Its joints are computed only; there is no telemetry.
 * The Cockpit rides it from views on the model (`tiangongMounts.js`), and
 * its ring follows the layer's orbit toggle like any tracked satellite's.
 * @returns {import('./stationModel.js').StationModelSpec}
 */
export function tiangongModelSpec() {
  return {
    key: 'tiangong',
    label: 'Tiangong', // i18n-ignore: the station's name, for log lines
    norad: TIANGONG_NORAD,
    modelUrl: TIANGONG_MODEL_URL,
    scale: 1,
    minPx: ISS_MODEL_MIN_PX,
    maxDistanceM: ISS_MODEL_MAX_DISTANCE_M,
    orbitHideM: ISS_ORBIT_HIDE_M,
    cardClearM: TIANGONG_CARD_CLEAR_M,
    companionRadiusM: ISS_COMPANION_RADIUS_M,
    companionCoarseM: ISS_COMPANION_COARSE_M,
    companionScanMs: ISS_COMPANION_SCAN_MS,
    localAxes: ISS_MODEL_LOCAL_AXES,
    isModule: tiangongIsModule,
    createArticulation: createTiangongArticulation,
    createTelemetry: null,
    cockpitMount: tiangongCockpitMount,
    // The Cockpit rides the station from a mount on the model, so the model
    // stays while it does.
    hideInCockpit: false,
    syncOrbit: null,
  };
}

/**
 * Tiangong as a 3D model when the camera is close (stationModel.js).
 * @param {{state: object, parts: object, resolveAsset?: (url: string) => string}} context
 */
export function createTiangongModel(context) {
  return createStationModel(tiangongModelSpec(), context);
}
