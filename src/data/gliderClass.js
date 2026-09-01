/**
 * OGN aircraft-type classification — `ftype` label → operator-legible class.
 *
 * The Open Glider Network tags every contact with an integer aircraft type,
 * which ognFallback.js `OGN_AIRCRAFT_TYPES` resolves to a label. This module is
 * the single source of truth for which of those types the gliders layer
 * surfaces at all, the class each belongs to, the color it renders in, and the
 * token the row legend prints — so the point color, the legend swatch, and the
 * filter can never disagree about what a class is or whether it is on screen.
 *
 * By design this layer surfaces exactly two classes: sailplanes and crewed
 * balloons. Every other OGN type — paragliders, hang gliders, tow planes,
 * helicopters, drones, ADS-B relay traffic, ground reference beacons — is
 * excluded, see OGN_TYPE_CLASS below for why each is left out.
 *
 * Deliberately Cesium-free, following satelliteClass.js: colors are CSS hex
 * strings that gliders.js converts once at module load. That keeps this file
 * unit-testable and lets the legend swatches reuse the exact same strings the
 * points are drawn with.
 */

/**
 * Class registry. `label` is the legend token, `color` the point color, `blurb`
 * the plain-language gloss for the legend tooltip.
 * @type {Readonly<Record<string, { label: string, color: string, blurb: string }>>}
 */
export const GLIDER_CLASSES = Object.freeze({
  glider: Object.freeze({
    label: 'GLIDER',
    // Cyan — the brightest accent goes to the class the layer is named for.
    color: '#5ec8ff',
    blurb: 'Sailplanes — the FLARM traffic this layer exists to surface',
  }),
  balloon: Object.freeze({
    label: 'BALLOON',
    // Amber-yellow. Distinct from the weatherBalloons.js layer, which tracks
    // unmanned radiosondes from an entirely different feed (SondeHub) — this
    // is a crewed balloon carrying its own FLARM/OGN tracker.
    color: '#ffd166',
    blurb: 'Crewed balloons carrying a FLARM/OGN tracker',
  }),
});

/** Legend order for the classes above. */
export const GLIDER_CLASS_ORDER = Object.freeze(['glider', 'balloon']);

/**
 * OGN type label (ognFallback.js `OGN_AIRCRAFT_TYPES`) → class key.
 *
 * This map IS the layer's filter: a type absent from it is neither drawn nor
 * counted. Deliberately scoped to just gliders and balloons — everything else
 * OGN reports is excluded, for one of three reasons:
 *
 *  - `plane` (ftype 8) and `jet` (9): OGN ground stations commonly relay the
 *    Mode-S/ADS-B targets they also receive, filed under these two generic
 *    codes. A bounding box over busy airspace comes back full of ordinary
 *    airliners — aircraft that already carry a transponder and are already
 *    drawn by flights.js. Unfiltered, these once flooded this layer and
 *    inflated its contact count.
 *  - `paraglider` (7), `hang-glider` (6), `tow-plane` (2), `helicopter` (3),
 *    `drone` (13): real OGN/FLARM traffic, just not what this layer is
 *    scoped to show.
 *  - `unknown` (ftype 0/14/15, see ognFallback.js): ftype 14 specifically
 *    means a static ground reference object, not an aircraft — it never
 *    moves because it was never airborne. 0 and 15 are reserved/unset-type
 *    slots ognFallback.js lumps into the same 'unknown' label. None of the
 *    three are reliably "an active glider."
 */
export const OGN_TYPE_CLASS = Object.freeze({
  glider: 'glider',
  balloon: 'balloon',
});

/**
 * Resolve an OGN type label to its class key, or null when this layer does not
 * surface that type at all. Callers treat null as "drop this contact" — it is
 * the filter and the classifier in one lookup, so a type can never be counted
 * by one and rejected by the other.
 * @param {string|undefined|null} typeLabel OGN type label.
 * @returns {string|null} Class key, or null when not surfaced.
 */
export function gliderClassOf(typeLabel) {
  return OGN_TYPE_CLASS[typeLabel] || null;
}

/**
 * Point color for an OGN type label, as a CSS hex string. An unsurfaced type
 * (one `gliderClassOf` returns null for) falls back to the GLIDER color rather
 * than throwing — the filter should already have dropped it before painting,
 * so this is belt-and-braces for any caller that paints before it filters.
 * @param {string|undefined|null} typeLabel OGN type label.
 * @returns {string} CSS hex color.
 */
export function gliderClassColor(typeLabel) {
  return GLIDER_CLASSES[gliderClassOf(typeLabel) || 'glider'].color;
}

/**
 * Build the layer-row legend from a class tally.
 * Classes with no members are omitted, so the legend never advertises a color
 * that is not currently on screen — near a typical site that is three or four
 * rows, not all seven.
 * @param {Record<string, number>|null|undefined} counts Class key → count.
 * @returns {Array<{ klass: string, label: string, color: string, blurb: string, count: number }>}
 *   Present classes in legend order.
 */
export function gliderClassLegend(counts) {
  const result = [];
  for (const klass of GLIDER_CLASS_ORDER) {
    const count = counts?.[klass];
    if (!(count > 0)) continue;
    const spec = GLIDER_CLASSES[klass];
    result.push({ klass, label: spec.label, color: spec.color, blurb: spec.blurb, count });
  }
  return result;
}
