/**
 * Convert a cardinal/intercardinal direction string to a compass heading.
 *
 * Two matching modes, because the same text is parsed from two very different
 * kinds of source field:
 *
 *   1. Dedicated direction fields (Caltrans `location.direction`, Austin
 *      `travel_direction`/`facing`, …) hold a real facing value. There, bare
 *      cardinal words ("West", "North") ARE the answer — pass `allowBare=true`.
 *
 *   2. Free-form name/description text ("5TH ST / WEST AVE", "N LAMAR BLVD") is
 *      full of STREET names that merely contain a cardinal word. Reading a bare
 *      "West" there as a facing direction mis-orients the camera with false
 *      confidence (59 of ~1000 Austin cameras hit this — owner adversarial review
 *      2026-07-04). There, only explicit travel forms ("WESTBOUND"/"WB") count —
 *      leave `allowBare=false` (the default).
 *
 * Recognizes full travel words ("NORTHBOUND"), abbreviations ("NB"), and —
 * only when `allowBare` is set — bare cardinals ("NORTH").
 *
 * @param {string} value - Direction text (case-insensitive).
 * @param {boolean} [allowBare=false] - Match bare cardinal words. Use ONLY for
 *   dedicated direction fields, never for free-form name inference.
 * @returns {number} Heading in degrees [0..360), or NaN if unrecognized.
 */
export function directionToHeading(value, allowBare = false) {
  const text = String(value || '')
    .trim()
    .toUpperCase();
  if (!text) return NaN;
  const tiers = [
    [
      [/\bNORTHBOUND\b|\bNB\b/, 0],
      [/\bSOUTHBOUND\b|\bSB\b/, 180],
      [/\bEASTBOUND\b|\bEB\b/, 90],
      [/\bWESTBOUND\b|\bWB\b/, 270],
    ],
    [
      [/\bNORTHEAST\b|\bNE\b/, 45],
      [/\bNORTHWEST\b|\bNW\b/, 315],
      [/\bSOUTHEAST\b|\bSE\b/, 135],
      [/\bSOUTHWEST\b|\bSW\b/, 225],
    ],
  ];
  if (allowBare)
    tiers.push([
      [/\bNORTH\b/, 0],
      [/\bSOUTH\b/, 180],
      [/\bEAST\b/, 90],
      [/\bWEST\b/, 270],
    ]);
  for (const forms of tiers) {
    const headings = new Set();
    for (const [pattern, heading] of forms) {
      if (pattern.test(text)) headings.add(heading);
    }
    if (headings.size)
      return headings.size === 1 ? headings.values().next().value : NaN;
  }
  return NaN;
}
