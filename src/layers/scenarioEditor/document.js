/**
 * Scenario documents as the editor sees them: the raw file format, edited
 * immutably (every operation returns a new document) and checked with the
 * same validator the Simulation layer loads with. No Cesium, DOM or i18n
 * imports, so the tests run without WebGL.
 * @module layers/scenarioEditor/document
 */
import {
  MAX_AIRCRAFT,
  MAX_WAYPOINTS,
  SCENARIO_VERSION,
  normalizeScenario,
} from '../simulation/scenario.js';

export const DEFAULT_ALT_FT = 1000;
export const DEFAULT_SPEED_KT = 250;
export const DEFAULT_TYPE_CODE = 'B738';
export const DEFAULT_CATEGORY = 'A3';
export const DEFAULT_COLORS = Object.freeze([
  '#ffd166',
  '#9be7ff',
  '#ff7b7b',
  '#b4ffb4',
  '#f3a6ff',
  '#ffb86b',
]);

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function fail(message) {
  throw new TypeError(`Editor: ${message}`);
}

/** Deep copy through JSON: documents are plain data by construction. */
export function cloneDocument(doc) {
  return JSON.parse(JSON.stringify(doc));
}

/**
 * A new, empty scenario.
 * @param {string} [id]
 * @param {string} [title]
 */
export function emptyDocument(id = 'my-scenario', title = 'My scenario') {
  if (!ID_PATTERN.test(id))
    fail('scenario id must be lowercase letters, digits, dashes');
  return { version: SCENARIO_VERSION, id, title, aircraft: [], cameras: [] };
}

function aircraftIndex(doc, aircraftId) {
  const index = (doc.aircraft || []).findIndex(
    (entry) => entry.id === aircraftId,
  );
  if (index < 0) fail(`no aircraft "${aircraftId}"`);
  return index;
}

/** The first free `aircraft-N` id. */
export function nextAircraftId(doc) {
  const taken = new Set((doc.aircraft || []).map((entry) => entry.id));
  let n = taken.size + 1;
  while (taken.has(`aircraft-${n}`)) n += 1;
  return `aircraft-${n}`;
}

/**
 * Add an aircraft with no waypoints yet.
 * @returns {{doc:object, id:string}}
 */
export function addAircraft(doc, options = {}) {
  const aircraft = doc.aircraft || [];
  if (aircraft.length >= MAX_AIRCRAFT) fail(`at most ${MAX_AIRCRAFT} aircraft`);
  const id = options.id || nextAircraftId(doc);
  if (!ID_PATTERN.test(id)) fail('aircraft id is invalid');
  if (aircraft.some((entry) => entry.id === id))
    fail(`aircraft "${id}" exists`);
  const next = cloneDocument(doc);
  next.aircraft = [
    ...aircraft,
    {
      id,
      callsign:
        String(
          options.callsign || id.toUpperCase().replace(/[^A-Z0-9]/g, ''),
        ).slice(0, 12) || id.toUpperCase(),
      typeCode: options.typeCode || DEFAULT_TYPE_CODE,
      category: options.category || DEFAULT_CATEGORY,
      color:
        options.color ||
        DEFAULT_COLORS[aircraft.length % DEFAULT_COLORS.length],
      loop: options.loop !== false,
      waypoints: [],
    },
  ];
  return { doc: next, id };
}

/** Remove an aircraft and the cameras that targeted it. */
export function removeAircraft(doc, aircraftId) {
  aircraftIndex(doc, aircraftId);
  const next = cloneDocument(doc);
  next.aircraft = next.aircraft.filter((entry) => entry.id !== aircraftId);
  next.cameras = (next.cameras || []).map((camera) =>
    camera.target === aircraftId ? { ...camera, target: null } : camera,
  );
  return next;
}

export function setAircraftLoop(doc, aircraftId, loop) {
  const index = aircraftIndex(doc, aircraftId);
  const next = cloneDocument(doc);
  next.aircraft[index].loop = Boolean(loop);
  return next;
}

