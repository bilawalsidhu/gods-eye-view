/**
 * @file Preset-aware transit sprite styling — pure lookup tables mapping the
 * active post-FX style to a sprite treatment the shaders cannot destroy, and
 * the detection tier that carries each mode's colour above them.
 *
 * Why: transit sprites are in-scene billboards, so they pass THROUGH the
 * post-FX chain. NVG and FLIR reduce the scene to luminance, and the mode
 * palette's luma is middling — a green bus, a red metro and an amber tram all
 * collapse to the same dim grey, on a road NVG's auto-gain has pushed to
 * white. The owner's Boston test: "you can barely see these guys".
 *
 * Encoding per profile, the traffic-dot precedent applied to a glyph:
 *  - `mono` (surveillance/NVG, thermal/FLIR, noir, cockpit nvg/thermal): the
 *    sprite is WHITE — the hottest end of grayscale FLIR and of the Ironbow
 *    ramp, and the brightest phosphor under NVG — drawn larger, with a dark
 *    halo sized in SCREEN pixels so it keeps local contrast on a bright road
 *    through any luma mapping. Black-hot FLIR inverts it, deliberately: a
 *    black sprite with a light ring is what a hot object looks like there.
 *  - `crt` (retro): saturated per-mode colours that survive posterisation,
 *    a size boost to out-shout the pixel grid, and a thinner halo.
 *  - `normal` (normal/anime/snow/unknown): every lookup returns the shipped
 *    value — mode colour, shipped size, hairline edge only.
 *
 * Brackets are a different matter. The detection canvas composites ABOVE the
 * post-FX chain, so a tier colour is literal screen RGB in every preset: the
 * brackets carry the mode colour the sprites can no longer encode, the way
 * traffic's brackets carry congestion. Tier colours per theme live in
 * `src/overlays/worldOverlayTokens.js`.
 *
 * Cesium-free so the tables are unit-testable; the layer maps them to Cesium
 * colours and billboard sizes at spawn and restyle time.
 *
 * @module data/transitPresetStyle
 */

/** @const {Object<string,'mono'|'crt'>} Style name → non-normal profile. */
const PROFILE_BY_STYLE = Object.freeze({
  surveillance: 'mono', // NVG — P43 phosphor × luma
  thermal: 'mono', // FLIR — grayscale/Ironbow × luma
  noir: 'mono', // full desaturation
  nvg: 'mono', // cockpit vision names its modes directly
  retro: 'crt', // CRT — hue survives, small glyphs don't
});

/**
 * Per-profile sprite treatment. `rgba` is [r,g,b] 0–255 + alpha 0–1;
 * `scale` multiplies the shipped billboard size; `outlinePx` is the dark
 * halo's width in FINAL SCREEN PIXELS, which is the only unit that means
 * anything for a glyph rendered at eighteen pixels — the shipped 1.5-unit
 * hairline in a 96-unit box is 0.28 px on screen, and vanishes.
 */
const SPRITE_STYLE = Object.freeze({
  mono: Object.freeze({
    rgba: Object.freeze([255, 255, 255, 1]),
    scale: 1.4,
    outlinePx: 2.5,
  }),
  crt: Object.freeze({
    scale: 1.3,
    outlinePx: 1.25,
    rgbaByMode: Object.freeze({
      bus: Object.freeze([0, 255, 102, 1]),
      tram: Object.freeze([255, 179, 0, 1]),
      subway: Object.freeze([255, 59, 48, 1]),
      rail: Object.freeze([215, 139, 255, 1]),
      ferry: Object.freeze([58, 208, 255, 1]),
      unknown: Object.freeze([255, 255, 255, 1]),
    }),
  }),
});

/** Modes with a bracket tier of their own. */
const TIER_MODES = Object.freeze([
  'bus',
  'tram',
  'subway',
  'rail',
  'ferry',
  'unknown',
]);

/**
 * Classify a style name into a transit styling profile.
 * @param {string|null|undefined} styleName - Active style (e.g. 'thermal').
 * @returns {'normal'|'mono'|'crt'} Styling profile; unknown → 'normal'.
 */
export function transitStyleProfile(styleName) {
  return PROFILE_BY_STYLE[styleName] || 'normal';
}

/**
 * Preset sprite colour, or null to keep the shipped mode colour.
 * @param {string|null|undefined} styleName
 * @param {string} mode Transit mode.
 * @returns {number[]|null} [r,g,b,a] with rgb 0–255, alpha 0–1, or null.
 */
export function presetSpriteRgba(styleName, mode) {
  const profile = transitStyleProfile(styleName);
  if (profile === 'mono') return SPRITE_STYLE.mono.rgba;
  if (profile === 'crt') {
    return (
      SPRITE_STYLE.crt.rgbaByMode[mode] || SPRITE_STYLE.crt.rgbaByMode.unknown
    );
  }
  return null;
}

/**
 * Multiplier a preset applies to the shipped billboard size.
 * @param {string|null|undefined} styleName
 * @returns {number} 1 under the normal profile.
 */
export function presetSpriteScale(styleName, selected = false) {
  if (transitStyleProfile(styleName) === 'mono')
    return selected ? 36 / 30 : 28 / 20;
  return SPRITE_STYLE[transitStyleProfile(styleName)]?.scale ?? 1;
}

/**
 * Dark-halo width in final screen pixels, or 0 for the shipped hairline only.
 * @param {string|null|undefined} styleName
 * @returns {number}
 */
export function presetSpriteOutlinePx(styleName, selected = false) {
  return (
    SPRITE_STYLE[transitStyleProfile(styleName)]?.outlinePx ??
    (selected ? 1.5 : 1)
  );
}

/**
 * Detection-overlay tier key for a transit mode. Every theme's `tiers`
 * table carries these six, so the bracket colour is per mode in every
 * preset. Unlike traffic, transit sets its tier keyless as well: the feeds
 * are keyless, and there is no separate keyless experience to keep
 * byte-identical.
 * @param {string} mode
 * @returns {string}
 */
export function transitModeTier(mode) {
  return `transit_${TIER_MODES.includes(mode) ? mode : 'unknown'}`;
}

/** The tier keys this module can produce, for the tables that must carry them. */
export const TRANSIT_TIER_KEYS = Object.freeze(
  TIER_MODES.map((mode) => `transit_${mode}`),
);
