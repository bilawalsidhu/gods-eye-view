// src/data/aircraftIcons.js
/**
 * Nose-up white aircraft silhouettes, one per classifyAircraft() kind, as SVG
 * data URIs for Cesium billboards.
 *
 * FIDELITY NOTE (2026-07-02): redrawn at a 96×96 viewBox (glyph centered at
 * 48,48) instead of the old 32×32. The billboards themselves are still added at
 * width/height 20 (24 tracked) in flights.js / militaryFlights.js, so Cesium
 * DOWN-samples this larger, higher-precision source to the same on-screen
 * footprint — crisp anti-aliased edges instead of an upscaled 32px bitmap. The
 * on-screen size is unchanged (the billboard's explicit width/height, not the
 * SVG's, sets the pixel size — the intrinsic SVG size only controls raster
 * fidelity).
 *
 * All glyphs are nose-up (nose toward -Y at rotation 0; the screen-projected
 * rotation pipeline in iconOrientation.js spins the whole glyph). Fill is white
 * with a subtle dark hairline stroke so the tint pipeline (billboard.color =
 * white / cyan-tracked / amber-military, plus .withAlpha fades) keeps working —
 * no per-glyph hardcoded colors that would fight the tint.
 *
 * MIXED-SET UPDATE (2026-08-15, owner Hangar picks): airliner/widebody/
 * turboprop/helicopter use the "refined" recognition-chart redraw;
 * quadjet/glider use the "bold" chart-symbol redraw; light/fastjet keep the
 * original drawings. Raster fidelity doubled (192px source, same 96 coords).
 *
 * The helicopter is a top-down body under a four-blade rotor drawn in three
 * frames (`aircraftIcon('helicopter', px, frame)`, turned by
 * `rotorFrames.js`). Two kinds are not aircraft: `vehicle`, one sprite for
 * every airport vehicle, and `station`, a mast for ground stations, drawn
 * upright.
 *
 * Silhouette language follows skylight's type-aware glyphs (MIT,
 * https://github.com/cpaczek/skylight): slender fuselages, swept wings for
 * jets, long high-aspect wings for the glider, straight wings + prop discs for
 * props, a rotor disc + tail boom + tail-rotor for the helicopter, and a delta
 * for the fast jet. Each class has a DISTINCT planform so it reads at ~20px by
 * shape alone: every glyph is fitted to the same extent, so none is bigger
 * than another.
 */

const VIEW = 96;
const C = VIEW / 2; // 48 — glyph centre

// Hairline dark edge (scaled for the 96 box: ~1.5u ≈ the old 0.5u at 32).
const STROKE =
  'stroke="rgba(0,0,0,0.32)" stroke-width="1.4" stroke-linejoin="round"';
// Heavier edge for the chart-symbol ("bold") glyphs adopted 2026-08-15.
const STROKE_BOLD =
  'stroke="rgba(0,0,0,0.38)" stroke-width="2" stroke-linejoin="round"';
// Softer white for translucent detail (prop discs, rotor disc) — still white so
// the tint multiplies cleanly; only the alpha differs.
const DISC = 'fill="white" fill-opacity="0.5"';

