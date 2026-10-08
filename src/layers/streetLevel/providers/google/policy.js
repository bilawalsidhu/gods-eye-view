import { COLORS as SHARED_COLORS, PROVIDER_COLORS } from '../../policy.js';

export { NEAREST_RADIUS_M } from '../../policy.js';

/** Identity of the Google Street View street-level provider. */
export const GOOGLE_PROVIDER_ID = 'google';
export const GOOGLE_NAME = 'Google Street View';
export const GOOGLE_LABEL = 'STREET VIEW';
/** The browser Maps key; Street View also needs the Maps JavaScript API on it. */
export const GOOGLE_KEY_ID = 'google-maps';

/** Every primitive id this provider creates starts with it. */
export const PICK_PREFIX = Object.freeze({ root: 'gsv:' });

export const COLORS = Object.freeze({
  coverage: PROVIDER_COLORS.google,
  selected: SHARED_COLORS.selected,
});

export const GOOGLE_CREDIT_HTML =
  'Street View imagery © <a href="https://www.google.com/streetview/" target="_blank" rel="noopener">Google</a>';

/**
 * Shown when Google refuses the key (gm_authFailure): the Maps JavaScript API
 * is not enabled for it, this site is not an allowed referrer, or billing is off.
 */
export const KEY_REJECTED_MESSAGE =
  'Google refused GOOGLE_MAPS_API_KEY for Street View — check that the Maps JavaScript API is enabled for it and this site is an allowed referrer';

/** A nearest-panorama lookup that takes longer has failed. */
export const NEAREST_TIMEOUT_MS = 10_000;
/** A panorama that has not shown by then has failed to open. */
export const OPEN_TIMEOUT_MS = 20_000;

/** Google answered nothing: the network, or a key Google ignores. */
export const NO_ANSWER_MESSAGE =
  'Street View did not answer — check the network, and that the Maps JavaScript API is enabled for GOOGLE_MAPS_API_KEY';

/** Under FLAT, in place of the click hint: every Street View photo is 360°. */
export const FLAT_FILTER_HINT = 'Street View has 360° photos only';

/** Shown while the provider is on, in place of coverage lines it does not have. */
export const GROUND_CLICK_HINT = 'click a street to open Street View';

/** Deep link to a panorama on Google Maps (Maps URLs). */
export function streetViewUrl(panoId, { heading = 0, pitch = 0 } = {}) {
  const params = new URLSearchParams({
    api: '1',
    map_action: 'pano',
    pano: String(panoId),
    heading: String(Math.round(heading)),
    pitch: String(Math.round(pitch)),
  });
  return `https://www.google.com/maps/@?${params}`;
}

/** Epoch ms for a Street View image date ('YYYY-MM'), or null. */
export function imageDateMs(imageDate) {
  const match = /^(\d{4})-(\d{2})/.exec(String(imageDate ?? ''));
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return Date.UTC(Number(match[1]), month - 1, 1);
}

/**
 * The last millisecond of an image's month: Google dates by month, so a
 * "since" window keeps a panorama taken any time in its cut-off month.
 */
export function imageMonthEndMs(imageDate) {
  const start = imageDateMs(imageDate);
  if (start === null) return null;
  const date = new Date(start);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1;
}

/** The photographer from a copyright line ('© 2024 Google' → 'Google'). */
export function creatorFrom(copyright) {
  const text = String(copyright ?? '')
    .replace(/^©\s*(\d{4}\s+)?/, '')
    .replace(/^From the Owner,\s*Photo by:\s*/i, '')
    .trim();
  return text || null;
}
