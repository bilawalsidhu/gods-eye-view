/**
 * Satellite labels and colours by CelesTrak source group, beneath the six
 * classes.
 *
 * The class a satellite is filed under (STATIONS, IMAGING, TELECOM,
 * STARLINK, PROBES or DEBRIS) is decided in src/layers/satellites/classes.js
 * from SATCAT, the UCS database, names and the group, and that module owns
 * each class's colour, legend label and toggle. This module keeps the
 * group-based layer: the constellation subtype a card adds to the class
 * (`TELECOM · GPS`, `STATIONS · ISS`; satelliteClassText), the group's own
 * label for a satellite with no class (satelliteClassLabel), and the colour
 * per group (satelliteClassColor), which the layer's base point styles use
 * where a satellite has no class (src/layers/satellites/policy.js).
 *
 * Deliberately Cesium-free: colors are CSS hex strings that the layer
 * converts once at module load, so this file stays unit-testable.
 */

import { t, msg } from '../i18n/index.js';
import { SATELLITE_CLASS_DISPLAY } from '../layers/satellites/classes.js';

/**
 * Class registry: the point color of each class. The card and legend text is
 * in CLASS_DISPLAY_KEYS.
 * @type {Readonly<Record<string, { color: string }>>}
 */
export const SATELLITE_CLASSES = Object.freeze({
  station: Object.freeze({
    // Warm white — "crewed", and the brightest class in the sky. Deliberately
    // NOT amber: 40-48deg amber is the app's known-military convention
    // (flights.js MIL_TINT / militaryFlights.js MIL_ICON_COLOR) and must not
    // leak into another domain. Slightly warm so it also separates from the
    // pure white the civilian air fleet draws in.
    color: '#fff6e5',
  }),
  nav: Object.freeze({
    // Cyan — the strongest accent goes to the class users actually name
    // ("how many GPS satellites are up?"). Takes over the slot the catch-all
    // VISUAL group used to occupy, so this adds no new hue to the app.
    color: '#4fd8ff',
  }),
  geo: Object.freeze({
    // Violet, unchanged. Already the app's "space" semantic (the detection
    // overlay paints the SAT tier #bda4ff), and the geostationary belt draws
    // as one clean equatorial ring at globe scale.
    color: '#c89bff',
  }),
  visual: Object.freeze({
    // Muted blue-gray. This is the catch-all bucket, so it gives up the bright
    // cyan it used to hold and recedes behind the three classes that mean
    // something. Still well clear of the dense shell by luminance.
    color: '#9fb3c4',
  }),
  comms: Object.freeze({
    // Dim slate — thousands of these appear in DENSE mode. They must read as
    // texture behind the core catalog, never compete with it. Rec.601 luma
    // ~0.40 against VISUAL's ~0.69 keeps the two separable even when the
    // NVG/FLIR shaders collapse the scene to a single channel.
    color: '#54697f',
  }),
});

/** Legend/report order for the classes above. */
export const SATELLITE_CLASS_ORDER = Object.freeze([
  'station',
  'nav',
  'geo',
  'visual',
  'comms',
]);

// What the card and legend show for each class.
const CLASS_DISPLAY_KEYS = Object.freeze({
  station: Object.freeze({
    label: msg('STATION'),
    blurb: msg('Crewed stations and their visiting vehicles'),
  }),
  nav: Object.freeze({
    label: msg('NAV'),
    blurb: msg('GNSS navigation — GPS, GLONASS, Galileo'),
  }),
  geo: Object.freeze({
    label: msg('GEO'),
    blurb: msg(
      'Geostationary belt — comms and weather, fixed over the equator',
    ),
  }),
  visual: Object.freeze({
    label: msg('VISUAL'),
    blurb: msg('Brightest naked-eye objects — CelesTrak visual group'),
  }),
  comms: Object.freeze({
    label: msg('COMMS'),
    blurb: msg('Broadband constellation shell — shown only in DENSE mode'),
  }),
});

/**
 * CelesTrak group tag → { class, subtype }. Subtype names the specific
 * constellation so the card can read "NAV · GPS" rather than a bare "NAV".
 * Keys must stay in sync with CATALOG_GROUPS + the 'dense' tag in satellites.js.
 */
