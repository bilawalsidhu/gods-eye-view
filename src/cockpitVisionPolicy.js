export const COCKPIT_VISION_MODES = Object.freeze(['optical', 'crt', 'nvg', 'thermal', 'noir']);

const TARGET_STYLE_BY_MODE = Object.freeze({
  crt: 'retro',
  nvg: 'surveillance',
  thermal: 'thermal',
  noir: 'noir',
});

/**
 * Normalize a requested Cockpit vision mode to the inherited preset entry.
 * @param {string} mode Requested vision mode id.
 * @returns {string} A member of COCKPIT_VISION_MODES; unknown falls back to
 *   'optical'.
 */
export function normalizeCockpitVisionMode(mode) {
  return COCKPIT_VISION_MODES.includes(mode) ? mode : 'optical';
}

/**
 * Settle pending map-style crossfades and return their intended final intensities.
 * @param {{[name: string]: {uniforms: {intensity: number}}}} stages Live post-process
 *   stages keyed by preset name.
 * @param {Map<string, {to: number}>|null} transitions In-flight crossfades.
 * @returns {{[name: string]: number}} Baseline intensity per stage name, restored
 *   by applyCockpitVisionStageIntensities().
 */
export function captureCockpitVisionBaseline(stages, transitions) {
  const baseline = {};
  for (const [name, stage] of Object.entries(stages)) {
    const intensity = transitions?.get(name)?.to ?? stage.uniforms.intensity;
    stage.uniforms.intensity = intensity;
    transitions?.delete(name);
    baseline[name] = intensity;
  }
  return baseline;
}

/**
 * Apply Cockpit-only stage intensities without changing any shader parameters.
 * Returns the temporary style whose parameters should be shown, or null.
 * @param {{[name: string]: {uniforms: {intensity: number}}}} stages Live post-process
 *   stages keyed by preset name.
 * @param {string} mode Requested Cockpit vision mode.
 * @param {{[name: string]: number}} [restore] Baseline intensities captured by
 *   captureCockpitVisionBaseline(), reapplied for 'optical'.
 * @returns {string|null} Preset name whose parameters should be shown, or null
 *   when the optical (unchanged) presentation is in force.
 */
export function applyCockpitVisionStageIntensities(stages, mode, restore = {}) {
  const next = normalizeCockpitVisionMode(mode);
  if (next === 'optical') {
    for (const [name, intensity] of Object.entries(restore)) {
      if (stages[name]) stages[name].uniforms.intensity = intensity;
    }
    return null;
  }

  for (const stage of Object.values(stages)) stage.uniforms.intensity = 0;
  const target = TARGET_STYLE_BY_MODE[next] || null;
  if (target && stages[target]) stages[target].uniforms.intensity = 1;
  return target;
}