// Each body is drawn in a centred coordinate frame (origin 0,0 = glyph centre),
// nose toward -Y. Numbers are in the 96-unit space (half-extent up to ~45).
const BODIES = {
  // ── Airliner: slender swept-wing narrow-body, two underwing engine pods,
  //    swept tailplane. The canonical jet; everything else reads against it.
  airliner: `
    <path d="M0,-42 C 3.8,-40 4.6,-34 4.6,-26 L 4.6,-14
             L 32,4 L 34,6 L 34,10 L 31.4,9.2 L 4.6,2.4
             L 4.2,20
             L 14,28 L 14,32 L 0,28.6 L -14,32 L -14,28 L -4.2,20
             L -4.6,2.4 L -31.4,9.2 L -34,10 L -34,6 L -32,4 L -4.6,-14
             L -4.6,-26 C -4.6,-34 -3.8,-40 0,-42 Z" fill="white" ${STROKE}/>
    <path d="M-15.5,-1.5 l3,7.6 4,-1.4 -1.5,-8.4 Z" fill="white"/>
    <path d="M15.5,-1.5 l-3,7.6 -4,-1.4 1.5,-8.4 Z" fill="white"/>
    <path d="M-1.6,33.5 L 1.6,33.5 L 1.6,40 L -1.6,40 Z" fill="white"/>`,

  // ── Widebody: same swept jet but noticeably BIGGER span + fatter fuselage,
  //    twin engines set further out. Reads as a heavier airliner.
  widebody: `
    <path d="M0,-45 C 5.6,-43 6.8,-36 6.8,-27 L 6.8,-12
             L 38,9 L 41.5,12.4 L 41.5,16.6 L 37.6,15 L 6.8,6
             L 6.3,21
             L 17,30 L 17,34.6 L 0,30.4 L -17,34.6 L -17,30 L -6.3,21
             L -6.8,6 L -37.6,15 L -41.5,16.6 L -41.5,12.4 L -38,9 L -6.8,-12
             L -6.8,-27 C -6.8,-36 -5.6,-43 0,-45 Z" fill="white" ${STROKE}/>
    <path d="M-19,2 l3.6,9 4.8,-1.7 -1.8,-10 Z" fill="white"/>
    <path d="M19,2 l-3.6,9 -4.8,-1.7 1.8,-10 Z" fill="white"/>
    <path d="M-2,35.5 L 2,35.5 L 2,42.5 L -2,42.5 Z" fill="white"/>`,

  // ── Quadjet: the widest swept jet, with FOUR bold underwing engine pods (two
  //    per wing) that hang well below the trailing edge — the wing reads as a
  //    4-lumped bar even when the individual pods blur together at ~20px.
  quadjet: `
    <path d="M0,-45 C 7,-42 9,-34 9,-25 L 9,-11
             L 46,12 L 46,21 L 9,11.5
             L 8.4,21 L 20,31 L 20,37.5 L 0,32 L -20,37.5 L -20,31 L -8.4,21
             L -9,11.5 L -46,21 L -46,12 L -9,-11
             L -9,-25 C -9,-34 -7,-42 0,-45 Z" fill="white" ${STROKE_BOLD}/>
    <rect x="-31" y="9" width="7" height="12" rx="2" fill="white"/>
    <rect x="-17" y="4.5" width="7" height="12" rx="2" fill="white"/>
    <rect x="10" y="4.5" width="7" height="12" rx="2" fill="white"/>
    <rect x="24" y="9" width="7" height="12" rx="2" fill="white"/>`,

  // ── Turboprop: bold STRAIGHT (unswept) wings — thicker chord than a jet — two
  //    fat nacelles that jut ahead of the leading edge, each capped by a solid
  //    prop disc. Reads as "straight wing with two lumps + discs" at ~20px.
  turboprop: `
    <path d="M0,-40 C 3.4,-38.5 4.2,-33 4.2,-26 L 4.2,-18
             L 36,-15.5 L 36,-7.5 L 4.2,-8
             L 3.8,22
             L 13,27.5 L 13,31.5 L 0,28.6 L -13,31.5 L -13,27.5 L -3.8,22
             L -4.2,-8 L -36,-7.5 L -36,-15.5 L -4.2,-18
             L -4.2,-26 C -4.2,-33 -3.4,-38.5 0,-40 Z" fill="white" ${STROKE}/>
    <circle cx="-17.5" cy="-16.5" r="7.5" fill="white" fill-opacity="0.5"/>
    <circle cx="17.5" cy="-16.5" r="7.5" fill="white" fill-opacity="0.5"/>
    <path d="M-19.5,-19 h4 v5 h-4 Z" fill="white"/>
    <path d="M15.5,-19 h4 v5 h-4 Z" fill="white"/>
    <path d="M-1.7,31.5 L 1.7,31.5 L 1.7,38.5 L -1.7,38.5 Z" fill="white"/>`,

  // ── Light GA: small and CHUNKY — short, DEEP-chord straight wings and a fat
  //    stubby fuselage make it read as a solid little block (not a thin cross),
  //    with a bold nose prop disc. The short deep wing is the anti-glider cue.
  light: `
    <path d="M0,-27
             C 4,-25 5.2,-20 5.2,-13
             L 5.2,-9
             L 27,-9 L 27,6 L 5.2,6
             L 5.2,16
             L 11.5,23 L 11.5,27 L 0,23.5 L -11.5,27 L -11.5,23 L -5.2,16
             L -5.2,6
             L -27,6 L -27,-9 L -5.2,-9
             L -5.2,-13
             C -5.2,-20 -4,-25 0,-27 Z" fill="white" ${STROKE}/>
    <ellipse cx="0" cy="-29" rx="12" ry="3.8" ${DISC}/>`,

  // ── Glider: VERY long, high-aspect TAPERED wings (fat root → thin tips) on a
  //    slim fuselage with a T-tail. The extreme span is the whole identity — it
  //    reads as "the wide skinny one" against light's short stubby wings.
  glider: `
    <path d="M0,-35 C 2.4,-33 3,-29 3,-25 L 3,-14
             L 45,-10.5 L 45,-3.5 L 2.9,-6
             L 2.2,32 L -2.2,32 L -2.9,-6
             L -45,-3.5 L -45,-10.5 L -3,-14
             L -3,-25 C -3,-29 -2.4,-33 0,-35 Z" fill="white" ${STROKE_BOLD}/>
    <rect x="-10.5" y="32.5" width="21" height="5" rx="1.5" fill="white" ${STROKE_BOLD}/>`,

  // ── Fast jet: sharp delta/cropped-delta with a pointed nose, LERX root
  //    blend, and twin tail fins. Aggressive, all-wing.
  fastjet: `
    <path d="M0,-43
             L 3.5,-30
             C 4,-24 4.6,-16 5,-8
             L 27,20 L 27,26 L 6,16
             L 8,30 L 8,34 L 3,31
             L 3,38 L 6.5,42 L 6.5,44 L 0,41.5
             L -6.5,44 L -6.5,42 L -3,38
             L -3,31 L -8,34 L -8,30 L -6,16
             L -27,26 L -27,20 L -5,-8
             C -4.6,-16 -4,-24 -3.5,-30 Z" fill="white" ${STROKE}/>`,
  // 2026-08-15 additions: two NEW classes (bizjet, uav). Same contract as
  // the set above: 96×96 nose-up,
  // white fill, hairline stroke, tint-safe.
  // Business jet — slender fuselage, modest swept wing, aft engines, T-tail.
  bizjet: `
    <path d="M0,-42
             L 2.6,-36 L 3.4,-26 L 3.4,-8
             L 27,8 L 27,13 L 3.6,6
             L 3.6,16
             L 8,18 L 8,26 L 3.8,25
             L 3.2,30 L 15,34 L 15,38 L 2.4,36
             L 0,40
             L -2.4,36 L -15,38 L -15,34 L -3.2,30
             L -3.8,25 L -8,26 L -8,18 L -3.6,16
             L -3.6,6 L -27,13 L -27,8 L -3.4,-8
             L -3.4,-26 L -2.6,-36 Z" fill="white" ${STROKE}/>`,
  // ── TR-3B (hidden 9th kind, Easter egg — NOT a classifyAircraft() output).
  //    The canonical black-triangle silhouette: a dark isosceles delta with a
  //    light at each corner and a dimmer one at the centre. Reached only by
  //    explicit user conversion (see tr3bRegistry.js), never by classification.
  //
  //    DELIBERATE BREAK from the white-fill contract above: this glyph is a
  //    SHADOW, so it carries its own near-black fill. The billboard tint still
  //    multiplies (white fleet / cyan tracked / amber military), which darkens
  //    rather than lightens — the triangle stays a silhouette in every layer,
  //    and the corner lights pick the tint up as their hue.
  tr3b: `
    <path d="M0,-38 L 40,30 L -40,30 Z"
          fill="#0d1014" stroke="rgba(158,184,210,0.34)" stroke-width="1.6"
          stroke-linejoin="round"/>
    <circle cx="0" cy="-24" r="8.5" fill="#c9dcf0" fill-opacity="0.13"/>
    <circle cx="-28" cy="21" r="8.5" fill="#c9dcf0" fill-opacity="0.13"/>
    <circle cx="28" cy="21" r="8.5" fill="#c9dcf0" fill-opacity="0.13"/>
    <circle cx="0" cy="-24" r="4.6" fill="#dceaf8" fill-opacity="0.52"/>
    <circle cx="-28" cy="21" r="4.6" fill="#dceaf8" fill-opacity="0.52"/>
    <circle cx="28" cy="21" r="4.6" fill="#dceaf8" fill-opacity="0.52"/>
    <circle cx="0" cy="6" r="3.4" fill="#dceaf8" fill-opacity="0.26"/>`,

  // ── TR-3B, thermal-reactive variant. Same cold airframe, but the three
  //    corner emitters + the centre one render HOT: near-white cores inside a
  //    baked radial glow, so the FLIR/NVG luminance mapping (and any bloom)
  //    lights them up while the hull stays cold. Selected by the layers
  //    whenever their `irBoost` style param is on (surveillance/thermal/nvg).
  tr3bHot: `
    <defs>
      <radialGradient id="tr3bGlow">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.92"/>
        <stop offset="32%" stop-color="#f2f9ff" stop-opacity="0.44"/>
        <stop offset="100%" stop-color="#dcefff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <path d="M0,-38 L 40,30 L -40,30 Z"
          fill="#0b0e12" stroke="rgba(126,148,172,0.3)" stroke-width="1.6"
          stroke-linejoin="round"/>
    <circle cx="0" cy="-24" r="15" fill="url(#tr3bGlow)"/>
    <circle cx="-28" cy="21" r="15" fill="url(#tr3bGlow)"/>
    <circle cx="28" cy="21" r="15" fill="url(#tr3bGlow)"/>
    <circle cx="0" cy="6" r="10" fill="url(#tr3bGlow)"/>
    <circle cx="0" cy="-24" r="5.2" fill="#ffffff"/>
    <circle cx="-28" cy="21" r="5.2" fill="#ffffff"/>
    <circle cx="28" cy="21" r="5.2" fill="#ffffff"/>
    <circle cx="0" cy="6" r="3.6" fill="#ffffff" fill-opacity="0.82"/>`,

  // Large UAV (Reaper-class) — bulbous sensor nose, very long slender
  // straight wings, slim tail boom, canted V-tail.
  uav: `
    <path d="M0,-40
             C 3.6,-40 4.6,-35 4.4,-30
             L 2.4,-12
             L 43,-7 L 43,-2.5 L 2.3,0
             L 2.1,24
             L 13,32 L 13,36 L 1.6,30
             L 0,38
             L -1.6,30 L -13,36 L -13,32 L -2.1,24
             L -2.3,0 L -43,-2.5 L -43,-7 L -2.4,-12
             L -4.4,-30 C -4.6,-35 -3.6,-40 0,-40 Z" fill="white" ${STROKE}/>`,

  // ── Airport vehicle (type ZVEH, emitter C1/C2): one service van seen from
  //    above, front up, for every kind (fire truck, tug, car, de-icer). A
  //    boxy body, a dark windscreen band and a roof light bar; the layer
  //    tints it amber so it reads apart from aircraft.
  vehicle: `
    <path d="M-12,-39 L 12,-39 L 15,-36 L 15,38 L 13,40 L -13,40 L -15,38
             L -15,-36 Z" fill="white" ${STROKE}/>
    <path d="M-18.5,-25 h4 v3 h-4 Z M14.5,-25 h4 v3 h-4 Z" fill="white" ${STROKE}/>
    <path d="M-13,-32 L 13,-32 L 12,-21 L -12,-21 Z" fill="rgba(0,0,0,0.62)"/>
    <rect x="-10" y="-13" width="20" height="5" rx="1.5" fill="rgba(0,0,0,0.45)"/>`,

  // ── Ground station or obstacle (type GRND, emitter C3–C5): a radio mast
  //    with two pairs of signal arcs, drawn upright on screen, never turned.
  station: `
    <path d="M7.1,-38.4 A 11 11 0 0 1 7.1,-21.6 M-7.1,-38.4 A 11 11 0 0 0 -7.1,-21.6
             M12.2,-44.6 A 19 19 0 0 1 12.2,-15.4 M-12.2,-44.6 A 19 19 0 0 0 -12.2,-15.4"
          fill="none" stroke="rgba(0,0,0,0.32)" stroke-width="5" stroke-linecap="round"/>
    <path d="M7.1,-38.4 A 11 11 0 0 1 7.1,-21.6 M-7.1,-38.4 A 11 11 0 0 0 -7.1,-21.6
             M12.2,-44.6 A 19 19 0 0 1 12.2,-15.4 M-12.2,-44.6 A 19 19 0 0 0 -12.2,-15.4"
          fill="none" stroke="white" stroke-width="3.4" stroke-linecap="round"/>
    <circle cx="0" cy="-30" r="4.5" fill="white" ${STROKE}/>
    <path d="M-2.5,-25 L 2.5,-25 L 7,34 L 13,34 L 13,38 L -13,38 L -13,34
             L -7,34 Z" fill="white" ${STROKE}/>`,
};

