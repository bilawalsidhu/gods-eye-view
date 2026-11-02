/** A 200% feather reaches the center while keeping its midpoint on the keyhole. */
export const SCOPE_FEATHER_RATIO_MAX = 2;
const SCOPE_FEATHER_MAX_PCT = SCOPE_FEATHER_RATIO_MAX * 100;

/** Normalize a UI/share-link feather percentage to the supported integer range. */
export function clampScopeFeatherPct(value) {
  return Math.max(
    0,
    Math.min(SCOPE_FEATHER_MAX_PCT, Math.round(Number(value) || 0)),
  );
}
