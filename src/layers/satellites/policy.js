import * as Cesium from 'cesium';
import { satelliteClassColor } from '../../data/satelliteClass.js';
import { SATELLITE_CLASS_DISPLAY, SATELLITE_CLASS_IDS } from './classes.js';

/**
 * Satellite Orbits — Real-time positions via CelesTrak TLE + SGP4 propagation.
 *
 * Loads eleven CelesTrak groups: stations, visual, GPS, GLONASS, Galileo, the
 * geosynchronous belt, and the Earth resources, weather, Planet, SAR and
 * science groups. Each object is filed under one of six classes
 * (src/layers/satellites/classes.js) whose visibility the layer row toggles; dense mode
 * (setParams catalog:'dense', the STARLINK toggle) adds the Starlink shell as
 * points-only extras.
 * Renders positions via PointPrimitiveCollection, orbital paths as polylines.
 * Click any satellite to track it with camera follow + orbital path.
 *
 * ISS gets special treatment: larger point, persistent host label, path shown by default.
 */

export const ISS_NORAD = 25544;

/**
 * The ISS drawn as a 3D model up close (issModel.js): NASA's "International
 * Space Station (ISS) (D) (IGOAL)" from NASA 3D Resources, the station's
 * current configuration (Nauka, Prichal, Bishop, the roll-out solar arrays),
 * with NASA's own textures. The shipped file is that model reduced for the
 * web and put in one frame, in meters (public/models/README.md says how).
 */
export const ISS_MODEL_URL = '/models/iss.glb';

/** The real station across its main truss, end to end, in meters. */
export const ISS_SPAN_M = 109;

/**
 * The asset's span along its truss (glTF X, solar array to solar array) in
 * its own units, read from the file's accessors. The file is in meters.
 */
export const ISS_MODEL_NATIVE_SPAN = 109;

/**
 * The station's bounding-box centre in the file's coordinates, whose origin is
 * NASA's (the middle of the S0 truss). The scene root is translated by minus
 * this, so the model's origin is the station's centre. That is what
 * minimumPixelSize scales about, so the enlarged far-range model stays
 * centred on the orbital position (and on the tracked card's leader).
 */
export const ISS_MODEL_CENTER_NATIVE = Object.freeze([0, -7.38, 0.001]);

/**
 * Which flight axis each of the model's local axes (Cesium's, after its glTF
 * axis correction: local X = glTF Z, Y = glTF X, Z = glTF Y) points along.
 * The file has the U.S. segment at +Z (forward), Kibo at +X (port) and the Z1
 * truss at +Y (zenith; the Cupola faces -Y), so: local X → along-track, local
 * Y → orbit normal, local Z → zenith.
 */
export const ISS_MODEL_LOCAL_AXES = Object.freeze(['x', 'y', 'z']);

/**
 * Within this camera distance the model replaces the dot; farther out the dot
 * stays. Covers the tracked view (~726 km back for LEO) with room to spare.
 */
export const ISS_MODEL_MAX_DISTANCE_M = 1_500_000;

/**
 * The model is never drawn smaller than this, in pixels. At true size the
 * station is under a pixel from the tracked view, so the floor is what makes
 * it readable there; within a few kilometres the true size takes over.
 */
export const ISS_MODEL_MIN_PX = 72;

/**
 * Objects within this distance of the ISS are docked to it (their element
 * sets put them within a few hundred meters); while the model shows, their
 * dots give way to it inside its range (issModel.js).
 */
export const ISS_COMPANION_RADIUS_M = 5_000;

/**
 * Dots are moved at different moments, so with the clock sped up a docked
 * object's dot can trail the ISS's by a long way. Only objects whose dots are
 * within this distance are checked orbit against orbit (issModel.js).
 */
export const ISS_COMPANION_COARSE_M = 3_000_000;

/** How often the docked set is rescanned, ms. */
export const ISS_COMPANION_SCAN_MS = 1_000;

/**
 * Within this camera distance of the ISS its orbit ring is hidden. The ring is
 * drawn as ~230 km chords and turned with the Earth once a second, so up close
 * it runs metres to kilometres off the model and jumps; at the tracked view
 * (~726 km) and beyond it stays.
 */
