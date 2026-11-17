/** Normalize a heading into the [0, 360) range; 0 when it is not finite. */
export function normalizeHeading(value) {
  if (!Number.isFinite(value)) return 0;
  // Only a negative remainder takes the extra turn, so a positive bearing
  // keeps its precision (0.49999999999999 must not become 360.5).
  const remainder = value % 360;
  const wrapped = remainder < 0 ? remainder + 360 : remainder;
  return wrapped === 360 ? 0 : wrapped;
}

/**
 * Whole degrees for display, 0–359. 359.5° and above rounds to north (0),
 * and negative or multi-turn values wrap. Null when the value is not finite,
 * so each caller keeps its own placeholder.
 */
export function roundHeadingDegrees(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(normalizeHeading(value)) % 360;
}
