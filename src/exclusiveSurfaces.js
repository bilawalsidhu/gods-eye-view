/**
 * Body classes that mean "another surface owns the screen": cockpit, scene
 * playback, recording and clean view. First run yields to them and the phone
 * shell closes its sheets for them.
 */
export const EXCLUSIVE_SURFACE_CLASSES = Object.freeze([
  'cockpit-mode',
  'scene-playback-mode',
  'recording-mode',
  'ui-clean-view',
]);

/**
 * Is some other surface currently claiming the screen?
 * @param {Document} [documentRef]
 * @returns {boolean}
 */
export function exclusiveSurfaceActive(documentRef = globalThis.document) {
  const list = documentRef?.body?.classList;
  if (!list) return false;
  return EXCLUSIVE_SURFACE_CLASSES.some((name) => list.contains(name));
}