export const ISS_ORBIT_HIDE_M = 50_000;

/**
 * The tracked card keeps clear of the model: its gap from the anchor is this
 * many meters of the station as drawn on screen (about its reach from its
 * centre in an oblique view), so up close the card sits beside the station, not on it.
 */
export const ISS_CARD_CLEAR_M = 40;

/**
 * NASA's official live stream from the ISS on YouTube ("Live High-Definition
 * Views from the International Space Station", channel @NASA), shown in a
 * panel while the ISS is selected (issLive.js). A YouTube live keeps its id
 * while the broadcast runs; if NASA restarts it under a new id, change it here.
 */
export const ISS_LIVE_VIDEO_ID = 'ROboUHfPUrU';

export const ISS_OVERLAY_SOURCE_ID = 'satellites-iss';

export const ISS_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: true,
  solveIntervalMs: 125,
});

export const ORBIT_PATH_STEPS = 180;
// points per orbital path

export const POSITION_UPDATE_MS = 1000;
/** How far either side of now SGP4 on current element sets stays meaningful. */
export const SATELLITE_COVERAGE_MS = 14 * 24 * 3_600_000;

/**
 * How far the world time may move from when an orbit ring was drawn before it
 * is drawn again: the Earth's turn is followed exactly, but the orbit's plane
 * drifts a few degrees a day.
 */
export const ORBIT_REBAKE_MS = 30 * 60_000;
// re-propagate every 1s (SGP4 is smooth at this rate)

export const RING_ROTATION_MS = 1000;
// re-align baked orbit rings to current GMST every 1s

/**
 * CelesTrak groups loaded as the core catalog, in dedupe-priority order:
 * a satellite that appears in multiple groups keeps the FIRST (most specific)
 * tag. `path` is the upstream GROUP name forwarded by the /api/celestrak
 * proxy; `tag` is the internal group key used for POINT_STYLES lookup.
 * Note: CelesTrak's GLONASS group is named 'glo-ops' (not
 * 'glonass-operational' — that name 404s upstream).
 */

export const CATALOG_GROUPS = [
  { tag: 'stations', path: 'stations' },
  { tag: 'visual', path: 'visual' },
  { tag: 'gps-ops', path: 'gps-ops' },
  { tag: 'glonass', path: 'glo-ops' },
  { tag: 'galileo', path: 'galileo' },
  { tag: 'geo', path: 'geo' },
  // Earth observation launched after the UCS snapshot, and science probes.
  // Each object's class comes from src/layers/satellites/classes.js, not its group.
  { tag: 'resource', path: 'resource' },
  { tag: 'weather', path: 'weather' },
  { tag: 'planet', path: 'planet' },
  { tag: 'sar', path: 'sar' },
  { tag: 'science', path: 'science' },
];

// Dense-catalog mode (setParams({ catalog: 'dense' })): Starlink shell as
// points-only extras — no labels, no detection-overlay participation, and a
// relaxed propagation budget (round-robin, ~1/5 of core cadence per sat).

export const DENSE_GROUP_PATH = 'starlink';

export const DENSE_REFRESH_FRAMES = 300;
// full dense pass spread over ~300 frames (~5s @ 60fps)

export const DENSE_CREATE_CHUNK = 1500;
// satrec builds per macro-task while loading

/**
 * Tracked-entity camera offset, east-north-up meters (Entity.viewFrom).
 * Magnitude ≈ 726 km — the user-validated "slightly zoomed out" framing for
 * LEO: far enough that per-frame satellite motion doesn't stutter the camera
 * or smear the label, with +Z biasing the view down onto the satellite.
 * High orbits (MEO nav / GEO belt) scale this up so the ring stays in frame.
 */

export const TRACK_VIEW_FROM_LEO = new Cesium.Cartesian3(
  -450000,
  -450000,
  350000,
);

export const HIGH_ORBIT_ALTITUDE_M = 2000000;

