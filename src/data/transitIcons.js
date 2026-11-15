import {
  presetSpriteScale,
  presetSpriteOutlinePx,
  transitStyleProfile,
} from './transitPresetStyle.js';
// src/data/transitIcons.js
/**
 * Front-up transit-vehicle silhouettes, one per mode, as SVG data URIs for
 * Cesium billboards.
 *
 * Same house language as `aircraftIcons.js`: a 96-unit viewBox with the glyph
 * centred at (48,48), drawn nose toward -Y so the screen-projected rotation in
 * `iconOrientation.js` can spin the whole glyph, filled WHITE with a dark
 * hairline edge so the tint pipeline (billboard.color = the mode colour, plus
 * `.withAlpha` fades) keeps working. No glyph carries a colour of its own; a
 * hardcoded fill would fight the tint that tells a person what they are looking
 * at.
 *
 * These are plan views, the way a vehicle reads from a camera above a street —
 * not side elevations. Each mode has a DISTINCT outline so it is recognisable
 * at the ~18 px the fleet renders at, by shape and not only by colour: a bus is
 * short and blunt, a tram is long and slender with articulation joints, a metro
 * car is squared off, a mainline train has a tapered nose, and a ferry is a
 * hull with a bow. A trolleybus trails its two poles, a cable car is a short
 * single car, a monorail the slimmest bullet, a funicular hangs off its rope,
 * and a gondola is a cabin on its cable.
 *
 * Interior detail is drawn with the same dark hairline as the edge — windscreen
 * lines, articulation joints, a deck line — because a solid dark panel would
 * darken the tint and a white-on-white panel would vanish.
 */

const VIEW = 96;
const C = VIEW / 2; // 48 — glyph centre

/** Hairline dark edge, matching the aircraft glyph weight at this box size. */
const STROKE =
  'stroke="rgba(0,0,0,0.34)" stroke-width="1.5" stroke-linejoin="round"';
/** Interior panel lines: the same ink, thinner, capped so joints read cleanly. */
const DETAIL =
  'stroke="rgba(0,0,0,0.30)" stroke-width="1.5" stroke-linecap="round" fill="none"';

/**
 * Each body is drawn in a centred frame (origin 0,0 = glyph centre), front
 * toward -Y, in the 96-unit space (half-extent up to ~45).
 *
 * Two sets. `HEADING_BODIES` is what a vehicle with a known course wears: every
 * outline has a front that cannot be mistaken for its back at fleet size — a
 * nose, a bow or a chamfered cab — because at twenty pixels a bus drawn as a
 * near-symmetric box gives no hint which way it is going, and a hairline
 * windscreen is far below one pixel. The front is part of the OUTLINE, not
 * interior ink, so it survives the tint, the halo (which strokes the outline)
 * and the sensor profiles (which keep only the outline).
 *
 * `NEUTRAL_BODIES` is what a vehicle with NO known course wears. Its billboard
 * sits at rotation 0, so a pointed glyph would claim it is heading north; these
 * outlines are the same footprint, symmetric end to end, and claim nothing.
 */