/** The altitude and speed a new waypoint inherits: the last one's, else defaults. */
export function waypointDefaults(doc, aircraftId) {
  const index = (doc.aircraft || []).findIndex(
    (entry) => entry.id === aircraftId,
  );
  const last = index >= 0 ? doc.aircraft[index].waypoints?.at(-1) : null;
  return {
    altFt: Number.isFinite(last?.altFt) ? last.altFt : DEFAULT_ALT_FT,
    speedKt: Number.isFinite(last?.speedKt) ? last.speedKt : DEFAULT_SPEED_KT,
  };
}

/**
 * Append a waypoint to an aircraft's path.
 * @param {object} doc
 * @param {string} aircraftId
 * @param {{lat:number, lon:number, altFt?:number, speedKt?:number}} waypoint
 */
export function appendWaypoint(doc, aircraftId, waypoint) {
  const index = aircraftIndex(doc, aircraftId);
  const lat = Number(waypoint?.lat);
  const lon = Number(waypoint?.lon);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    fail('waypoint needs lat/lon');
  const defaults = waypointDefaults(doc, aircraftId);
  const next = cloneDocument(doc);
  const waypoints = next.aircraft[index].waypoints || [];
  if (waypoints.length >= MAX_WAYPOINTS)
    fail(`at most ${MAX_WAYPOINTS} waypoints`);
  waypoints.push({
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
    altFt: Number.isFinite(Number(waypoint.altFt))
      ? Math.round(Number(waypoint.altFt))
      : defaults.altFt,
    speedKt: Number.isFinite(Number(waypoint.speedKt))
      ? Math.round(Number(waypoint.speedKt))
      : defaults.speedKt,
  });
  next.aircraft[index].waypoints = waypoints;
  return next;
}

export function removeLastWaypoint(doc, aircraftId) {
  const index = aircraftIndex(doc, aircraftId);
  const next = cloneDocument(doc);
  next.aircraft[index].waypoints = (next.aircraft[index].waypoints || []).slice(
    0,
    -1,
  );
  return next;
}

export function clearWaypoints(doc, aircraftId) {
  const index = aircraftIndex(doc, aircraftId);
  const next = cloneDocument(doc);
  next.aircraft[index].waypoints = [];
  return next;
}

/** The document with extra cameras appended (same id replaces). */
export function withCameras(doc, cameras = []) {
  const next = cloneDocument(doc);
  const byId = new Map(
    (next.cameras || []).map((camera) => [camera.id, camera]),
  );
  for (const camera of cameras || [])
    byId.set(camera.id, cloneDocument(camera));
  next.cameras = [...byId.values()];
  return next;
}

/**
 * What the Simulation layer can fly right now: aircraft with at least two
 * waypoints, and cameras whose target still exists.
 */
export function playableDocument(doc) {
  const next = cloneDocument(doc);
  next.aircraft = (next.aircraft || []).filter(
    (entry) => Array.isArray(entry.waypoints) && entry.waypoints.length >= 2,
  );
  const ids = new Set(next.aircraft.map((entry) => entry.id));
  next.cameras = (next.cameras || [])
    .filter((camera) => camera.target == null || ids.has(camera.target))
    .map((camera) =>
      camera.target == null ? { ...camera, target: null } : camera,
    );
  return next;
}

/** Run the loader's validator; never throws. */
export function validateDocument(doc) {
  try {
    return { ok: true, scenario: normalizeScenario(doc) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

export function serializeDocument(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Counts for the row. */
export function documentSummary(doc) {
  const aircraft = doc?.aircraft || [];
  return {
    aircraft: aircraft.length,
    waypoints: aircraft.reduce(
      (sum, entry) => sum + (entry.waypoints?.length || 0),
      0,
    ),
    cameras: (doc?.cameras || []).length,
  };
}

/**
 * Parse an imported file: JSON first, then the validator, so a bad file is
 * refused with its reason and never half-loaded.
 * @returns {{ok:true, doc:object}|{ok:false, error:string}}
 */
export function parseDocument(text) {
  let doc;
  try {
    doc = JSON.parse(String(text));
  } catch (error) {
    return { ok: false, error: `not JSON: ${error?.message || error}` };
  }
  const result = validateDocument(doc);
  if (!result.ok) return result;
  if (!Array.isArray(doc.cameras)) doc.cameras = [];
  return { ok: true, doc };
}
