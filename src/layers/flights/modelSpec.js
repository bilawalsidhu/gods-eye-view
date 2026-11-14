import {
  aircraftCallsignRule,
  aircraftModelByCallsign,
  aircraftModelSpec,
  fleetModelSet,
} from '../../data/fleetModels.js';
import { MODEL_COLOR_BLEND_AMOUNT } from './policy.js';

/**
 * What an aircraft draws with before the fleet model set has loaded: no
 * model (its billboard stays the visual), with neutral geometry for any
 * reader that asks.
 */
export const UNLOADED_AIRCRAFT_MODEL_SPEC = Object.freeze({
  model: null,
  url: null,
  scale: 1,
  scaleXYZ: Object.freeze([1, 1, 1]),
  length: 0,
  nativeRadiusM: 20,
  clearanceM: 0,
  bellyM: 0,
  elevationM: 0,
  tinted: false,
  blendAmount: MODEL_COLOR_BLEND_AMOUNT,
  visualCenterNative: Object.freeze([0, 0, 0]),
  trailAnchorNative: Object.freeze([0, 0, 0]),
  key: 'unloaded',
});

/**
 * The fleet model, life-size scale and measured geometry an aircraft draws
 * with, chosen by its ICAO type and emitter category, and by its callsign
 * for the types that pick by callsign (`fleetModels.js`).
 * Shared by the Flights, Military Flights and Local ADS-B layers so all three
 * draw the same model for the same aircraft. `bellyM` is the model's scaled
 * clearance: how far a grounded aircraft's origin stands above the ground.
 * @param {{typeCode?: string|null, type?: string|null,
 *   category?: string|number|null,
 *   callsign?: string|null}|null|undefined} aircraft
 * @param {object|null} [set] The loaded fleet model set.
 * @returns {object} The spec, or {@link UNLOADED_AIRCRAFT_MODEL_SPEC} before
 *   the set has loaded.
 */
export function aircraftLayerModelSpec(aircraft, set = fleetModelSet()) {
  if (!set) return UNLOADED_AIRCRAFT_MODEL_SPEC;
  // Layers ask on every tick; each type and category is resolved once per set.
  let cache = specCaches.get(set);
  if (!cache) specCaches.set(set, (cache = new Map()));
  const key = aircraftModelSpecCacheKey(aircraft, set);
  let layerSpec = cache.get(key);
  if (!layerSpec) {
    const spec = aircraftModelSpec(set, {
      typeCode: aircraft?.typeCode ?? aircraft?.type ?? null,
      category: aircraft?.category ?? null,
      callsign: aircraft?.callsign ?? null,
    });
    layerSpec = Object.freeze({
      ...spec,
      bellyM: spec.clearanceM,
      blendAmount: MODEL_COLOR_BLEND_AMOUNT,
    });
    cache.set(key, layerSpec);
  }
  return layerSpec;
}

/** @type {WeakMap<object, Map<string, object>>} set -> cache key -> spec */
const specCaches = new WeakMap();

/**
 * Cache key of an aircraft's model spec: what selects its model. For a type
 * that picks its model by callsign (an airport vehicle) the key adds the
 * rule its callsign matches, or `type` for none, so such a type caches at
 * most one entry per rule and one for its own model.
 * @param {object|null|undefined} aircraft
 * @param {object|null} [set] The loaded fleet model set.
 * @returns {string}
 */
export function aircraftModelSpecCacheKey(aircraft, set = fleetModelSet()) {
  const type = aircraft?.typeCode ?? aircraft?.type ?? '';
  const key = `${type}|${aircraft?.category ?? ''}`;
  if (!set || !aircraftModelByCallsign(set.types, type)) return key;
  const rule = aircraftCallsignRule(set.types, type, aircraft?.callsign);
  return `${key}|${rule >= 0 ? `r${rule}` : 'type'}`;
}
