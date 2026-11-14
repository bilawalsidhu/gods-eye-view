/**
 * @module fleetModels
 * @description The project's procedural fleet models (`public/models/fleet/`):
 * which model draws an aircraft, a vessel or a transit or rail vehicle, and at
 * what size, from the set's `catalog.json` (each model's file, bounds,
 * length, beam, clearance and icon class) and `types.json` (which model
 * draws which type, and the fallbacks).
 *
 * Every model is metres, glTF Y-up, nose toward local -X, origin at the body
 * centre (an aircraft's fuselage axis, a vessel's waterline, a road or rail
 * vehicle's road or rail top), and is drawn life size: a type's published
 * length over the model's built length is its scale.
 *
 * The resolvers are plain functions over the parsed JSON; `loadFleetModelSet`
 * fetches the JSON and every GLB once, up front, so no model is fetched
 * mid-session.
 */

import { classifyAircraft } from './aircraftClass.js';
import { FLEET_TRAIL_ANCHORS } from './fleetTrailAnchors.js';

/** Where the model set is served, relative to the application base. */
export const FLEET_MODEL_BASE = '/models/fleet/';

/**
 * Longest and widest hulls afloat, metres (Seawise Giant 458 m; the TI
 * tankers 68 m abeam). AIS gives the bow and stern from the antenna in 9 bits
 * and each side in 6, their largest values (511, 63) meaning "that or more"
 * or a set never configured: a 30 m tug reported 511 m long would be drawn 17
 * times its size.
 */
const MAX_HULL_LENGTH_M = 460;
const MAX_HULL_BEAM_M = 75;

/** The model a known aircraft class draws when its type has no entry. */
const CLASS_MODELS = Object.freeze({
  light: 'c172',
  glider: 'glider',
  turboprop: 'at72',
  widebody: 'b789',
  quadjet: 'b744',
  helicopter: 'generic_heli',
  fastjet: 't38',
  bizjet: 'c56x',
  uav: 'mq9',
});

/** OpenSky's integer aircraft category (state vector index 17) → ADS-B emitter category. */
const OPENSKY_EMITTER_CATEGORY = Object.freeze({
  2: 'A1',
  3: 'A2',
  4: 'A3',
  5: 'A4',
  6: 'A5',
  7: 'A6',
  8: 'A7',
  9: 'B1',
  10: 'B2',
  11: 'B3',
  12: 'B4',
  14: 'B6',
  15: 'B7',
  16: 'C1',
  17: 'C2',
  18: 'C3',
  19: 'C4',
  20: 'C5',
});

/** A text vessel type (as some AIS sources name it) → a representative AIS ship-type code. */
const TEXT_SHIP_TYPES = [
  [/tanker|lng|lpg|gas carrier/i, 80],
  [/cargo|container|bulk|carrier|freighter|ro-?ro/i, 70],
  [/passenger|ferry|cruise/i, 60],
  [/high.?speed/i, 40],
  [/fishing|trawler/i, 30],
  [/tug|towing/i, 52],
  [/pilot/i, 50],
  [/search|rescue|\bsar\b/i, 51],
  [/dredg/i, 33],
  [/military|naval|navy/i, 35],
  [/law|police|patrol|coast ?guard/i, 55],
  [/sail/i, 36],
  [/pleasure|yacht/i, 37],
];

/**
 * The model for an aircraft of ICAO type `type` (A320, B738, R44), ADS-B
 * emitter category `category` and callsign `callsign`: the first of the
 * type's callsign rules (`aircraft_callsign`) the callsign matches, else the
 * type's, else the category's, else `default_aircraft`. An airport vehicle
 * (type ZVEH) is a fire truck, tug or van by its callsign, else a car.
 * @param {object} types Parsed `types.json`.
 * @param {string} [type]
 * @param {string} [category]
 * @param {string} [callsign]
 * @returns {{model: string, length: number|null}}
 */
