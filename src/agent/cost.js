/**
 * Per-command cost for the typed agent.
 *
 * Shared because both sides need it for different reasons: the server knows
 * the real prefix size and attaches an estimate to each model it offers, and
 * the console formats that estimate next to the model picker. A reader
 * deciding between a hosted model and one on their own GPU is making a cost
 * decision, so the number belongs in front of them before they type.
 */

/** Round trips one typed command costs: the tool-calling turn, then the answer. */
const DEFAULT_ROUND_TRIPS = 2;

/** New input tokens one command adds on top of the fixed prefix. */
const DEFAULT_NEW_INPUT_TOKENS = 200;

/** Output tokens one command produces across its round trips. */
const DEFAULT_OUTPUT_TOKENS = 70;

/** Share of the list input price a warm cached prefix is billed at. */
const DEFAULT_CACHE_DISCOUNT = 0.1;

/**
 * Estimate what one typed command costs, in USD.
 *
 * Models the loop this app actually runs: a fixed prefix resent on every round
 * trip, billed at the cached rate once warm. Approximate by construction — the
 * prefix size is a character heuristic and cache behaviour varies by provider.
 *
 * @param {{pricing: {promptPerMTok: number, completionPerMTok: number}|null}} model
 * @param {{prefixTokens: number, roundTrips?: number, newInputTokens?: number,
 *   outputTokens?: number, cacheDiscount?: number, warm?: boolean}} options
 * @returns {number|null} USD per command, or null when the model has no pricing.
 */
function estimateCommandCostUsd(
  model,
  {
    prefixTokens,
    roundTrips = DEFAULT_ROUND_TRIPS,
    newInputTokens = DEFAULT_NEW_INPUT_TOKENS,
    outputTokens = DEFAULT_OUTPUT_TOKENS,
    cacheDiscount = DEFAULT_CACHE_DISCOUNT,
    warm = true,
  } = {},
) {
  if (!model?.pricing) return null;
  if (!Number.isFinite(prefixTokens) || prefixTokens < 0) return null;
  const { promptPerMTok, completionPerMTok } = model.pricing;
  if (!Number.isFinite(promptPerMTok) || !Number.isFinite(completionPerMTok)) {
    return null;
  }
  const prefixRate = warm ? promptPerMTok * cacheDiscount : promptPerMTok;
  const prefixCost = (prefixTokens * roundTrips * prefixRate) / 1_000_000;
  const newInputCost = (newInputTokens * promptPerMTok) / 1_000_000;
  const outputCost = (outputTokens * completionPerMTok) / 1_000_000;
  return prefixCost + newInputCost + outputCost;
}

/**
 * Format a per-command estimate for the console. Sub-cent values need more
 * decimal places to say anything at all.
 *
 * @param {number|null|undefined} usd
 * @returns {string}
 */
function formatCommandCostUsd(usd) {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return 'n/a';
  if (usd === 0) return 'free';
  if (usd < 0.001) return `~$${usd.toFixed(5)}`;
  if (usd < 1) return `~$${usd.toFixed(4)}`;
  return `~$${usd.toFixed(2)}`;
}

export {
  DEFAULT_CACHE_DISCOUNT,
  DEFAULT_NEW_INPUT_TOKENS,
  DEFAULT_OUTPUT_TOKENS,
  DEFAULT_ROUND_TRIPS,
  estimateCommandCostUsd,
  formatCommandCostUsd,
};
