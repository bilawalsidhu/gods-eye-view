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
 * hull with a bow.
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
 */
const BODIES = {
  // ── Bus: short, blunt, square-shouldered. The shape everything else reads
  //    against, and the one most people will see most often.
  bus: `
    <path d="M-17,-28 C-17,-32 -14,-34 0,-34 C14,-34 17,-32 17,-28
             L17,28 C17,32 14,34 0,34 C-14,34 -17,32 -17,28 Z"
          fill="white" ${STROKE}/>
    <path d="M-11,-24 L11,-24" ${DETAIL}/>
    <path d="M-11,20 L11,20" ${DETAIL}/>`,

  // ── Tram / light rail: longer and slimmer than a bus, with the two
  //    articulation joints that make a modern low-floor tram unmistakable.
  tram: `
    <path d="M-10,-38 C-10,-41 -8,-42.5 0,-42.5 C8,-42.5 10,-41 10,-38
             L10,38 C10,41 8,42.5 0,42.5 C-8,42.5 -10,41 -10,38 Z"
          fill="white" ${STROKE}/>
    <path d="M-10,-13 L10,-13" ${DETAIL}/>
    <path d="M-10,13 L10,13" ${DETAIL}/>
    <path d="M-8,-34 L8,-34" ${DETAIL}/>`,

  // ── Metro / subway: squared off at both ends, wider than a tram, a single
  //    cab line at the front. Reads as rolling stock, not a road vehicle.
  subway: `
    <path d="M-11.5,-40 L11.5,-40 L11.5,40 L-11.5,40 Z"
          fill="white" ${STROKE}/>
    <path d="M-11.5,-32 L11.5,-32" ${DETAIL}/>
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

  // ── Unknown: a plain rounded marker. Deliberately featureless, so an
  //    unclassified vehicle never pretends to be a mode it is not.
  unknown: `
    <path d="M-10,-26 C-10,-30 -7,-32 0,-32 C7,-32 10,-30 10,-26
             L10,26 C10,30 7,32 0,32 C-7,32 -10,30 -10,26 Z"
          fill="white" ${STROKE}/>`,
};

/** The modes this module can draw. */
export const TRANSIT_ICON_KINDS = Object.freeze(Object.keys(BODIES));

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
 * Data URI for one mode's silhouette, lazily built and cached per kind, size
 * and halo.
 *
 * With a halo, the body is drawn twice: first as a wide dark stroke, then as
 * the shipped white fill with its hairline edge on top, so the ring sits
 * OUTSIDE the silhouette and the interior detail is untouched. The dark ring
 * is what survives NVG's auto-gain and FLIR's luma mapping when the bright
 * core alone would merge with a bright road.
 *
 * @param {string} kind One of TRANSIT_ICON_KINDS; anything else draws `unknown`.
 * @param {number} [px] Raster size.
 * @param {{haloScreenPx?: number, screenPx?: number}} [options]
 * @returns {string} `data:image/svg+xml;base64,...`
 */
export function transitIcon(kind, px = FLEET_RASTER_PX, options = {}) {
  const k = BODIES[kind] ? kind : 'unknown';
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
  const key = `${k}:${selected ? 1 : 0}:${profile}`;
  let uri = _iconCache.get(key);
  if (!uri) {
    const size = VIEW + 2 * frame.pad;
    // Sensor signatures use a broad rounded envelope, without dark interior
    // joints or a second outline eating into the hot core at display resolution.
    const halfW = k === 'bus' || k === 'ferry' || k === 'unknown' ? 48 : 47;
    const halfH = 48;
    const radius = k === 'subway' ? 8 : k === 'rail' ? 12 : 14;
    const capsule = `<path d="M${-halfW + radius},${-halfH} H${halfW - radius} Q${halfW},${-halfH} ${halfW},${-halfH + radius} V${halfH - radius} Q${halfW},${halfH} ${halfW - radius},${halfH} H${-halfW + radius} Q${-halfW},${halfH} ${-halfW},${halfH - radius} V${-halfH + radius} Q${-halfW},${-halfH} ${-halfW + radius},${-halfH} Z" fill="white" />`;
    const body = profile === 'mono' ? capsule : BODIES[k];
    const halo =
      frame.units > 0
        ? body.replace(
            /<path d="([^"]+)"\s+fill="white" [^/]*\/>/,
            (_m, d) =>
              `<path d="${d}" fill="none" stroke="${profile === 'mono' ? '#000000' : '#05080C'}" stroke-opacity="${profile === 'mono' ? 1 : 0.95}" stroke-width="${frame.units.toFixed(2)}" stroke-linejoin="round"/>`,
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