export function resolveAircraft(types, type, category, callsign) {
  const t = type?.trim().toUpperCase();
  const index = aircraftCallsignRule(types, t, callsign);
  if (index >= 0) {
    const rule = types.aircraft_callsign[t][index];
    return { model: rule.model, length: rule.length };
  }
  const [model, length] =
    (t && (types.aircraft[t] ?? types.helicopters[t])) ||
    (category && types.categories[category]) ||
    types.default_aircraft;
  return { model, length };
}

/**
 * A callsign as the rules read it: upper case, spaces removed.
 * @param {string} callsign
 * @returns {string}
 */
function callsignKey(callsign) {
  return String(callsign).toUpperCase().replace(/\s+/g, '');
}

/**
 * Which of type `type`'s callsign rules (`types.json`'s
 * `aircraft_callsign[type]`, each `{prefixes, model, length}`, first match
 * wins) `callsign` matches: its index, -1 when none does or the type has
 * none. A callsign matches a rule when, upper-cased with spaces removed, it
 * starts with one of the rule's prefixes.
 * @param {object} types Parsed `types.json`.
 * @param {string|null} [type] ICAO type.
 * @param {string|null} [callsign]
 * @returns {number}
 */
export function aircraftCallsignRule(types, type, callsign) {
  const t = String(type ?? '')
    .trim()
    .toUpperCase();
  const rules = t ? types.aircraft_callsign?.[t] : undefined;
  if (!rules || !callsign) return -1;
  const c = callsignKey(callsign);
  return rules.findIndex((rule) =>
    rule.prefixes.some((prefix) => c.startsWith(callsignKey(prefix))),
  );
}

/**
 * Whether an aircraft of ICAO type `type` picks its model by callsign.
 * @param {object} types Parsed `types.json`.
 * @param {string|null} [type]
 * @returns {boolean}
 */
export function aircraftModelByCallsign(types, type) {
  const t = String(type ?? '')
    .trim()
    .toUpperCase();
  return Boolean(t && types.aircraft_callsign?.[t]);
}

/**
 * A reported length as one a hull can have, else undefined (drawn as built).
 * @param {number} [length]
 * @returns {number|undefined}
 */
export function hullLength(length) {
  return length !== undefined &&
    length !== null &&
    length > 0 &&
    length <= MAX_HULL_LENGTH_M
    ? length
    : undefined;
}

/**
 * A reported beam as one a hull can have, else undefined.
 * @param {number} [beam]
 * @returns {number|undefined}
 */
export function hullBeam(beam) {
  return beam !== undefined &&
    beam !== null &&
    beam > 0 &&
    beam <= MAX_HULL_BEAM_M
    ? beam
    : undefined;
}

/**
 * The model for a vessel of AIS ship type `shipType` and the reported length
 * and beam (metres) and name: the first rule that matches in the first type
 * range that has one, else `default_vessel`. Drawn at the reported length;
 * when it is unknown (most live feeds send none), chosen and drawn at the
 * range's `typical_len`, else as built.
 * @param {object} types Parsed `types.json`.
 * @param {number} [shipType]
 * @param {number} [length]
 * @param {number} [beam]
 * @param {string} [name]
 * @returns {{model: string, length: number|null}}
 */
export function resolveVessel(types, shipType, length, beam, name) {
  const L = hullLength(length) ?? 0;
  const B = hullBeam(beam) ?? 0;
  if (shipType !== undefined && shipType !== null) {
    for (const group of types.vessels) {
      if (!(shipType >= group.types[0] && shipType <= group.types[1])) continue;
      const len = L > 0 ? L : (group.typical_len ?? 0);
      const drawn = len > 0 ? len : null;
      for (const rule of group.rules) {
        if (rule.min_len && len < rule.min_len) continue;
        if (rule.max_len && len > rule.max_len) continue;
        if (rule.name_re && !new RegExp(rule.name_re).test(name ?? ''))
          continue;
        if (rule.max_bl && !(B > 0 && L > 0 && B / L <= rule.max_bl)) continue;
        return { model: rule.model, length: drawn };
      }
    }
  }
  return { model: types.default_vessel, length: L > 0 ? L : null };
}