export const TRACK_VIEW_FROM_HIGH_SCALE = 4;
// ≈ 2900 km back for MEO/GEO

/**
 * Shared per-group point styling — single source of truth used by BOTH the
 * creation site (update) and tracking restore (_clearTracking) so deselecting
 * a satellite never loses the original palette (WS-D3).
 *
 * Colors come from `satelliteClass.js` so the dot, the class label on the
 * card, and the legend swatch on the layer row can never disagree. Only
 * pixelSize/outline live here — those encode per-group prominence, not class.
 * Converted once at module load; per-point color is a plain primitive
 * attribute, so classification costs nothing per frame.
 */

const POINT_OUTLINE = Cesium.Color.WHITE.withAlpha(0.3);

const _classColor = (group) =>
  Cesium.Color.fromCssColorString(satelliteClassColor(group));

export const POINT_STYLES = {
  // The ISS keeps its own long-standing red hero styling rather than the
  // STATION class color: it is the object most users open this layer for, it
  // carries a permanent name label, and its size/outline already set it apart.
  // Its card still reads "STATION · ISS", so the class stays legible.
  iss: {
    pixelSize: 12,
    color: Cesium.Color.fromCssColorString('#ff4444'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 2,
  },
  stations: {
    pixelSize: 8,
    color: _classColor('stations'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  visual: {
    pixelSize: 6,
    color: _classColor('visual'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  // Nav constellations (GPS / GLONASS / Galileo) resolve to one shared NAV
  // color; 6px so the MEO shells read as clearly as the old visual group did.
  'gps-ops': {
    pixelSize: 6,
    color: _classColor('gps-ops'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  glonass: {
    pixelSize: 6,
    color: _classColor('glonass'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  galileo: {
    pixelSize: 6,
    color: _classColor('galileo'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  geo: {
    pixelSize: 5,
    color: _classColor('geo'),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
  // Dense-mode extras (Starlink): dim, small, points-only.
  dense: {
    pixelSize: 3,
    color: _classColor('dense').withAlpha(0.9),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
};

const CLASS_COLORS = Object.fromEntries(
  SATELLITE_CLASS_IDS.map((id) => [
    id,
    Cesium.Color.fromCssColorString(SATELLITE_CLASS_DISPLAY[id].color),
  ]),
);
const _classStyles = new Map();

/**
 * A satellite's point style: its group's size and outline, in its class's
 * colour (src/layers/satellites/classes.js), so the dots match the class legend and
 * toggles. Styles are shared per group and class.
 * @param {string|undefined} group Catalog group tag.
 * @param {string|undefined} satelliteClass Class id.
 */
export function classPointStyle(group, satelliteClass) {
  const base = POINT_STYLES[group] || POINT_STYLES.visual;
  const color = CLASS_COLORS[satelliteClass];
  if (!color) return base;
  const key = `${group}|${satelliteClass}`;
  let style = _classStyles.get(key);
  if (!style) {
    style = Object.freeze({
      ...base,
      color: group === 'dense' ? color.withAlpha(0.9) : color,
    });
    _classStyles.set(key, style);
  }
  return style;
}

/**
 * Physically DOCKED vehicles are separate real tracks sharing one position: the
 * station and everything berthed to it sit within metres of each other. Their
 * ambient labels therefore stack underneath the tracked card, which is what the
 * owner saw. This radius is deliberately tight — it must catch a docked stack
 * and nothing else, so an unrelated satellite in a similar orbit is never
 * suppressed. Formation-flying pairs are km apart; a docked stack is ~100 m.
 */

export const DOCKED_COMPANION_RADIUS_M = 2000;

/** The scan is O(points); the tracked label is rebuilt every frame, so throttle. */

export const DOCKED_SCAN_INTERVAL_MS = 1000;

/**
 * Shared-context refresh interval. The tracked satellite is re-propagated
 * every rendered frame; the voice context only needs to be current to about
 * the propagation cadence, so this refreshes on the same 1 s beat instead of
 * allocating a record 60 times a second.
 */

export const CONTEXT_REFRESH_INTERVAL_MS = 1000;