/**
 * The helicopter, seen from above: a cabin, tail boom and tail plane under a
 * four-blade main rotor. The rotor turns in {@link ROTOR_FRAMES} frames 30°
 * apart; four blades repeat every 90°, so the third frame steps back onto
 * the first and the loop is seamless. The middle frame (blades as an X) is
 * the still one.
 */
const HELI_ROTOR_CENTRE_Y = -11.2;
const HELI_DISC = `<circle cx="0" cy="${HELI_ROTOR_CENTRE_Y}" r="32.8" fill="white" fill-opacity="0.22"/>`;
const HELI_BODY = `
    <path d="M0,-33.4 L -2.3,-32.1 L -4.2,-28 L -4.3,-30.6 L -6.2,-30.6
             L -6.2,0.2 L -4.3,0.2 L -4.2,-3.1 L -1.9,7.9 L -1.7,18.9
             L -7.4,19.2 L -7.8,24 L -2.9,24.4 L -3.2,35.6 L -1.2,36
             L 0,34.3 L 1.2,36 L 3.2,35.6 L 2.9,24.4 L 7.8,24 L 7.4,19.2
             L 1.7,18.9 L 1.9,7.9 L 4.2,-3.1 L 4.3,0.2 L 6.2,0.2 L 6.2,-30.6
             L 4.3,-30.6 L 4.2,-28 L 2.3,-32.1 Z" fill="white" ${STROKE}/>
    <circle cx="0" cy="${HELI_ROTOR_CENTRE_Y}" r="3.2" fill="white" ${STROKE}/>`;
