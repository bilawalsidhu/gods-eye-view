import { msg } from '../i18n/marker.js';

/**
 * English names for installations without a mapped name. Data keeps them
 * English (server, AI tools, voice context); classLabel.js and
 * militaryAwarenessEngine.js translate them.
 */

/** Name of an unnamed feature, by installation class. */
export const UNNAMED_INSTALLATION_LABEL_BY_CLASS = Object.freeze({
  airfield: msg('Military airfield'),
  naval_base: msg('Naval base'),
  range: msg('Firing range'),
  military_land: msg('Military land'),
});

/** Name of an unnamed feature without a usable class. */
export const UNNAMED_INSTALLATION_FALLBACK = msg('Mapped installation');

/** Name of a military polygon the names pack has not named. */
export const UNNAMED_MILITARY_AREA = msg('Military area');

/** Every name above, for the display to translate. */
export const UNNAMED_PLACE_NAMES = Object.freeze([
  ...Object.values(UNNAMED_INSTALLATION_LABEL_BY_CLASS),
  UNNAMED_INSTALLATION_FALLBACK,
  UNNAMED_MILITARY_AREA,
]);
