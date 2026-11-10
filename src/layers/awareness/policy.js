export const AIRCRAFT_DEPENDENCIES = ['flights', 'military'];

const DEFERRED_DEPENDENCIES = ['ais-live-vessels', 'military-installations'];

export const DEPENDENCIES = [
  ...AIRCRAFT_DEPENDENCIES,
  ...DEFERRED_DEPENDENCIES,
];

export const AWARENESS_REFRESH_MS = 750;

/** @constant {number} Refresh cadence while the camera pose is CHANGING.
 *  Owner playtest 2026-08-18: the Contacts direction arrows and card readouts
 *  "feel sluggish when you look around" — at the parked 750 ms cadence the
 *  arrows lag the view by up to three quarters of a second. */

export const AWARENESS_MOTION_REFRESH_MS = 175;

/** @constant {number} How long the pose signature must stay UNCHANGED before
 *  the view counts as parked again. The signature is quantized, so a slow drag
 *  crosses a bin only every few frames; without this hysteresis every crossing
 *  read as a motion-end and refreshed at nearly display rate. */

export const AWARENESS_MOTION_SETTLE_MS = 250;

export const AWARENESS_REEVALUATE_DISTANCE_M = 250;

export const AWARENESS_PAGE_ROTATE_MS = 10000;

export const AWARENESS_PAGE_SIZE = 3;

export const AWARENESS_MAX_EXAMPLES = 10;

// Navigation walks the whole 250 km cohort, not the ten rows the panel shows,
// so these caps sit far above any realistic in-range population rather than at
// the display limit. They are still FINITE: an unbounded materialization would
// let a pathological feed sort an eleven-thousand-contact array on every
// refresh. Callers sample beyond this cap and carry explicit completeness, so
// a saturated cohort is a lower bound rather than a silently exact count.

export const AWARENESS_QUERY_LIMIT = 20000;

export const AWARENESS_MAX_NAVIGATION_EXAMPLES = 10000;

export const CONTEXT_RIM_HEIGHT_M = 2500;

/** @constant The 250 km range ring around the Global Context subject.
 *  The old 1 px ellipse outline vanished over desert, snow and under
 *  the FLIR, NVG and CRT styles. A bright core inside a dark halo keeps
 *  luminance contrast on light and dark ground alike, and luminance is what
 *  the monochrome styles keep. The core is the Context panel's blue; the halo
 *  is the map-card ink. Widths are screen pixels; `outlineWidth` is per side.
 *  It is drawn as an unpickable primitive, so clicks on its edge reach the
 *  contacts underneath.
 *  While the sonar pulses run, the ring dims to `restOpacity` and flashes
 *  to full as each pulse reaches it, fading over `flashMs`. `restOpacity`
 *  keeps the 250 km edge readable between flashes, in screenshots and for
 *  low-vision viewers. Once the pulses rest, and without pulses (reduced
 *  motion, or a scene that cannot animate), it stays on screen at full. */
export const AWARENESS_RANGE_RING_STYLE = Object.freeze({
  color: 'rgba(98, 181, 255, 0.95)',
  outlineColor: 'rgba(4, 12, 16, 0.8)',
  width: 4,
  outlineWidth: 1,
  segments: 128,
  flashMs: 1800,
  restOpacity: 0.4,
});

/** @constant Sonar-style pulses that grow slowly from the subject to the
 *  range ring and are almost gone when they reach it. `count` pulses share
 *  one `periodMs`, evenly staggered, so a new one starts every
 *  `periodMs / count`. Each starts at `startFraction` of the radius, fades in
 *  over `fadeInFraction` of its travel, then fades as (1 - travel) to the
 *  `fadeOutPower` down to `endOpacityFraction` of `peakOpacity`, so a pulse
 *  is dim but still visible when it reaches the ring and the ring flashes.
 *  Each line is `width` CSS pixels wide, its outer `outlineWidth` a dark
 *  halo, in the ring's colours, as Cesium's polyline outline material draws.
 *  Behind each line a radial gradient in the same blue fades inward over
 *  `gradientDepthFraction` of the radius, at most
 *  `gradientOpacity` strong. One unpickable disc draws the lines and the
 *  gradient, so pulses never catch a click meant for a contact; its shader
 *  takes at most four pulses. The disc follows the subject by a model-matrix
 *  rotation, so it stays concentric with the ring, and is rebuilt only after
 *  the subject moves `gradientRebuildM` from where it was built; while the
 *  pulses rest the hidden disc is left alone and catches up when they wake. The
 *  disc is hidden while the camera is below its height, where it would sweep
 *  the sky.
 *  The pulses run for `activeMs` (three ring flashes) after a selection or
 *  a camera move, fading in and out over `settleMs`, then rest: the ring
 *  stays on screen, static, and nothing asks for frames, so a parked view
 *  goes quiet again. Only a camera move within `inputWakeMs` of the user
 *  handling the map (pointer, wheel or touch on the canvas, which covers a
 *  drag's inertia, while the camera controls take input) wakes them; a moving subject and the app's own camera moves
 *  (tracking, cockpit, orbit, a fly-to) do not. Below the disc's height they
 *  rest too. While they run they never hold
 *  continuous rendering; each drawn frame arms one more request after the
 *  Cyber sonar's 80 ms cadence, so the two never beat. When something else
 *  already renders continuously they update every frame. Skipped under
 *  prefers-reduced-motion. */
export const AWARENESS_RANGE_PULSE = Object.freeze({
  count: 3,
  periodMs: 9000,
  startFraction: 0.02,
  fadeInFraction: 0.08,
  fadeOutPower: 1.5,
  endOpacityFraction: 0.35,
  peakOpacity: 0.6,
  width: 3,
  outlineWidth: 1,
  gradientDepthFraction: 0.35,
  gradientOpacity: 0.22,
  gradientGranularityDeg: 0.25,
  gradientRebuildM: 20000,
  activeMs: 9000,
  settleMs: 1200,
  inputWakeMs: 1500,
});

/** @constant Sonar echoes on contact brackets. When a pulse front reaches a
 *  flight, military aircraft or AIS vessel in the window, the detection
 *  overlay draws a second bracket in `color` around that contact's own
 *  bracket. It starts on the bracket and spreads outward by up to `spreadPx`
 *  as it fades over `fadeMs`, so the frame pulses. Only `layerIds` echo;
 *  mapped installations have no detection bracket. */
export const AWARENESS_RANGE_ECHO = Object.freeze({
  layerIds: ['flights', 'military', 'ais-live-vessels'],
  fadeMs: 1400,
  color: 'rgb(98, 181, 255)',
  spreadPx: 8,
  lineWidth: 1.75,
});

export const VESSEL_FOCUS_RADIUS_M = 3000;

export const SOURCE_LABEL = {
  flights: 'OpenSky',
  military: 'adsb.lol',
  'ais-live-vessels': 'AISStream',
  'military-installations': 'OpenStreetMap',
};

/**
 * Whether a refresh tick could confirm the subject in its source collection.
 * UNCHECKED means the tick did not look — it must never change the verdict.
 */

export const SUBJECT_PRESENCE = Object.freeze({
  LIVE: 'live',
  MISSING: 'missing',
  UNCHECKED: 'unchecked',
});
