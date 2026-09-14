/**
 * Who owns the pointer over the globe.
 *
 * Most layers bind their own `ScreenSpaceEventHandler` to the same canvas and
 * select whatever is under a left click. That is right when nothing else is
 * going on, and wrong the moment a tool needs the pointer for itself: a draw
 * session placing a vertex on top of an aircraft must not also track the
 * aircraft, and the next such tool must not have to be added to a list inside
 * every layer.
 *
 * So there is one claim, held by at most one owner at a time:
 *
 * - A TOOL that needs the pointer calls `claimPointer('draw')` when it turns on
 *   and `releasePointer('draw')` when it turns off. It does not consult anyone;
 *   holding the claim is what makes it the owner.
 * - An AMBIENT SELECTION HANDLER — anything that picks an entity because the
 *   user clicked near it — early-returns while `isPointerFree()` is false. It
 *   never claims.
 *
 * Claims do not stack and are never stolen: while one owner holds the pointer a
 * second `claimPointer` returns false rather than displacing it, so a tool can
 * tell it did not get the pointer instead of silently fighting for it. Release
 * is identity-checked for the same reason — a late teardown that has already
 * been superseded cannot free the claim its successor now holds.
 *
 * Ownership is page-scoped, like the layers and handlers it arbitrates.
 */

/** @type {string|null} */
let currentOwner = null;

/**
 * Take the pointer for `owner`. Re-claiming as the current owner succeeds and
 * changes nothing, so a tool may claim on every activation without tracking
 * whether it already had it.
 * @param {string} owner Stable identifier for the claiming tool, e.g. 'draw'.
 * @returns {boolean} Whether `owner` holds the pointer after this call.
 */
export function claimPointer(owner) {
  const name = normalizeOwner(owner);
  if (!name) return false;
  if (currentOwner !== null && currentOwner !== name) return false;
  currentOwner = name;
  return true;
}

/**
 * Give the pointer back. Only the holder can release it: a call naming anyone
 * else, or made when the pointer is already free, does nothing.
 * @param {string} owner The identifier that claimed it.
 * @returns {boolean} Whether this call released the claim.
 */
export function releasePointer(owner) {
  const name = normalizeOwner(owner);
  if (!name || currentOwner !== name) return false;
  currentOwner = null;
  return true;
}

/** @returns {string|null} The current owner, or null when the pointer is free. */
export function pointerOwner() {
  return currentOwner;
}

/** @returns {boolean} True when no tool holds the pointer. */
export function isPointerFree() {
  return currentOwner === null;
}

/**
 * @param {string} owner
 * @returns {boolean} True when `owner` is the one holding the pointer.
 */
export function isPointerOwnedBy(owner) {
  const name = normalizeOwner(owner);
  return Boolean(name) && currentOwner === name;
}

/**
 * Drop any claim. For tests and for application teardown, which cannot rely on
 * a half-disposed tool to release its own claim.
 * @returns {string|null} The owner that was holding it, if any.
 */
export function resetPointerOwnership() {
  const previous = currentOwner;
  currentOwner = null;
  return previous;
}

function normalizeOwner(owner) {
  return typeof owner === 'string' && owner.trim() ? owner.trim() : null;
}
