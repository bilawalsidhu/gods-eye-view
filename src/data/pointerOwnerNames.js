import { msg } from '../i18n/marker.js';

/**
 * Tool name for a pointer owner. Owner ids (inputOwnership.js) never go on
 * screen; callers translate the English name with translateKnown().
 */

const POINTER_OWNER_NAMES = Object.freeze({
  draw: msg('Draw'),
  directions: msg('Directions'),
  'recent-imagery-box': msg('Recent imagery'),
});

/**
 * English display name of a pointer owner. An owner without a registered name
 * falls back to its id.
 * @param {string|null} owner Pointer-owner id, as `pointerOwner()` returns it.
 * @returns {string}
 */
export function pointerOwnerName(owner) {
  const id = typeof owner === 'string' ? owner.trim() : '';
  if (!id) return '';
  return Object.hasOwn(POINTER_OWNER_NAMES, id) ? POINTER_OWNER_NAMES[id] : id;
}