const HEADING_BODIES = {
  // ── Bus: short, broad, square-shouldered behind an arrow-like nose. The
  //    shape everything else reads against, and the one most people will see
  //    most often, so it carries the boldest front.
  bus: `
    <path d="M0,-41 L17,-25 L17,28 C17,32 14,34 0,34 C-14,34 -17,32 -17,28
             L-17,-25 Z"
          fill="white" ${STROKE}/>
    <path d="M-11,-21 L11,-21" ${DETAIL}/>
    <path d="M-11,20 L11,20" ${DETAIL}/>`,

  // ── Tram / light rail: longer and slimmer than a bus, a short pointed cab
  //    and the two articulation joints of a modern low-floor tram.
  tram: `
    <path d="M0,-44 L10,-33 L10,38 C10,41 8,42.5 0,42.5 C-8,42.5 -10,41 -10,38
             L-10,-33 Z"
          fill="white" ${STROKE}/>
    <path d="M-10,-13 L10,-13" ${DETAIL}/>
    <path d="M-10,13 L10,13" ${DETAIL}/>
    <path d="M-8,-29 L8,-29" ${DETAIL}/>`,

  // ── Metro / subway: squared off and wider than a tram, the cab end
  //    chamfered to a narrow flat face; the rear stays square.
  subway: `
    <path d="M-4,-40 L4,-40 L11.5,-30 L11.5,40 L-11.5,40 L-11.5,-30 Z"
          fill="white" ${STROKE}/>
    <path d="M-11.5,-26 L11.5,-26" ${DETAIL}/>
    <path d="M-11.5,0 L11.5,0" ${DETAIL}/>
    <path d="M-11.5,32 L11.5,32" ${DETAIL}/>`,

  // ── Mainline / commuter rail: the tapered nose of an intercity set, longer
  //    than anything else in the set.
  rail: `
    <path d="M0,-45 C5,-45 9.5,-41 10.5,-34 L10.5,40
             C10.5,43 8.5,44.5 0,44.5 C-8.5,44.5 -10.5,43 -10.5,40
             L-10.5,-34 C-9.5,-41 -5,-45 0,-45 Z"
          fill="white" ${STROKE}/>
    <path d="M-9,-30 L9,-30" ${DETAIL}/>
    <path d="M-10.5,6 L10.5,6" ${DETAIL}/>`,

  // ── Ferry: a hull. Pointed bow, square stern, superstructure amidships —
  //    the only glyph in the set that is not a box on rails or rubber.
  ferry: `
    <path d="M0,-44 C6,-38 12,-26 12.5,-14 L12.5,34
             C12.5,37 11,38 0,38 C-11,38 -12.5,37 -12.5,34
             L-12.5,-14 C-12,-26 -6,-38 0,-44 Z"
          fill="white" ${STROKE}/>
    <path d="M-7.5,-6 L7.5,-6 L7.5,20 L-7.5,20 Z" ${DETAIL}/>`,

  // ── Trolleybus: a bus a little narrower, trailing the two trolley poles
  //    that reach back to its wires. Body and poles are one outline, so no
  //    edge is drawn across the body.
  trolleybus: `
    <path d="M0,-41 L15,-26 L15,25 C15,28.5 13,30 9,30 L7.5,30 L7.5,42 L4,42
             L4,30 L-4,30 L-4,42 L-7.5,42 L-7.5,30 L-9,30 C-13,30 -15,28.5 -15,25
             L-15,-26 Z"
          fill="white" ${STROKE}/>
    <path d="M-10,-21 L10,-21" ${DETAIL}/>`,

  // ── Cable car (street cable railway): a short single car, under half a
  //    tram, with open platforms at both ends.
  cable_tram: `
    <path d="M0,-30 L11,-21 L11,26 C11,28 9,29 0,29 C-9,29 -11,28 -11,26
             L-11,-21 Z"
          fill="white" ${STROKE}/>
    <path d="M-11,-12 L11,-12" ${DETAIL}/>
    <path d="M-11,18 L11,18" ${DETAIL}/>`,

  // ── Monorail: the slimmest train in the set, a rounded bullet nose over
  //    its beam.
  monorail: `
    <path d="M0,-45 C3,-45 8.5,-36 8.5,-22 L8.5,42 L-8.5,42 L-8.5,-22
             C-8.5,-36 -3,-45 0,-45 Z"
          fill="white" ${STROKE}/>
    <path d="M0,-18 L0,38" ${DETAIL}/>`,

  // ── Funicular: a squat car hauled by the rope at its upper end.
  funicular: `
    <path d="M-6,-30 L6,-30 L11,-24 L11,36 L-11,36 L-11,-24 Z
             M-1.75,-46 L1.75,-46 L1.75,-30 L-1.75,-30 Z"
          fill="white" ${STROKE}/>
    <path d="M-11,-8 L11,-8" ${DETAIL}/>
    <path d="M-11,14 L11,14" ${DETAIL}/>`,

  // ── Gondola (aerial lift): a cabin hung on the cable that runs through
  //    it; the cabin's nose is its front.
  aerial_lift: `
    <path d="M0,-18 L12,-7 L12,14 C12,16 10,17 0,17 C-10,17 -12,16 -12,14
             L-12,-7 Z
             M-2.5,-40 L2.5,-40 L2.5,46 L-2.5,46 Z"
          fill="white" ${STROKE}/>`,

  // ── Unknown: a plain marker with a nose and nothing else, so an
  //    unclassified vehicle never pretends to be a mode it is not.
  unknown: `
    <path d="M0,-38 L10,-24 L10,26 C10,30 7,32 0,32 C-7,32 -10,30 -10,26
             L-10,-24 Z"
          fill="white" ${STROKE}/>`,
};

