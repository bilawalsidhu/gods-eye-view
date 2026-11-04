/**
 * Per-layer opacity as the address bar carries it.
 *
 * Opacity is a fraction from 0 to 1. A layer that is not at 1 travels in the
 * page address as `lop=<layer-id>:<percent>,...`, a query parameter of its
 * own: the `#v=2` share codec, its layer tokens and every existing link are
 * untouched, and a link without `lop` means every layer at 100 %. Nothing is
 * written for a layer at 100 %.
 *
 * Pure: no DOM and no Cesium. Everything read from an address is untrusted
 * and is dropped rather than repaired: a malformed pair, an id the caller
 * does not know, a duplicate, a value outside 0-100, and a value that is too
 * long to be ours. Reading never throws.
 */

/** Query parameter that carries the opacity of the layers not at 100 %. */
export const LAYER_OPACITY_PARAM = 'lop';
/** What a layer shows when nothing has been chosen. */
export const OPACITY_DEFAULT = 1;
/** Slider granularity in percent. */
export const OPACITY_STEP_PERCENT = 5;
/** The longest `lop` value read; a real address is far shorter. */
export const MAX_LAYER_OPACITY_CHARS = 2048;
/** The most `id:percent` pairs read from one address. */
export const MAX_LAYER_OPACITY_ENTRIES = 96;

// Layer ids are the permanent ids of the layer registry. Anything outside
// this grammar is never written to or read from an address.
const LAYER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PERCENT = /^\d{1,3}$/;

/**
 * A fraction clamped to 0-1 and rounded to a whole percent; anything that is
 * not a finite number is the default.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeOpacity(value) {
  const number = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(number)) return OPACITY_DEFAULT;
  return Math.round(Math.min(1, Math.max(0, number)) * 100) / 100;
}

/**
 * Whole percent of a fraction, as the slider shows it.
 * @param {unknown} value
 * @returns {number}
 */
export function opacityPercent(value) {
  return Math.round(normalizeOpacity(value) * 100);
}

/**
 * `id:percent,id:percent` for the entries not at 100 %, in id order; '' when
 * there are none.
 * @param {Iterable<[string, number]>} entries
 * @returns {string}
 */
export function encodeLayerOpacity(entries) {
  return [...entries]
    .filter(
      ([id, value]) =>
        LAYER_ID.test(id) && normalizeOpacity(value) !== OPACITY_DEFAULT,
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, value]) => `${id}:${opacityPercent(value)}`)
    .join(',');
}

/**
 * Read a `lop` value. Percentages round to the slider's step so the handle
 * and its readout always agree; entries that come out at 100 % are dropped.
 * @param {unknown} text The raw parameter value.
 * @param {(id: string) => boolean} [isKnown] Whether a layer id may be set.
 * @returns {Map<string, number>} Layer id to fraction.
 */
export function decodeLayerOpacity(text, isKnown = () => true) {
  const out = new Map();
  if (
    typeof text !== 'string' ||
    text.length === 0 ||
    text.length > MAX_LAYER_OPACITY_CHARS
  )
    return out;
  const pairs = text.split(',');
  if (pairs.length > MAX_LAYER_OPACITY_ENTRIES) return out;
  for (const pair of pairs) {
    const at = pair.lastIndexOf(':');
    if (at <= 0) continue;
    const id = pair.slice(0, at);
    const percent = pair.slice(at + 1);
    if (!LAYER_ID.test(id) || !PERCENT.test(percent) || out.has(id)) continue;
    let known = false;
    try {
      known = isKnown(id) === true;
    } catch {
      known = false;
    }
    if (!known) continue;
    const snapped =
      Math.round(Number(percent) / OPACITY_STEP_PERCENT) * OPACITY_STEP_PERCENT;
    const value = normalizeOpacity(snapped / 100);
    if (value !== OPACITY_DEFAULT) out.set(id, value);
  }
  return out;
}

// The name a query pair has once decoded, so `l%6Fp=` is dropped with `lop=`:
// the parser would read either as the same parameter.
function paramName(pair) {
  const raw = pair.split('=')[0].replace(/\+/g, ' ');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The address with `lop` set from the entries, or removed when none is off
 * 100 %. Only the `lop` pair is edited; every other parameter, the path and
 * the hash keep their exact text.
 * @param {string} href
 * @param {Iterable<[string, number]>} entries
 * @returns {string}
 */
export function writeLayerOpacityToUrl(href, entries) {
  const url = new URL(href);
  const value = encodeLayerOpacity(entries);
  const kept = url.search
    .replace(/^\?/, '')
    .split('&')
    .filter((pair) => pair && paramName(pair) !== LAYER_OPACITY_PARAM);
  if (value) kept.push(`${LAYER_OPACITY_PARAM}=${value}`);
  url.search = kept.length ? `?${kept.join('&')}` : '';
  return url.href;
}

/**
 * The opacity an address carries; an address that cannot be parsed carries
 * none.
 * @param {string} href
 * @param {(id: string) => boolean} [isKnown]
 * @returns {Map<string, number>}
 */
export function readLayerOpacityFromUrl(href, isKnown) {
  try {
    return decodeLayerOpacity(
      new URL(href).searchParams.get(LAYER_OPACITY_PARAM),
      isKnown,
    );
  } catch {
    return new Map();
  }
}