const GROUP_CLASS = Object.freeze({
  stations: Object.freeze({ klass: 'station', subtype: null }),
  visual: Object.freeze({ klass: 'visual', subtype: null }),
  'gps-ops': Object.freeze({ klass: 'nav', subtype: 'GPS' }),
  glonass: Object.freeze({ klass: 'nav', subtype: 'GLONASS' }),
  galileo: Object.freeze({ klass: 'nav', subtype: 'GALILEO' }),
  geo: Object.freeze({ klass: 'geo', subtype: null }),
  dense: Object.freeze({ klass: 'comms', subtype: 'STARLINK' }),
});

/** Unknown groups fall back to the neutral bucket rather than vanishing. */
const FALLBACK = Object.freeze({ klass: 'visual', subtype: null });

/**
 * The ISS is always a STATION, whichever group ingested it. CelesTrak lists it
 * in `visual` as well as `stations`, and a catalog rebuild survives a partial
 * group outage — so a dropped stations feed would otherwise file the ISS under
 * VISUAL in both its label and the legend tally.
 */
const ISS_CLASS = Object.freeze({ klass: 'station', subtype: 'ISS' });

/**
 * Resolve a satellite to its class key and constellation subtype. This is the
 * ONLY place the ISS special case lives; the label and the legend tally both
 * route through here so they can never disagree about what the ISS is.
 * @param {string|undefined|null} group CelesTrak group tag (see GROUP_CLASS).
 * @param {{ isIss?: boolean }} [options] Whether this satellite is the ISS.
 * @returns {{ klass: string, subtype: string|null }} Class key and subtype.
 */
export function satelliteClassOf(group, { isIss = false } = {}) {
  if (isIss) return ISS_CLASS;
  return GROUP_CLASS[group] || FALLBACK;
}

/**
 * Point color for a catalog group, as a CSS hex string.
 * @param {string|undefined|null} group CelesTrak group tag.
 * @returns {string} CSS hex color.
 */
export function satelliteClassColor(group) {
  return SATELLITE_CLASSES[satelliteClassOf(group).klass].color;
}

/**
 * Operator-facing class label for a satellite — the text field shown on the
 * tracked card and the detection overlay ("NAV · GPS", "GEO", "STATION · ISS").
 * The ISS is the one object named individually: it is the reason most people
 * open this layer, and its dot is already styled apart from its class.
 *
 * The ISS is always a STATION regardless of which group ingested it — see
 * satelliteClassOf, which owns that rule for every consumer.
 * @param {string|undefined|null} group CelesTrak group tag.
 * @param {{ isIss?: boolean, localize?: boolean }} [options] isIss: the ISS;
 *   localize: false keeps the English label (data for the AI tools).
 * @returns {string} Display label.
 */
export function satelliteClassLabel(
  group,
  { isIss = false, localize = true } = {},
) {
  const { klass, subtype } = satelliteClassOf(group, { isIss });
  const label = CLASS_DISPLAY_KEYS[klass].label;
  const base = localize ? t(label) : label;
  return subtype ? `${base} · ${subtype}` : base;
}

/**
 * The class a satellite shows on its card, label, overlay and orbital
 * readout: its class (src/layers/satellites/classes.js) with the CelesTrak group's
 * subtype where one says more ("TELECOM · GPS", "STATIONS · ISS"). A subtype
 * that only repeats the class ("STARLINK · STARLINK") is dropped. Without a
 * class the group's label stands (satelliteClassLabel).
 * @param {string|null|undefined} satelliteClass Six-class id.
 * @param {string|undefined|null} group CelesTrak group tag.
 * @param {{ isIss?: boolean, localize?: boolean }} [options] As for
 *   satelliteClassLabel.
 * @returns {string} Display label.
 */
export function satelliteClassText(
  satelliteClass,
  group,
  { isIss = false, localize = true } = {},
) {
  const display = SATELLITE_CLASS_DISPLAY[satelliteClass];
  if (!display) return satelliteClassLabel(group, { isIss, localize });
  const base = localize ? t(display.label) : display.label;
  const { subtype } = satelliteClassOf(group, { isIss });
  return subtype && subtype !== display.label ? `${base} · ${subtype}` : base;
}