const NEUTRAL_BODIES = {
  bus: `
    <path d="M-17,-28 C-17,-32 -14,-34 0,-34 C14,-34 17,-32 17,-28
             L17,28 C17,32 14,34 0,34 C-14,34 -17,32 -17,28 Z"
          fill="white" ${STROKE}/>
    <path d="M-11,-20 L11,-20" ${DETAIL}/>
    <path d="M-11,20 L11,20" ${DETAIL}/>`,

  tram: `
    <path d="M-10,-38 C-10,-41 -8,-42.5 0,-42.5 C8,-42.5 10,-41 10,-38
             L10,38 C10,41 8,42.5 0,42.5 C-8,42.5 -10,41 -10,38 Z"
          fill="white" ${STROKE}/>
    <path d="M-10,-13 L10,-13" ${DETAIL}/>
    <path d="M-10,13 L10,13" ${DETAIL}/>`,

  subway: `
    <path d="M-11.5,-40 L11.5,-40 L11.5,40 L-11.5,40 Z"
          fill="white" ${STROKE}/>
    <path d="M-11.5,-32 L11.5,-32" ${DETAIL}/>
    <path d="M-11.5,0 L11.5,0" ${DETAIL}/>
    <path d="M-11.5,32 L11.5,32" ${DETAIL}/>`,

  rail: `
    <path d="M-10.5,-40 C-10.5,-43 -8.5,-44.5 0,-44.5 C8.5,-44.5 10.5,-43 10.5,-40
             L10.5,40 C10.5,43 8.5,44.5 0,44.5 C-8.5,44.5 -10.5,43 -10.5,40 Z"
          fill="white" ${STROKE}/>
    <path d="M-10.5,-6 L10.5,-6" ${DETAIL}/>
    <path d="M-10.5,6 L10.5,6" ${DETAIL}/>`,

  ferry: `
    <path d="M-12.5,-30 C-12.5,-36 -8,-38 0,-38 C8,-38 12.5,-36 12.5,-30
             L12.5,30 C12.5,36 8,38 0,38 C-8,38 -12.5,36 -12.5,30 Z"
          fill="white" ${STROKE}/>
    <path d="M-7.5,-13 L7.5,-13 L7.5,13 L-7.5,13 Z" ${DETAIL}/>`,

  trolleybus: `
    <path d="M-15,-26 C-15,-30 -13,-32 -9,-32 L-7.5,-32 L-7.5,-42 L-4,-42
             L-4,-32 L4,-32 L4,-42 L7.5,-42 L7.5,-32 L9,-32 C13,-32 15,-30 15,-26
             L15,26 C15,30 13,32 9,32 L7.5,32 L7.5,42 L4,42 L4,32 L-4,32 L-4,42
             L-7.5,42 L-7.5,32 L-9,32 C-13,32 -15,30 -15,26 Z"
          fill="white" ${STROKE}/>`,

  cable_tram: `
    <path d="M-11,-25 C-11,-27 -9,-28 0,-28 C9,-28 11,-27 11,-25
             L11,25 C11,27 9,28 0,28 C-9,28 -11,27 -11,25 Z"
          fill="white" ${STROKE}/>
    <path d="M-11,-17 L11,-17" ${DETAIL}/>
    <path d="M-11,17 L11,17" ${DETAIL}/>`,

  monorail: `
    <path d="M0,-44 C5,-44 8.5,-38 8.5,-28 L8.5,28 C8.5,38 5,44 0,44
             C-5,44 -8.5,38 -8.5,28 L-8.5,-28 C-8.5,-38 -5,-44 0,-44 Z"
          fill="white" ${STROKE}/>
    <path d="M0,-24 L0,24" ${DETAIL}/>`,

  funicular: `
    <path d="M-11,-30 L11,-30 L11,30 L-11,30 Z
             M-1.75,-46 L1.75,-46 L1.75,-30 L-1.75,-30 Z
             M-1.75,30 L1.75,30 L1.75,46 L-1.75,46 Z"
          fill="white" ${STROKE}/>
    <path d="M-11,-10 L11,-10" ${DETAIL}/>
    <path d="M-11,10 L11,10" ${DETAIL}/>`,

  aerial_lift: `
    <path d="M-12,-14 C-12,-16 -10,-17 0,-17 C10,-17 12,-16 12,-14
             L12,14 C12,16 10,17 0,17 C-10,17 -12,16 -12,14 Z
             M-2.5,-46 L2.5,-46 L2.5,46 L-2.5,46 Z"
          fill="white" ${STROKE}/>`,

  unknown: `
    <path d="M-10,-26 C-10,-30 -7,-32 0,-32 C7,-32 10,-30 10,-26
             L10,26 C10,30 7,32 0,32 C-7,32 -10,30 -10,26 Z"
          fill="white" ${STROKE}/>`,
};

