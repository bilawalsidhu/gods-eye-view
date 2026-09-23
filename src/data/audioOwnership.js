/**
 * Who is making sound.
 *
 * Several unrelated parts of the app produce audio — the radio transport, its
 * tuning noise, CCTV stream playback, the Nepal event clip, the voice
 * assistant — and each owns its own element or context. Nothing arbitrates
 * between them, so today two of them can play at once and the only thing
 * stopping a third is that no one has written it yet. "One audio source at a
 * time" is a property of there currently being one `HTMLAudioElement` inside
 * one layer, not a rule anything enforces.
 *
 * So there is one claim, held by at most one owner at a time:
 *
 * - A PRODUCER that is about to make sound calls `claimAudio('radio', {
 *   onRevoked })` and gets back a LEASE — an opaque token. It stops and calls
 *   `releaseAudio(lease)` when it goes quiet.
 * - When someone else claims, the incumbent's `onRevoked` runs and it is
 *   expected to stop. It does not poll and it is not asked permission.
 *
 * WHY THIS PREEMPTS AND `inputOwnership` DOES NOT. A pointer claim is refused
 * while another tool holds it, because a click that does two things is worse
 * than a click that does nothing. Audio is the other way round: if the user
 * opens a CCTV stream while the radio plays, silence from the camera is a bug
 * and two soundtracks at once is a worse one. The last thing the user asked
 * for is the thing that should be audible, so a claim always succeeds and the
 * incumbent is told to stop.
 *
 * DUCKING IS NOT OWNERSHIP and does not belong here. The voice assistant
 * lowering the radio for the length of an utterance is a volume policy between
 * two sources that are both meant to be live (`layerState._voiceDucked`); this
 * module is about which source is playing at all.
 *
 * `onRevoked` runs at most once per lease and never on a voluntary release —
 * a producer that stopped itself does not need to be told to stop. It runs
 * after the new owner is installed, so a revoked producer that calls
 * `releaseAudio` with its own now-stale lease frees nothing and cannot silence
 * its successor. A callback that throws is reported and swallowed: a broken
 * incumbent must not prevent the new sound from starting.
 *
 * Ownership is page-scoped, like the layers it arbitrates.
 */

/** @typedef {{owner: string, id: number}} AudioLease */

/** @type {AudioLease|null} */
let currentLease = null;
/** @type {(() => void)|null} Incumbent's revocation callback. */
let currentOnRevoked = null;
let nextLeaseId = 1;

/**
 * Take the audio for `owner`, stopping whoever had it.
 *
 * A producer that ALREADY holds the audio and is only changing what it plays
 * must pass its live lease as `renew`, or it revokes itself: its own
 * `onRevoked` would fire and stop the playback it is in the middle of
 * starting. Renewing still issues a fresh lease, so the old one goes stale on
 * schedule and a queued teardown from the previous attempt cannot free the new
 * claim.
 * @param {string} owner Stable identifier for the producer, e.g. 'radio', 'atc'.
 * @param {{onRevoked?: () => void, renew?: AudioLease|null}} [options]
 *   `onRevoked` is called when a LATER claim takes the audio away; it is not
 *   called when this owner releases voluntarily, nor when it renews.
 *   `renew` is the caller's current lease, if it has one.
 * @returns {AudioLease|null} The lease to release with, or null when `owner`
 *   is not a usable name.
 */
export function claimAudio(owner, options = {}) {
  const name = normalizeOwner(owner);
  if (!name) return null;
  const { onRevoked, renew = null } = options;
  const revoked = currentOnRevoked;
  // A renewal by the live lease holder is a continuation, not a takeover.
  const hadOwner = currentLease !== null && !isAudioLeaseCurrent(renew);
  // Install the new owner BEFORE telling the old one, so a callback that
  // re-enters this module sees the finished state rather than a half-swapped
  // one — and so its stale lease can no longer release anything.
  const issued = Object.freeze({ owner: name, id: nextLeaseId++ });
  currentLease = issued;
  currentOnRevoked = typeof onRevoked === 'function' ? onRevoked : null;
  if (hadOwner && typeof revoked === 'function') {
    try {
      revoked();
    } catch (error) {
      // A producer that cannot stop cleanly is a bug in that producer. It is
      // not a reason to leave the user with no sound from the thing they just
      // asked for.
      console.warn('[audioOwnership] revocation callback threw', error);
    }
  }
  // The lease THIS call issued, not whatever the module holds now: a
  // revocation callback is allowed to claim for itself, and in that case the
  // caller's lease is already stale. Returning the live one instead would hand
  // it someone else's token and let it release a claim it never held.
  // `isAudioLeaseCurrent(lease)` is how a caller finds out.
  return issued;
}

/**
 * Give the audio back. Only the exact lease that took it can release it, so a
 * producer that has already been revoked cannot silence its successor.
 * @param {AudioLease|null} lease The token `claimAudio` returned.
 * @returns {boolean} Whether this call released the claim.
 */
export function releaseAudio(lease) {
  if (!currentLease || !lease || lease.id !== currentLease.id) return false;
  currentLease = null;
  currentOnRevoked = null;
  return true;
}

/** @returns {string|null} The current owner's name, or null when free. */
export function audioOwner() {
  return currentLease ? currentLease.owner : null;
}

/** @returns {boolean} True when no producer holds the audio. */
export function isAudioFree() {
  return currentLease === null;
}

/**
 * @param {string} owner Producer name.
 * @returns {boolean} True when a producer of that name is holding the audio.
 */
export function isAudioOwnedBy(owner) {
  const name = normalizeOwner(owner);
  return Boolean(name) && audioOwner() === name;
}

/**
 * @param {AudioLease|null} lease A lease previously issued.
 * @returns {boolean} True when THIS lease is the live one — the cheap check a
 *   producer makes before an async continuation resumes playback.
 */
export function isAudioLeaseCurrent(lease) {
  return Boolean(currentLease && lease && lease.id === currentLease.id);
}

/**
 * Drop any claim WITHOUT revoking. For tests and for application teardown,
 * where the incumbent is being disposed anyway and calling back into it would
 * reach a half-torn-down object.
 * @returns {string|null} The owner that was holding it, if any.
 */
export function resetAudioOwnership() {
  const previous = audioOwner();
  currentLease = null;
  currentOnRevoked = null;
  return previous;
}

function normalizeOwner(owner) {
  return typeof owner === 'string' && owner.trim() ? owner.trim() : null;
}
