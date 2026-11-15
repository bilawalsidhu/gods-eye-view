/**
 * A weather source can describe its own products (credit, units, coverage,
 * legend) in the optional `display` object of a product manifest. Each field
 * is checked on its own: an absent or invalid field is dropped, and the layer
 * keeps its built-in text for it. Units and legend describe the same scale,
 * so they are kept only together. Accepted text is source data, shown as is
 * rather than translated.
 */

const TEXT_LIMITS = Object.freeze({
  source: 60,
  credit: 200,
  units: 40,
  coverage: 48,
  info: 600,
});
const LEGEND_MIN = 2;
const LEGEND_MAX = 16;
const LEGEND_LABEL_MAX = 16;
// Control and line-break characters, plus invisible or format characters:
// soft hyphen, combining grapheme joiner, Arabic letter mark, Mongolian vowel
// separator, zero-width, direction-mark, bidi embedding/override/isolate,
// variation selector, byte-order and tag characters.
const CONTROL =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufe00-\ufe0f\ufeff\u{e0000}-\u{e007f}]/u;
// A number label must read as a plain decimal, as the legend formats it.
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
// A label the legend formats as a number: a plain decimal, maybe with "+".
const SCALE_NUMBER = /^-?(\d+(?:\.(\d+))?)\+?$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const EMPTY = Object.freeze({});
const cache = new WeakMap();

function text(value, max) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max && !CONTROL.test(trimmed)
    ? trimmed
    : undefined;
}

/**
 * Whether a label the legend formats as a number reads back exactly as given:
 * within the safe integer range and with no digits lost to rounding, so
 * '9999999999999999' (shown as 10000000000000000) and '007' are refused.
 * Other text is shown as given.
 */
function exactScaleLabel(label) {
  const match = SCALE_NUMBER.exec(label);
  if (!match) return true;
  const magnitude = Number(match[1]);
  return (
    magnitude <= Number.MAX_SAFE_INTEGER &&
    magnitude.toFixed(match[2]?.length ?? 0) === match[1]
  );
}

function number(value) {
  if (!Number.isFinite(value)) return undefined;
  const label = String(value);
  return DECIMAL.test(label) && label.length <= LEGEND_LABEL_MAX
    ? label
    : undefined;
}

function legend(value) {
  if (
    !Array.isArray(value) ||
    value.length < LEGEND_MIN ||
    value.length > LEGEND_MAX
  )
    return undefined;
  const stops = [];
  for (const stop of value) {
    if (!stop || typeof stop !== 'object') return undefined;
    const label =
      typeof stop.label === 'number'
        ? number(stop.label)
        : text(stop.label, LEGEND_LABEL_MAX);
    if (label === undefined || !exactScaleLabel(label)) return undefined;
    if (typeof stop.color !== 'string' || !COLOR.test(stop.color))
      return undefined;
    stops.push(Object.freeze([label, stop.color]));
  }
  return Object.freeze(stops);
}

function extent(value) {
  if (!value || typeof value !== 'object') return undefined;
  const { west, south, east, north } = value;
  if (
    ![west, south, east, north].every(Number.isFinite) ||
    west < -180 ||
    west > 180 ||
    east < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    south >= north ||
    // No width: one meridian, including 180 to -180 across the antimeridian.
    west === east ||
    west - east >= 360
  )
    return undefined;
  // West greater than east crosses the antimeridian.
  return Object.freeze({ west, south, east, north });
}

/**
 * The valid display fields of a weather manifest; `{}` when it has none.
 * @param {object|null|undefined} manifest A validated weather snapshot.
 * @returns {{ source?: string, credit?: string, units?: string,
 *   coverage?: string, info?: string,
 *   legend?: ReadonlyArray<readonly [string, string]>,
 *   extent?: { west: number, south: number, east: number, north: number } }}
 */
export function weatherDisplay(manifest) {
  const display = manifest?.display;
  if (!display || typeof display !== 'object' || Array.isArray(display))
    return EMPTY;
  const known = cache.get(manifest);
  if (known) return known;
  const result = {};
  for (const [key, max] of Object.entries(TEXT_LIMITS)) {
    const value = text(display[key], max);
    if (value !== undefined) result[key] = value;
  }
  const stops = legend(display.legend);
  if (stops && result.units !== undefined) result.legend = stops;
  else delete result.units;
  const box = extent(display.extent);
  if (box) result.extent = box;
  Object.freeze(result);
  cache.set(manifest, result);
  return result;
}

/** Whether a longitude/latitude falls inside an extent, across the antimeridian too. */
export function insideExtent({ west, south, east, north }, lon, lat) {
  if (lat < south || lat > north) return false;
  return west < east ? lon >= west && lon <= east : lon >= west || lon <= east;
}

/** Plain text for a Cesium credit, which otherwise reads its text as HTML. */
export function escapeCreditText(value) {
  return value.replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        ch
      ],
  );
}