/** The modes this module can draw. */
export const TRANSIT_ICON_KINDS = Object.freeze(Object.keys(HEADING_BODIES));

const _iconCache = new Map();

const _b64 = (s) =>
  typeof btoa === 'function'
    ? btoa(s)
    : Buffer.from(s, 'utf8').toString('base64');

/**
 * Fleet raster size. Same reasoning as the aircraft fleet glyphs: Cesium's
 * billboard atlas has no mipmaps, so a texture far larger than its on-screen
 * footprint is GPU-minified into mush. Transit billboards render around 14–20
 * CSS px, so 48 px of source covers the band on a Retina display with very
 * little minification.
 */
const FLEET_RASTER_PX = 48;
/** The selected vehicle draws bigger and deserves a crisper source. */
export const SELECTED_ICON_PX = 96;

/**
 * On-screen size the fleet glyph is authored for. A halo width asked for in
 * screen pixels is converted to viewBox units against this, so "two pixels of
 * ring" means two pixels on an eighteen-pixel billboard.
 */
export const FLEET_SCREEN_PX = 20;

/**
 * How a halo changes the glyph's frame. A thick outer stroke would clip at
 * the 96-unit box (the tram already reaches 42.5 of 48), so the viewBox is
 * padded by the stroke and the billboard has to grow by the same ratio to
 * keep the body its shipped size on screen.
 *
 * @param {number} haloScreenPx Ring width in final screen pixels (0 = none).
 * @param {number} [screenPx] Billboard size the ring is specified against.
 * @returns {{units: number, pad: number, ratio: number}} Stroke width in
 *   viewBox units (the visible ring is half of it, outside the body), the
 *   padding added on every side, and the frame growth factor to apply to the
 *   billboard's width and height.
 */
