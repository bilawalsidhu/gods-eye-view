import { STATIONS, stationTrackedOn } from './policy.js';

/**
 * Which station a catalog entry belongs to. The layer knows more than one
 * station (STATIONS in policy.js: the ISS, Tiangong), each drawn as a model
 * part (stationModel.js) at its own catalog entry and standing in for the
 * entries docked to it; the parts that key behaviour to "the station" (card
 * anchor and clearance, detection marks, the LIVE and STATION sections, the
 * Cockpit's mounts) ask here instead of naming the ISS. The model parts are
 * read from `parts.stationModels` each time, so a layer built without them
 * (tests, a part replaced) still answers.
 */

/**
 * The model whose station `noradId` is drawn as: the station's own entry,
 * or a docked object whose dot the model stands in for right now.
 * @param {Array<{norad: number, _standsInFor?: (noradId: number) => boolean}>} models
 * @param {number|null|undefined} noradId
 * @returns {object|null}
 */
export function stationModelFor(models, noradId) {
  if (noradId === null || noradId === undefined) return null;
  for (const model of models)
    if (model.norad === noradId || model._standsInFor?.(noradId)) return model;
  return null;
}

/**
 * The station that is selected: the tracked satellite is the station
 * itself, or an object docked to it, judged by the dots sharing a position
 * (`dockedCompanions`), by both orbits compared when tracking began
 * (`trackedDockedToStation`, the station's NORAD or null), or by the
 * station's model standing in for its dot.
 * @param {ReadonlyArray<{key: string, norad: number}>} stations
 * @param {Array<{norad: number, _standsInFor?: (noradId: number) => boolean}>} models
 * @param {{trackedNorad: number|null, dockedCompanions?: {has(id: number): boolean}|null,
 *   trackedDockedToStation?: number|null}} selection
 * @returns {{key: string, norad: number, model: object|null}|null} The
 *   station and its model part (null when none is built).
 */
export function trackedStationOf(
  stations,
  models,
  { trackedNorad, dockedCompanions, trackedDockedToStation },
) {
  if (trackedNorad === null || trackedNorad === undefined) return null;
  for (const station of stations) {
    const model = models.find((m) => m.norad === station.norad) ?? null;
    if (
      stationTrackedOn(station.norad, trackedNorad, dockedCompanions) ||
      trackedDockedToStation === station.norad ||
      Boolean(model?._standsInFor?.(trackedNorad))
    )
      return { ...station, model };
  }
  return null;
}

/** The layer's station model parts, as built (index.js). */
export function stationModels(parts) {
  return parts.stationModels ?? [];
}

/** See stationModelFor, over the layer's model parts. */
export function modelFor(parts, noradId) {
  return stationModelFor(stationModels(parts), noradId);
}

/** See trackedStationOf, over the layer's stations, model parts and state. */
export function trackedStation(layerState, parts) {
  return trackedStationOf(STATIONS, stationModels(parts), {
    trackedNorad: layerState._trackedNorad,
    dockedCompanions: layerState._dockedCompanions,
    trackedDockedToStation: layerState._trackedDockedToStation ?? null,
  });
}

/**
 * The station whose model a click's draw hit landed on, over the layer's
 * model parts: its NORAD number, or null for any other hit.
 * @param {object} parts
 * @param {{set?: string, id?: string}|null|undefined} hit
 * @returns {number|null}
 */
export function modelHitNorad(parts, hit) {
  if (!hit) return null;
  for (const model of stationModels(parts)) {
    const norad = model._hitNorad?.(hit) ?? null;
    if (norad !== null) return norad;
  }
  return null;
}
