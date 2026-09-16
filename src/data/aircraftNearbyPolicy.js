/** Decide whether a loaded aircraft participates in a proximity query.
 *
 * `modelRendering` is the OWNERSHIP question, not `model.show`: a model that
 * exists but is hidden, unplaced, or still loading is not what the operator sees,
 * and the billboard flag is what answers for the contact in those states. Reading
 * a bare `show` here counted a contact whose model had been admitted but was
 * drawing nothing.
 *
 * @param {{isTracked?: boolean, billboardShown?: boolean, modelRendering?: boolean, includeHidden?: boolean}} [root0] Visibility flags sampled from one loaded aircraft.
 * @param {boolean} [root0.isTracked] Aircraft is the operator's followed contact — always participates, even when nothing draws.
 * @param {boolean} [root0.billboardShown] The 2D billboard is the live visual for this contact.
 * @param {boolean} [root0.modelRendering] The 3D glTF is actually admitted and drawing (not merely present).
 * @param {boolean} [root0.includeHidden] Debug/QA override that sweeps in aircraft with no visual at all.
 * @returns {boolean} True when the aircraft counts toward nearby-contact queries and readouts.
 */
export function aircraftIncludedInNearby({
  isTracked = false,
  billboardShown = false,
  modelRendering = false,
  includeHidden = false,
} = {}) {
  return Boolean(includeHidden || isTracked || billboardShown || modelRendering);
}