export function haloFrame(haloScreenPx, screenPx = FLEET_SCREEN_PX) {
  const ring = Number.isFinite(haloScreenPx) ? Math.max(0, haloScreenPx) : 0;
  if (ring === 0) return { units: 0, pad: 0, ratio: 1 };
  // Half the stroke lies outside the body, so a ring of R px needs 2R of
  // stroke. One screen pixel is VIEW/screenPx units.
  const units = (2 * ring * VIEW) / Math.max(1, screenPx);
  const pad = Math.ceil(units / 2) + 1;
  return { units, pad, ratio: (VIEW + 2 * pad) / VIEW };
}

/** Number of raster variants ever built — a bound a test can hold the cache to. */
export function transitIconCacheSize() {
  return _iconCache.size;
}

/**
 * Data URI for one mode's silhouette, lazily built and cached per kind, size,
 * halo and whether the vehicle has a known course.
 *
 * With a halo, the body is drawn twice: first as a wide dark stroke, then as
 * the shipped white fill with its hairline edge on top, so the ring sits
 * OUTSIDE the silhouette and the interior detail is untouched. The dark ring
 * is what survives NVG's auto-gain and FLIR's luma mapping when the bright
 * core alone would merge with a bright road.
 *
 * @param {string} kind One of TRANSIT_ICON_KINDS; anything else draws `unknown`.
 * @param {number} [px] Raster size.
 * @param {{haloScreenPx?: number, screenPx?: number, style?: string,
 *   heading?: boolean}} [options] `heading: false` draws the symmetric outline
 *   for a vehicle whose course is unknown (its billboard is not rotated, so a
 *   front would point north for no reason).
 * @returns {string} `data:image/svg+xml;base64,...`
 */
export function transitIcon(kind, px = FLEET_RASTER_PX, options = {}) {
  const k = HEADING_BODIES[kind] ? kind : 'unknown';
  const selected = px > FLEET_RASTER_PX;
  px = selected ? SELECTED_ICON_PX : FLEET_RASTER_PX;
  const profile = transitStyleProfile(
    options.style ||
      (options.haloScreenPx >= 2
        ? 'thermal'
        : options.haloScreenPx === 1.25
          ? 'retro'
          : 'normal'),
  );
  const style =
    profile === 'mono' ? 'thermal' : profile === 'crt' ? 'retro' : 'normal';
  const displayPx = (selected ? 30 : 20) * presetSpriteScale(style, selected);
  const frame = haloFrame(presetSpriteOutlinePx(style, selected), displayPx);
  const heading = options.heading !== false;
  const bodies = heading ? HEADING_BODIES : NEUTRAL_BODIES;
  const key = `${k}:${selected ? 1 : 0}:${profile}:${heading ? 'h' : 'n'}`;
  let uri = _iconCache.get(key);
  if (!uri) {
    const size = VIEW + 2 * frame.pad;
    // Reuse the exact outer path. Sensors fill its interior without panel ink.
    const silhouette = bodies[k].match(/<path d="([^"]+)"/)[1];
    const body =
      profile === 'mono'
        ? `<path d="${silhouette}" fill="white" />`
        : bodies[k];
    const halo =
      frame.units > 0
        ? profile === 'mono'
          ? `<path d="${silhouette}" fill="none" stroke="#05080C" stroke-opacity="1" stroke-width="${frame.units.toFixed(2)}" stroke-linejoin="round"/>`
          : body.replace(
              /<path d="([^"]+)"\s+fill="white" [^/]*\/>/,
              (_m, d) =>
                `<path d="${d}" fill="none" stroke="#05080C" stroke-opacity="0.95" stroke-width="${frame.units.toFixed(2)}" stroke-linejoin="round"/>`,
            )
        : '';
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(px * frame.ratio)}" height="${Math.round(px * frame.ratio)}" viewBox="${-frame.pad} ${-frame.pad} ${size} ${size}">` +
      `<g transform="translate(${C},${C})">${halo}${body}</g></svg>`;
    uri = 'data:image/svg+xml;base64,' + _b64(svg);
    _iconCache.set(key, uri);
  }
  return uri;
}
