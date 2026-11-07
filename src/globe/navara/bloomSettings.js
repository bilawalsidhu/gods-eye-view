// The app's Bloom control on Navara, without Navara itself (Node tests):
// the strength the Display slider sets (src/bloom.js
// bloomStrengthFromIntensity, 0..1) as postprocessing BloomEffect settings,
// and the bloom port createNavaraEngine takes. bloom.js adds the effect.
//
// Cesium's bloom stage (src/globe/cesium/postStages.js bloomUniforms) eases
// the strength above a 0.06 dead zone (smoothstep) into a lower contrast, a
// brighter offset and a wider blur: more of the frame glows, further out.
// The same eased value drives the threshold, softness, blur radius and
// strength here. The threshold is chosen in display (sRGB) terms, as
// Cesium's stage reads display RGB, and handed to the effect in the linear
// terms Navara's buffers hold (the exact transfer, as sharpen.js uses).

/** Strength at or under which bloom draws nothing (Cesium's dead zone). */
export const BLOOM_DEAD_ZONE = 0.06;

const srgbToLinear = (value) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

/** The dead zone removed and smoothstepped, as Cesium's stage eases it. */
export function easedBloomStrength(strength) {
  const raw = Math.min(1, Math.max(0, Number(strength) || 0));
  if (raw <= BLOOM_DEAD_ZONE) return 0;
  const t = (raw - BLOOM_DEAD_ZONE) / (1 - BLOOM_DEAD_ZONE);
  return t * t * (3 - 2 * t);
}

/**
 * BloomEffect settings for a strength: the luminance threshold falls from
 * display 0.92 to 0.72, its smoothing widens, the mipmap blur reaches
 * further and the glow strengthens. At full strength a bright map keeps its
 * detail under the glow, as on Cesium (QA: qa-navara-bloom.mjs).
 */
export function bloomSettingsFromStrength(strength) {
  const eased = easedBloomStrength(strength);
  return {
    eased,
    luminanceThreshold: srgbToLinear(0.92 - 0.2 * eased),
    luminanceSmoothing: 0.04 + 0.14 * eased,
    radius: 0.4 + 0.4 * eased,
    intensity: 0.25 + 0.75 * eased,
  };
}

/**
 * The bloom port createNavaraEngine takes: `set({ enabled, strength })`
 * (already checked) adds the effect the first time bloom draws, updates its
 * settings and hides it while off or in the dead zone, so a view that never
 * blooms has no pass. `add(settings)` adds the effect and returns its
 * handle ({ update, delete }); bloom.js supplies it.
 */
export function createBloomPort(add) {
  let handle = null;
  let shown = false;
  return {
    set({ enabled, strength }) {
      const settings = bloomSettingsFromStrength(strength);
      const next = enabled && settings.eased > 0;
      if (!handle) {
        if (!next) return;
        handle = add(settings);
        shown = true;
        return;
      }
      handle.update({ settings, visible: next });
      shown = next;
    },
    /** Navara only (QA): whether the bloom pass draws. */
    shown: () => shown,
    destroy() {
      handle?.delete();
      handle = null;
      shown = false;
    },
  };
}
