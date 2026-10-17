import { COLORS as SHARED_COLORS, PROVIDER_COLORS } from '../../policy.js';
import { msg } from '../../../../i18n/index.js';

export { NEAREST_RADIUS_M } from '../../policy.js';

export const GOOGLE_PROVIDER_ID = 'google';
export const GOOGLE_NAME = msg('Google Street View');
export const GOOGLE_LABEL = msg('GOOGLE STREET VIEW');
/** The browser Maps key; Street View also needs the Maps JavaScript API on it. */
export const GOOGLE_KEY_ID = 'google-maps';

export const PICK_PREFIX = Object.freeze({ root: 'gsv:' });

export const COLORS = Object.freeze({
  coverage: PROVIDER_COLORS.google,
  selected: SHARED_COLORS.selected,
});

export const GOOGLE_CREDIT_HTML =
  'Street View imagery © <a href="https://www.google.com/streetview/" target="_blank" rel="noopener">Google</a>';

/** Shown when Google refuses the key (gm_authFailure). */
export const KEY_REJECTED_MESSAGE = msg(
  'Google refused GOOGLE_MAPS_API_KEY for Street View — check that the Maps JavaScript API is enabled for it and this site is an allowed referrer',
);

/** Past these, a nearest lookup, an open or a details lookup has failed. */
export const NEAREST_TIMEOUT_MS = 10_000;
export const OPEN_TIMEOUT_MS = 20_000;
export const DETAILS_TIMEOUT_MS = 10_000;
/** Pause after a failed details lookup before a view event can retry. */
export const DETAILS_RETRY_COOLDOWN_MS = 5_000;

export const NO_ANSWER_MESSAGE = msg(
  'Street View did not answer — check the network, and that the Maps JavaScript API is enabled for GOOGLE_MAPS_API_KEY',
);

export const GROUND_CLICK_HINT = msg('click a street to open Street View');

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

/** The photographer from a copyright line ('© 2024 Google' → 'Google'). */
export function creatorFrom(copyright) {
  const text = String(copyright ?? '')
    .replace(/^©\s*(\d{4}\s+)?/, '')
    .replace(/^From the Owner,\s*Photo by:\s*/i, '')
    .trim();
  return text || null;
}
