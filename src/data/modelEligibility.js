/**
 * Shared 3D-model eligibility for the aircraft layers.
 *
 * Eligibility is by DISTANCE (the mode's add/keep band) with ON-SCREEN
 * PRIORITY under the cap, in four visible-first passes so the slots are spent
 * on what the operator can see:
 *  1. KEEP on-screen contacts that already have a model (hysteresis for
 *     visible planes);
 *  2. ADD on-screen new contacts inside the add radius, nearest first;
 *  3. KEEP off-screen contacts that already have a model;
 *  4. ADD off-screen new contacts inside the add radius with leftover slots.
 * KEEP is split by frustum so an off-screen retained model can never starve
 * an on-screen contact that wants one.
 *
 * Portable: no Cesium, DOM or layer state.
 */

/**
 * @param {Array<[string, number, boolean]>} candidates `[id, distanceSq,
 *   onScreen]` for every contact inside the KEEP radius, sorted nearest first.
 * @param {object} options
 * @param {number} options.cap Maximum number of eligible contacts.
 * @param {number} options.addDistSq Squared ADD radius (m²).
 * @param {(id: string) => boolean} options.isModeled Whether the contact
 *   already has a model (live, not merely pending).
 * @returns {Set<string>} Contacts that may hold a model this tick.
 */
export function selectModelEligible(candidates, { cap, addDistSq, isModeled }) {
  const eligible = new Set();
  const passes = [
    (onScreen, modeled) => onScreen && modeled,
    (onScreen, modeled, inAdd) => onScreen && inAdd,
    (onScreen, modeled) => !onScreen && modeled,
    (onScreen, modeled, inAdd) => !onScreen && inAdd,
  ];
  for (const admit of passes) {
    for (const [id, distanceSq, onScreen] of candidates) {
      if (eligible.size >= cap) return eligible;
      if (eligible.has(id)) continue;
      if (admit(onScreen, isModeled(id), distanceSq <= addDistSq))
        eligible.add(id);
    }
  }
  return eligible;
}
