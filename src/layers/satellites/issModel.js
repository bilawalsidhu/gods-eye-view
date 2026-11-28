import { createIssArticulation } from './issArticulation.js';
import {
  ISS_MOUNTS,
  ISS_NAUKA_NORAD,
  ISS_POISK_NORAD,
  issMountView,
  issMountViews,
  issMountWorld,
} from './issMounts.js';
import { createIssTelemetryFeed } from './issTelemetry.js';
import {
  ISS_COMPANION_COARSE_M,
  ISS_COMPANION_RADIUS_M,
  ISS_COMPANION_SCAN_MS,
  ISS_CARD_CLEAR_M,
  ISS_MODEL_LOCAL_AXES,
  ISS_MODEL_MAX_DISTANCE_M,
  ISS_MODEL_MIN_PX,
  ISS_MODEL_NATIVE_SPAN,
  ISS_MODEL_URL,
  ISS_NORAD,
  ISS_ORBIT_HIDE_M,
  ISS_SPAN_M,
} from './policy.js';
import {
  createStationModel,
  stationFlightAxes,
  stationModelShouldShow,
  temeToEcefAxes,
} from './stationModel.js';

/** The model's scale for the real 109 m truss. */
export const ISS_MODEL_SCALE = ISS_SPAN_M / ISS_MODEL_NATIVE_SPAN;

// The station-independent rules live in stationModel.js; these names are
// kept for the code and tests written against the ISS-only model.
export { temeToEcefAxes };
export const issFlightAxes = stationFlightAxes;

/**
 * Whether the ISS model may be drawn (stationModelShouldShow with the ISS's
 * `hasIss` wording).
 * @param {{enabled: boolean, showPoints: boolean, hasIss: boolean,
 *   classVisible: boolean, tracked: boolean, cockpitHidden: boolean}} input
 * @returns {boolean}
 */
export function issModelShouldShow({ hasIss, ...rest }) {
  return stationModelShouldShow({ hasStation: hasIss, ...rest });
}

/**
 * Whether a catalog entry at the ISS is one of the station's own modules
 * (Zarya, Nauka, Poisk, or any other the catalog lists as "ISS (…)") rather
 * than a visiting vehicle. A missing entry counts as a module.
 * @param {number} noradId
 * @param {{name?: string}|undefined} entry
 * @returns {boolean}
 */
export function issIsModule(noradId, entry) {
  return (
    noradId === ISS_NORAD ||
    noradId === ISS_NAUKA_NORAD ||
    noradId === ISS_POISK_NORAD ||
    /^ISS\s*\(/i.test(entry?.name ?? 'ISS (')
  );
}

/**
 * The ISS as the station model factory describes it: NASA's model at the
 * real 109 m span, its joints on the Sun or NASA's telemetry, the Cockpit's
 * views from mounts on the model (so the model stays drawn in the Cockpit),
 * and its orbit ring, drawn only while the ISS is tracked.
 * @param {{parts: object}} context
 * @returns {import('./stationModel.js').StationModelSpec}
 */
export function issModelSpec({ parts }) {
  return {
    key: 'iss',
    label: 'ISS', // i18n-ignore: the station's name, for log lines
    norad: ISS_NORAD,
    modelUrl: ISS_MODEL_URL,
    scale: ISS_MODEL_SCALE,
    minPx: ISS_MODEL_MIN_PX,
    maxDistanceM: ISS_MODEL_MAX_DISTANCE_M,
    orbitHideM: ISS_ORBIT_HIDE_M,
    cardClearM: ISS_CARD_CLEAR_M,
    companionRadiusM: ISS_COMPANION_RADIUS_M,
    companionCoarseM: ISS_COMPANION_COARSE_M,
    companionScanMs: ISS_COMPANION_SCAN_MS,
    localAxes: ISS_MODEL_LOCAL_AXES,
    isModule: issIsModule,
    createArticulation: createIssArticulation,
    createTelemetry: createIssTelemetryFeed,
    /**
     * One of the views on the model (issMounts.js), in the world.
     * `noradId` on the result is the catalog entry the view belongs to.
     */
    cockpitMount: ({ key, centre, axes, name, entry, dockedVehicle }) => {
      const views = issMountViews({
        naukaName: name(ISS_NAUKA_NORAD),
        zaryaName: name(ISS_NORAD),
        poiskName: name(ISS_POISK_NORAD),
        dockedName: name(dockedVehicle),
        naukaNorad: entry(ISS_NAUKA_NORAD),
        zaryaNorad: entry(ISS_NORAD),
        poiskNorad: entry(ISS_POISK_NORAD),
        dockedNorad: entry(dockedVehicle),
      });
      const view = issMountView(views, key);
      return {
        ...issMountWorld(ISS_MOUNTS[view.key], centre, axes),
        key: view.key,
        label: view.label,
        noradId: view.noradId,
        card: view.card,
        views,
      };
    },
    // The Cockpit rides the station from a mount on the model, so the model
    // stays while it does.
    hideInCockpit: false,
    syncOrbit: null,
  };
}

/**
 * The ISS as a 3D model when the camera is close (stationModel.js), with the
 * part's methods also under their former ISS-only names.
 * @param {{state: object, parts: object, resolveAsset?: (url: string) => string}} context
 */
export function createIssModel(context) {
  const model = createStationModel(issModelSpec(context), context);
  return {
    ...model,
    _updateIssModel: model._updateStationModel,
    _destroyIssModel: model._destroyStationModel,
    _issVisualPosition: model._visualPosition,
    _issCardClearPx: model._cardClearPx,
    _issStandsInFor: model._standsInFor,
    _issCockpitMount: model._cockpitMount,
    _issTelemetryStatus: model._telemetryStatus,
    _issArticulation: model._articulation,
  };
}