/**
 * The model for a public transport vehicle: a rail category and mode
 * (`transit`/`local`/`regional`/`national`/`international` × `rail`/`metro`/
 * `tram`), else a GTFS `route_type` (basic 0-12 or extended 100-1507), else a
 * mode name (`bus`, `tram`, `subway`, `rail`, `ferry`, `light_rail`, …),
 * else `transit.default`. Each comes with the length to draw it at.
 * @param {object} types Parsed `types.json`.
 * @param {{railCategory?: string, railMode?: string, routeType?: number|string,
 *   mode?: string}} vehicle
 * @returns {{model: string, length: number|null}}
 */
export function resolveTransit(
  types,
  { railCategory, railMode, routeType, mode } = {},
) {
  const transit = types.transit;
  const rail = railCategory ? transit.rail[railCategory] : null;
  const routeKey =
    routeType === undefined || routeType === null || routeType === ''
      ? null
      : String(Number(routeType));
  const [model, length] =
    (rail && (rail[railMode || 'rail'] ?? rail.rail)) ||
    (routeKey && transit.route_types[routeKey]) ||
    (mode && transit.modes[mode]) ||
    transit.default;
  return { model, length };
}

/**
 * An AIS ship type as its numeric code: a code as given ("70"), or the code
 * of the family a text type names ("Cargo" → 70); undefined when it names
 * none.
 * @param {string|number|null|undefined} type
 * @returns {number|undefined}
 */
export function aisShipTypeCode(type) {
  const text = String(type ?? '').trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) {
    const code = Number(text);
    return code > 0 && code < 100 ? code : undefined;
  }
  for (const [pattern, code] of TEXT_SHIP_TYPES)
    if (pattern.test(text)) return code;
  return undefined;
}

/**
 * An aircraft category as an ADS-B emitter category: an emitter string as
 * given ("A3"), or OpenSky's integer category mapped to one.
 * @param {string|number|null|undefined} category
 * @returns {string|undefined}
 */
export function emitterCategory(category) {
  if (typeof category === 'number')
    return OPENSKY_EMITTER_CATEGORY[category] || undefined;
  const text = String(category ?? '')
    .trim()
    .toUpperCase();
  if (/^\d+$/.test(text)) return OPENSKY_EMITTER_CATEGORY[Number(text)];
  return /^[A-D][0-7]$/.test(text) ? text : undefined;
}

/**
 * The scale of model `model` drawn `length` metres long, along the model's
 * length, beam and height. A vessel's reported beam stretches it sideways;
 * its height follows the mean of the two.
 * @param {object} model Catalog entry.
 * @param {number|null} length
 * @param {number} [beam] A vessel's reported beam.
 * @returns {[number, number, number]}
 */
export function placeScale(model, length, beam) {
  if (length === null || length === undefined || !(model.length > 0))
    return [1, 1, 1];
  const sx = length / model.length;
  const b = hullBeam(beam);
  const sy = b !== undefined && model.beam > 0 ? b / model.beam : sx;
  return [sx, sy, (sx + sy) / 2];
}

/** Half the diagonal of a model's bounds: the radius Cesium bounds it by. */
function boundingRadius(model) {
  const [x0, y0, z0] = model.min;
  const [x1, y1, z1] = model.max;
  return Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2;
}

/**
 * The drawing of model `name` at `length` metres: what the layers place.
 *
 * `scale` is the uniform scale (along the model's length) a Cesium Model
 * takes; `scaleXYZ` the model's length, beam and height scales, for a vessel
 * stretched to its reported beam. `clearanceM` is how far the model reaches
 * below its origin at that scale (wheels below an aircraft's axis, a keel
 * below the waterline): a grounded aircraft stands its origin that far up.
 * `elevationM` lifts a vehicle off the route it follows (a monorail, a
 * gondola). `tinted` models carry the `_TINT` vertex attribute marking where
 * a route colour applies. `nativeRadiusM` (unscaled), `visualCenterNative`
 * and `trailAnchorNative` (raw glTF axes, unscaled) serve the aircraft
 * layers' pixel-size, bracket and trail geometry.
 * @param {{catalog: object, types: object}} set
 * @param {string} name Catalog model name.
 * @param {number|null} length Metres along the body; null draws it as built.
 * @param {{beam?: number}} [options]
 * @returns {object}
 */
