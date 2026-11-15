import { validateHistoricalWellPack } from './historicalPack.mjs';
/** Browser admission and display contract, not an upstream acquisition backend. */
export const WELL_LIMITS = Object.freeze({
  bytes: 8 * 1024 * 1024,
  sites: 2000,
});

/** Reject malformed packs at the browser trust boundary before creating entities. */
export function validateWellPack(pack) {
  return validateHistoricalWellPack(pack);
}