/** Main-rotor blade angle of each frame, degrees clockwise. */
const ROTOR_ANGLES_DEG = [15, 45, 75];
/** How many rotor frames the helicopter turns through. */
export const ROTOR_FRAMES = ROTOR_ANGLES_DEG.length;
/** The frame a helicopter holds when its rotor does not turn. */
export const ROTOR_STILL_FRAME = 1;

/** A supported helicopter rotor frame, or the still frame. */
export function rotorFrameIndex(frame) {
  return Number.isInteger(frame) && frame >= 0 && frame < ROTOR_FRAMES
    ? frame
    : ROTOR_STILL_FRAME;
}

/** One rotor frame: the disc, two crossed blades at `angle`, the body over them. */
function helicopterBody(frame) {
  const angle = ROTOR_ANGLES_DEG[frame] ?? ROTOR_ANGLES_DEG[ROTOR_STILL_FRAME];
  const blade = (deg) =>
    `<rect x="-32.2" y="${HELI_ROTOR_CENTRE_Y - 2.2}" width="64.4" height="4.4" rx="2.2" fill="white" fill-opacity="0.92" stroke="rgba(0,0,0,0.25)" stroke-width="0.8" transform="rotate(${deg} 0 ${HELI_ROTOR_CENTRE_Y})"/>`;
  return `${HELI_DISC}${blade(angle)}${blade(angle + 90)}${HELI_BODY}`;
}

