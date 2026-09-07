/**
 * @module worldOverlayTokens
 * @description Visual constants shared by the world-overlay host, painters,
 * and source presentation bridges. Keep source selection and data semantics in
 * their owning modules; this file is the single home for cross-source canvas
 * presentation values.
 */

/** Shared visual tokens used by every world-overlay source. */
export const WORLD_OVERLAY_STYLE = Object.freeze({
  background: 'rgba(4, 12, 16, 0.82)',
  selectedBackground: 'rgba(5, 18, 24, 0.94)',
  border: 'rgba(190, 232, 242, 0.18)',
  selectedBorder: 'rgba(107, 232, 255, 0.72)',
  title: 'rgba(232, 240, 244, 0.96)',
  detail: 'rgba(147, 161, 173, 0.92)',
  leader: 'rgba(147, 213, 228, 0.58)',
  accent: '#6be8ff',
  fontLabel: '500 10px "JetBrains Mono", monospace',
  fontTrack: '600 10px "JetBrains Mono", monospace',
  fontTitle: '600 12px "JetBrains Mono", monospace',
  fontDetail: '500 10.5px "JetBrains Mono", monospace',
  fontSelected: '600 13px "JetBrains Mono", monospace',
  fontTrackedTitle: '600 13px "JetBrains Mono", monospace',
  fontTrackedDetail: '500 11px "JetBrains Mono", monospace',
  radius: 4,
});

/** CCTV's field-tested thumbnail-card overrides on top of shared card chrome. */
export const CCTV_THUMBNAIL_STYLE = Object.freeze({
  padding: 4,
  titleHeight: 13,
  titleChars: 15,
  background: WORLD_OVERLAY_STYLE.background,
  titleColor: 'rgba(210, 236, 244, 0.95)',
  titleFont: '600 10px "JetBrains Mono", monospace',
  accent: 'rgb(107, 232, 255)',
  leader: 'rgba(107, 232, 255, 0.6)',
  rule: 'rgba(107, 232, 255, 0.95)',
  ruleHeight: 2,
  radius: 4,
});

/** Detection fonts and compositor glow retained exactly from the source renderer. */
export const DETECTION_STYLE = Object.freeze({
  font: '10px JetBrains Mono, monospace',
  microFont: '9px JetBrains Mono, monospace',
  glowPx: 3,
});

/**
 * Alpha of the tracked readout card's backing plate — the legibility reference
 * every other backing is measured against. Derived from
 * `WORLD_OVERLAY_STYLE.background` and asserted against it in unit tests, so a
 * future retune of the card cannot silently desynchronize the ambient family.
 */
export const CARD_PLATE_ALPHA = 0.82;

/**
 * Ambient detection callouts carry a LIGHTER member of the card's backing
 * family: enough plate to hold small mono text against sunlit imagery, not so
 * much that a field of them reads as a wall of boxes. `calloutPlate` sits at
 * ~58% of `CARD_PLATE_ALPHA`; `calloutPlateSpace` is the owner-requested
 * "slightly higher opacity so the text pops" for space-tier (satellite)
 * contacts, which sit over the high-albedo lit Earth disc more often than
 * aircraft do.
 *
 * These are DARK plates painted with NORMAL blending, which makes them
 * self-adapting: over night terrain or space a dark plate on a dark scene is
 * nearly invisible, while over bright ground it does the full darkening job.
 * That is the same mechanism the tracked card uses, and the reason it survives
 * every style — see `PLATE_ALPHA_BAND` in the tests.
 */
export const DETECTION_PLATE_BAND = Object.freeze({ min: 0.5, max: 0.62 });

/**
 * What survives of a callout plate when SKY, not ground, is behind the label.
 *
 * The plate exists to hold small mono text against sunlit imagery. Against the
 * horizon it has no job to do — there is nothing bright and busy to separate
 * the text from — and at full strength it reads as a row of dark boxes pasted
 * on an empty sky, which is the one place the pre-plate bare-text look was
 * already better (owner field call, 2026-08-21).
 *
 * So the plate is SCALED here rather than replaced: every theme keeps its own
 * hue and its own relative weight, and the sky case lands at a whisper that is
 * visually the old bare text while still catching a bright cloud. Which case a
 * given label is in comes from `skyBackdropFactor`, blended across a band so
 * contacts crossing the horizon fade instead of popping.
 */
export const SKY_PLATE_SCALE = 0.22;

/**
 * Sensor-style palettes for the host-owned detection paint lane.
 *
 * `labelBg` is the SCANLINE wash colour and stays on the screen-blended sensor
 * surface. `calloutPlate`/`calloutPlateSpace` are the callout backings and are
 * painted on the shared normal-blend canvas; they are deliberately separate
 * tokens so retuning label legibility can never shift the scanline wash.
 * The plate stays visually related to the label chrome rather than appearing
 * as a neutral box dropped on top of the image.
 */
export const DETECTION_THEME_MAP = Object.freeze({
  _default: {
    line: 'rgba(0, 244, 255, 0.9)',
    label: 'rgba(200, 250, 255, 0.97)',
    labelBg: 'rgba(2, 18, 26, 0.66)',
    calloutPlate: 'rgba(2, 18, 26, 0.46)',
    calloutPlateSpace: 'rgba(2, 18, 26, 0.54)',
    glow: 'rgba(0, 244, 255, 0.4)',
    dim: 'rgba(150, 200, 215, 0.66)',
    cardBorder: 'rgba(255, 255, 255, 0.12)',
    blend: 'screen',
    filter: 'contrast(1.05) saturate(1.05)',
    scanline: 0.05,
    tiers: {
      civil: '#22e0ff', military: '#ffb347', sea: '#3fe0c8', space: '#bda4ff', vehicle: '#8fa6b4',
      veh_jam: '#e05252', veh_slow: '#f0b23e', veh_free: '#2ecc71', veh_nodata: '#c9c9c9',
    },
  },
});
