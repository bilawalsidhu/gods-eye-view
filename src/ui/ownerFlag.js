/**
 * The owner mark beside a satellite's name: the owner country's flag, or a
 * short text badge for an organisation without one (ESA, EUMETSAT,
 * "Multinational"). Windows draws no flag emoji, so the flags are pictures:
 * one sheet of every owner country's flag (`scripts/build-owner-flags.mjs`,
 * from flag-icons), loaded once at startup (`preloadOwnerFlags`), so riding
 * a satellite never waits for its flag.
 */

import { OWNER_FLAG_SHEET } from './ownerFlagSheet.js';

/** The flag sheet's URL. */
export const OWNER_FLAG_SHEET_URL = new URL(
  '../data/local_data/owner_flags/owner_flags.png',
  import.meta.url,
).href;

/** Each flag's place on the sheet, by ISO code. */
const SHEET_INDEX = new Map(
  OWNER_FLAG_SHEET.codes.map((code, index) => [code, index]),
);

let sheetLoad = null;

/**
 * Load the flag sheet, once; the app calls this at startup. A failed load
 * is asked again by the next caller, so a flag shown later can still come.
 * @param {{createImage?: () => {onload: Function|null, onerror: Function|null,
 *   src: string}}} [options] Test seam.
 * @returns {Promise<boolean>} Whether the sheet is ready to draw from.
 */
export function preloadOwnerFlags({
  createImage = () => new globalThis.Image(),
} = {}) {
  if (sheetLoad) return sheetLoad;
  let image;
  try {
    image = createImage();
  } catch {
    return Promise.resolve(false);
  }
  const load = new Promise((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => {
      if (sheetLoad === load) sheetLoad = null;
      resolve(false);
    };
  });
  sheetLoad = load;
  image.src = OWNER_FLAG_SHEET_URL;
  return load;
}

/**
 * How to draw a flag from the sheet at a size: the sheet as the element's
 * background, scaled and shifted onto the flag's cell.
 * @param {string} code ISO 3166-1 alpha-2, upper case.
 * @param {{widthPx?: number, heightPx?: number}} [size] CSS pixels.
 * @returns {{backgroundImage: string, backgroundSize: string,
 *   backgroundPosition: string}|null} Null for a code not on the sheet.
 */
export function ownerFlagStyle(code, { widthPx = 20, heightPx = 15 } = {}) {
  const index = SHEET_INDEX.get(code);
  if (index === undefined) return null;
  const sheet = OWNER_FLAG_SHEET;
  const column = index % sheet.columns;
  const row = Math.floor(index / sheet.columns);
  // A cell and its gutter, in CSS pixels at this size.
  const pitchX =
    (widthPx * (sheet.cellWidthPx + sheet.gutterPx)) / sheet.cellWidthPx;
  const pitchY =
    (heightPx * (sheet.cellHeightPx + sheet.gutterPx)) / sheet.cellHeightPx;
  return {
    backgroundImage: `url("${OWNER_FLAG_SHEET_URL}")`,
    backgroundSize: `${sheet.columns * pitchX}px ${sheet.rows * pitchY}px`,
    backgroundPosition: `${-column * pitchX}px ${-row * pitchY}px`,
  };
}

/** An ISO 3166-1 alpha-2 code, upper case, or null. */
function isoCode(value) {
  const code = String(value ?? '').trim();
  return /^[A-Za-z]{2}$/.test(code) ? code.toUpperCase() : null;
}

/**
 * A region's name in the locale, from the browser's own table.
 * @param {string} code ISO 3166-1 alpha-2.
 * @param {string} locale BCP 47 tag.
 * @returns {string|null}
 */
export function regionName(code, locale) {
  try {
    const name = new Intl.DisplayNames([locale || 'en'], {
      type: 'region',
    }).of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

/**
 * How to mark a satellite's owner.
 * @param {{countryCode: string|null, label: string|null}|null|undefined} owner
 * @param {{locale?: string, flags?: {has: (code: string) => boolean}}}
 *   [options] `flags`: the codes with a flag (the sheet's).
 * @returns {{kind: 'flag', code: string, label: string}
 *   | {kind: 'badge', label: string, title: string}
 *   | null} A flag (with the country's localized name as its label), a text
 *   badge for an owner with no flag to show, or nothing when unknown.
 */
export function ownerMark(owner, { locale = 'en', flags = SHEET_INDEX } = {}) {
  const code = isoCode(owner?.countryCode);
  const label = String(owner?.label ?? '').trim();
  if (code) {
    const name = regionName(code, locale) || label || code;
    if (flags.has(code)) return { kind: 'flag', code, label: name };
    return { kind: 'badge', label: label || code, title: name };
  }
  return label ? { kind: 'badge', label, title: label } : null;
}

/**
 * What the readout shows for an owner once the flag sheet has loaded or
 * failed: the flag, or a badge (the country code when the sheet would not
 * load, so the owner never disappears), or nothing for an unknown owner.
 * @param {ReturnType<typeof ownerMark>} mark
 * @param {{ready?: boolean, failed?: boolean}} [sheet] The sheet's state.
 * @returns {{kind: 'flag', style: object, label: string}
 *   | {kind: 'badge', label: string, title: string} | null}
 */
export function shownOwnerMark(mark, { ready = false, failed = false } = {}) {
  if (!mark) return null;
  if (mark.kind === 'badge') return mark;
  const style = ownerFlagStyle(mark.code);
  if (failed || !style) {
    return { kind: 'badge', label: mark.code.toUpperCase(), title: mark.label };
  }
  return ready ? { kind: 'flag', style, label: mark.label } : null;
}
