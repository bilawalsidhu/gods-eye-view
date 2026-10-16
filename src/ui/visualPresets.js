import { retroShader } from '../styles/retro.js';
import { animeShader } from '../styles/anime.js';
import { noirShader } from '../styles/noir.js';
import { snowShader } from '../styles/snow.js';
import { nightVisionShader } from '../styles/surveillance.js';
import { thermalShader } from '../styles/thermal.js';
import { BLOOM_INTENSITY_DEFAULT } from '../bloom.js';

/** Duration (ms) for shader intensity crossfade between style presets. */
export const TRANSITION_DURATION_MS = 500;
/** Map of style name to its GLSL shader module for post-process stages. */
export const STYLES = {
  retro: retroShader,
  surveillance: nightVisionShader,
  thermal: thermalShader,
  anime: animeShader,
  noir: noirShader,
  snow: snowShader,
};

/**
 * The tactical detection look: Dense at 75%.
 *
 * Owner playtest 2026-08-18: "detection mode… 75% weighted, with the 16% fade
 * and 5% outside, whatever we had. I want that as the default. It should just
 * happen." Fade and outside opacity live in GLOBAL_POST_DEFAULTS, so "whatever
 * we had" still needs nothing here — but they are 7% and 1% now, the outside
 * default having moved 5 → 3 → 1 as the owner locked final tuning after field trials (2026-08-24). What the quote asked for is the
 * baseline of the day, not the two numbers it happened to name.
 *
 * ONE object, shared by the first-load baseline below, by every military style,
 * AND by the Contacts context mode (which OWNS detection while active and
 * restores the prior state on exit — see contactsDetectionPolicy.js). Cockpit
 * deliberately does NOT touch detection: entering it with SPARSE selected leaves
 * SPARSE. Declared ahead of GLOBAL_POST_DEFAULTS because that baseline now reads
 * from it.
 */
export const MILITARY_DETECTION_PRESET = Object.freeze({
  mode: 'dense',
  densityPct: 75,
});

/** The Sharpen slider's default (%) on Cesium, in every preset. */
export const SHARPEN_INTENSITY_DEFAULT = 49;
/** The Sharpen slider's default (%) on the Navara engine. */
export const NAVARA_SHARPEN_INTENSITY_DEFAULT = 80;

/**
 * The sharpen intensity (%) a default, a preset or a share link sets on an
 * engine: Navara reads Cesium's default (49, every preset's value) as its own
 * default (80); any other value, and everything on Cesium, stays as given.
 */
export function sharpenIntensityForEngine(pct, engineKind) {
  return engineKind === 'navara' && pct === SHARPEN_INTENSITY_DEFAULT
    ? NAVARA_SHARPEN_INTENSITY_DEFAULT
    : pct;
}

/** The unsharp mask's `amount` for a slider value normalized to 0..1. */
export const sharpenAmount = (value) => 0.1 + value * 2.0;

/** Baseline post-processing settings applied on first load (before share-link restore). */
export const GLOBAL_POST_DEFAULTS = {
  bloom: { enabled: false, intensity: BLOOM_INTENSITY_DEFAULT },
  sharpen: { enabled: true, intensity: SHARPEN_INTENSITY_DEFAULT },
  hudVariant: 'tactical',
  hudVisible: true,
  // Detection is ON for EVERY style on a first run, Normal included (owner
  // directive 2026-08-22: "detect should also be on by default"). It is the
  // same preset object the military styles and Contacts already apply, so there
  // is one tactical look, not several that can drift.
  //
  // This is a first-LOAD baseline, not an override: `_applyGlobalPostDefaults`
  // runs before any share-link restore, so a link's `dm`/`dd` still lands on top
  // of it. It also deliberately leaves `_detectionUserOverridden` alone — the
  // flag means the OPERATOR hand-edited detection, and a factory default is not
  // that. Turning detection off by hand therefore still sets the flag and still
  // suppresses the military-style auto-enable for the rest of the session.
  detectionMode: MILITARY_DETECTION_PRESET.mode.toUpperCase(),
  detectionDensity: MILITARY_DETECTION_PRESET.densityPct,
  detectionAllocation: 'ELASTIC',
  detectionFadePct: 7,
  detectionOutsideOpacityPct: 1,
  celestialRing: false,
};

// Tactical style defaults applied when users select military style presets.
export const STYLE_PRESET_DEFAULTS = {
  retro: {
    bloom: { enabled: false, intensity: BLOOM_INTENSITY_DEFAULT },
    sharpen: { enabled: true, intensity: SHARPEN_INTENSITY_DEFAULT },
    styleParams: {
      retro: {
        pixelation: 1.0,
        distortion: 0,
        instability: 0.42,
      },
    },
    hudVariant: 'tactical',
    hudVisible: true,
    detection: MILITARY_DETECTION_PRESET,
  },
  surveillance: {
    bloom: { enabled: false, intensity: BLOOM_INTENSITY_DEFAULT },
    sharpen: { enabled: true, intensity: SHARPEN_INTENSITY_DEFAULT },
    styleParams: {
      surveillance: {
        gain: 0.18,
        bloom: 0.22,
        scanlineStr: 0.96,
        pixelation: 1.0,
      },
    },
    hudVariant: 'tactical',
    hudVisible: true,
    detection: MILITARY_DETECTION_PRESET,
  },
  thermal: {
    bloom: { enabled: false, intensity: BLOOM_INTENSITY_DEFAULT },
    sharpen: { enabled: true, intensity: SHARPEN_INTENSITY_DEFAULT },
    styleParams: {
      thermal: {
        sensitivity: 0.85,
        bloom: 0.2,
        mode: 0.33,
        pixelation: 1.0,
      },
    },
    hudVariant: 'tactical',
    hudVisible: true,
    detection: MILITARY_DETECTION_PRESET,
  },
};

/**
 * GLSL fragment shader implementing an unsharp-mask sharpening filter.
 * Samples a 3x3 neighborhood, computes box blur, then adds the
 * difference (center - blur) scaled by `amount` for edge enhancement.
 */
export const SHARPEN_SHADER = /* glsl */ `
  uniform sampler2D colorTexture;
  uniform vec2 colorTextureDimensions;
  uniform float amount;
  in vec2 v_textureCoordinates;

  void main() {
    vec2 uv = v_textureCoordinates;
    vec2 texel = 1.0 / colorTextureDimensions;
    vec4 center = texture(colorTexture, uv);
    vec4 blur = (
      texture(colorTexture, uv + vec2(-texel.x, -texel.y)) +
      texture(colorTexture, uv + vec2( 0.0,     -texel.y)) +
      texture(colorTexture, uv + vec2( texel.x, -texel.y)) +
      texture(colorTexture, uv + vec2(-texel.x,  0.0))     +
      center +
      texture(colorTexture, uv + vec2( texel.x,  0.0))     +
      texture(colorTexture, uv + vec2(-texel.x,  texel.y)) +
      texture(colorTexture, uv + vec2( 0.0,      texel.y)) +
      texture(colorTexture, uv + vec2( texel.x,  texel.y))
    ) / 9.0;
    vec4 sharpened = center + (center - blur) * amount;
    out_FragColor = vec4(clamp(sharpened.rgb, 0.0, 1.0), center.a);
  }
`;

/** Stable display labels for the active style and inherited Cockpit vision. */
export const STYLE_STATUS_LABELS = {
  normal: 'NORMAL',
  retro: 'CRT',
  surveillance: 'NVG',
  thermal: 'FLIR',
  anime: 'ANIME',
  noir: 'NOIR',
  snow: 'SNOW',
};