export function fleetModelSpec(set, name, length, { beam } = {}) {
  const model = set.catalog[name];
  // Ground vehicles, balloons and obstacles are built at the size their type
  // names (a tower's 60 m is its height, not a length to scale to).
  const drawnLength = model.category === 'other' ? null : length;
  const scaleXYZ = placeScale(model, drawnLength, beam);
  const elevationM = set.types.transit?.elevation?.[name] || 0;
  return Object.freeze({
    model: name,
    url: FLEET_MODEL_BASE + model.file,
    category: model.category,
    icon: model.icon,
    length: model.length * scaleXYZ[0],
    scale: scaleXYZ[0],
    scaleXYZ: Object.freeze(scaleXYZ),
    clearanceM: model.clearance * scaleXYZ[2],
    elevationM,
    tinted: model.category === 'transit',
    nativeRadiusM: boundingRadius(model),
    visualCenterNative: CENTRED,
    trailAnchorNative: FLEET_TRAIL_ANCHORS[name] || CENTRED,
    key: `${name}@${scaleXYZ.map((s) => s.toFixed(4)).join('x')}`,
  });
}

const CENTRED = Object.freeze([0, 0, 0]);

/** `resolved` drawn from `set`, its model replaced by `fallback` when the catalog lacks it. */
function specOf(set, resolved, fallback, options) {
  const known = set.catalog[resolved.model] ? resolved : fallback(resolved);
  return fleetModelSpec(set, known.model, known.length, options);
}

/**
 * The model an aircraft is drawn with. The type's callsign rules (an airport
 * vehicle by its callsign), then the type's entry; then, for a
 * type the map lacks, the model of its class (a fast jet, a helicopter, a
 * glider) when the type names one; then the emitter category's; then
 * `default_aircraft`.
 * @param {{catalog: object, types: object}} set
 * @param {{typeCode?: string|null, type?: string|null,
 *   category?: string|number|null, callsign?: string|null}} aircraft
 * @returns {object} {@link fleetModelSpec}
 */
export function aircraftModelSpec(
  set,
  { typeCode, type, category, callsign } = {},
) {
  const { types, catalog } = set;
  const code = String(typeCode ?? type ?? '')
    .trim()
    .toUpperCase();
  const emitter = emitterCategory(category);
  const sign = callsign ? String(callsign) : undefined;
  let resolved = resolveAircraft(types, code, emitter, sign);
  // A callsign rule names the model outright; a type's class only stands in
  // for a type the map lacks.
  const ruled = aircraftCallsignRule(types, code, sign) >= 0;
  const typed = code && (types.aircraft[code] || types.helicopters[code]);
  if (!ruled && !typed && code) {
    const model = CLASS_MODELS[classifyAircraft({ typeCode: code })];
    if (model && catalog[model])
      resolved = { model, length: catalog[model].length };
  }
  return specOf(set, resolved, () => ({
    model: types.default_aircraft[0],
    length: types.default_aircraft[1],
  }));
}

/**
 * The model a vessel is drawn with, from its AIS ship type (a code or a text
 * family), reported length and beam (metres) and name.
 * @param {{catalog: object, types: object}} set
 * @param {{type?: string|number|null, length?: number|null,
 *   beam?: number|null, name?: string|null}} vessel
 * @returns {object} {@link fleetModelSpec}
 */