/**
 * Every sprite draws at one size. The bodies were drawn at different spans
 * (a light aircraft's half-extent is 32.8 units, a quadjet's 47), so each is
 * scaled until its farthest painted edge, stroke included, sits
 * {@link GLYPH_HALF_EXTENT} units from the centre. Values are each body's
 * measured half-extent; aircraftIcons.test.mjs re-measures the rasters.
 */
const GLYPH_HALF_EXTENT = 44;
const BODY_HALF_EXTENT = {
  airliner: 42.7,
  widebody: 45.7,
  quadjet: 47.0,
  turboprop: 40.7,
  light: 32.8,
  glider: 46.0,
  fastjet: 44.7,
  bizjet: 42.7,
  uav: 43.7,
  helicopter: 44.0,
  vehicle: 40.7,
  station: 47.1,
  tr3b: 40.8,
  tr3bHot: 42.3,
};

const _iconCache = new Map();

const _b64 = (s) =>
  typeof btoa === 'function'
    ? btoa(s)
    : Buffer.from(s, 'utf8').toString('base64');

/** Fleet raster: billboards render at ~40–58 DEVICE px (width 20–24 CSS ×
 *  Retina × class scale). Cesium's billboard atlas has no mipmaps, so a big
 *  texture gets GPU-minified into mush (192 px ÷ 40 = 4.8× — the owner's
 *  "soft" glyphs; the pre-2026-08-15 96 px raster aliased instead). Rastering
 *  NEAR the display size lets the browser's SVG AA do the work: crisp AND
 *  smooth. 64 covers the 40–58 px fleet band with ≤1.6× minification. */
