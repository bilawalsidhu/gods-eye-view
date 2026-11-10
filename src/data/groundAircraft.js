export const GROUND_AIRCRAFT_MODES = Object.freeze(['show', 'dim', 'hide']);
export function normalizeGroundAircraftMode(value) {
  return GROUND_AIRCRAFT_MODES.includes(value) ? value : 'dim';
}
/** Only explicit feed ground reports qualify; low altitude alone is not ground. */
export function groundAircraftAlpha(mode, onGround, protectedContact = false) {
  if (onGround !== true || protectedContact) return 1;
  return mode === 'hide' ? 0 : mode === 'show' ? 1 : 0.35;
}
