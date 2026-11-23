/**
 * A host-supplied placement provider: an application embedding the catalog
 * may decide where its moving contacts are drawn while live. Each layer that
 * takes one tells it every fix it accepts (`observe`) and asks it, each time
 * it draws a contact, where to draw it now (`place`). A layer given none, or
 * asking about a contact the provider does not place (`null`), draws the
 * contact with its own motion, exactly as without a provider. A provider
 * that throws is treated as having no answer for that call.
 *
 * Layers consult a provider only while live: following the world clock, the
 * layer's own motion places every contact.
 *
 * @typedef {'aircraft'|'military'|'vessels'|'transit'|'rail'} PlacementKind
 *
 * @typedef {object} PlacementFix
 * @property {number} timeMs The fix's own time, Unix ms.
 * @property {number} lat
 * @property {number} lon
 * @property {number} [altitudeM] The height the layer draws the fix at,
 *   metres above the ellipsoid; NaN when the layer keeps its own height.
 * @property {number} [speedMps] Reported ground speed, NaN for none.
 * @property {number} [courseDeg] Reported course over ground, NaN for none.
 * @property {number} [headingDeg] Reported heading, NaN for none.
 * @property {boolean} [onGround] Reported on the ground (aircraft).
 * @property {string} [feedId] The feed the contact belongs to (transit, rail).
 *
 * @typedef {object} Placement
 * @property {number} lat
 * @property {number} lon
 * @property {number} altitudeM Metres above the ellipsoid, as the observed
 *   fixes' `altitudeM`; NaN keeps the layer's own height.
 * @property {number} courseDeg Direction of travel, NaN for none.
 * @property {number} speedMps NaN for none.
 * @property {boolean} extrapolating Past the contact's newest fix.
 *
 * @typedef {object} LayerPlacement What a layer is handed: never throws.
 * @property {(id: string, fix: PlacementFix) => void} observe
 * @property {(id: string, wallMs: number) => Placement|null} place The
 *   answer is one object reused by every call: read it before the next.
 * @property {(id: string) => void} forget The contact left the layer.
 *
 * @typedef {object} PlacementProvider
 * @property {(kind: PlacementKind) => object|null|undefined} layer The
 *   placement for one kind of contact: an object with `place(id, wallMs)`
 *   and optionally `observe(id, fix)` and `forget(id)`, or null to leave that
 *   kind to its layer's own motion.
 */

/** The kinds of contact a provider may place. */
export const PLACEMENT_KINDS = Object.freeze([
  'aircraft',
  'military',
  'vessels',
  'transit',
  'rail',
]);

const finiteOr = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * One kind's placement from a provider, guarded so a layer can call it every
 * frame: null when there is no provider or it does not place `kind`.
 * @param {PlacementProvider|null|undefined} provider
 * @param {PlacementKind} kind
 * @returns {LayerPlacement|null}
 */
export function layerPlacement(provider, kind) {
  if (!PLACEMENT_KINDS.includes(kind))
    throw new TypeError(`Unknown placement kind: ${kind}`);
  if (provider == null) return null;
  if (typeof provider.layer !== 'function')
    throw new TypeError('A placement provider needs a layer(kind) function');
  const placement = provider.layer(kind);
  if (placement == null) return null;
  if (typeof placement.place !== 'function')
    throw new TypeError(`The ${kind} placement needs a place(id, wallMs)`);
  const observe =
    typeof placement.observe === 'function' ? placement.observe : null;
  const forget =
    typeof placement.forget === 'function' ? placement.forget : null;
  // Asked for every drawn contact every frame: one answer, reused.
  const answer = {
    lat: NaN,
    lon: NaN,
    altitudeM: NaN,
    courseDeg: NaN,
    speedMps: NaN,
    extrapolating: false,
  };
  return Object.freeze({
    observe(id, fix) {
      if (!observe) return;
      try {
        observe.call(placement, id, fix);
      } catch {
        // A provider that fails to take a fix only answers less.
      }
    },
    place(id, wallMs) {
      let placed;
      try {
        placed = placement.place(id, wallMs);
      } catch {
        return null;
      }
      if (
        !placed ||
        !Number.isFinite(placed.lat) ||
        !Number.isFinite(placed.lon) ||
        Math.abs(placed.lat) > 90
      )
        return null;
      answer.lat = placed.lat;
      answer.lon = placed.lon;
      answer.altitudeM = finiteOr(placed.altitudeM, NaN);
      answer.courseDeg = finiteOr(placed.courseDeg, NaN);
      answer.speedMps = finiteOr(placed.speedMps, NaN);
      answer.extrapolating = placed.extrapolating === true;
      return answer;
    },
    forget(id) {
      if (!forget) return;
      try {
        forget.call(placement, id);
      } catch {
        // Nothing to undo.
      }
    },
  });
}
