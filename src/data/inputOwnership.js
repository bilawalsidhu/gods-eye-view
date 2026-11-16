/**
 * Who owns the pointer over the globe.
 *
 * Most layers read the same globe clicks (src/input/dispatcher.js) and
 * select whatever is under a left click. That is right when nothing else is
 * going on, and wrong the moment a tool needs the pointer for itself: a draw
 * session placing a vertex on top of an aircraft must not also track the
 * aircraft, and the next such tool must not have to be added to a list inside
 * every layer.
 *
 * So there is one claim, held by at most one owner at a time:
 *
 * - A TOOL that needs the pointer calls `claimPointer('draw', {onLost})` when
 *   it turns on and gets back a LEASE — an opaque token. It releases with
 *   `releasePointer(lease)` when it turns off. It does not consult anyone;
 *   holding the claim is what makes it the owner.
 * - An AMBIENT SELECTION HANDLER — anything that picks an entity because the
 *   user clicked — is not called while `isPointerFree()` is false: the input
 *   dispatcher skips it. It never claims.
 *
 * The newest claim takes over, as a claim on the renderer's input port does
 * (`src/render/contract/input.d.ts`): a second `claimPointer` ends the lease
 * out, and its holder's `onLost` is called once, after the new lease holds the
 * pointer, so that tool turns itself off as if the person had turned it off.
 * That holds for a second claim under the SAME name too: an old instance
 * mid-teardown and its replacement already running are two owners, and the
 * replacement wins. The lease is what tells them apart: releasing takes the
 * token that was issued, so a superseded instance calling `releasePointer`
 * with its own stale lease frees nothing and its successor keeps the pointer.
 *
 * Each scene's input dispatcher bridges its renderer's input port here
 * (`bridgePointer`): while a tool holds the pointer the port holds a lease
 * for it, so the port is not free, and a claim made on the port itself
 * takes over from the tool here like any newer claim. While such a claim is
 * out the pointer is not free. The bridge's lease takes no press (its `grab`
 * refuses each one): the dispatcher decides who hears each event when it
 * arrives, and the renderer's own select and double-click follow run unless
 * a tool holds them off (`suppressStockClicks`).
 *
 * Ownership is page-scoped, like the layers and handlers it arbitrates.
 */

/** @typedef {{owner: string, id: number}} PointerLease */

/** @type {PointerLease|null} */
let currentLease = null;
let nextLeaseId = 1;
/** @type {WeakMap<PointerLease, () => void>} each lease's `onLost` */
const lostHandlers = new WeakMap();
/** @type {Set<{claimed: (lease: PointerLease|null) => void, isFree: () => boolean}>} */
const bridges = new Set();

/**
 * Take the pointer for `owner`. The newest claim takes over: the lease out
 * ends, and its `onLost` is called once, after this one holds the pointer.
 * @param {string} owner Stable identifier for the claiming tool, e.g. 'draw'.
 * @param {{onLost?: () => void}} [options] `onLost`: called once when a newer
 *   claim, here or on a bridged port, ends this lease; never when it is
 *   released. A tool turns itself off in it.
 * @returns {PointerLease|null} The lease to release with, or null for an
 *   owner with no name.
 */
export function claimPointer(owner, { onLost } = {}) {
  const name = normalizeOwner(owner);
  if (!name) return null;
  const previous = currentLease;
  const lease = Object.freeze({ owner: name, id: nextLeaseId++ });
  currentLease = lease;
  if (typeof onLost === 'function') lostHandlers.set(lease, onLost);
  announce();
  if (previous) tellLost(previous);
  return lease;
}

/** Each bridged port hears who holds the pointer now. */
function announce() {
  for (const bridge of [...bridges]) bridge.claimed(currentLease);
}

/** Tell the holder of an ended `lease`, once. */
function tellLost(lease) {
  const onLost = lostHandlers.get(lease);
  lostHandlers.delete(lease);
  if (!onLost) return;
  try {
    onLost();
  } catch (error) {
    console.error('Pointer owner failed to let go', error);
  }
}

/**
 * Hold a lease on a renderer's input port for as long as a tool holds the
 * pointer here, made afresh for each claim. A claim made on the port by
 * anyone else ends the tool's lease here, and its holder is told; while that
 * claim is out, `isPointerFree()` is false.
 * @param {import('../render/contract/input').InputPort} port
 * @returns {{lease: () => import('../render/contract/input').Lease|null, off: () => void}}
 *   `lease` is the port lease standing for the tool's, null while no tool
 *   here holds the pointer; `off` gives it back and stops bridging.
 */
export function bridgePointer(port) {
  let held = null;
  const bridge = {
    claimed(lease) {
      held?.release();
      held = null;
      if (!lease) return;
      held = port.claimPointer(lease.owner, {
        // Every press goes on to the port's other listeners; the dispatcher
        // decides who hears it when it arrives.
        grab: () => false,
        // A claim on the port that is not this bridge's.
        onLost: () => {
          held = null;
          if (currentLease !== lease) return;
          currentLease = null;
          announce();
          tellLost(lease);
        },
      });
    },
    isFree: () => port.isPointerFree(),
  };
  bridges.add(bridge);
  bridge.claimed(currentLease);
  return {
    lease: () => (held?.current ? held : null),
    off() {
      if (!bridges.delete(bridge)) return;
      held?.release();
      held = null;
    },
  };
}

/**
 * Give the pointer back. Only the exact lease that took it can release it, so a
 * superseded instance cannot free the claim its replacement now holds.
 * @param {PointerLease|null} lease The token `claimPointer` returned.
 * @returns {boolean} Whether this call released the claim.
 */
export function releasePointer(lease) {
  if (!currentLease || !lease || lease.id !== currentLease.id) return false;
  lostHandlers.delete(currentLease);
  currentLease = null;
  announce();
  return true;
}

/** @returns {string|null} The current owner's name, or null when free. */
export function pointerOwner() {
  return currentLease ? currentLease.owner : null;
}

/**
 * @returns {boolean} True when no tool holds the pointer, here or through a
 *   claim on a bridged port.
 */
export function isPointerFree() {
  if (currentLease !== null) return false;
  for (const bridge of bridges) if (!bridge.isFree()) return false;
  return true;
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
 * Drop any claim, telling no one. For tests and for application teardown,
 * which cannot rely on a half-disposed tool to release its own lease.
 * @returns {string|null} The owner that was holding it, if any.
 */
export function resetPointerOwnership() {
  const previous = pointerOwner();
  if (currentLease) lostHandlers.delete(currentLease);
  currentLease = null;
  announce();
  return previous;
}

function normalizeOwner(owner) {
  return typeof owner === 'string' && owner.trim() ? owner.trim() : null;
}
