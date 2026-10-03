export const PERCEPTION_TIERS = Object.freeze([
  'state',
  'selected',
  'query',
  'crop',
  'viewport',
  'multimodal',
  'abstain',
]);

/**
 * Pick the cheapest evidence tier already known to be sufficient.
 *
 * Callers own the sufficiency checks. This helper only enforces escalation
 * order and capability bounds; it never infers whether a lower tier contains
 * facts that are not actually present.
 *
 * @param {object} input
 * @param {boolean} [input.stateSufficient=false]
 * @param {boolean} [input.selectedSufficient=false]
 * @param {boolean} [input.querySufficient=false]
 * @param {boolean} [input.cropSufficient=false]
 * @param {boolean} [input.viewportSufficient=false]
 * @param {boolean} [input.multimodalAllowed=true]
 * @returns {'state'|'selected'|'query'|'crop'|'viewport'|'multimodal'|'abstain'}
 */
export function resolvePerceptionTier({
  stateSufficient = false,
  selectedSufficient = false,
  querySufficient = false,
  cropSufficient = false,
  viewportSufficient = false,
  multimodalAllowed = true,
} = {}) {
  if (stateSufficient) return 'state';
  if (selectedSufficient) return 'selected';
  if (querySufficient) return 'query';
  if (cropSufficient) return 'crop';
  if (viewportSufficient) return 'viewport';
  return multimodalAllowed ? 'multimodal' : 'abstain';
}

/**
 * Classify whether an observed choice was a missed or wasted perception step.
 *
 * @param {object} input
 * @param {string} input.chosenTier
 * @param {string} input.minimumSufficientTier
 * @returns {'matched'|'missed'|'wasted'|'unknown'}
 */
export function classifyPerceptionChoice({
  chosenTier,
  minimumSufficientTier,
} = {}) {
  const chosen = PERCEPTION_TIERS.indexOf(chosenTier);
  const minimum = PERCEPTION_TIERS.indexOf(minimumSufficientTier);
  if (chosen < 0 || minimum < 0) return 'unknown';
  if (chosen === minimum) return 'matched';
  return chosen < minimum ? 'missed' : 'wasted';
}
