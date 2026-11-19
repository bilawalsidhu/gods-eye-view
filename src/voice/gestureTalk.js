/**
 * Hand-gesture microphone toggle (src/handControl).
 *
 * The voice input that currently owns the Space shortcut registers here, so the
 * hand tracker can open and send a push-to-talk turn exactly as holding Space
 * does, without reaching into a provider session.
 *
 * @module voice/gestureTalk
 */

let current = null;

/** @param {{toggleGestureTalk: Function}} input */
export function registerGestureTalkInput(input) {
  current = input;
}

/** @param {object} input */
export function unregisterGestureTalkInput(input) {
  if (current === input) current = null;
}

/**
 * Toggles the microphone like a latched Space hold.
 * @returns {'listening'|'sent'|'open-mic'|'unavailable'}
 */
export function toggleGestureTalk() {
  if (!current) return 'unavailable';
  return current.toggleGestureTalk();
}

/** @returns {boolean} Whether a gesture or Space turn holds the microphone open. */
export function gestureTalkListening() {
  return Boolean(current?.pushToTalkKeyHeld);
}
