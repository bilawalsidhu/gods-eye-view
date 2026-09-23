/**
 * @module audioOwnership
 * @description Centralized audio lease and preemption coordinator.
 *
 * Ensures only one primary audio system (e.g. World Radio or Avionics ATC Radio)
 * streams through the browser at a given time, arbitrating claims, preemption,
 * and teardown without coupling individual layers directly to each other.
 *
 * Pattern mirrors `src/data/inputOwnership.js` with audio-specific preemption support.
 */

/** @typedef {{ owner: string, id: number }} AudioLease */

/** @type {AudioLease|null} */
let currentLease = null;
let nextLeaseId = 1;
const listeners = new Set();

function normalizeOwner(owner) {
  if (typeof owner !== 'string') return null;
  const trimmed = owner.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function notifyChange(change) {
  for (const listener of listeners) {
    try {
      listener(change);
    } catch (err) {
      console.warn('[Audio Ownership] Listener error:', err);
    }
  }
}

/**
 * Request ownership of the global audio transport.
 * @param {string} owner Stable identifier for the audio producer, e.g. 'atc' or 'radio'.
 * @param {object} [options]
 * @param {boolean} [options.preempt=true] Whether to preempt an existing owner.
 * @returns {AudioLease|null} Active lease token, or null if occupied and not preempting.
 */
export function claimAudio(owner, { preempt = true } = {}) {
  const name = normalizeOwner(owner);
  if (!name) return null;

  if (currentLease !== null) {
    if (!preempt) return null;
    const displacedLease = currentLease;
    const previousOwner = displacedLease.owner;
    currentLease = Object.freeze({ owner: name, id: nextLeaseId++ });
    notifyChange({
      owner: name,
      lease: currentLease,
      previousOwner,
      displacedLease,
    });
    return currentLease;
  }

  currentLease = Object.freeze({ owner: name, id: nextLeaseId++ });
  notifyChange({
    owner: name,
    lease: currentLease,
    previousOwner: null,
    displacedLease: null,
  });
  return currentLease;
}

/**
 * Release an audio lease.
 * @param {AudioLease|null} lease The lease token previously returned by `claimAudio`.
 * @returns {boolean} Whether the lease was active and successfully released.
 */
export function releaseAudio(lease) {
  if (!currentLease || !lease || lease.id !== currentLease.id) return false;
  const previousOwner = currentLease.owner;
  const displacedLease = currentLease;
  currentLease = null;
  notifyChange({
    owner: null,
    lease: null,
    previousOwner,
    displacedLease,
  });
  return true;
}

/**
 * Current audio owner identifier, or null if free.
 * @returns {string|null}
 */
export function audioOwner() {
  return currentLease ? currentLease.owner : null;
}

/**
 * Check if the audio channel is currently unowned.
 * @returns {boolean}
 */
export function isAudioFree() {
  return currentLease === null;
}

/**
 * Check if a specific owner currently holds the audio lease.
 * @param {string} owner
 * @returns {boolean}
 */
export function isAudioOwnedBy(owner) {
  const name = normalizeOwner(owner);
  return Boolean(name) && audioOwner() === name;
}

/**
 * Check if a specific lease token is currently active.
 * @param {AudioLease|null} lease
 * @returns {boolean}
 */
export function isAudioLeaseCurrent(lease) {
  return Boolean(currentLease && lease && lease.id === currentLease.id);
}

/**
 * Subscribe to audio ownership changes (claims, releases, preemption).
 * @param {function({ owner: string|null, lease: AudioLease|null, previousOwner: string|null, displacedLease: AudioLease|null }):void} listener
 * @returns {function():void} Unsubscribe function
 */
export function subscribeAudioOwnership(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Reset audio ownership. Intended for tests and teardown.
 * @returns {string|null} Previous owner, if any.
 */
export function resetAudioOwnership() {
  const prev = audioOwner();
  const displaced = currentLease;
  currentLease = null;
  if (displaced) {
    notifyChange({
      owner: null,
      lease: null,
      previousOwner: prev,
      displacedLease: displaced,
    });
  }
  return prev;
}