export function vesselModelSpec(set, { type, length, beam, name } = {}) {
  // A beam counts only beside a reported length: a vessel drawn at its type's
  // typical length keeps the model's proportions.
  const reported = hullLength(length ?? undefined);
  const hullWidth = reported === undefined ? undefined : (beam ?? undefined);
  const resolved = resolveVessel(
    set.types,
    aisShipTypeCode(type),
    reported,
    hullWidth,
    name ?? undefined,
  );
  return specOf(
    set,
    resolved,
    (r) => ({ model: set.types.default_vessel, length: r.length }),
    { beam: hullWidth },
  );
}

/**
 * The model a transit or rail vehicle is drawn with ({@link resolveTransit}).
 * @param {{catalog: object, types: object}} set
 * @param {object} vehicle
 * @returns {object} {@link fleetModelSpec}
 */
export function transitModelSpec(set, vehicle) {
  return specOf(set, resolveTransit(set.types, vehicle), () => ({
    model: set.types.transit.default[0],
    length: set.types.transit.default[1],
  }));
}

/**
 * Every model the type map names, defaults and fallbacks included.
 * @param {object} types Parsed `types.json`.
 * @returns {Set<string>}
 */
export function namedFleetModels(types) {
  const pairs = (map) => Object.values(map).map(([model]) => model);
  const transit = types.transit;
  return new Set([
    ...pairs(types.aircraft),
    ...pairs(types.helicopters),
    ...pairs(types.categories),
    ...Object.values(types.aircraft_callsign ?? {}).flatMap((rules) =>
      rules.map((rule) => rule.model),
    ),
    ...types.vessels.flatMap((group) => group.rules.map((rule) => rule.model)),
    types.default_aircraft[0],
    types.default_vessel,
    ...pairs(transit.modes),
    ...pairs(transit.route_types),
    ...Object.values(transit.rail).flatMap(pairs),
    transit.default[0],
    ...Object.keys(transit.elevation),
    ...Object.values(CLASS_MODELS),
  ]);
}

let loading = null;
let loaded = null;

/**
 * The model set once {@link loadFleetModelSet} has loaded it, else null.
 * @returns {object|null}
 */
export function fleetModelSet() {
  return loaded;
}

/**
 * Fetch the model set once for every layer: `catalog.json`, `types.json` and
 * every GLB the catalog names, all up front, so no model is fetched while a
 * session runs. Resolves to `{catalog, types, bytes, loadMs, totalBytes}`,
 * `bytes` holding each model's GLB by name; a GLB that fails to load is left
 * out (that model then draws nothing and its entities stay icons).
 * @param {{resolveAsset?: (url: string) => string,
 *   fetchImpl?: typeof fetch, now?: () => number}} [options]
 * @returns {Promise<object>}
 */
export function loadFleetModelSet({
  resolveAsset = (url) => url,
  fetchImpl = globalThis.fetch,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  if (loading) return loading;
  const started = now();
  const json = async (name) => {
    const response = await fetchImpl(resolveAsset(FLEET_MODEL_BASE + name));
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    return response.json();
  };
  loading = (async () => {
    const [catalog, types] = await Promise.all([
      json('catalog.json'),
      json('types.json'),
    ]);
    const bytes = new Map();
    let totalBytes = 0;
    await Promise.all(
      Object.entries(catalog).map(async ([name, model]) => {
        try {
          const response = await fetchImpl(
            resolveAsset(FLEET_MODEL_BASE + model.file),
          );
          if (!response.ok) return;
          const glb = new Uint8Array(await response.arrayBuffer());
          bytes.set(name, glb);
          totalBytes += glb.byteLength;
        } catch {
          /* that model draws nothing; its entities stay icons */
        }
      }),
    );
    loaded = Object.freeze({
      catalog,
      types,
      bytes,
      loadMs: now() - started,
      totalBytes,
    });
    console.info(
      `[Fleet] ${bytes.size}/${Object.keys(catalog).length} models ` +
        `(${(totalBytes / 1048576).toFixed(2)} MB) loaded in ${Math.round(loaded.loadMs)} ms`,
    );
    return loaded;
  })();
  // A failed catalog load may be retried by the next layer that starts.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** Forget the loaded set (tests). */
export function resetFleetModelSet() {
  loading = null;
  loaded = null;
}
