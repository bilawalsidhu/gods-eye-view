import { satelliteClassColor } from '../../data/satelliteClass.js';
import { cssColor, hexColor } from '../../render/color.js';
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
 * Renders positions as points, orbital paths as polylines.
 * Click any satellite to track it with camera follow + orbital path.
 *
 * ISS gets special treatment: larger point, persistent host label, path shown by default.
 */

export const ISS_NORAD = 25544;

export const ISS_OVERLAY_SOURCE_ID = 'satellites-iss';

export const ISS_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: true,
  solveIntervalMs: 125,
});

export const ORBIT_PATH_STEPS = 180;
// points per orbital path

/** How often every core satellite takes a fresh SGP4 sample (wall ms). */
export const POSITION_UPDATE_MS = 1000;
/**
 * Between SGP4 samples every point is reckoned each frame from its last one
 * (motion.js). A sample this far from the world time is taken again, so a
 * point is never more than about 10 m off SGP4 however fast time plays.
 */
export const ORBIT_SAMPLE_HORIZON_MS = 30_000;
/** Beyond this from its sample a point is left where it is until sampled again. */
export const ORBIT_RECKON_LIMIT_MS = 120_000;
/** How far either side of now SGP4 on current element sets stays meaningful. */
export const SATELLITE_COVERAGE_MS = 14 * 24 * 3_600_000;

/**
 * How far the world time may move from when an orbit ring was drawn before it
 * is drawn again: the Earth's turn is followed exactly, but the orbit's plane
 * drifts a few degrees a day.
 */
export const ORBIT_REBAKE_MS = 30 * 60_000;

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

/**
 * The most dense extras sampled in one frame while time plays fast (~4 ms).
 * Past about 10 minutes of world time a second the full dense set no longer
 * fits within ORBIT_RECKON_LIMIT_MS, and its points move only as they are
 * sampled.
 */
export const DENSE_SAMPLES_PER_FRAME_MAX = 2000;

export const DENSE_CREATE_CHUNK = 1500;
// satrec builds per macro-task while loading

/**
 * Tracked-entity camera offset, east-north-up meters (Entity.viewFrom).
 * Magnitude ≈ 726 km — the user-validated "slightly zoomed out" framing for
 * LEO: far enough that per-frame satellite motion doesn't stutter the camera
 * or smear the label, with +Z biasing the view down onto the satellite.
 * High orbits (MEO nav / GEO belt) scale this up so the ring stays in frame.
 */

export const TRACK_VIEW_FROM_LEO = Object.freeze({
  x: -450000,
  y: -450000,
  z: 350000,
});

/** The tracked satellite's orbit ring. */
export const TRACKED_ORBIT_COLOR = Object.freeze([1, 1, 0, 1]);

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
 * Colours are the render contract's `[r, g, b, a]` (0..1); the rendering
 * part turns each style into the renderer's own colours once.
 */

const POINT_OUTLINE = Object.freeze([1, 1, 1, 0.3]);

const rgba = (hex, alpha = 1) => Object.freeze(hexColor(hex, alpha));

const _classColor = (group, alpha = 1) =>
  rgba(satelliteClassColor(group), alpha);

export const POINT_STYLES = {
  // The ISS keeps its own long-standing red hero styling rather than the
  // STATION class color: it is the object most users open this layer for, it
  // carries a permanent name label, and its size/outline already set it apart.
  // Its card still reads "STATION · ISS", so the class stays legible.
  iss: {
    pixelSize: 12,
    color: rgba('#ff4444'),
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
    color: _classColor('dense', 0.9),
    outlineColor: POINT_OUTLINE,
    outlineWidth: 0,
  },
};

const CLASS_COLORS = Object.fromEntries(
  SATELLITE_CLASS_IDS.map((id) => [
    id,
    Object.freeze(cssColor(SATELLITE_CLASS_DISPLAY[id].color)),
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
      color:
        group === 'dense'
          ? Object.freeze([color[0], color[1], color[2], 0.9])
          : color,
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
