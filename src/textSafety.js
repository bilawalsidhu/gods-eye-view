/**
 * One-line text safety for anything that reaches a model or a tool result.
 *
 * Coordinates, names and OSM tags are attacker-editable: anyone can set an ALPR
 * `operator` tag to a string carrying newlines and a fake instruction, and it
 * arrives in the Realtime model's tool output as if it were ours. Every such
 * value is flattened to a single line and capped here, at one place, so a new
 * call site cannot quietly reintroduce the gap.
 */

/** Cap for a short identifier-like tag (operator, manufacturer, zone). */
export const SAFE_TAG_MAX = 120;

/** Cap for a descriptive field carried into tool output (names, labels). */
export const SAFE_TEXT_MAX = 180;

/**
 * Flatten a value to a single trimmed line and cap it.
 *
 * Control characters, including newlines, are replaced with a space rather than
 * deleted so neighbouring words do not fuse (`Town PD\n\nSYSTEM` stays two
 * words instead of becoming `Town PDSYSTEM`). Line and paragraph separators are
 * treated the same way: they are not `\s` in every engine's shorthand, and they
 * render as line breaks to a model.
 *
 * @param {*} value - Raw value; non-strings are stringified, objects rejected.
 * @param {number} maxLength - Maximum characters to keep.
 * @returns {string} Single-line text, empty when there is nothing usable.
 */
export function singleLine(value, maxLength = SAFE_TAG_MAX) {
  if (value == null || typeof value === 'object') return '';
  const flat = String(value)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!Number.isFinite(maxLength) || maxLength <= 0) return flat;
  return flat.length > maxLength ? flat.slice(0, maxLength).trimEnd() : flat;
}