const FLEET_RASTER_PX = 64;
/** Raster size of the default fleet glyph. */
export const FLEET_ICON_PX = FLEET_RASTER_PX;
/** Tracked raster: the tracked billboard is the one SUSTAINED large 2D glyph
 *  (close-zoom fleet flybys hand off to 3D models). Keep the 192 px texture so
 *  it stays crisp at its biggest on-screen sizes. */
const TRACKED_RASTER_PX = 192;

/** Raster size of the tracked glyph and every glyph's near image. */
export const TRACKED_ICON_PX = TRACKED_RASTER_PX;
/**
 * Data URI for a class silhouette (lazily built, cached per kind, size and
 * frame). The default size serves the fleet; pass
 * `aircraftIcon(kind, TRACKED_ICON_PX)` for the near image.
 * @param {string} kind A `classifyAircraft()` class, or a TR-3B kind.
 * @param {number} [px] Raster size.
 * @param {number} [frame] A helicopter's rotor frame, 0 to `ROTOR_FRAMES - 1`
 *   (the still frame by default); other kinds have one image.
 * @returns {string}
 */
export function aircraftIcon(kind, px = FLEET_RASTER_PX, frame) {
  const heli = kind === 'helicopter';
  const k = heli || BODIES[kind] ? kind : 'airliner';
  const f = heli ? rotorFrameIndex(frame) : 0;
  const key = `${k}@${px}#${f}`;
  let uri = _iconCache.get(key);
  if (!uri) {
    const body = heli ? helicopterBody(f) : BODIES[k];
    const fit = +(GLYPH_HALF_EXTENT / BODY_HALF_EXTENT[k]).toFixed(4);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${VIEW} ${VIEW}"><g transform="translate(${C},${C}) scale(${fit})">${body}</g></svg>`;
    uri = 'data:image/svg+xml;base64,' + _b64(svg);
    _iconCache.set(key, uri);
  }
  return uri;
}
