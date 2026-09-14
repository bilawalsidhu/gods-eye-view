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
 *   and gets back a LEASE — an opaque token. It releases with
 *   `releasePointer(lease)` when it turns off. It does not consult anyone;
 *   holding the claim is what makes it the owner.
 * - An AMBIENT SELECTION HANDLER — anything that picks an entity because the
 *   user clicked — early-returns while `isPointerFree()` is false. It never
 *   claims.
 *
 * Claims do not stack and are never stolen: while one owner holds the pointer,
 * a second `claimPointer` returns null rather than displacing it — and so does
 * a second claim under the SAME name, because two live instances of one tool
 * (an old one mid-teardown, its replacement already running) are two owners,
 * not one. The lease is what tells them apart: releasing takes the token that
 * was issued, so a superseded instance calling `releasePointer` with its own
 * stale lease frees nothing and its successor keeps the pointer.
 *
 * Ownership is page-scoped, like the layers and handlers it arbitrates.
 */

/** @typedef {{owner: string, id: number}} PointerLease */

/** @type {PointerLease|null} */
let currentLease = null;
let nextLeaseId = 1;

/**
 * Take the pointer for `owner`.
 * @param {string} owner Stable identifier for the claiming tool, e.g. 'draw'.
 * @returns {PointerLease|null} The lease to release with, or null if the
 *   pointer is already held — including by another instance of the same tool.
 */
export function claimPointer(owner) {
  const name = normalizeOwner(owner);
  if (!name) return null;
  if (currentLease !== null) return null;
  currentLease = Object.freeze({ owner: name, id: nextLeaseId++ });
  return currentLease;
}

/**
 * Give the pointer back. Only the exact lease that took it can release it, so a
 * superseded instance cannot free the claim its replacement now holds.
 * @param {PointerLease|null} lease The token `claimPointer` returned.
 * @returns {boolean} Whether this call released the claim.
 */
export function releasePointer(lease) {
  if (!currentLease || !lease || lease.id !== currentLease.id) return false;
  currentLease = null;
  return true;
}

/** @returns {string|null} The current owner's name, or null when free. */
export function pointerOwner() {
  return currentLease ? currentLease.owner : null;
}

/** @returns {boolean} True when no tool holds the pointer. */
export function isPointerFree() {
  return currentLease === null;
}

/**
 * @param {string} owner
 * @returns {boolean} True when a tool of that name is holding the pointer.
 */
export function isPointerOwnedBy(owner) {
  const name = normalizeOwner(owner);
  return Boolean(name) && pointerOwner() === name;
}

/**
 * @param {PointerLease|null} lease
 * @returns {boolean} True when THIS lease is the live one.
 */
export function isLeaseCurrent(lease) {
  return Boolean(currentLease && lease && lease.id === currentLease.id);
}

/**
 * Drop any claim. For tests and for application teardown, which cannot rely on
 * a half-disposed tool to release its own lease.
 * @returns {string|null} The owner that was holding it, if any.
 */
export function resetPointerOwnership() {
  const previous = pointerOwner();
  currentLease = null;
  return previous;
}

function normalizeOwner(owner) {
  return typeof owner === 'string' && owner.trim() ? owner.trim() : null;
}
